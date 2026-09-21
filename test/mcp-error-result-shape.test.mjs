import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBlock, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// An error tool_result may only carry text/image blocks. `modelContent` on an
// MCP failure is a general MCP result, so a non-text block reaching the error
// envelope would be a payload the provider API rejects — and JSON-encoding the
// whole envelope instead would show the model `[{"type":"text",...}]` rather
// than the server's diagnostic. These run the real bundled executor.

const runtime = await loadMcpRuntime()

/** A tool whose call throws the given error, as a failing MCP tool does. */
function throwingTool(error) {
  return fixtureTool({
    name: 'mcp__fixture__failing',
    isMcp: true,
    userFacingName: () => 'fixture:failing',
    async call() {
      throw error
    },
  })
}

function errorResultOf(results) {
  assert.equal(results.length, 1)
  const [result] = results
  assert.equal(result.is_error, true, 'the failure must stay a failure')
  return result
}

test('a plain MCP failure keeps its diagnostic as text', async () => {
  const tool = throwingTool(new Error('the server refused: use ref alone'))
  const block = { type: 'tool_use', id: 'mcp-err-1', name: tool.name, input: {} }

  const { results } = await executeBlock(runtime, block, tool)
  const result = errorResultOf(results)

  const text = typeof result.content === 'string'
    ? result.content
    : result.content.map(b => b.text ?? '').join('\n')
  assert.match(text, /use ref alone/)
  // The envelope must never be a JSON dump of the block array.
  assert.doesNotMatch(text, /^\s*\[\s*\{\s*"type"/)
})

test('every block in an error result is a type the provider API accepts', async () => {
  // A diagnostic carrying a non-text, non-image block: it must be rendered,
  // not dropped and not passed through as an invalid block. Built with the
  // real error class from the bundle, since only that type carries
  // `modelContent` through the executor.
  const error = new runtime.McpToolCallError(
    'structured failure',
    'MCP tool returned error',
    undefined,
    undefined,
    undefined,
    [
      { type: 'text', text: 'first: the server rejected the call' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'text', text: 'last: check the ref field' },
    ],
  )
  const tool = throwingTool(error)
  const block = { type: 'tool_use', id: 'mcp-err-2', name: tool.name, input: {} }

  const { results } = await executeBlock(runtime, block, tool)
  const result = errorResultOf(results)

  if (typeof result.content !== 'string') {
    for (const item of result.content) {
      assert.ok(
        item.type === 'text' || item.type === 'image',
        `an error result may not contain a ${item.type} block`,
      )
    }
  }

  const text = typeof result.content === 'string'
    ? result.content
    : result.content.map(b => b.text ?? '').join('\n')
  // Evidence on both sides of the unsupported block survives, and the block
  // itself is represented rather than silently discarded.
  assert.match(text, /the server rejected the call/)
  assert.match(text, /check the ref field/)
  assert.match(text, /audio/)
})

test('image evidence survives outbound sanitization as a file reference', async () => {
  // The end-to-end case: an error result may only carry text, and
  // `sanitizeErrorToolResultContent` silently drops anything else on the way
  // out. Evidence must therefore already be a saved-file reference by the time
  // it leaves the executor, exactly as the normal MCP path produces.
  const error = new runtime.McpToolCallError(
    'screenshot failed',
    'MCP tool returned error',
    undefined,
    undefined,
    undefined,
    [
      { type: 'text', text: 'the render step failed' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
    ],
  )
  const tool = throwingTool(error)
  const block = { type: 'tool_use', id: 'mcp-err-3', name: tool.name, input: {} }

  const { messages } = await executeBlock(runtime, block, tool)

  // Run the real outbound sanitizer over the real executor output.
  const sanitized = runtime.sanitizeErrorToolResultContent(messages)
  const results = sanitized
    .flatMap(m => m.message.content)
    .filter(b => b.type === 'tool_result')
  const result = errorResultOf(results)

  const text = typeof result.content === 'string'
    ? result.content
    : result.content.map(b => b.text ?? '').join('\n')

  // The diagnostic survives, and so does a pointer to the image.
  assert.match(text, /the render step failed/)
  assert.match(text, /saved to|could not be saved/,
    'the image must leave behind a retrievable reference, not vanish')
  assert.match(text, /image\/png/)
})

test('a timeout tells the model the operation may already have happened', async () => {
  // The whole point of the unknown outcome: a timed-out write must not read as
  // a plain failure, or the model retries a mutation that already landed.
  const error = new Error('MCP server "fixture" tool "send" timed out after 5s')
  runtime.attachOutcome(error, {
    version: runtime.OUTCOME_RECORD_VERSION,
    dispatch: 'possibly_sent',
    outcome: 'unknown',
    verification: 'not_attempted',
  })
  const tool = throwingTool(error)
  const block = { type: 'tool_use', id: 'mcp-timeout', name: tool.name, input: {} }

  const { results } = await executeBlock(runtime, block, tool)
  const result = errorResultOf(results)

  const text = typeof result.content === 'string'
    ? result.content
    : result.content.map(b => b.text ?? '').join('\n')

  // The server's own diagnostic survives...
  assert.match(text, /timed out/)
  // ...qualified by the uncertainty, not replaced by it.
  assert.match(text, /unknown whether/i)
  assert.match(text, /check the current state/i)
  assert.doesNotMatch(text, /did not run|rolled back/i)
})

test('uncertainty survives a failure that escapes to the outer handler', async () => {
  // The outer catch wraps permission checking AND execution, so an error
  // arriving there may belong to a call that already ran. A non-MCP tool
  // throwing a carried outcome takes that path rather than the MCP one.
  const error = new Error('connection dropped mid-call')
  runtime.attachOutcome(error, {
    version: runtime.OUTCOME_RECORD_VERSION,
    dispatch: 'possibly_sent',
    outcome: 'unknown',
    verification: 'not_attempted',
  })
  const tool = fixtureTool({
    name: 'PlainTool',
    userFacingName: () => 'PlainTool',
    // Throwing from schema parsing escapes past the execution handler and
    // lands in the outer one — verified by reverting the fix and watching
    // this assertion fail there specifically.
    inputSchema: {
      safeParse: () => {
        throw error
      },
    },
  })
  const block = { type: 'tool_use', id: 'outer-catch', name: tool.name, input: {} }

  const { results } = await executeBlock(runtime, block, tool)
  const result = errorResultOf(results)
  const text = typeof result.content === 'string'
    ? result.content
    : result.content.map(b => b.text ?? '').join('\n')

  assert.match(text, /connection dropped mid-call/)
  assert.match(text, /unknown whether/i)
  assert.doesNotMatch(text, /did not run|rolled back/i)
})

test('a setup failure with no carried outcome claims no uncertainty', async () => {
  // The fallback at the outer handler. Most errors that reach it ran before
  // dispatch, so the default must stay "did not run" — inventing uncertainty
  // for every scaffolding bug would be as misleading as denying it for a
  // genuine timeout.
  const tool = fixtureTool({
    name: 'PlainTool',
    userFacingName: () => 'PlainTool',
    inputSchema: {
      safeParse: () => {
        throw new Error('plain scaffolding error')
      },
    },
  })
  const block = { type: 'tool_use', id: 'outer-plain', name: tool.name, input: {} }

  const { results } = await executeBlock(runtime, block, tool)
  const result = errorResultOf(results)
  const text = typeof result.content === 'string'
    ? result.content
    : result.content.map(b => b.text ?? '').join('\n')

  assert.match(text, /plain scaffolding error/)
  assert.doesNotMatch(text, /unknown whether|check the current state/i)
})

test('an ordinary failure gains no uncertainty note', async () => {
  // Only a genuinely uncertain outcome earns the note. A definite failure must
  // stay definite, or every error would read as "maybe it worked".
  const tool = throwingTool(new Error('the server rejected the arguments'))
  const block = { type: 'tool_use', id: 'mcp-plain-fail', name: tool.name, input: {} }

  const { results } = await executeBlock(runtime, block, tool)
  const result = errorResultOf(results)
  const text = typeof result.content === 'string'
    ? result.content
    : result.content.map(b => b.text ?? '').join('\n')

  assert.match(text, /rejected the arguments/)
  assert.doesNotMatch(text, /unknown whether|check the current state/i)
})

test('a successful MCP call is untouched by the error path', async () => {
  const tool = fixtureTool({
    name: 'mcp__fixture__ok',
    isMcp: true,
    userFacingName: () => 'fixture:ok',
  })
  const block = { type: 'tool_use', id: 'mcp-ok-1', name: tool.name, input: {} }

  const { results } = await executeBlock(runtime, block, tool)

  assert.equal(tool.calls.length, 1, 'the tool must run exactly once')
  assert.equal(results.length, 1)
  assert.notEqual(results[0].is_error, true)
})
