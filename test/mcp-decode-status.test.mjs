// Decode status must survive native tool adaptation.
//
// A lane decoder that cannot parse a tool call's streamed arguments has to
// say so in a way the executor will still see. Marking the argument object
// itself does not survive: a native adapter builds a fresh object from the
// fields it knows about, so the marker is dropped and a truncated call
// dispatches with whatever did arrive.
//
// Exercised through the built bundle, like core-tool-contracts.test.mjs.

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.mcp-decode-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __decodeStatus() {
  init_analytics(); init_tools(); init_contractValidation();
  init_messages(); init_json();
  return { getRegistrationByNativeName, checkMcpArguments,
    TOOL_DECODE_STATUS_KEY, decodeStatusOf, describeDecodeFailure,
    normalizeContentFromAPI };
}
`
writeFileSync(auditPath, source)

let d
try {
  const module = await import(pathToFileURL(auditPath).href)
  d = module.__decodeStatus()
} finally {
  unlinkSync(auditPath)
}

test('a native adapter rebuilds the argument object', () => {
  // The reason an in-arguments marker cannot work: `replace` returns a fresh
  // object containing only the fields it maps, so anything else is gone.
  const replace = d.getRegistrationByNativeName('replace')
  assert.ok(replace, 'expected a replace registration')
  const adapted = replace.adaptInput({
    file_path: '/tmp/a',
    old_string: 'x',
    new_string: 'y',
    somethingElse: 'dropped',
  })
  assert.equal('somethingElse' in adapted, false)
  assert.equal(adapted.file_path, '/tmp/a')
})

test('decode failure is carried on the block, not in the arguments', () => {
  // The envelope survives adaptation because adaptation only ever replaces
  // `input`; the block itself is spread through the message pipeline.
  // The shape the Gemini lane emits on content_block_start.
  const block = {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Edit',
    input: { file_path: '/tmp/a', old_string: 'x', new_string: 'y' },
    [d.TOOL_DECODE_STATUS_KEY]: { category: 'truncated', fragmentLength: 21 },
  }

  const replace = d.getRegistrationByNativeName('replace')
  const adaptedBlock = { ...block, input: replace.adaptInput(block.input) }

  const status = d.decodeStatusOf(adaptedBlock)
  assert.ok(status, 'decode status did not survive adaptation')
  assert.equal(status.category, 'truncated')
  // And it is not smuggled through the arguments.
  assert.equal(d.TOOL_DECODE_STATUS_KEY in adaptedBlock.input, false)
})

test('a tool parameter may legitimately be named like the old marker', () => {
  // The previous in-arguments marker reserved an undocumented parameter
  // name. A server declaring it must be validated normally.
  const tool = {
    name: 'mcp__fixture__marker_named',
    isMcp: true,
    inputJSONSchema: {
      type: 'object',
      properties: { __tauIncompleteArguments: { type: 'string' } },
      required: ['__tauIncompleteArguments'],
    },
  }
  assert.equal(
    d.checkMcpArguments(tool, { __tauIncompleteArguments: 'a real value' }).ok,
    true,
  )
  assert.equal(
    d.checkMcpArguments(tool, { __tauIncompleteArguments: 7 }).ok,
    false,
  )
})

test('decodeStatusOf ignores a model-supplied lookalike in arguments', () => {
  // Decode status is set by trusted runtime processing. A model that emits a
  // field of that name inside its arguments must not be able to claim it.
  const block = {
    type: 'tool_use',
    id: 'toolu_2',
    name: 'Edit',
    input: { [d.TOOL_DECODE_STATUS_KEY]: { category: 'truncated' } },
  }
  assert.equal(d.decodeStatusOf(block), undefined)
})

test('a block with no decode status reports none', () => {
  assert.equal(
    d.decodeStatusOf({ type: 'tool_use', id: 't', name: 'Edit', input: {} }),
    undefined,
  )
})

test('an unparseable streamed tool input is not turned into an empty call', () => {
  // The shared path, so this covers every provider rather than one lane.
  // `parsed ?? {}` used to dispatch a call whose arguments never arrived as
  // though the model had deliberately sent none — which a parameterless or
  // all-optional schema accepts.
  const [block] = d.normalizeContentFromAPI(
    [{ type: 'tool_use', id: 'toolu_1', name: 'SomeTool', input: '{"a":1,"b":tr' }],
    [],
    undefined,
  )
  const status = d.decodeStatusOf(block)
  assert.ok(status, 'an unparseable tool input was accepted as a complete call')
  assert.equal(status.category, 'truncated')
})

test('a complete streamed tool input carries no decode status', () => {
  const [block] = d.normalizeContentFromAPI(
    [{ type: 'tool_use', id: 'toolu_2', name: 'SomeTool', input: '{"a":1}' }],
    [],
    undefined,
  )
  assert.deepEqual(block.input, { a: 1 })
  assert.equal(d.decodeStatusOf(block), undefined)
})

test('a deliberately empty argument object still decodes cleanly', () => {
  // `{}` is the correct call for a parameterless tool and must not be
  // confused with arguments that failed to arrive.
  const [block] = d.normalizeContentFromAPI(
    [{ type: 'tool_use', id: 'toolu_3', name: 'SomeTool', input: '{}' }],
    [],
    undefined,
  )
  assert.deepEqual(block.input, {})
  assert.equal(d.decodeStatusOf(block), undefined)
})
