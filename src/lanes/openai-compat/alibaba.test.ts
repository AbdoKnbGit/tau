/**
 * Alibaba Model Studio — catalogue derivation, per-model thinking ladder,
 * request shaping, and region resolution.
 *
 * The assertions pin the one thing that can turn every request into a 400:
 * Model Studio rejects a thinking parameter a model does not accept, and which
 * parameters a model accepts is per-model. So the ladder must come out of the
 * catalogue and nothing may be sent for a model the catalogue has not
 * described.
 *
 * Run: bun run src/lanes/openai-compat/alibaba.test.ts
 *  or: npx esbuild src/lanes/openai-compat/alibaba.test.ts --bundle
 *      --platform=node --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the effort store at a scratch file BEFORE the store module loads it,
// and opt out of models.dev so nothing here can reach the network — every
// test installs its own catalogue fixture instead.
process.env.TAU_ALIBABA_THINKING_STORE = join(
  mkdtempSync(join(tmpdir(), 'alibaba-thinking-')),
  'store.json',
)
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'

import { OpenAICompatLane } from './loop.js'
import type { NormalizedUsage } from '../types.js'
import { alibabaTransformer } from './transformers/alibaba.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'
import {
  _resetAlibabaCatalogForTests,
  alibabaCatalogProviderId,
  alibabaMaxOutputTokens,
  alibabaModelCatalog,
  deriveAlibabaRows,
  getAlibabaModelMeta,
  listAlibabaModelMeta,
  normalizeAlibabaModelId,
  recordAlibabaLiveModels,
  type CacheFile,
} from '../../utils/model/alibabaCatalog.js'
import {
  _resetAlibabaThinkingForTests,
  alibabaEffortLevelsFor,
  alibabaReasoningContentReplayRequired,
  cycleAlibabaEffort,
  getAlibabaEffort,
  getAlibabaEffortLabel,
  resolveAlibabaThinkingFields,
  setAlibabaEffort,
  supportsAlibabaEffortSelection,
} from '../../utils/model/alibabaThinking.js'

let passed = 0
let failed = 0

/**
 * A models.dev `alibaba` block covering all four reasoning shapes the real
 * document contains: toggle + effort, toggle only, effort only, and none.
 * Plus a non-chat row, which must never reach the picker.
 */
const MODELS_DEV_FIXTURE = {
  models: {
    'qwen3.8-max': {
      id: 'qwen3.8-max',
      name: 'Qwen3.8 Max',
      reasoning: true,
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'medium', 'xhigh'] },
        { type: 'budget_tokens', min: 0, max: 262144 },
      ],
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1_000_000, output: 131_072 },
      last_updated: '2026-08-03',
    },
    'qwen3.7-max': {
      id: 'qwen3.7-max',
      name: 'Qwen3.7 Max',
      reasoning: true,
      reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }],
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1_000_000, output: 65_536 },
      last_updated: '2026-05-21',
    },
    'glm-5.2': {
      id: 'glm-5.2',
      name: 'GLM 5.2',
      reasoning: true,
      reasoning_options: [
        { type: 'effort', values: ['none', 'minimal', 'low', 'high', 'max'] },
      ],
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 200_000, output: 65_536 },
      last_updated: '2026-06-13',
    },
    'qwen3-coder-plus': {
      id: 'qwen3-coder-plus',
      name: 'Qwen3 Coder Plus',
      reasoning: false,
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1_048_576, output: 65_536 },
      last_updated: '2025-07-23',
    },
    'qwen2-5-72b-instruct': {
      id: 'qwen2-5-72b-instruct',
      name: 'Qwen2.5 72B Instruct',
      reasoning: false,
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 131_072, output: 8_192 },
      last_updated: '2024-09',
    },
    'qwen3-omni-flash-realtime': {
      id: 'qwen3-omni-flash-realtime',
      name: 'Qwen3 Omni Flash Realtime',
      reasoning: false,
      tool_call: true,
      modalities: { input: ['audio'], output: ['audio'] },
      limit: { context: 32_768, output: 4_096 },
      last_updated: '2025-09-15',
    },
  },
}

function fixtureCache(): CacheFile {
  return {
    version: 1,
    fetchedAt: Date.now(),
    regions: { alibaba: deriveAlibabaRows(MODELS_DEV_FIXTURE) },
  }
}

