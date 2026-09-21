import assert from 'node:assert/strict'
import test from 'node:test'

import { fixtureContext, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Phase 5/F3: the final contract guard.
//
// MCP arguments are validated against the server's JSON Schema early, on the
// input as it arrived. Hooks and permission handlers can replace that input
// wholesale afterwards, and the replacement used to reach the transport
// unverified — so a handler could send the server arguments it never agreed
// to. These run the real bundled executor end to end.

const runtime = await loadMcpRuntime()

/** An MCP tool with a strict server contract. */
function strictMcpTool(name = 'mcp__fx__create') {
  return fixtureTool({
    name,
    isMcp: true,
    userFacingName: () => name,
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  })
}

/** Runs a block with a permission handler that may rewrite the input. */
async function runWith(tool, block, canUseTool) {
  const context = fixtureContext([tool])
  const updates = []
  for await (const update of runtime.runToolUse(
    block,
    { type: 'assistant', uuid: 'fixture-assistant', message: { id: 'fixture-message', content: [block] } },
    canUseTool,
    context,
  )) {
    updates.push(update)
  }
  const results = updates
    .map(u => u.message)
    .filter(m => m?.type === 'user')
    .flatMap(m => m.message.content)
    .filter(b => b.type === 'tool_result')
  return { results }
}

test('a permission handler cannot send arguments the server never agreed to', async () => {
  const tool = strictMcpTool()
  const block = { type: 'tool_use', id: 'guard-1', name: tool.name, input: { title: 'valid' } }

  // Swaps in input that is missing `title` and carries a forbidden extra.
  const { results } = await runWith(tool, block, async () => ({
    behavior: 'allow',
    updatedInput: { bogus: 'not-in-schema' },
  }))

  assert.equal(tool.calls.length, 0, 'the contract-violating call must not be sent')
  assert.equal(results[0].is_error, true)
  assert.match(String(results[0].content), /changed after they were validated/)
})

test('a hook cannot drop a required field after validation', async () => {
  const tool = strictMcpTool()
  const block = { type: 'tool_use', id: 'guard-2', name: tool.name, input: { title: 'valid' } }

  const { results } = await runWith(tool, block, async () => ({
    behavior: 'allow',
    updatedInput: {},
  }))

  assert.equal(tool.calls.length, 0, 'a call missing a required field must not be sent')
  assert.equal(results[0].is_error, true)
})

test('a legitimate rewrite that still satisfies the contract is sent', async () => {
  // The guard against over-correction: hooks exist to adjust input, and an
  // adjustment that respects the contract must still work.
  const tool = strictMcpTool()
  const block = { type: 'tool_use', id: 'guard-3', name: tool.name, input: { title: 'before' } }

  const { results } = await runWith(tool, block, async () => ({
    behavior: 'allow',
    updatedInput: { title: 'after' },
  }))

  assert.equal(tool.calls.length, 1, 'a valid rewrite must still run')
  assert.deepEqual(tool.calls[0], { title: 'after' })
  assert.notEqual(results[0].is_error, true)
})

test('an untouched valid call runs exactly once', async () => {
  // The guard must be invisible when nothing changed.
  const tool = strictMcpTool()
  const block = { type: 'tool_use', id: 'guard-4', name: tool.name, input: { title: 'unchanged' } }

  const { results } = await runWith(tool, block, async (_t, input) => ({
    behavior: 'allow',
    updatedInput: input,
  }))

  assert.equal(tool.calls.length, 1)
  assert.deepEqual(tool.calls[0], { title: 'unchanged' })
  assert.notEqual(results[0].is_error, true)
})

test('an open server schema still accepts a rewritten call', async () => {
  // A permissive contract is a deliberate choice, not a missing one. The
  // guard must not invent restrictions the server did not declare.
  const tool = fixtureTool({
    name: 'mcp__fx__anything',
    isMcp: true,
    userFacingName: () => 'fx:anything',
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema: { type: 'object' },
  })
  const block = { type: 'tool_use', id: 'guard-5', name: tool.name, input: { a: 1 } }

  const { results } = await runWith(tool, block, async () => ({
    behavior: 'allow',
    updatedInput: { totally: 'different', shape: [1, 2] },
  }))

  assert.equal(tool.calls.length, 1, 'an open contract must keep accepting input')
  assert.deepEqual(tool.calls[0], { totally: 'different', shape: [1, 2] })
  assert.notEqual(results[0].is_error, true)
})

test('the validation opt-out cannot bypass the final guard', async () => {
  // TAU_MCP_ARG_VALIDATION=0 relaxes the early, informed-call check. It is
  // not permission to send a server arguments it never agreed to, so the
  // final gate stays on.
  const previous = process.env.TAU_MCP_ARG_VALIDATION
  process.env.TAU_MCP_ARG_VALIDATION = '0'
  try {
    const tool = strictMcpTool('mcp__fx__optout')
    const block = { type: 'tool_use', id: 'guard-optout', name: tool.name, input: { title: 'valid' } }

    const { results } = await runWith(tool, block, async () => ({
      behavior: 'allow',
      updatedInput: { bogus: 'not-in-schema' },
    }))

    assert.equal(tool.calls.length, 0, 'the opt-out must not disable the final gate')
    assert.equal(results[0].is_error, true)
  } finally {
    if (previous === undefined) delete process.env.TAU_MCP_ARG_VALIDATION
    else process.env.TAU_MCP_ARG_VALIDATION = previous
  }
})

test('a prebuilt tool is unaffected by the MCP guard', async () => {
  // The guard is MCP-only: a prebuilt tool's Zod schema is authoritative and
  // its hook rewrites must not be re-checked against a contract it has none of.
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
  const block = { type: 'tool_use', id: 'guard-6', name: 'Counter', input: { count: 1 } }

  const { results } = await runWith(prebuilt, block, async () => ({
    behavior: 'allow',
    updatedInput: { count: 99, extra: 'allowed' },
  }))

  assert.equal(calls.length, 1, 'a prebuilt rewrite must still run')
  assert.deepEqual(calls[0], { count: 99, extra: 'allowed' })
  assert.notEqual(results[0].is_error, true)
})

test('a server parameter named like internal metadata stays ordinary data', async () => {
  // Reserved-looking names belong to the server, not the runtime.
  const tool = fixtureTool({
    name: 'mcp__fx__raw',
    isMcp: true,
    userFacingName: () => 'fx:raw',
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema: {
      type: 'object',
      properties: { _raw: { type: 'string' }, _tau_decode_status: { type: 'string' } },
      required: ['_raw'],
    },
  })
  const block = { type: 'tool_use', id: 'guard-7', name: tool.name, input: { _raw: 'x' } }

  const { results } = await runWith(tool, block, async () => ({
    behavior: 'allow',
    updatedInput: { _raw: 'y', _tau_decode_status: 'z' },
  }))

  assert.equal(tool.calls.length, 1, 'declared reserved-looking params are just data')
  assert.deepEqual(tool.calls[0], { _raw: 'y', _tau_decode_status: 'z' })
  assert.notEqual(results[0].is_error, true)
})
