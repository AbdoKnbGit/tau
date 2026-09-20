// Validating MCP tool arguments against the server's own input schema.
//
// Exercised through the built bundle, like core-tool-contracts.test.mjs.
//
// The validator cache is process-global and keyed by contract hash, so cases
// that need a distinct compilation give their schema a distinguishing field
// rather than relying on a reset seam.

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.mcp-contract-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __mcpContracts() {
  init_contractValidation();
  return { checkMcpArguments, inputContractHash };
}
`
writeFileSync(auditPath, source)

let c
try {
  const module = await import(pathToFileURL(auditPath).href)
  c = module.__mcpContracts()
} finally {
  unlinkSync(auditPath)
}

const mcpTool = (name, inputJSONSchema) => ({
  name,
  isMcp: true,
  inputJSONSchema,
})

test('a call matching its schema is accepted', () => {
  const tool = mcpTool('mcp__fixture__create', {
    type: 'object',
    properties: { title: { type: 'string' }, count: { type: 'number' } },
    required: ['title'],
  })
  assert.deepEqual(c.checkMcpArguments(tool, { title: 'a', count: 2 }), {
    ok: true,
  })
})

test('a missing required field is rejected on an ordinary call', () => {
  // The whole point of this change: before it, only blind calls were checked,
  // so an ordinary MCP call with missing arguments was dispatched as sent.
  const tool = mcpTool('mcp__fixture__needs_id', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  })
  const result = c.checkMcpArguments(tool, {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_arguments')
  assert.match(result.message, /id/)
  // The expected schema is inlined so the model can correct the call.
  assert.match(result.message, /Expected input schema/)
})

test('a wrong value type is rejected', () => {
  const tool = mcpTool('mcp__fixture__typed', {
    type: 'object',
    properties: { count: { type: 'number' } },
  })
  const result = c.checkMcpArguments(tool, { count: 'twelve' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_arguments')
})

test('a value outside an enum is rejected', () => {
  const tool = mcpTool('mcp__fixture__enum', {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
    required: ['mode'],
  })
  assert.equal(c.checkMcpArguments(tool, { mode: 'fast' }).ok, true)
  assert.equal(c.checkMcpArguments(tool, { mode: 'medium' }).ok, false)
})

test('a genuinely parameterless tool accepts empty arguments', () => {
  // A blanket "never empty arguments" rule would be wrong: {} is the correct
  // call for a tool that takes nothing.
  const tool = mcpTool('mcp__fixture__ping', {
    type: 'object',
    properties: {},
  })
  assert.deepEqual(c.checkMcpArguments(tool, {}), { ok: true })
})

test('an explicitly open schema accepts an extra field', () => {
  // Reproduced defect: the blind validator rejected any property the
  // properties map did not name, including on a schema that says extras are
  // expected. A schema that says so explicitly is taken at its word.
  const tool = mcpTool('mcp__fixture__open', {
    type: 'object',
    additionalProperties: true,
    properties: { id: { type: 'string' } },
  })
  assert.deepEqual(c.checkMcpArguments(tool, { id: 'a', extra: 1 }), {
    ok: true,
  })
  // Including for a blind call: the schema, not the caller, decides.
  assert.deepEqual(
    c.checkMcpArguments(tool, { id: 'a', extra: 1 }, { blind: true }),
    { ok: true },
  )
})

test('a subschema for additional properties is enforced, not banned', () => {
  const tool = mcpTool('mcp__fixture__typed_extras', {
    type: 'object',
    additionalProperties: { type: 'string' },
    properties: { id: { type: 'string' } },
  })
  assert.equal(c.checkMcpArguments(tool, { id: 'a', note: 'ok' }).ok, true)
  assert.equal(c.checkMcpArguments(tool, { id: 'a', note: 5 }).ok, false)
})

test('a closed schema rejects an extra field', () => {
  const tool = mcpTool('mcp__fixture__closed', {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string' } },
  })
  assert.equal(c.checkMcpArguments(tool, { id: 'a', extra: 1 }).ok, false)
})

test('a blind call is rejected for a property the schema does not name', () => {
  // The schema says nothing about extras, and the model never saw it, so an
  // unnamed property is treated as an invention rather than dispatched.
  const tool = mcpTool('mcp__fixture__silent', {
    type: 'object',
    properties: { repo: { type: 'string' } },
  })
  const blind = c.checkMcpArguments(
    tool,
    { repo: 'a/b', branch: 'main' },
    { blind: true },
  )
  assert.equal(blind.ok, false)
  assert.match(blind.message, /branch/)
  // An informed call against the same schema is left to the schema, whose
  // default is permissive.
  assert.equal(c.checkMcpArguments(tool, { repo: 'a/b', branch: 'main' }).ok, true)
})

test('a changed contract under the same tool name is validated afresh', () => {
  // Reproduced defect: validators were cached by tool name, so after a server
  // changed `id` from string to number, the valid number was rejected and the
  // stale string accepted. Keying by contract hash makes the change a
  // different key.
  const asString = mcpTool('mcp__fixture__evolving', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  })
  assert.equal(c.checkMcpArguments(asString, { id: 'abc' }).ok, true)
  assert.equal(c.checkMcpArguments(asString, { id: 123 }).ok, false)

  const asNumber = mcpTool('mcp__fixture__evolving', {
    type: 'object',
    properties: { id: { type: 'number' } },
    required: ['id'],
  })
  assert.equal(c.checkMcpArguments(asNumber, { id: 123 }).ok, true)
  assert.equal(c.checkMcpArguments(asNumber, { id: 'abc' }).ok, false)
})

test('a nested object and array contract is enforced', () => {
  const tool = mcpTool('mcp__fixture__nested', {
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        required: ['tags'],
      },
    },
    required: ['filter'],
  })
  assert.equal(
    c.checkMcpArguments(tool, { filter: { tags: ['a', 'b'] } }).ok,
    true,
  )
  assert.equal(c.checkMcpArguments(tool, { filter: {} }).ok, false)
  assert.equal(c.checkMcpArguments(tool, { filter: { tags: [1] } }).ok, false)
})

test('a local $ref is resolved rather than treated as unconstrained', () => {
  const tool = mcpTool('mcp__fixture__refs', {
    type: 'object',
    $defs: {
      Id: { type: 'string', minLength: 3 },
    },
    properties: { id: { $ref: '#/$defs/Id' } },
    required: ['id'],
  })
  assert.equal(c.checkMcpArguments(tool, { id: 'abcd' }).ok, true)
  assert.equal(c.checkMcpArguments(tool, { id: 'ab' }).ok, false)
  assert.equal(c.checkMcpArguments(tool, { id: 7 }).ok, false)
})

test('an unknown $schema dialect does not stop validation', () => {
  // The structural keywords are dialect-independent, so the dialect is
  // dropped rather than the contract refused.
  const tool = mcpTool('mcp__fixture__dialect', {
    $schema: 'https://example.invalid/never-shipped',
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  })
  assert.equal(c.checkMcpArguments(tool, { id: 'a' }).ok, true)
  assert.equal(c.checkMcpArguments(tool, {}).ok, false)
})

test('an uncompilable contract is reported as such, not as bad arguments', () => {
  const tool = mcpTool('mcp__fixture__broken', {
    type: 'object',
    properties: { id: { $ref: '#/$defs/Missing' } },
  })
  const result = c.checkMcpArguments(tool, { id: 'a' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unsupported_contract')
})

test('a blind call with no local schema is refused with schema_not_exposed', () => {
  const tool = { name: 'mcp__fixture__unknown', isMcp: true }
  const result = c.checkMcpArguments(tool, { anything: 1 }, { blind: true })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'schema_not_exposed')
})

test('an informed call with no local schema is not blocked', () => {
  // The model was declared the same (absent) schema Tau holds, so there is
  // nothing more to enforce here.
  const tool = { name: 'mcp__fixture__unknown2', isMcp: true }
  assert.deepEqual(c.checkMcpArguments(tool, { anything: 1 }), { ok: true })
})

test('non-object arguments are validated as an empty object', () => {
  const tool = mcpTool('mcp__fixture__scalar_args', {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  })
  // A string or an array where an argument object belongs cannot satisfy a
  // required field, so it is rejected rather than coerced into one.
  assert.equal(c.checkMcpArguments(tool, 'not an object').ok, false)
  assert.equal(c.checkMcpArguments(tool, ['a']).ok, false)
  assert.equal(c.checkMcpArguments(tool, null).ok, false)
})

test('contract hashes distinguish contracts and match identical ones', () => {
  const a = { type: 'object', properties: { id: { type: 'string' } } }
  const b = { type: 'object', properties: { id: { type: 'string' } } }
  const different = { type: 'object', properties: { id: { type: 'number' } } }
  assert.equal(c.inputContractHash(a), c.inputContractHash(b))
  assert.notEqual(c.inputContractHash(a), c.inputContractHash(different))
})

test('a property named like a schema keyword is not mistaken for one', () => {
  // `default`, `format` and `type` are ordinary property names here.
  const tool = mcpTool('mcp__fixture__keywordish', {
    type: 'object',
    properties: {
      default: { type: 'string' },
      format: { type: 'number' },
      type: { type: 'boolean' },
    },
    required: ['default'],
  })
  assert.equal(
    c.checkMcpArguments(tool, { default: 'x', format: 1, type: true }).ok,
    true,
  )
  assert.equal(c.checkMcpArguments(tool, { default: 1 }).ok, false)
  assert.equal(c.checkMcpArguments(tool, { format: 1 }).ok, false)
})

test('a meaningful null is preserved where the contract allows it', () => {
  const tool = mcpTool('mcp__fixture__nullable', {
    type: 'object',
    properties: { note: { type: ['string', 'null'] } },
    required: ['note'],
  })
  assert.equal(c.checkMcpArguments(tool, { note: null }).ok, true)
  assert.equal(c.checkMcpArguments(tool, { note: 'text' }).ok, true)
  assert.equal(c.checkMcpArguments(tool, { note: 5 }).ok, false)
})
