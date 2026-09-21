import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBlock, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// A model can name an optional prebuilt tool that this session does not offer
// (it saw the tool earlier, or the user toggled it off). That branch of
// `runToolUseInner` read a variable belonging to a different function, so the
// call died with `ReferenceError: errorText is not defined` instead of
// returning its notice. esbuild cannot catch an out-of-scope read, so this
// runs the real bundle.

const runtime = await loadMcpRuntime()

// Every optional prebuilt tool reaches the same branch; naming them keeps the
// coverage honest if the list changes.
const OPTIONAL_PREBUILT_TOOLS = [
  'ArtifactCanvas',
  'InspectSite',
  'WebBrowser',
  'Browser',
]

for (const toolName of OPTIONAL_PREBUILT_TOOLS) {
  test(`an unavailable ${toolName} returns its notice instead of crashing`, async () => {
    const present = fixtureTool()
    const block = { type: 'tool_use', id: `unavailable-${toolName}`, name: toolName, input: {} }

    const { results } = await executeBlock(runtime, block, present)

    assert.equal(results.length, 1)
    const [result] = results
    assert.equal(result.tool_use_id, block.id)
    assert.equal(typeof result.content, 'string', 'the notice must be plain text')
    assert.match(result.content, /disabled or unavailable/)
    // No internal failure may leak into what the model reads.
    assert.doesNotMatch(result.content, /ReferenceError|is not defined|undefined/)
    // This is an informational notice, not a failure envelope.
    assert.equal(result.is_error, false)
  })
}

test('an ordinary unknown tool name still reports no such tool', async () => {
  // The neighbouring branch: a name that is not an optional prebuilt tool must
  // keep its own distinct handling rather than borrowing the notice above.
  const present = fixtureTool()
  const block = { type: 'tool_use', id: 'unknown-1', name: 'NoSuchToolAnywhere', input: {} }

  const { results } = await executeBlock(runtime, block, present)

  assert.equal(results.length, 1)
  const [result] = results
  assert.equal(result.is_error, true)
  assert.doesNotMatch(String(result.content), /ReferenceError|is not defined/)
})

test('a tool the session does offer still executes normally', async () => {
  const present = fixtureTool()
  const block = { type: 'tool_use', id: 'ok-1', name: 'FixtureTool', input: { a: 1 } }

  const { results } = await executeBlock(runtime, block, present)

  assert.equal(present.calls.length, 1, 'the real tool must run exactly once')
  assert.equal(results.length, 1)
  assert.notEqual(results[0].is_error, true)
})
