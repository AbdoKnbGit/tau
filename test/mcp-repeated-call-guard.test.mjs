import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBlock, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// A strict server rejects a call, the model patches only the key the
// diagnostic named, sends again, is rejected for the next key, and repeats.
// Observed as seven near-identical attempts against one tool, ended only by
// the user interrupting. Each payload differed, so nothing downstream saw a
// duplicate — the call was simply going nowhere, one round trip at a time.
//
// The prompt already asks the model to stop after two same-cause failures.
// This is the half that does not depend on it obeying.

const runtime = await loadMcpRuntime()

/** Prior attempts, newest last, as the executor reconstructs them. */
const failed = input => ({ input, failed: true })
const succeeded = input => ({ input, failed: false })

test('a third attempt with the same argument shape is a repeat', () => {
  const history = [
    failed({ container: 1, payload: 'a', ref: 1 }),
    failed({ container: 1, payload: 'b', ref: 1 }),
  ]
  assert.equal(
    runtime.isRepeatedFailingCall(history, { container: 1, payload: 'c', ref: 1 }),
    true,
    'editing values while the server objects to shape is the loop',
  )
})

test('the real transcript progression is stopped at the third attempt', () => {
  // The seven observed calls, by the top-level keys the executor sees. They
  // are identical throughout: the churn was buried inside the payload string.
  const call = { container: 1, payload: 'varies', ref: 1 }
  const history = []
  const stoppedAt = []
  for (let attempt = 1; attempt <= 7; attempt++) {
    if (runtime.isRepeatedFailingCall(history, call)) {
      stoppedAt.push(attempt)
      break
    }
    history.push(failed(call))
  }
  assert.deepEqual(
    stoppedAt,
    [3],
    'the loop must break on the third attempt, not after seven',
  )
})

test('a structurally different retry is allowed through', () => {
  // The guard against over-correction: adding or dropping a key is a real
  // correction, and the model must be able to act on a diagnostic.
  const history = [
    failed({ op: 1, ref: 1, value: 1 }),
    failed({ op: 1, ref: 1, value: 1 }),
  ]
  assert.equal(
    runtime.isRepeatedFailingCall(history, { op: 1, target: 1, with: 1 }),
    false,
    'a corrected shape is progress, not a repeat',
  )
})

test('one failure is never a loop', () => {
  assert.equal(
    runtime.isRepeatedFailingCall([failed({ a: 1 })], { a: 2 }),
    false,
    'a single failure is a typo, not a misunderstanding',
  )
  assert.equal(runtime.isRepeatedFailingCall([], { a: 1 }), false)
})

test('a success between failures resets the run', () => {
  // Recovery means the next failure starts fresh, or a long session would
  // eventually refuse every call to a tool that had failed twice before.
  const history = [
    failed({ a: 1 }),
    failed({ a: 1 }),
    succeeded({ a: 1 }),
    failed({ a: 1 }),
  ]
  assert.equal(runtime.isRepeatedFailingCall(history, { a: 1 }), false)
})

test('key order and value type do not affect the comparison', () => {
  // Shape is the key set, not its spelling or its contents.
  const history = [
    failed({ b: 1, a: 'x' }),
    failed({ a: [], b: null }),
  ]
  assert.equal(
    runtime.isRepeatedFailingCall(history, { a: { deep: true }, b: 0 }),
    true,
  )
})

test('a repeating call is refused before it reaches the server', async () => {
  // End to end through the real executor: the tool must not be called.
  const tool = fixtureTool({
    name: 'mcp__fx__strict',
    isMcp: true,
    userFacingName: () => 'fx:strict',
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema: { type: 'object' },
  })

  const priorCall = input => ({
    type: 'assistant',
    uuid: `a-${input.payload}`,
    message: {
      id: `m-${input.payload}`,
      content: [{ type: 'tool_use', id: `t-${input.payload}`, name: tool.name, input }],
    },
  })
  const priorResult = id => ({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'rejected', is_error: true }],
    },
  })

  const messages = [
    priorCall({ container: 1, payload: 'a', ref: 1 }),
    priorResult('t-a'),
    priorCall({ container: 1, payload: 'b', ref: 1 }),
    priorResult('t-b'),
  ]
  const block = {
    type: 'tool_use',
    id: 'loop-3',
    name: tool.name,
    input: { container: 1, payload: 'c', ref: 1 },
  }

  const { results } = await executeBlock(runtime, block, tool, { messages })

  assert.equal(tool.calls.length, 0, 'the repeating call must not reach the server')
  assert.equal(results[0].is_error, true)
  assert.match(String(results[0].content), /failed 2 times in a row/)
  assert.match(String(results[0].content), /Re-read the tool's schema/)
})

test('a first call with no history still runs', async () => {
  // The guard must be invisible to an ordinary call.
  const tool = fixtureTool({
    name: 'mcp__fx__ok',
    isMcp: true,
    userFacingName: () => 'fx:ok',
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema: { type: 'object' },
  })
  const block = { type: 'tool_use', id: 'first', name: tool.name, input: { a: 1 } }

  const { results } = await executeBlock(runtime, block, tool)

  assert.equal(tool.calls.length, 1)
  assert.notEqual(results[0].is_error, true)
})

test('a prebuilt tool is not subject to the MCP loop guard', async () => {
  // Scoped to MCP: built-in tools have their own validation and failure modes.
  const calls = []
  const prebuilt = fixtureTool({
    name: 'Counter',
    calls,
    isMcp: false,
    userFacingName: () => 'Counter',
    async call(input) {
      calls.push(input)
      return { data: 'ok' }
    },
  })
  const priorCall = tag => ({
    type: 'assistant',
    uuid: `a-${tag}`,
    message: {
      id: `m-${tag}`,
      content: [{ type: 'tool_use', id: `t-${tag}`, name: 'Counter', input: { a: 1 } }],
    },
  })
  const priorResult = id => ({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: true }],
    },
  })
  const messages = [priorCall('a'), priorResult('t-a'), priorCall('b'), priorResult('t-b')]
  const block = { type: 'tool_use', id: 'pre-3', name: 'Counter', input: { a: 1 } }

  const { results } = await executeBlock(runtime, block, prebuilt, { messages })

  assert.equal(calls.length, 1, 'a prebuilt tool must still run')
  assert.notEqual(results[0].is_error, true)
})
