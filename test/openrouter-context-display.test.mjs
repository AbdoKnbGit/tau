import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const r = await loadMcpRuntime({
  paths: ['src/utils/sessionContextUsage.ts', 'src/utils/contextBaseline.ts', 'src/utils/forcedProvider.ts'],
  exports: ['getSessionContextUsage', 'setContextBaselineTokens', 'runWithForcedProvider'],
})
const model = 'openrouter-display-fixture'
const response = (id, input, read = 0) => ({ type: 'assistant', uuid: id,
  message: { id, model, content: [{ type: 'text', text: 'Response' }],
    usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } } })
const usage = (messages, provider = 'openrouter') => r.runWithForcedProvider({ provider },
  () => r.getSessionContextUsage(messages, model))
r.setContextBaselineTokens(model, 71_000)

test('OpenRouter retains measured 54k/55k usage while each next response has provisional zero usage', () => {
  const messages = [response('completed', 54_000)]
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.push(response('thinking', 0))
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.push(response('tool', 0))
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.at(-1).message.usage.input_tokens = 55_000
  assert.equal(usage(messages).usedTokens, 55_000)
  messages.push(response('next-thinking', 0))
  assert.equal(usage(messages).usedTokens, 55_000)
})

test('OpenRouter accepts an entirely cached real measurement and respects compaction', () => {
  const messages = [response('cached', 0, 54_000), response('pending', 0)]
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
  assert.equal(usage(messages).usedTokens, 71_000, 'pre-compaction measurements must not leak')
  messages.push(response('after-compact', 15_000))
  assert.equal(usage(messages).usedTokens, 15_000, 'real smaller measurements must remain visible')
})

test('Codex (openai) keeps the measured context while the next response streams', () => {
  // The Responses API reports usage only with response.completed, so every
  // streamed block of the next response starts at zero, exactly like OpenRouter.
  const messages = [response('completed', 1_075, 68_000)]
  assert.equal(usage(messages, 'openai').usedTokens, 69_075)
  messages.push(response('thinking', 0))
  assert.equal(usage(messages, 'openai').usedTokens, 69_075, 'a streaming block must not drop the meter to the baseline')
  messages.push(response('tool', 0))
  messages.at(-1).message.usage.input_tokens = 900
  messages.at(-1).message.usage.cache_read_input_tokens = 69_000
  assert.equal(usage(messages, 'openai').usedTokens, 69_900)
})

test('other providers keep their existing pending-usage display policy', () => {
  const messages = [response('completed', 54_000), response('pending', 0)]
  assert.ok(usage(messages, 'deepseek').usedTokens >= 71_000)
})
