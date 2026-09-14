/**
 * Cline gateway behavior: live catalog, prompt-cache markers, stream reading
 * and error text.
 *
 * Run: bun run src/lanes/cline/gateway.test.ts
 */

import {
  buildClineCatalogIndex,
  buildClinePassModels,
  catalogIsFreeViaApi,
  catalogSupportsPromptCache,
  clineModelDisplayName,
  findClineCatalogModel,
  isClineCatalogRetryDue,
  parseClineCatalog,
  parseClineRecommendedFeed,
} from './catalog.js'
import {
  applyClinePromptCache,
  isClinePromptCacheRejected,
  resolveClinePromptCacheShape,
  type ClineWireMessage,
} from './prompt_cache.js'
import {
  clineFailureFromPayload,
  clineUsageFromRaw,
  collectClineStream,
} from './stream.js'
import { describeClineError, describeEmptyClineResponse } from './errors.js'
import {
  getClinePassModelDisplayName,
  getClinePassModels,
  recordClinePassModelNames,
} from '../../utils/model/clinePassCatalog.js'
import type { OpenAIMessage } from '../../services/api/adapters/anthropic_to_openai.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
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

// Small reads split lines (and any multi-byte character) across chunks.
function textBody(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize))
      }
      controller.close()
    },
  })
}

