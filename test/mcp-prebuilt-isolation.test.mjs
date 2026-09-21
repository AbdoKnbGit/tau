import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBlock, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// MCP tools and prebuilt tools share the executor but must not share its
// decisions. An MCP tool stands in for a remote server's real JSON Schema
// behind a passthrough Zod object, so the checks that make a prebuilt tool
// safe (Zod parsing) check nothing for it, and the checks that make an MCP
// call safe (server schema validation, argument repair) must not be applied
// to a prebuilt tool whose Zod schema is already authoritative.
//
// These run the real bundled executor end to end.

const runtime = await loadMcpRuntime()

/** A prebuilt-style tool whose Zod schema actually constrains its input. */
function prebuiltTool(name, overrides = {}) {
  const calls = []
  return fixtureTool({
    name,
    calls,
    isMcp: false,
    userFacingName: () => name,
    inputSchema: {
      safeParse: value =>
        typeof value?.count === 'number'
          ? { success: true, data: value }
          : {
              success: false,
              error: { issues: [{ path: ['count'], message: 'expected number' }] },
            },
    },
    async call(input) {
      calls.push(input)
      return { data: `${name} ran` }
    },
    ...overrides,
  })
}

/** An MCP-style tool: passthrough Zod, real contract in inputJSONSchema. */
function mcpTool(name, jsonSchema, overrides = {}) {
  const calls = []
  return fixtureTool({
    name,
    calls,
    isMcp: true,
    userFacingName: () => name,
    inputSchema: { safeParse: value => ({ success: true, data: value }) },
    inputJSONSchema: jsonSchema,
    async call(input) {
      calls.push(input)
      return { data: `${name} ran` }
    },
    ...overrides,
  })
}

test('a same-named MCP tool and prebuilt tool do not share a decision', async () => {
  // The collision that matters: identical names, incompatible contracts. The
  // executor resolves the tool it was given, never "the other one with this
  // name".
  const mcp = mcpTool('search', {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  })

  const { results } = await executeBlock(
    runtime,
    { type: 'tool_use', id: 'same-name-mcp', name: 'search', input: { query: 'hello' } },
    mcp,
  )

  assert.equal(mcp.calls.length, 1, 'the MCP tool must run')
  assert.deepEqual(mcp.calls[0], { query: 'hello' })
  assert.notEqual(results[0].is_error, true)
})

test('a prebuilt tool keeps its Zod validation', async () => {
  // A prebuilt tool's Zod schema is authoritative and must still reject.
  const prebuilt = prebuiltTool('Counter')

  const { results } = await executeBlock(
    runtime,
    { type: 'tool_use', id: 'prebuilt-bad', name: 'Counter', input: { count: 'not-a-number' } },
    prebuilt,
  )

  assert.equal(prebuilt.calls.length, 0, 'invalid input must not reach the tool')
  assert.equal(results[0].is_error, true)
})

test('an MCP tool is validated against its server schema, not its Zod stand-in', async () => {
  // The passthrough Zod object accepts anything, so if the server contract
  // were not checked this call would reach the server malformed.
  const mcp = mcpTool('create', {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  })

  const { results } = await executeBlock(
    runtime,
    { type: 'tool_use', id: 'mcp-bad', name: 'create', input: { wrong: 1 } },
    mcp,
  )

  assert.equal(mcp.calls.length, 0, 'a call violating the server contract must not be sent')
  assert.equal(results[0].is_error, true)
})

test('a valid MCP call and a valid prebuilt call both still run', async () => {
  // The guard against over-correction: general safety must not become a
  // blanket refusal.
  const mcp = mcpTool('fetch', {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  })
  const prebuilt = prebuiltTool('Counter')

  const mcpRun = await executeBlock(
    runtime,
    { type: 'tool_use', id: 'ok-mcp', name: 'fetch', input: { url: 'https://example.test' } },
    mcp,
  )
  const prebuiltRun = await executeBlock(
    runtime,
    { type: 'tool_use', id: 'ok-prebuilt', name: 'Counter', input: { count: 2 } },
    prebuilt,
  )

  assert.equal(mcp.calls.length, 1)
  assert.equal(prebuilt.calls.length, 1)
  assert.notEqual(mcpRun.results[0].is_error, true)
  assert.notEqual(prebuiltRun.results[0].is_error, true)
})

test('an MCP tool with an open schema stays open', async () => {
  // An empty/permissive server schema is a deliberate contract, not a missing
  // one. Hardcoding additionalProperties:false onto it would break servers
  // that legitimately accept free-form input.
  const mcp = mcpTool('passthrough', { type: 'object' })

  const { results } = await executeBlock(
    runtime,
    {
      type: 'tool_use',
      id: 'open-schema',
      name: 'passthrough',
      input: { anything: 'goes', nested: { deep: true } },
    },
    mcp,
  )

  assert.equal(mcp.calls.length, 1, 'an open contract must keep accepting input')
  assert.deepEqual(mcp.calls[0], { anything: 'goes', nested: { deep: true } })
  assert.notEqual(results[0].is_error, true)
})

test('two MCP tools with the same base name stay independent', async () => {
  // Two servers exposing the same tool name resolve through their own
  // prefixed identities, so one server's contract cannot validate another's
  // call.
  const first = mcpTool('mcp__alpha__list', {
    type: 'object',
    properties: { limit: { type: 'number' } },
    required: ['limit'],
    additionalProperties: false,
  })
  const second = mcpTool('mcp__beta__list', {
    type: 'object',
    properties: { cursor: { type: 'string' } },
    required: ['cursor'],
    additionalProperties: false,
  })

  const a = await executeBlock(
    runtime,
    { type: 'tool_use', id: 'alpha', name: first.name, input: { limit: 5 } },
    first,
  )
  const b = await executeBlock(
    runtime,
    { type: 'tool_use', id: 'beta', name: second.name, input: { cursor: 'abc' } },
    second,
  )

  assert.equal(first.calls.length, 1)
  assert.equal(second.calls.length, 1)
  assert.deepEqual(first.calls[0], { limit: 5 })
  assert.deepEqual(second.calls[0], { cursor: 'abc' })
  assert.notEqual(a.results[0].is_error, true)
  assert.notEqual(b.results[0].is_error, true)
})
