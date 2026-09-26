// Optional arguments that a model filled with a placeholder.
//
// Replays tool calls recorded in real sessions through the shipped
// `runToolUse`, with the real Browser, Read and Bash tools — their real
// schemas and their real validateInput — and only `call` replaced by a
// recorder. Placeholders the contract rejects must read as omitted; every
// other invalid call must still fail and never reach the tool.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod/v4'

import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const runtime = await loadMcpRuntime({
  paths: [
    'src/tools/BrowserTool/BrowserTool.tsx',
    'src/tools/FileReadTool/FileReadTool.ts',
    'src/tools/BashTool/BashTool.tsx',
  ],
  exports: ['BrowserTool', 'FileReadTool', 'BashTool'],
})

/** The real tool, with `call` recording its input instead of acting. */
function recording(tool) {
  const calls = []
  return {
    ...tool,
    calls,
    async call(input) {
      calls.push(input)
      return { data: 'recorded' }
    },
    mapToolResultToToolResultBlockParam: (content, id) => ({ type: 'tool_result', tool_use_id: id, content }),
  }
}

let uid = 0
async function run(tool, input) {
  const block = { type: 'tool_use', id: `toolu_placeholder_${++uid}`, name: tool.name, input }
  const updates = []
  for await (const update of runtime.runToolUse(
    block,
    { type: 'assistant', uuid: `uuid_${uid}`, message: { id: `msg_${uid}`, content: [block] } },
    // Like the real permission path: allow the input as it was handed over.
    async (_tool, allowed) => ({ behavior: 'allow', updatedInput: allowed }),
    fixtureContext([tool]),
  )) {
    updates.push(update)
  }
  const results = updates
    .map(update => update.message)
    .filter(message => message?.type === 'user')
    .flatMap(message => message.message.content)
    .filter(content => content.type === 'tool_result')
  const text = results.map(result => typeof result.content === 'string'
    ? result.content
    : (result.content ?? []).map(part => part.text ?? '').join('\n')).join('\n')
  return { results, text }
}

test('the recorded zero-filled Browser call runs without the zeros its schema rejects', async () => {
  // Recorded from a model that fills every parameter: rejected for nth, amount, timeoutMs.
  const browser = recording(runtime.BrowserTool)
  const recorded = {
    action: 'observe', url: 'https://example.com', ref: 0, nth: 0, x: 0, y: 0,
    submit: false, double: false, direction: 'down', amount: 0, ms: 0, gone: false,
    timeoutMs: 0, toRef: 0, maxChars: 4000, offset: 0, full: false, annotate: false,
    level: 'all', failed: false, limit: 30, clear: false, width: 0, height: 0,
    mobile: false, hard: false, surface: 'auto', tabIndex: 0, headless: true,
  }
  const { results, text } = await run(browser, recorded)
  assert.equal(browser.calls.length, 1, `the call did not run: ${text}`)
  const sent = browser.calls[0]
  for (const dropped of ['nth', 'amount', 'timeoutMs']) {
    assert.equal(dropped in sent, false, `${dropped} reached the tool`)
  }
  // Placeholders the schema accepts are the model's values and are kept.
  assert.equal(sent.ref, 0)
  assert.equal(sent.offset, 0)
  assert.equal(sent.headless, true)
  assert.notEqual(results.at(-1).is_error, true)
  assert.match(text, /`nth` = 0/)
  assert.match(text, /Leave out optional parameters/)
  // First, so a preview of a result cut down to its beginning still carries it.
  assert.ok(text.startsWith('[Ignored optional'), text.slice(0, 80))
})

test('a strict-lane Browser call with null for every unused field runs silently', async () => {
  // A strict-mode lane sends null for every optional field.
  const browser = recording(runtime.BrowserTool)
  const input = { action: 'observe', url: 'https://example.com' }
  for (const field of ['ref', 'text', 'nth', 'value', 'x', 'y', 'key', 'amount', 'timeoutMs', 'files', 'fields']) {
    input[field] = null
  }
  const { text } = await run(browser, input)
  assert.equal(browser.calls.length, 1, `the call did not run: ${text}`)
  assert.deepEqual(browser.calls[0], { action: 'observe', url: 'https://example.com' })
  assert.doesNotMatch(text, /Ignored optional/, 'null is how strict lanes omit a field; no note')
})

test('a real invalid Browser value still fails and never runs', async () => {
  const browser = recording(runtime.BrowserTool)
  const { results } = await run(browser, { action: 'observe', nth: 'second', amount: 0 })
  assert.equal(browser.calls.length, 0, 'an invalid call ran')
  assert.equal(results[0].is_error, true)
})

