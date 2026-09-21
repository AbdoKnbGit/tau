// Tool calls actually execute.
//
// This file exists because a decode-status variable was read from a function
// that did not declare it. The build transpiled fine, the MCP helper tests
// all passed, and every single tool call in the product threw
// `ReferenceError: decodeFailure is not defined`. Nothing in the suite ran a
// tool, so nothing noticed.
//
// So these drive the real exported `runToolUse` with a fixture tool and
// count invocations. Only outside dependencies (permission, context) are
// stubbed; the execution chain itself is production code.

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.mcp-exec-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __execution() {
  init_analytics(); init_toolExecution(); init_decodeStatus();
  return { runToolUse, TOOL_DECODE_STATUS_KEY };
}
`
writeFileSync(auditPath, source)

let x
try {
  const module = await import(pathToFileURL(auditPath).href)
  x = module.__execution()
} finally {
  unlinkSync(auditPath)
}

let uid = 0
const nextId = () => `toolu_${++uid}`

/** A tool that records every call and returns a fixed result. */
function spyTool(overrides = {}) {
  const calls = []
  const tool = {
    name: 'FixtureTool',
    calls,
    isMcp: false,
    maxResultSizeChars: 100_000,
    inputSchema: {
      // A permissive stand-in: these tests are about whether `call` runs at
      // all, not about schema validation, which has its own suite.
      safeParse: value => ({ success: true, data: value }),
    },
    inputJSONSchema: { type: 'object', properties: {}, additionalProperties: true },
    async description() {
      return 'fixture'
    },
    async prompt() {
      return 'fixture'
    },
    userFacingName: () => 'FixtureTool',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async checkPermissions() {
      return { behavior: 'allow', updatedInput: undefined }
    },
    async call(input) {
      calls.push(input)
      return { data: 'fixture ok' }
    },
    mapToolResultToToolResultBlockParam: (content, toolUseID) => ({
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: String(content),
    }),
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    ...overrides,
  }
  return tool
}

function makeContext(tool) {
  return {
    abortController: new AbortController(),
    options: {
      tools: [tool],
      mcpClients: [],
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
    messages: [],
    getAppState: () => ({
      mcp: { clients: [], tools: [] },
      sessionHooks: new Map(),
      toolPermissionContext: { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
    }),
    setAppState: () => {},
    queryTracking: undefined,
  }
}

function makeAssistantMessage() {
  return {
    type: 'assistant',
    uuid: `uuid_${++uid}`,
    message: { id: `msg_${uid}`, content: [] },
    requestId: undefined,
  }
}

/** Run a tool_use block through the real pipeline; collect its results. */
async function execute(block, tool) {
  const updates = []
  const context = makeContext(tool)
  const allow = async () => ({ behavior: 'allow', updatedInput: block.input })
  try {
    for await (const update of x.runToolUse(
      block,
      makeAssistantMessage(),
      allow,
      context,
    )) {
      updates.push(update)
    }
  } catch (error) {
    return { updates, thrown: error }
  }
  return { updates, thrown: undefined, aborted: context.abortController.signal.aborted }
}

/** Every tool_result block across the collected updates. */
function resultsOf(updates) {
  const out = []
  for (const update of updates) {
    const content = update?.message?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_result') out.push(block)
    }
  }
  return out
}

test('R1.1 a valid call reaches the tool exactly once', async () => {
  // The regression that mattered: this threw ReferenceError for every tool.
  const tool = spyTool()
  const { thrown, updates, aborted } = await execute(
    { type: 'tool_use', id: nextId(), name: 'FixtureTool', input: { a: 1 } },
    tool,
  )
  assert.equal(thrown, undefined, `execution threw: ${thrown?.message}`)
  assert.equal(
    tool.calls.length,
    1,
    `the tool did not run; aborted=${aborted}; results: ${JSON.stringify(resultsOf(updates).map(r => String(r.content).slice(0, 200)))}`,
  )
  assert.deepEqual(tool.calls[0], { a: 1 })
  const results = resultsOf(updates)
  assert.equal(results.length >= 1, true, 'no tool_result was produced')
  assert.equal(results.at(-1).is_error ?? false, false)
})

test('R1.1b no result mentions an internal ReferenceError', async () => {
  // A caught ReferenceError formatted as a tool error would satisfy a naive
  // "the call failed" assertion. Name it explicitly so it cannot pass.
  const tool = spyTool()
  const { updates } = await execute(
    { type: 'tool_use', id: nextId(), name: 'FixtureTool', input: {} },
    tool,
  )
  for (const result of resultsOf(updates)) {
    assert.doesNotMatch(String(result.content ?? ''), /ReferenceError/)
    assert.doesNotMatch(String(result.content ?? ''), /is not defined/)
  }
})

test('R1.3 a decode failure refuses execution with a stated reason', async () => {
  const tool = spyTool()
  const id = nextId()
  const { thrown, updates } = await execute(
    {
      type: 'tool_use',
      id,
      name: 'FixtureTool',
      input: { a: 1 },
      [x.TOOL_DECODE_STATUS_KEY]: { category: 'truncated', fragmentLength: 12 },
    },
    tool,
  )
  assert.equal(thrown, undefined)
  assert.equal(tool.calls.length, 0, 'a call with incomplete arguments ran')
  const results = resultsOf(updates)
  assert.equal(results.length, 1)
  assert.equal(results[0].is_error, true)
  assert.equal(results[0].tool_use_id, id)
  // Refused for the right reason, not by accident.
  assert.match(String(results[0].content), /was not run/)
  assert.match(String(results[0].content), /full arguments/)
})

test('R1.4 the refusal does not depend on the validation switch', async () => {
  const original = process.env.TAU_MCP_ARG_VALIDATION
  process.env.TAU_MCP_ARG_VALIDATION = '0'
  try {
    const tool = spyTool()
    const { updates } = await execute(
      {
        type: 'tool_use',
        id: nextId(),
        name: 'FixtureTool',
        input: {},
        [x.TOOL_DECODE_STATUS_KEY]: { category: 'malformed' },
      },
      tool,
    )
    assert.equal(tool.calls.length, 0)
    assert.equal(resultsOf(updates)[0].is_error, true)
  } finally {
    if (original === undefined) delete process.env.TAU_MCP_ARG_VALIDATION
    else process.env.TAU_MCP_ARG_VALIDATION = original
  }
})

test('R1.5 interleaved calls do not exchange decode status', async () => {
  const good = spyTool()
  const bad = spyTool()
  const goodId = nextId()
  const badId = nextId()

  const [goodRun, badRun] = await Promise.all([
    execute(
      { type: 'tool_use', id: goodId, name: 'FixtureTool', input: { ok: true } },
      good,
    ),
    execute(
      {
        type: 'tool_use',
        id: badId,
        name: 'FixtureTool',
        input: { ok: true },
        [x.TOOL_DECODE_STATUS_KEY]: { category: 'truncated' },
      },
      bad,
    ),
  ])

  assert.equal(good.calls.length, 1, 'the valid call did not run')
  assert.equal(bad.calls.length, 0, 'the invalid call ran')
  assert.equal(resultsOf(goodRun.updates).at(-1).is_error ?? false, false)
  assert.equal(resultsOf(badRun.updates)[0].tool_use_id, badId)
})

test('R1.6 an argument named like internal metadata is just an argument', async () => {
  // The envelope is read from the block. A value of the same name inside
  // `input` is the server's own parameter and carries no runtime authority.
  const tool = spyTool()
  const { updates } = await execute(
    {
      type: 'tool_use',
      id: nextId(),
      name: 'FixtureTool',
      input: {
        [x.TOOL_DECODE_STATUS_KEY]: { category: 'truncated' },
        __tauIncompleteArguments: 'a real value',
      },
    },
    tool,
  )
  assert.equal(tool.calls.length, 1, 'a model-supplied lookalike blocked the call')
  assert.equal(tool.calls[0].__tauIncompleteArguments, 'a real value')
  assert.equal(resultsOf(updates).at(-1).is_error ?? false, false)
})
