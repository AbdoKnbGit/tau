import assert from 'node:assert/strict'
import { CommandCodeProvider } from '../src/services/api/providers/commandcode_provider.js'
import { CommandCodeUsageAccumulator } from '../src/services/api/providers/commandcode_usage.js'

const originalFetch = globalThis.fetch
const provider = new CommandCodeProvider({ apiKey: 'test-key' })
const warmUsage = {
  inputTokens: 10_000, outputTokens: 20,
  inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 9_000 },
}
const expectedWarm = { input_tokens: 1_000, output_tokens: 20, cache_read_input_tokens: 9_000 }
let checks = 0

async function checkStream(
  name: string,
  events: Record<string, unknown>[],
  expected: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
  model = 'deepseek/deepseek-v4-flash-fast',
) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.match(String(url), /\/alpha\/generate$/, `${name}: preserve Go transport`)
    assert.equal(JSON.parse(String(init?.body)).params.model, model, `${name}: preserve selected model`)
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof fetch
  const params = { model, messages: [{ role: 'user' as const, content: 'Cache usage fixture' }], max_tokens: 32 }
  const stream = await provider.stream(params)
  const output = []
  for await (const event of stream) output.push(event)
  assert.deepEqual(output.findLast(event => event.type === 'message_delta')?.usage, expected, `${name}: stream usage`)
  assert.deepEqual((await stream.finalMessage()).usage, expected, `${name}: assembled usage`)
  assert.deepEqual((await provider.create(params)).usage, expected, `${name}: create usage`)
  assert.equal(output.filter(event => event.type === 'message_stop').length, 1)
  checks++
}

try {
  // All these model families share the Go transport and its usage decoder.
  for (const model of ['deepseek/deepseek-v4-flash-fast', 'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-pro', 'moonshotai/Kimi-K2.6', 'MiniMaxAI/MiniMax-M3',
    'Qwen/Qwen3.7-Plus', 'zai-org/GLM-5.1', 'gpt-6-luna', 'google/gemini-3.8-flash']) {
    await checkStream(model, [{ type: 'finish-step', usage: warmUsage },
      { type: 'finish', totalUsage: warmUsage }], expectedWarm, model)
  }

  await checkStream('DeepSeek native fields', [{ type: 'finish', usage: {
    prompt_tokens: 10_000, completion_tokens: 20,
    prompt_cache_hit_tokens: 9_000, prompt_cache_miss_tokens: 1_000,
  } }], expectedWarm)

  await checkStream('raw step cache survives normalized zeros in final totals', [
    { type: 'finish-step', usage: {
      inputTokens: 10_000, outputTokens: 20,
      inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0 },
      raw: { prompt_tokens: 10_000, prompt_cache_hit_tokens: 9_000 },
    } },
    { type: 'finish', totalUsage: { inputTokens: 10_000, outputTokens: 20,
      inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0 } } },
  ], expectedWarm)

  await checkStream('richer finish usage supplements totalUsage', [{ type: 'finish',
    totalUsage: { inputTokens: 10_000, outputTokens: 20 }, usage: warmUsage,
  }], expectedWarm)

  await checkStream('zero alias does not shadow positive cache count', [{ type: 'finish', usage: {
    inputTokens: 10_000, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 0 },
    cachedInputTokens: 9_000,
  } }], expectedWarm)

  await checkStream('OpenAI Responses details', [{ type: 'finish', usage: {
    input_tokens: 10_000, output_tokens: 20, input_tokens_details: { cached_tokens: 9_000 },
  } }], expectedWarm)

  await checkStream('Moonshot top-level cache', [{ type: 'finish', usage: {
    prompt_tokens: 10_000, completion_tokens: 20, cached_tokens: 9_000,
  } }], expectedWarm, 'moonshotai/Kimi-K2.6')

  await checkStream('GLM cache alias', [{ type: 'finish', usage: {
    prompt_tokens: 10_000, completion_tokens: 20, cache_hit_tokens: 9_000,
  } }], expectedWarm, 'zai-org/GLM-5.1')

  await checkStream('Gemini raw usage', [{ type: 'finish', usage: {
    raw: { promptTokenCount: 10_000, candidatesTokenCount: 15, thoughtsTokenCount: 5, cachedContentTokenCount: 9_000 },
  } }], expectedWarm, 'google/gemini-3.8-flash')

  await checkStream('SDK nested token totals', [{ type: 'finish', usage: {
    inputTokens: { total: 10_000, noCache: 1_000, cacheRead: 9_000 },
    outputTokens: { total: 20, text: 15, reasoning: 5 },
  } }], expectedWarm)

  await checkStream('native additive input with read and write', [{ type: 'finish', usage: {
    input_tokens: 1_000, output_tokens: 20, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 1_000,
  } }], { input_tokens: 1_000, output_tokens: 20, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 1_000 })

  await checkStream('canonical input includes reads and writes', [{ type: 'finish', totalUsage: {
    inputTokens: 10_000, outputTokens: 20,
    inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 8_000, cacheWriteTokens: 1_000 },
  } }], { input_tokens: 1_000, output_tokens: 20, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 1_000 })

  await checkStream('multiple steps counted once despite final aggregate', [
    { type: 'finish-step', usage: warmUsage }, { type: 'finish-step', usage: warmUsage },
    { type: 'finish', totalUsage: { inputTokens: 20_000, outputTokens: 40 } },
  ], { input_tokens: 2_000, output_tokens: 40, cache_read_input_tokens: 18_000 })

  await checkStream('final cache aggregate does not add to step cache', [
    { type: 'finish-step', usage: warmUsage }, { type: 'finish-step', usage: warmUsage },
    { type: 'finish', totalUsage: { inputTokens: 20_000, outputTokens: 40,
      inputTokenDetails: { noCacheTokens: 2_000, cacheReadTokens: 18_000 } } },
  ], { input_tokens: 2_000, output_tokens: 40, cache_read_input_tokens: 18_000 })

  await checkStream('EOF retains step usage', [{ type: 'finish-step', usage: warmUsage }], expectedWarm)
  await checkStream('empty finish retains step usage', [
    { type: 'finish-step', usage: warmUsage }, { type: 'finish' },
  ], expectedWarm)

  // Actual Flash Fast response shape: never infer cache hits from a repeated prompt.
  const cold = { inputTokens: 2417, outputTokens: 37,
    inputTokenDetails: { noCacheTokens: 2417, cacheReadTokens: 0 }, cachedInputTokens: 0,
    raw: { prompt_tokens: 2417, prompt_tokens_details: { cached_tokens: 0 } } }
  await checkStream('real upstream zero stays zero', [
    { type: 'finish-step', usage: cold }, { type: 'finish', totalUsage: cold },
  ], { input_tokens: 2417, output_tokens: 37 })

  await checkStream('absent cache stays absent', [{ type: 'finish', totalUsage: {
    inputTokens: 10_000, outputTokens: 20,
  } }], { input_tokens: 10_000, output_tokens: 20 })

  const accumulator = new CommandCodeUsageAccumulator()
  assert.deepEqual(accumulator.finish({ inputTokens: '10000', outputTokens: '20',
    inputTokenDetails: { cacheReadTokens: '', cacheWriteTokens: -1 },
    cachedInputTokens: '9000', cacheWriteTokens: Infinity,
  }), expectedWarm)
  checks++
  console.log(`Passed ${checks} Command Code cache checks (mocked Go streams, final messages and create calls).`)
} finally {
  globalThis.fetch = originalFetch
}
