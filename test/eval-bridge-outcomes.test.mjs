import assert from 'node:assert/strict'
import test from 'node:test'

import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// OUT-02: a tool that reports failure by RETURNING an error result, rather than
// throwing, must stay failed across the Eval bridge. These run against the real
// bundled bridge over real loopback HTTP, so the assertions cover the shipped
// protocol rather than a reimplementation of it.

const runtime = await loadMcpRuntime()

/** Post to the real bridge exactly as the Python kernel does. */
async function bridgeCall(info, session, name, args) {
  const response = await fetch(`${info.url}/v1/tool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${info.token}`,
    },
    body: JSON.stringify({ session, name, args: args ?? {} }),
  })
  return await response.json()
}

/**
 * Registers `tool` on the live bridge and returns a caller plus the records the
 * bridge reported, so a test can assert on the wire reply and the call log.
 */
async function withBridgedTool(tool, run) {
  const info = await runtime.ensureToolBridge()
  const session = `test-${Math.random().toString(36).slice(2)}`
  const records = []
  const unregister = runtime.registerBridgeSession(session, {
    tools: [tool],
    toolUseContext: fixtureContext([tool]),
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    parentMessage: { type: 'assistant', uuid: 'fixture', message: { id: 'fixture', content: [] } },
    signal: new AbortController().signal,
    onCall: record => records.push(record),
    budget: { enter() {}, exit() {} },
  })
  try {
    return await run({ info, session, records })
  } finally {
    unregister()
  }
}

test('a returned error result fails the bridge call instead of reading as success', async () => {
  const tool = fixtureTool({
    name: 'FailingTool',
    userFacingName: () => 'FailingTool',
    async call() {
      return { data: 'disk is full' }
    },
    mapToolResultToToolResultBlockParam: (content, id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content,
      is_error: true,
    }),
  })

  await withBridgedTool(tool, async ({ info, session, records }) => {
    const reply = await bridgeCall(info, session, 'FailingTool')

    assert.equal(reply.ok, false, 'an error result must not be reported as ok')
    // The tool's own diagnostic is the evidence; it must survive, not be
    // replaced by a generic bridge message.
    assert.match(reply.error, /disk is full/)
    assert.equal(reply.value, undefined)

    assert.equal(records.length, 1)
    assert.match(records[0].error ?? '', /disk is full/, 'the call record must be marked failed')
  })
})

test('an error result with no diagnostic still fails, without inventing a cause', async () => {
  const tool = fixtureTool({
    name: 'SilentFailure',
    userFacingName: () => 'SilentFailure',
    async call() {
      return { data: '' }
    },
    mapToolResultToToolResultBlockParam: (content, id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content,
      is_error: true,
    }),
  })

  await withBridgedTool(tool, async ({ info, session }) => {
    const reply = await bridgeCall(info, session, 'SilentFailure')
    assert.equal(reply.ok, false)
    assert.match(reply.error, /returned no diagnostic content/)
  })
})

test('an ordinary successful result is unchanged', async () => {
  const tool = fixtureTool({ name: 'OkTool', userFacingName: () => 'OkTool' })

  await withBridgedTool(tool, async ({ info, session, records }) => {
    const reply = await bridgeCall(info, session, 'OkTool')
    assert.equal(reply.ok, true, 'a valid call must still succeed')
    assert.equal(reply.value, 'fixture ok')
    assert.equal(records.length, 1)
    assert.equal(records[0].error, undefined)
  })
})

test('a result that merely contains the word error stays successful', async () => {
  // The status bit is authoritative; wording is not. A body mentioning an error
  // must not be downgraded, and a success must not be upgraded from prose.
  const tool = fixtureTool({
    name: 'MentionsError',
    userFacingName: () => 'MentionsError',
    async call() {
      return { data: 'recovered from an earlier error: 0 failures' }
    },
  })

  await withBridgedTool(tool, async ({ info, session }) => {
    const reply = await bridgeCall(info, session, 'MentionsError')
    assert.equal(reply.ok, true)
    assert.match(reply.value, /0 failures/)
  })
})

test.after(async () => {
  await runtime.disposeToolBridge()
})