test('the recorded Read call with pages "" reads the file', async () => {
  // Recorded: refused every time before this fix, on a plain source file.
  const dir = mkdtempSync(join(tmpdir(), 'tau-placeholder-'))
  try {
    const file = join(dir, 'analytics.py')
    writeFileSync(file, 'print("hi")\n')
    const read = recording(runtime.FileReadTool)
    const { results, text } = await run(read, {
      file_path: file, offset: 0, limit: 2000, skeleton: false, pages: '',
    })
    assert.equal(read.calls.length, 1, `the read did not run: ${text}`)
    assert.equal('pages' in read.calls[0], false, 'the empty page range reached the tool')
    assert.equal(read.calls[0].limit, 2000)
    assert.notEqual(results.at(-1).is_error, true)
    assert.match(text, /`pages` = ""/)
    assert.ok(text.startsWith('[Ignored empty optional'), text.slice(0, 80))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a real page range still goes to the tool untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tau-placeholder-'))
  try {
    const file = join(dir, 'doc.pdf')
    writeFileSync(file, '%PDF-1.4\n')
    const read = recording(runtime.FileReadTool)
    const { results } = await run(read, { file_path: file, pages: 'x-y' })
    assert.equal(read.calls.length, 0, 'an invalid page range ran')
    assert.equal(results[0].is_error, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the recorded Bash call with a filler command_parts runs its command', async () => {
  // Recorded: command_parts tokens filled with value [].
  const bash = recording(runtime.BashTool)
  const recorded = {
    command: 'echo placeholder-check', timeout: 120000,
    description: 'Check placeholder handling', run_in_background: false,
    plan_only: false, syntax_confirmed: false,
    command_parts: {
      executable: 'echo',
      tokens: [{ kind: 'arg', value: [] }, { kind: 'arg', value: [] }],
      positionals: [], trailing_args: [],
    },
    dangerouslyDisableSandbox: false,
  }
  const { text } = await run(bash, recorded)
  assert.equal(bash.calls.length, 1, `the command did not run: ${text}`)
  assert.equal(bash.calls[0].command, 'echo placeholder-check')
  assert.equal('command_parts' in bash.calls[0], false)
  assert.match(text, /`command_parts`/)
})

test('a Bash call missing its command still fails', async () => {
  const bash = recording(runtime.BashTool)
  const { results } = await run(bash, {
    description: '', timeout: 0, command_parts: { executable: 'ls', tokens: [] },
  })
  assert.equal(bash.calls.length, 0)
  assert.equal(results[0].is_error, true)
  assert.match(String(results[0].content), /command/)
})

const playwrightTabs = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'new', 'close', 'select'] },
    index: { type: 'number' },
    url: { type: 'string' },
  },
  required: ['action'],
  additionalProperties: false,
}

function mcpTool(name, inputJSONSchema) {
  return fixtureTool({
    name,
    isMcp: true,
    userFacingName: () => name,
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema,
  })
}

test('the recorded strict-lane MCP call runs without its nulls', async () => {
  // Recorded from a strict-mode lane: rejected for index/url null.
  const tool = mcpTool('mcp__playwright__browser_tabs', playwrightTabs)
  const { results, text } = await run(tool, { action: 'list', index: null, url: null })
  assert.equal(tool.calls.length, 1, `the call did not run: ${text}`)
  assert.deepEqual(tool.calls[0], { action: 'list' })
  assert.notEqual(results.at(-1).is_error, true)
  assert.doesNotMatch(text, /Ignored optional/)
})

test('an MCP null the server accepts is sent as null', async () => {
  const tool = mcpTool('mcp__fx__nullable', {
    type: 'object',
    properties: { action: { type: 'string' }, index: { type: ['number', 'null'] } },
    required: ['action'],
  })
  await run(tool, { action: 'list', index: null })
  assert.deepEqual(tool.calls[0], { action: 'list', index: null })
})

test('a stringified MCP argument is repaired once a placeholder is out of its way', async () => {
  const tool = mcpTool('mcp__brave__search', {
    type: 'object',
    properties: { query: { type: 'string' }, count: { type: 'integer' }, offset: { type: 'integer' } },
    required: ['query'],
  })
  const { text } = await run(tool, { query: 'x', count: '3', offset: null })
  assert.equal(tool.calls.length, 1, `the call did not run: ${text}`)
  assert.deepEqual(tool.calls[0], { query: 'x', count: 3 })
})

test('an MCP call missing a required argument is still refused', async () => {
  const tool = mcpTool('mcp__playwright__browser_tabs', playwrightTabs)
  const { results } = await run(tool, { action: null, index: 0 })
  assert.equal(tool.calls.length, 0)
  assert.equal(results[0].is_error, true)
})

/** A built-in-shaped tool: real Zod schema, its own validateInput. */
function validatingTool(name, validateInput) {
  return fixtureTool({
    name,
    inputSchema: z.strictObject({ file_path: z.string(), cell_id: z.string().optional() }),
    inputJSONSchema: undefined,
    validateInput,
  })
}

test('an empty optional argument the tool refuses reads as omitted', async () => {
  const tool = validatingTool('EmptyRefusingFixture', async input =>
    input.cell_id === '' ? { result: false, message: 'Invalid cell_id: "".', errorCode: 1 } : { result: true })
  const { results, text } = await run(tool, { file_path: 'a.ipynb', cell_id: '' })
  assert.equal(tool.calls.length, 1, `the call did not run: ${text}`)
  assert.deepEqual(tool.calls[0], { file_path: 'a.ipynb' })
  assert.notEqual(results.at(-1).is_error, true)
})

test('a pass owed to state the first check changed keeps the original refusal', async () => {
  // Like a read-first refusal: the first check records the read and refuses;
  // after that, every check passes. Dropping the empty argument is not what
  // made the retry pass, so the call must not run.
  let recorded = false
  const tool = validatingTool('StatefulFixture', async () => {
    if (!recorded) {
      recorded = true
      return { result: false, message: 'File has not been read yet.', errorCode: 6 }
    }
    return { result: true }
  })
  const { results } = await run(tool, { file_path: 'a.ipynb', cell_id: '' })
  assert.equal(tool.calls.length, 0, 'the refused call ran after the state changed')
  assert.equal(results[0].is_error, true)
  assert.match(String(results[0].content), /has not been read yet/)
})