function test(name: string, fn: () => void): void {
  try {
    _resetAlibabaCatalogForTests(fixtureCache())
    _resetAlibabaThinkingForTests()
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function eq(actual: unknown, expected: unknown, hint: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${hint}: got ${a}, want ${b}`)
}

function shape(
  model: string,
  ctx: Partial<Parameters<typeof alibabaTransformer.transformRequest>[1]> = {},
): Record<string, unknown> {
  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 900_000,
    temperature: 0.7,
    thinking: { type: 'enabled' },
    store: true,
    prompt_cache_key: 'session-1',
    transforms: ['middle-out'],
  } as unknown as OpenAIChatRequest
  return alibabaTransformer.transformRequest(body, {
    model,
    isReasoning: false,
    reasoningEffort: null,
    ...ctx,
  }) as unknown as Record<string, unknown>
}

console.log('Alibaba catalogue derivation:')

test('reads context window, output cap and tools off models.dev', () => {
  const meta = getAlibabaModelMeta('qwen3.8-max')
  eq(meta?.contextWindow, 1_000_000, 'context')
  eq(meta?.maxOutputTokens, 131_072, 'output cap')
  eq(meta?.tools, true, 'tool calling')
  eq(meta?.vision, true, 'image input')
})

test('drops the Realtime rows even though they claim text', () => {
  // models.dev lists qwen3-omni-flash-realtime with text in and text out, but
  // it is served by the websocket Realtime API — this lane can never call it.
  const rows = deriveAlibabaRows({
    models: {
      'qwen3-omni-flash-realtime': {
        id: 'qwen3-omni-flash-realtime',
        reasoning: false,
        modalities: { input: ['text', 'audio'], output: ['text', 'audio'] },
        limit: { context: 32_768, output: 4_096 },
      },
    },
  })
  eq(Object.keys(rows), [], 'realtime row dropped')
})

test('drops rows that cannot take or return text', () => {
  const ids = alibabaModelCatalog().map(m => m.id)
  assert(
    !ids.includes('qwen3-omni-flash-realtime'),
    'audio-only row must not reach the picker',
  )
})

test('matches a dotted DashScope id onto a dashed models.dev id', () => {
  // models.dev spells this one `qwen2-5-72b-instruct`; DashScope serves it as
  // `qwen2.5-72b-instruct`. Without the normalisation the row would look
  // undescribed and lose its real context window.
  eq(normalizeAlibabaModelId('qwen2.5-72b-instruct'), 'qwen2-5-72b-instruct', 'key')
  eq(getAlibabaModelMeta('qwen2.5-72b-instruct')?.contextWindow, 131_072, 'context')
})

test('orders described rows newest first', () => {
  const ids = alibabaModelCatalog().map(m => m.id)
  eq(ids[0], 'qwen3.8-max', 'newest described row leads')
})

console.log('\nAlibaba live /models reconciliation:')

test('narrows the catalogue to the ids this key may call', () => {
  recordAlibabaLiveModels(['qwen3.8-max', 'qwen3-coder-plus'])
  const ids = alibabaModelCatalog().map(m => m.id)
  eq(ids.sort(), ['qwen3-coder-plus', 'qwen3.8-max'], 'only the served ids')
})

test('keeps a model models.dev has never described', () => {
  // Alibaba ships models faster than the catalogue records them; a new row
  // must be usable the day it lands rather than hidden until a refresh.
  recordAlibabaLiveModels(['qwen3.8-max', 'qwen4-plus'])
  const ids = alibabaModelCatalog().map(m => m.id)
  assert(ids.includes('qwen4-plus'), 'unknown chat id kept')
  const meta = listAlibabaModelMeta().find(m => m.id === 'qwen4-plus')
  eq(meta?.described, false, 'flagged undescribed')
  eq(meta?.reasoning, false, 'claims no reasoning it cannot verify')
})

test('still drops an undescribed non-chat id', () => {
  recordAlibabaLiveModels([
    'qwen3.8-max',
    'text-embedding-v4',
    'qwen-tts-realtime',
    'wanx2.1-t2i-turbo',
  ])
  const ids = alibabaModelCatalog().map(m => m.id)
  eq(ids, ['qwen3.8-max'], 'speech / embedding / image rows filtered')
})

console.log('\nAlibaba thinking ladder (per model, from the catalogue):')

test('a toggle + effort row cycles Default / Off / its own values', () => {
  eq(
    alibabaEffortLevelsFor('qwen3.8-max'),
    ['default', 'off', 'low', 'medium', 'xhigh'],
    'qwen3.8-max ladder',
  )
})

test('a toggle-only row cycles Default / Off / On', () => {
  eq(
    alibabaEffortLevelsFor('qwen3.7-max'),
    ['default', 'off', 'on'],
    'qwen3.7-max ladder',
  )
})

test('an effort-only row uses its own none stop instead of an Off stop', () => {
  eq(
    alibabaEffortLevelsFor('glm-5.2'),
    ['default', 'none', 'minimal', 'low', 'high', 'max'],
    'glm-5.2 ladder',
  )
})

test('a non-reasoning row shows no chip', () => {
  eq(alibabaEffortLevelsFor('qwen3-coder-plus'), ['default'], 'single stop')
  assert(!supportsAlibabaEffortSelection('qwen3-coder-plus'), 'no chip')
})

test('an undescribed row shows no chip', () => {
  recordAlibabaLiveModels(['qwen4-plus'])
  assert(!supportsAlibabaEffortSelection('qwen4-plus'), 'no chip for unknown id')
})

test('every row starts on Default', () => {
  for (const id of ['qwen3.8-max', 'qwen3.7-max', 'glm-5.2']) {
    eq(getAlibabaEffort(id), 'default', `${id} starts on default`)
  }
})

test('cycling wraps in both directions', () => {
  eq(cycleAlibabaEffort('qwen3.7-max', 'right'), 'off', 'default -> off')
  eq(cycleAlibabaEffort('qwen3.7-max', 'right'), 'on', 'off -> on')
  eq(cycleAlibabaEffort('qwen3.7-max', 'right'), 'default', 'on wraps to default')
  eq(cycleAlibabaEffort('qwen3.7-max', 'left'), 'on', 'default wraps back to on')
})

test('the pick is per model, not global', () => {
  setAlibabaEffort('qwen3.8-max', 'xhigh')
  eq(getAlibabaEffort('qwen3.8-max'), 'xhigh', 'max row is xhigh')
  eq(getAlibabaEffort('qwen3.7-max'), 'default', 'the other row untouched')
})

test('a stored stop that is no longer on the ladder is ignored', () => {
  // The ladder moves when models.dev re-publishes a row. A stale value must
  // not keep riding along — that is exactly the 400 this guards.
  _resetAlibabaThinkingForTests({ 'qwen3.7-max': 'xhigh' })
  eq(getAlibabaEffort('qwen3.7-max'), 'default', 'stale xhigh dropped')
})

test('labels read the way the vendor spells them', () => {
  eq(getAlibabaEffortLabel('xhigh'), 'xHigh', 'xhigh label')
  eq(getAlibabaEffortLabel('medium'), 'Medium', 'medium label')
})

console.log('\nAlibaba wire fields:')

test('Default with no preference at all sends no thinking field', () => {
  // No chip pick and no session budget: leave Model Studio's own per-model
  // default alone rather than asserting one.
  eq(resolveAlibabaThinkingFields('qwen3.8-max'), {}, 'nothing sent')
})

test('no request ever carries thinking_budget', () => {
  // Model Studio documents thinking_budget as mutually exclusive with
  // reasoning_effort, and the ladder speaks in efforts.
  setAlibabaEffort('qwen3.8-max', 'xhigh')
  assert(!('thinking_budget' in shape('qwen3.8-max')), 'no thinking_budget')
})

test('Off sends only the toggle', () => {
  setAlibabaEffort('qwen3.8-max', 'off')
  eq(resolveAlibabaThinkingFields('qwen3.8-max'), { enable_thinking: false }, 'off')
})

test('On sends only the toggle for a row with no effort ladder', () => {
  setAlibabaEffort('qwen3.7-max', 'on')
  eq(resolveAlibabaThinkingFields('qwen3.7-max'), { enable_thinking: true }, 'on')
})

test('an effort pick sends the toggle and the value together', () => {
  setAlibabaEffort('qwen3.8-max', 'xhigh')
  const body = shape('qwen3.8-max')
  eq(body.enable_thinking, true, 'toggle on')
  eq(body.reasoning_effort, 'xhigh', 'published value')
})

test('never sends reasoning_effort to a row that publishes no values', () => {
  setAlibabaEffort('qwen3.7-max', 'on')
  const body = shape('qwen3.7-max')
  eq(body.enable_thinking, true, 'toggle on')
  assert(!('reasoning_effort' in body), 'no effort field on a toggle-only row')
})

test('never sends enable_thinking to a row that publishes no toggle', () => {
  setAlibabaEffort('glm-5.2', 'high')
  const body = shape('glm-5.2')
  eq(body.reasoning_effort, 'high', 'published value')
  assert(!('enable_thinking' in body), 'no toggle on an effort-only row')
})

test('the vendor none stop turns thinking off through the field it owns', () => {
  setAlibabaEffort('glm-5.2', 'none')
  eq(resolveAlibabaThinkingFields('glm-5.2'), { reasoning_effort: 'none' }, 'effort-only')
})

test('sends nothing for a model the catalogue has not described', () => {
  // The 400 this whole module exists to prevent.
  recordAlibabaLiveModels(['qwen4-plus'])
  const body = shape('qwen4-plus', { isReasoning: true, reasoningEffort: 'high' })
  assert(!('enable_thinking' in body), 'no enable_thinking')
  assert(!('reasoning_effort' in body), 'no reasoning_effort')
})

test('sends nothing for a row that does not reason', () => {
  const body = shape('qwen3-coder-plus', { isReasoning: true, reasoningEffort: 'high' })
  assert(!('enable_thinking' in body), 'no enable_thinking')
  assert(!('reasoning_effort' in body), 'no reasoning_effort')
})

console.log('\nAlibaba thinking-budget fallback:')

test('the session budget drives a Default row', () => {
  const body = shape('qwen3.8-max', { isReasoning: true, reasoningEffort: 'low' })
  eq(body.enable_thinking, true, 'toggle follows the budget')
  eq(body.reasoning_effort, 'low', 'effort follows the budget')
})

test('the session budget can turn a Default row off', () => {
  const body = shape('qwen3.8-max', { isReasoning: false, reasoningEffort: null })
  eq(body.enable_thinking, false, 'toggle off')
  assert(!('reasoning_effort' in body), 'no effort while off')
})

test('a budget effort the row does not publish is dropped, not forwarded', () => {
  // `high` is not on qwen3.8-max's published ladder (low / medium / xhigh).
  const body = shape('qwen3.8-max', { isReasoning: true, reasoningEffort: 'high' })
  eq(body.enable_thinking, true, 'toggle still rides')
  assert(!('reasoning_effort' in body), 'unpublished value not sent')
})

test('an explicit pick outranks the session budget', () => {
  setAlibabaEffort('qwen3.8-max', 'off')
  const body = shape('qwen3.8-max', { isReasoning: true, reasoningEffort: 'medium' })
  eq(body.enable_thinking, false, 'the chip wins')
  assert(!('reasoning_effort' in body), 'no effort while off')
})

console.log('\nAlibaba request shaping:')

test('clamps max_tokens to the row own output cap', () => {
  eq(shape('qwen3.8-max').max_tokens, 131_072, 'qwen3.8-max cap')
  eq(shape('qwen3-coder-plus').max_tokens, 65_536, 'coder cap')
  eq(alibabaMaxOutputTokens('glm-5.2'), 65_536, 'glm cap')
})

test('strips fields the compatible-mode route does not read', () => {
  const body = shape('qwen3.8-max')
  for (const field of ['thinking', 'store', 'prompt_cache_key', 'transforms']) {
    assert(!(field in body), `${field} stripped`)
  }
})

test('leaves the prompt cache to the implicit one', () => {
  // Model Studio caches automatically on the exact prefix; Anthropic-style
  // markers are documented against a protocol this lane does not speak, so
  // shipping one would risk a 400 to save nothing.
  eq(alibabaTransformer.cacheControlMode('qwen3.8-max'), 'none', 'strip markers')
})

test('prefers the live catalogue over the offline seed', () => {
  eq(alibabaTransformer.preferLiveModelCatalog?.(), true, 'live first')
})

test('points at the international endpoint by default', () => {
  eq(
    alibabaTransformer.defaultBaseUrl,
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'default base URL',
  )
})

console.log('\nAlibaba reasoning-content replay contract:')

test('requires the carry-back while thinking is on', () => {
  assert(alibabaReasoningContentReplayRequired('qwen3.8-max'), 'default counts as on')
  setAlibabaEffort('qwen3.8-max', 'xhigh')
  assert(alibabaReasoningContentReplayRequired('qwen3.8-max'), 'explicit effort')
})

test('drops the carry-back once thinking is off', () => {
  setAlibabaEffort('qwen3.8-max', 'off')
  assert(!alibabaReasoningContentReplayRequired('qwen3.8-max'), 'off needs no replay')
  setAlibabaEffort('glm-5.2', 'none')
  assert(!alibabaReasoningContentReplayRequired('glm-5.2'), 'none needs no replay')
})

test('never claims the contract for a non-reasoning or unknown row', () => {
  assert(!alibabaReasoningContentReplayRequired('qwen3-coder-plus'), 'coder row')
  assert(!alibabaReasoningContentReplayRequired('qwen4-plus'), 'unknown row')
})

console.log('\nAlibaba region resolution:')

test('maps each endpoint onto the price table that bills it', () => {
  eq(
    alibabaCatalogProviderId('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
    'alibaba',
    'international',
  )
  eq(
    alibabaCatalogProviderId('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'alibaba-cn',
    'Beijing',
  )
  eq(
    alibabaCatalogProviderId('https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),
    'alibaba-cn',
    'Beijing workspace host',
  )
  eq(
    alibabaCatalogProviderId('https://ws-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'),
    'alibaba',
    'Singapore workspace host',
  )
})

test('an unrecognised host bills at the dearer international rate', () => {
  // Overstating spend is recoverable; understating it is what surprises people.
  eq(alibabaCatalogProviderId('https://example.invalid/v1'), 'alibaba', 'unknown host')
  eq(alibabaCatalogProviderId('not a url'), 'alibaba', 'unparseable')
})

console.log('\nAlibaba lane wire contract:')

async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    _resetAlibabaCatalogForTests(fixtureCache())
    _resetAlibabaThinkingForTests()
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

type CapturedRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

/**
 * Drive one turn through the real lane against a stubbed endpoint, so the
 * assertions below cover what actually leaves the process rather than what the
 * transformer returns in isolation.
 */
async function captureAlibabaTurn(
  model = 'qwen3.8-max',
  baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
): Promise<{ request: CapturedRequest; usage: NormalizedUsage }> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('alibaba', 'sk-dashscope-test', baseUrl)

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null
  globalThis.fetch = (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse =
      [
        {
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          // Model Studio reports an implicit-cache hit exactly here.
          usage: {
            prompt_tokens: 1_200,
            completion_tokens: 8,
            total_tokens: 1_208,
            prompt_tokens_details: { cached_tokens: 1_024 },
          },
        },
      ]
        .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const stream = lane.streamAsProvider({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello',
              cache_control: { type: 'ephemeral' },
            } as never,
          ],
        },
      ],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 4_096,
      signal: new AbortController().signal,
      providerHint: 'alibaba',
    })
    let step = await stream.next()
    while (!step.done) step = await stream.next()
    assert(request !== null, 'fetch was not called')
    return { request: request!, usage: step.value }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('alibaba')
  }
}

await atest('posts to the configured compatible-mode endpoint', async () => {
  const { request } = await captureAlibabaTurn()
  eq(
    request.url,
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    'endpoint',
  )
})

await atest('authenticates with a Bearer token', async () => {
  const { request } = await captureAlibabaTurn()
  eq(request.headers.Authorization, 'Bearer sk-dashscope-test', 'auth header')
})

await atest('puts the thinking fields at the top level of the body', async () => {
  // The Python SDK wraps these in extra_body; on the wire they are top-level,
  // and this lane writes the JSON itself.
  setAlibabaEffort('qwen3.8-max', 'medium')
  const { request } = await captureAlibabaTurn()
  eq(request.body.enable_thinking, true, 'enable_thinking')
  eq(request.body.reasoning_effort, 'medium', 'reasoning_effort')
  assert(!('extra_body' in request.body), 'no extra_body wrapper')
})

await atest('strips Anthropic cache_control markers from messages', async () => {
  // Model Studio caches implicitly; the markers are documented against a
  // protocol this lane does not speak, so shipping one risks a 400 for
  // nothing the implicit cache is not already doing.
  const { request } = await captureAlibabaTurn()
  const serialized = JSON.stringify(request.body.messages)
  assert(!serialized.includes('cache_control'), 'no cache_control on the wire')
})

await atest('reads an implicit cache hit back as cached input', async () => {
  const { usage } = await captureAlibabaTurn()
  eq(usage.cache_read_tokens, 1_024, 'cached prompt tokens')
  eq(usage.cache_write_tokens, 0, 'implicit cache writes cost nothing')
  eq(usage.output_tokens, 8, 'output tokens')
})

await atest('follows DASHSCOPE_BASE_URL to the Beijing endpoint', async () => {
  const { request } = await captureAlibabaTurn(
    'qwen3.8-max',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
  )
  eq(
    request.url,
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'Beijing endpoint',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