function sse(...events: unknown[]): ReadableStream<Uint8Array> {
  return textBody(events
    .map(event => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`)
    .join(''))
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'gen-1',
    object: 'chat.completion.chunk',
    model: 'test/model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  }
}

function countMarkers(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countMarkers(item), 0)
  let count = 0
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'cache_control') count++
    else count += countMarkers(child)
  }
  return count
}

function streamedText(events: readonly unknown[]): string {
  return events
    .filter((event: any) => event.type === 'content_block_delta')
    .map((event: any) => event.delta?.text ?? '')
    .join('')
}

// Rows in the shape of https://api.cline.bot/api/v1/ai/cline/models.
const CATALOG = {
  data: [
    { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', created: 50, context_length: 1_000_000, pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005' }, supported_parameters: ['tools', 'reasoning'] },
    { id: 'qwen/qwen3.7-max', name: 'Qwen: Qwen3.7 Max', created: 40, context_length: 1_000_000, pricing: { prompt: '0.000001475', completion: '0.000004425', input_cache_read: '0.000000295' }, supported_parameters: ['tools'] },
    { id: 'qwen/qwen3.8-max-0902', name: 'Qwen: Qwen3.8 Max (0902)', created: 90, context_length: 1_000_000, pricing: { prompt: '0.000002', completion: '0.000006', input_cache_read: '0.00000025' }, supported_parameters: ['tools'] },
    { id: 'qwen/qwen3.6-plus', name: 'Qwen: Qwen3.6 Plus', created: 30, context_length: 1_000_000, pricing: { prompt: '0.000000325', completion: '0.00000195' }, supported_parameters: ['tools'] },
    { id: 'minimax/minimax-m3', name: 'MiniMax: MiniMax M3', created: 60, context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.00000006' }, supported_parameters: ['tools'] },
    { id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3', created: 70, context_length: 1_310_720, pricing: { prompt: '0.000001092', completion: '0.000003432', input_cache_read: '0.0000002028' }, supported_parameters: ['tools'] },
    { id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', created: 80, context_length: 1_310_720, pricing: { prompt: '0.000000075', completion: '0.00000025', input_cache_read: '0.000000015' }, supported_parameters: ['tools'] },
    { id: 'z-ai/glm-5.3-flash:batch', name: 'Z.ai: GLM 5.3 Flash (batch)', created: 80, context_length: 1_048_576, pricing: { prompt: '0.000000075', completion: '0.00000025' }, supported_parameters: ['tools'] },
    { id: '~z-ai/glm-latest', name: 'Z.ai: GLM Latest', created: 99, context_length: 1_310_720, pricing: { prompt: '0.000000936', completion: '0.000003168' }, supported_parameters: ['tools'] },
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek: DeepSeek V4 Pro 0423', created: 10, context_length: 1_048_576, pricing: { prompt: '0.0000016', completion: '0.0000032', input_cache_read: '0.000000135' }, supported_parameters: ['tools', 'reasoning'] },
    { id: 'poolside/laguna-s-2.1:free', name: 'Poolside: Laguna S 2.1 (free)', created: 20, context_length: 262_144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
  ],
}

// Buckets in the shape of https://api.cline.bot/api/v1/ai/cline/recommended-models.
const FEED = {
  recommended: [{ id: 'anthropic/claude-opus-5', name: 'claude-opus-5', tags: ['NEW'] }],
  free: [
    { id: 'cline-free/solar-pro4', name: 'Solar Pro 4', tags: [] },
    { id: 'z-ai/glm-5.3-flash', name: 'glm-5.3-flash', tags: [] },
  ],
  clinePass: [
    { id: 'cline-pass/qwen3.8-max', name: 'cline-pass/qwen3.8-max', tags: [] },
    { id: 'cline-pass/glm-5.3', name: 'cline-pass/glm-5.3', tags: [] },
    { id: 'cline-pass/minimax-m3', name: 'cline-pass/minimax-m3', tags: [] },
    { id: 'cline-pass/deepseek-v4-pro', name: 'cline-pass/deepseek-v4-pro', tags: [] },
    { id: 'cline-pass/brand-new-model', name: 'cline-pass/brand-new-model', tags: [] },
    { id: 'cline-pass/glm-5.3', name: 'duplicate row', tags: [] },
  ],
}

// The chat-completions history the lane builds from a Tau turn: the system
// prompt, two user turns, and a tool loop after each.
function conversation(): OpenAIMessage[] {
  return [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file a' },
    { role: 'assistant', content: 'done with a' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"b.ts"}' } }] },
    { role: 'tool', tool_call_id: 'call_2', content: 'file b' },
  ]
}

async function main(): Promise<void> {
  console.log('cline gateway:')

  const catalog = parseClineCatalog(CATALOG)
  const index = buildClineCatalogIndex(catalog)
  const feed = parseClineRecommendedFeed(FEED)

  await test('Cline Pass list is the live clinePass bucket, enriched from the catalog', () => {
    // Windows come only from the Cline Pass description (models.dev), never
    // from the upstream row.
    const models = buildClinePassModels(feed, index, id =>
      id === 'cline-pass/qwen3.8-max' ? { contextWindow: 1_000_000 } : undefined)
    const ids = models.map(model => model.id)
    assert(JSON.stringify(ids) === JSON.stringify([
      'cline-pass/qwen3.8-max',
      'cline-pass/glm-5.3',
      'cline-pass/minimax-m3',
      'cline-pass/deepseek-v4-pro',
      'cline-pass/brand-new-model',
    ]), `ids=${JSON.stringify(ids)}`)
    const byId = new Map(models.map(model => [model.id, model]))
    assert(byId.get('cline-pass/qwen3.8-max')?.name === 'Qwen3.8 Max',
      `qwen3.8 name=${byId.get('cline-pass/qwen3.8-max')?.name}`)
    assert(byId.get('cline-pass/qwen3.8-max')?.contextWindow === 1_000_000,
      'qwen3.8 context comes from its Cline Pass description')
    assert(byId.get('cline-pass/glm-5.3')?.name === 'GLM 5.3',
      `glm-5.3 borrowed a sibling: ${byId.get('cline-pass/glm-5.3')?.name}`)
    // Upstream z-ai/glm-5.3 lists 1,310,720; Cline Pass serves 1,000,000.
    assert(byId.get('cline-pass/glm-5.3')?.contextWindow === undefined,
      `glm-5.3 took the upstream window: ${byId.get('cline-pass/glm-5.3')?.contextWindow}`)
    assert(byId.get('cline-pass/deepseek-v4-pro')?.name === 'DeepSeek V4 Pro',
      `deepseek name=${byId.get('cline-pass/deepseek-v4-pro')?.name}`)
    const fresh = byId.get('cline-pass/brand-new-model')
    assert(fresh?.name === 'brand-new-model' && fresh.contextWindow === undefined,
      `unknown pass model=${JSON.stringify(fresh)}`)
    for (const model of models) {
      assert(model.provider === 'Cline Pass', `${model.id} provider=${model.provider}`)
      assert(model.tags?.includes('thinking') && model.tags.includes('pro'), `${model.id} tags=${model.tags}`)
    }
    assert(!ids.some(id => id.startsWith('cline-free/')), 'free-bucket models must not be offered in Tau')
  })

  await test('feed and catalog also parse from the success/data envelope', () => {
    const wrappedFeed = parseClineRecommendedFeed({ success: true, data: FEED })
    const wrappedCatalog = parseClineCatalog({ success: true, data: CATALOG })
    assert(wrappedFeed?.clinePass?.length === FEED.clinePass.length, 'wrapped feed lost clinePass')
    assert(wrappedCatalog.length === CATALOG.data.length, `wrapped catalog=${wrappedCatalog.length}`)
    assert(parseClineRecommendedFeed({ nope: true }) === null, 'an unrelated object is not a feed')
    assert(parseClineCatalog('not json').length === 0, 'garbage is an empty catalog')
  })

  await test('without the feed, Cline Pass falls back to the bundled list', () => {
    assert(buildClinePassModels(null, index).length === 0, 'no feed means no live list')
    const bundled = getClinePassModels()
    assert(bundled.length > 0, 'bundled list is empty')
    for (const model of bundled) {
      assert(model.id.startsWith('cline-pass/'), `bundled id=${model.id}`)
      assert(model.name && model.name !== model.id, `${model.id} has no display name`)
    }
  })

  await test('display names follow the live list, including effort variants', () => {
    recordClinePassModelNames([{ id: 'cline-pass/brand-new-model', name: 'Brand New' }])
    assert(getClinePassModelDisplayName('cline-pass/brand-new-model::cline-effort=high') === 'Brand New',
      'live name lost')
    assert(getClinePassModelDisplayName('cline-pass/kimi-k3') === 'Kimi K3', 'bundled name lost')
    assert(getClinePassModelDisplayName('cline-pass/not-a-model') === null, 'unknown ids have no name')
  })

  await test('catalog lookup never borrows a sibling or an alias row', () => {
    assert(findClineCatalogModel('cline-pass/glm-5.3', index)?.id === 'z-ai/glm-5.3', 'glm-5.3')
    assert(findClineCatalogModel('cline-pass/glm-5.3-flash', index)?.id === 'z-ai/glm-5.3-flash',
      'glm-5.3-flash matched its batch row')
    assert(findClineCatalogModel('cline-pass/qwen3.8-max', index)?.id === 'qwen/qwen3.8-max-0902',
      'dated snapshot not found')
    assert(findClineCatalogModel('cline-pass/glm-latest', index) === undefined, 'alias rows must not match')
    assert(findClineCatalogModel('ANTHROPIC/Claude-Opus-5', index)?.id === 'anthropic/claude-opus-5',
      'lookup is case-insensitive')
    assert(clineModelDisplayName('Qwen: Qwen3.5 Plus 2026-04-20') === 'Qwen3.5 Plus', 'dated name')
    assert(clineModelDisplayName('Claude Opus 5') === 'Claude Opus 5', 'plain name')
  })

  await test('free means free through the API, not the feed free bucket', () => {
    const byId = new Map(catalog.map(model => [model.id, model]))
    assert(catalogIsFreeViaApi(byId.get('poolside/laguna-s-2.1:free')!), 'zero-priced model is free')
    assert(!catalogIsFreeViaApi(byId.get('z-ai/glm-5.3-flash')!), 'glm-5.3-flash is billed through the API')
    assert(catalogSupportsPromptCache(byId.get('qwen/qwen3.7-max')!), 'qwen3.7-max prices cache reads')
    assert(!catalogSupportsPromptCache(byId.get('qwen/qwen3.6-plus')!), 'qwen3.6-plus does not cache')
  })

  await test('a catalog that fell short is retried after 30 s, then 1, 2 and 4 minutes, then every 5', () => {
    // The lane's pacing: CLINE_PARTIAL_CATALOG_TTL_MS, doubling up to CLINE_CATALOG_TTL_MS.
    const due = (count: number, elapsed: number) =>
      isClineCatalogRetryDue({ count, at: 1_000_000 }, 1_000_000 + elapsed, 30_000, 300_000)
    for (const [count, delay] of [
      [1, 30_000],
      [2, 60_000],
      [3, 120_000],
      [4, 240_000],
      [5, 300_000],
      [60, 300_000],
    ] as const) {
      assert(!due(count, delay - 1) && due(count, delay), `shortfall ${count} should retry after ${delay} ms`)
    }
    assert(isClineCatalogRetryDue({ count: 3, at: 2_000_000 }, 1_000_000, 30_000, 300_000),
      'a clock that moved backwards must not put the retry off')
  })

  await test('markers go only to explicit-cache families', () => {
    assert(resolveClinePromptCacheShape('anthropic/claude-opus-5', undefined) === 'anthropic',
      'claude needs no catalog')
    assert(resolveClinePromptCacheShape('cline-pass/qwen3.7-max', true) === 'content-part', 'cacheable qwen')
    assert(resolveClinePromptCacheShape('cline-pass/qwen3.7-max', undefined) === null,
      'qwen without a catalog answer stays unmarked')
    assert(resolveClinePromptCacheShape('qwen/qwen3.6-plus', false) === null, 'non-caching qwen')
    assert(resolveClinePromptCacheShape('minimax/minimax-m3', true) === 'content-part', 'cacheable minimax')
    for (const implicit of [
      'z-ai/glm-5.3',
      'moonshotai/kimi-k3',
      'deepseek/deepseek-v4-pro',
      'xiaomi/mimo-v2.5',
      'openai/gpt-6-astra',
      'google/gemini-3.8-flash',
    ]) {
      assert(resolveClinePromptCacheShape(implicit, true) === null,
        `${implicit} caches implicitly and gets no markers`)
    }
  })

  await test('Anthropic markers: system and last user message, never assistant or tool', () => {
    const input = conversation()
    const before = JSON.stringify(input)
    const out = applyClinePromptCache(input, 'anthropic')
    assert(JSON.stringify(input) === before, 'input was mutated')

    const system = out[0]!.content as Array<{ text: string; cache_control?: unknown }>
    assert(Array.isArray(system) && system.length === 1 && system[0]!.text === 'SYSTEM PROMPT',
      `system=${JSON.stringify(out[0])}`)
    assert(JSON.stringify(system[0]!.cache_control) === '{"type":"ephemeral"}', 'system marker')
    const lastUser = out[5] as ClineWireMessage
    assert(lastUser.content === 'second question'
      && JSON.stringify(lastUser.cache_control) === '{"type":"ephemeral"}',
    `last user=${JSON.stringify(lastUser)}`)
    assert(countMarkers(out[1]) === 0, 'older user turns stay unmarked')
    for (const message of out.filter(message => message.role === 'assistant' || message.role === 'tool')) {
      assert(countMarkers(message) === 0, `${message.role} message was marked`)
    }
    // Plus the request-level marker: three, under Anthropic's limit of four.
    assert(countMarkers(out) === 2, `markers=${countMarkers(out)}`)
    assert(JSON.stringify(applyClinePromptCache(conversation(), 'anthropic')) === JSON.stringify(out),
      'marking is not deterministic')
  })

  await test('Qwen/MiniMax markers sit on a text part, system untouched', () => {
    const out = applyClinePromptCache(conversation(), 'content-part')
    assert(out[0]!.content === 'SYSTEM PROMPT', 'system must stay a plain string')
    const lastUser = out[5] as ClineWireMessage
    assert(lastUser.cache_control === undefined, 'no message-level marker for part-keyed caches')
    assert(JSON.stringify(lastUser.content) === JSON.stringify([
      { type: 'text', text: 'second question', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: ' ' },
    ]), `last user=${JSON.stringify(lastUser.content)}`)
    assert(countMarkers(out) === 1, `markers=${countMarkers(out)}`)

    const withImage = applyClinePromptCache([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ], 'content-part')
    const parts = withImage[0]!.content as unknown as Array<Record<string, unknown>>
    assert(parts.length === 3 && parts[0]!.cache_control && parts[2]!.text === ' ',
      `image turn=${JSON.stringify(parts)}`)
  })

  await test('implicit caches get the conversation unchanged', () => {
    const input = conversation()
    const out = applyClinePromptCache(input, null)
    assert(JSON.stringify(out) === JSON.stringify(input), 'unmarked request changed')
    assert(countMarkers(out) === 0, 'markers leaked')
  })

  await test('a refusal that names cache_control is recognized, nothing else is', () => {
    assert(isClinePromptCacheRejected(400,
      '{"error":{"message":"messages.1.cache_control: Extra inputs are not permitted"}}'), '400 cache_control')
    assert(!isClinePromptCacheRejected(403, 'only available via Cline product surfaces'),
      'a 403 is not a marker refusal')
    assert(!isClinePromptCacheRejected(400, 'invalid tool schema'), 'a schema error is not a marker refusal')
  })

  await test('usage that arrives after finish_reason is kept, with cache reads and writes', async () => {
    const collected = await collectClineStream(sse(
      chunk({ role: 'assistant' }),
      chunk({ content: 'Hi ' }),
      chunk({ content: 'there' }),
      chunk({}, 'stop'),
      {
        id: 'gen-1',
        object: 'chat.completion.chunk',
        model: 'test/model',
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 600 },
          cache_creation_input_tokens: 300,
        },
      },
      'data: [DONE]\n\n',
    ))
    assert(collected.failure === null, `failure=${JSON.stringify(collected.failure)}`)
    const usage = collected.usage
    assert(usage.input_tokens === 100 && usage.cache_read_tokens === 600
      && usage.cache_write_tokens === 300 && usage.output_tokens === 5,
    `usage=${JSON.stringify(usage)}`)
    const delta = collected.events.find(event => event.type === 'message_delta') as any
    assert(delta?.usage?.input_tokens === 100, `delta input=${delta?.usage?.input_tokens}`)
    assert(delta?.usage?.cache_read_input_tokens === 600,
      `delta cache read=${delta?.usage?.cache_read_input_tokens}`)
    assert(delta?.usage?.cache_creation_input_tokens === 300,
      `delta cache write=${delta?.usage?.cache_creation_input_tokens}`)
    assert(streamedText(collected.events) === 'Hi there', `text=${streamedText(collected.events)}`)
  })

  await test('the usage shape Cline recorded for its own gateway reads right', async () => {
    // From sdk/packages/llms/src/tests/provider-vcr/cline-anthropic-sonnet.json.
    const collected = await collectClineStream(sse(
      chunk({ role: 'assistant' }),
      chunk({ content: 'OK' }),
      chunk({}, 'stop', {
        usage: {
          prompt_tokens: 22,
          completion_tokens: 4,
          total_tokens: 26,
          cost: 0,
          is_byok: true,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0, video_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0 },
          cache_creation_input_tokens: 0,
        },
      }),
      'data: [DONE]\n\n',
    ))
    assert(collected.failure === null, 'recorded response failed')
    assert(collected.usage.input_tokens === 22 && collected.usage.output_tokens === 4,
      `usage=${JSON.stringify(collected.usage)}`)
  })

  await test('a finish_reason repeated on the usage chunk ends the response once', async () => {
    // Each extra message_delta made claude.ts add the whole usage to the
    // session again, and each repeated tool stop re-emitted its tool call.
    const usage = { prompt_tokens: 26_460, completion_tokens: 59, prompt_tokens_details: { cached_tokens: 20_000 } }
    const repeatFinish = (reason: string) => ({
      id: 'gen-1',
      object: 'chat.completion.chunk',
      model: 'test/model',
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
      usage,
    })
    const read = (index: number, id: string, file: string) => chunk({
      tool_calls: [{ index, id, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: file }) } }],
    })
    const text = await collectClineStream(sse(
      chunk({ role: 'assistant' }), chunk({ content: 'Hi' }), chunk({}, 'stop'), repeatFinish('stop'), 'data: [DONE]\n\n'))
    const tools = await collectClineStream(sse(
      chunk({ role: 'assistant' }), chunk({ content: 'Reading both.' }), read(0, 'c1', 'a.ts'), read(1, 'c2', 'b.ts'),
      chunk({}, 'tool_calls'), repeatFinish('tool_calls'), 'data: [DONE]\n\n'))

    for (const [name, collected, stopReason] of [['text', text, 'end_turn'], ['tools', tools, 'tool_use']] as const) {
      const deltas = collected.events.filter(event => event.type === 'message_delta')
      assert(deltas.length === 1, `${name}: message_delta x${deltas.length}`)
      assert(deltas[0]!.delta?.stop_reason === stopReason, `${name}: stop_reason=${deltas[0]!.delta?.stop_reason}`)
      assert(deltas[0]!.usage?.input_tokens === 6_460 && deltas[0]!.usage.output_tokens === 59
        && deltas[0]!.usage.cache_read_input_tokens === 20_000,
      `${name}: usage=${JSON.stringify(deltas[0]!.usage)}`)
      assert(collected.events.filter(event => event.type === 'message_stop').length === 1,
        `${name}: more than one message_stop`)
      assert(collected.events.at(-1)?.type === 'message_stop', `${name}: the stream must end with message_stop`)
      const stops = collected.events.filter(event => event.type === 'content_block_stop').map(event => event.index)
      assert(new Set(stops).size === stops.length, `${name}: a block was stopped twice: ${stops.join(',')}`)
    }
    assert(streamedText(text.events) === 'Hi', 'the answer text changed')
    assert(tools.events.filter(event => event.content_block?.type === 'tool_use').length === 2,
      'both tool calls must survive')
  })

  await test('an error inside a 200 stream is reported instead of an empty turn', async () => {
    const surface = await collectClineStream(sse(
      { error: { code: 'API_REQUEST_ERROR_CODE', message: 'Error 403: z-ai/glm-5.3-flash is only available via Cline product surfaces.' } },
      'data: [DONE]\n\n',
    ))
    assert(surface.failure?.kind === 'stream' && surface.failure.status === 403,
      `failure=${JSON.stringify(surface.failure)}`)
    assert(surface.events.length === 0, 'no events for a failed stream')

    const midStream = await collectClineStream(sse(
      chunk({ content: 'partial answer' }),
      chunk({ content: '' }, 'error', { error: { code: 502, message: 'Upstream error' } }),
    ))
    assert(midStream.failure?.status === 502, `mid-stream failure=${JSON.stringify(midStream.failure)}`)
    assert(midStream.events.length === 0, 'partial output of a failed stream is dropped')

    const namedEvent = await collectClineStream(textBody('event: error\ndata: {"message":"overloaded"}\n\n'))
    assert(namedEvent.failure?.message === 'overloaded',
      `event:error failure=${JSON.stringify(namedEvent.failure)}`)
  })

  await test('a late error after a clean finish does not discard the answer', async () => {
    const collected = await collectClineStream(sse(
      chunk({ content: 'complete answer' }),
      chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      { error: { message: 'late accounting error' } },
    ))
    assert(collected.failure === null, `failure=${JSON.stringify(collected.failure)}`)
    assert(streamedText(collected.events) === 'complete answer', 'answer was dropped')
  })

  await test('a JSON body where SSE was expected is read, not dropped', async () => {
    const error = await collectClineStream(textBody('{"error":{"message":"Error 401: token expired"}}'))
    assert(error.failure?.status === 401, `json error=${JSON.stringify(error.failure)}`)

    const completion = await collectClineStream(textBody(JSON.stringify({
      id: 'cmpl-1',
      model: 'test/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 1 },
    })))
    assert(completion.failure === null, `completion failure=${JSON.stringify(completion.failure)}`)
    assert(streamedText(completion.events) === 'Hello' && completion.usage.input_tokens === 12,
      `completion=${streamedText(completion.events)} usage=${JSON.stringify(completion.usage)}`)
  })

  await test('an empty stream becomes a visible failure', async () => {
    for (const body of ['data: [DONE]\n\n', '', ': keep-alive\n\n']) {
      const collected = await collectClineStream(textBody(body))
      assert(collected.failure?.kind === 'empty',
        `body ${JSON.stringify(body)} gave ${JSON.stringify(collected.failure)}`)
    }
    const emptyAnswer = await collectClineStream(sse(chunk({ content: '' }, 'stop')))
    assert(emptyAnswer.failure?.kind === 'empty', 'a reply with no content is reported')
  })

  await test('usage math holds when writes are reported outside prompt_tokens', () => {
    const usage = clineUsageFromRaw({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 80 },
      cache_creation_input_tokens: 50,
    })
    assert(usage.input_tokens === 20 && usage.cache_read_tokens === 80 && usage.cache_write_tokens === 50,
      `usage=${JSON.stringify(usage)}`)
    assert(clineUsageFromRaw(null).input_tokens === 0, 'no usage is zero usage')
    assert(clineFailureFromPayload({ id: 'x', choices: [], error: null }) === null, 'error:null is not a failure')
  })

  await test('the free-model refusal is explained and the raw body kept', () => {
    const body = '{"error":{"code":"API_REQUEST_ERROR_CODE","message":"Error 403: cline-free/solar-pro4 is only available via Cline product surfaces. If you are using an old version of Cline, please update to the latest version"}}'
    const text = describeClineError({ status: 403, body, model: 'cline-free/solar-pro4' })
    assert(text.includes('Cline IDE extension and CLI'), `hint missing: ${text}`)
    assert(text.includes(`cline API error 403: ${body}`), 'raw body missing')
  })

  await test('context overflow keeps the prefix reactive compaction looks for', () => {
    assert(describeClineError({ status: 400, body: 'context_length_exceeded', model: 'm' })
      .startsWith('Prompt is too long (cline 400)'), 'http overflow')
    assert(describeClineError({ body: 'maximum context length is 40960 tokens', model: 'm' })
      .startsWith('Prompt is too long (cline)'), 'stream overflow')
  })

  await test("Cline Pass limits use Cline's own sentence", () => {
    const body = 'Error 429: You have reached your ClinePass limit for this period. Please try again later.'
    const text = describeClineError({ status: 429, body, model: 'cline-pass/glm-5.3' })
    assert(text.startsWith('You have reached your ClinePass limit for this period. Please try again later.'), text)
  })

  await test('an empty reply names the model', () => {
    const text = describeEmptyClineResponse('z-ai/glm-5.3-flash', '')
    assert(text.includes('z-ai/glm-5.3-flash') && !text.includes('Response body'), text)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
