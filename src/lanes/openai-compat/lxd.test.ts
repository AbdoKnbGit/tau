/**
 * LXD API provider — catalog, per-model effort ladders, and request shaping.
 *
 * Run: bun run src/lanes/openai-compat/lxd.test.ts
 *  or: npx esbuild src/lanes/openai-compat/lxd.test.ts --bundle --platform=node
 *      --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the effort store at a scratch file BEFORE the store module loads it.
process.env.TAU_LXD_THINKING_STORE = join(
  mkdtempSync(join(tmpdir(), 'lxd-thinking-')),
  'store.json',
)

import { lxdTransformer } from './transformers/lxd.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'
import {
  filterLxdModelCatalog,
  getLxdModelMeta,
  isLxdChatRow,
  listLxdModelMeta,
  lxdMaxOutputTokens,
  recordLxdCatalog,
  type LxdCatalogRow,
} from '../../utils/model/lxdCatalog.js'
import {
  _resetLxdThinkingForTests,
  cycleLxdEffort,
  getLxdEffort,
  lxdEffortLevelsFor,
  lxdReasoningContentReplayRequired,
  resolveLxdRequestEffort,
  setLxdEffort,
  supportsLxdEffortSelection,
} from '../../utils/model/lxdThinking.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    _resetLxdThinkingForTests()
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

/** Build a request the way the lane does, then run it through the transformer. */
function shape(
  model: string,
  ctx: Partial<Parameters<typeof lxdTransformer.transformRequest>[1]> = {},
): OpenAIChatRequest {
  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 200_000,
    temperature: 0.7,
    thinking: { type: 'enabled' },
    stream_options: { include_usage: true },
    prompt_cache_retention: '24h',
    transforms: ['middle-out'],
  } as unknown as OpenAIChatRequest
  return lxdTransformer.transformRequest(body, {
    model,
    isReasoning: false,
    reasoningEffort: null,
    ...ctx,
  })
}

console.log('LXD catalog:')

test('drops the image and speech rows from a /v1/models payload', () => {
  const rows: LxdCatalogRow[] = [
    { id: 'gpt-oss-120b', architecture: { modality: 'text->text' } },
    { id: 'llama-4-scout', architecture: { modality: 'text+image->text' } },
    { id: 'whisper-large-v3-turbo', architecture: { modality: 'audio->text' } },
    { id: 'lxd-emaj-flash', architecture: { modality: 'text->image' } },
    { id: 'flux-2-klein', architecture: { modality: 'text->image' } },
  ]
  eq(
    filterLxdModelCatalog(rows).map(r => r.id),
    ['gpt-oss-120b', 'llama-4-scout'],
    'chat rows',
  )
})

test('classifies rows that omit architecture by id family', () => {
  assert(!isLxdChatRow({ id: 'emaj-reasoning-2' }), 'emaj row is not chat')
  assert(!isLxdChatRow({ id: 'flux-2-klein' }), 'flux row is not chat')
  assert(isLxdChatRow({ id: 'spy-model' }), 'spy-model is chat')
})

test('folds a live catalog row into the metadata store', () => {
  recordLxdCatalog([{
    id: 'brand-new-row',
    name: 'Brand New Row',
    context_length: 512_000,
    max_tokens: 12_345,
    architecture: { modality: 'text->text' },
    pricing: { prompt: '0.000042', completion: '0.000084' },
    capabilities: { reasoning: true, reasoning_efforts: ['low', 'max'], tools: true },
  }])
  const meta = getLxdModelMeta('brand-new-row')
  assert(meta != null, 'row was recorded')
  eq(meta!.contextWindow, 512_000, 'context window')
  eq(meta!.xenPerMillion, { prompt: 42, completion: 84 }, 'Xen per 1M')
  eq(lxdEffortLevelsFor('brand-new-row'), ['default', 'low', 'max'], 'ladder from the API')
})

test('clamps every output ceiling to the documented 32k per-request cap', () => {
  // deepseek-v4-pro advertises max_tokens 400_000, which is a context figure.
  eq(lxdMaxOutputTokens('deepseek-v4-pro-0813'), 32_000, 'pro clamp')
  eq(lxdMaxOutputTokens('gpt-oss-120b'), 4_096, 'per-model ceiling wins when lower')
  eq(lxdTransformer.clampMaxTokens(999_999), 32_000, 'transformer clamp')
})

test('static fallback covers only chat rows', () => {
  const ids = lxdTransformer.staticCatalog!().map(m => m.id)
  assert(ids.includes('gpt-oss-120b'), 'includes gpt-oss-120b')
  assert(!ids.some(id => id.includes('emaj') || id.includes('whisper')), 'no image/speech rows')
  assert(lxdTransformer.preferLiveModelCatalog!(), 'prefers the live catalog')
})

console.log('\nLXD effort ladders:')

test('each model gets the ladder its own capabilities declare', () => {
  eq(lxdEffortLevelsFor('gpt-oss-120b'), ['default', 'low', 'medium', 'high'], 'gpt-oss')
  eq(lxdEffortLevelsFor('deepseek-v4-flash-0731'), ['default', 'none', 'high', 'max'], 'deepseek v4')
  eq(lxdEffortLevelsFor('nemotron-3-ultra'), ['default', 'high'], 'nemotron')
  eq(lxdEffortLevelsFor('llama-4-scout'), ['default'], 'non-reasoning row')
})

test('the chip hides on rows with no published ladder', () => {
  assert(supportsLxdEffortSelection('gpt-oss-120b'), 'gpt-oss shows a chip')
  assert(!supportsLxdEffortSelection('llama-4-scout'), 'scout hides the chip')
  assert(!supportsLxdEffortSelection('minimax-m3'), 'minimax-m3 hides the chip')
})

test('cycling right wraps through the ladder and back to Default', () => {
  const seen = [
    cycleLxdEffort('gpt-oss-120b', 'right'),
    cycleLxdEffort('gpt-oss-120b', 'right'),
    cycleLxdEffort('gpt-oss-120b', 'right'),
    cycleLxdEffort('gpt-oss-120b', 'right'),
  ]
  eq(seen, ['low', 'medium', 'high', 'default'], 'right cycle')
})

test('cycling left walks the ladder backwards', () => {
  eq(cycleLxdEffort('gpt-oss-120b', 'left'), 'high', 'left from default')
  eq(cycleLxdEffort('gpt-oss-120b', 'left'), 'medium', 'left again')
})

test('a stored effort the model no longer supports falls back to Default', () => {
  _resetLxdThinkingForTests({ 'nemotron-3-ultra': 'medium' })
  eq(getLxdEffort('nemotron-3-ultra'), 'default', 'stale medium on a high-only row')
})

test('Default resolves to no wire value at all', () => {
  setLxdEffort('gpt-oss-120b', 'default')
  eq(resolveLxdRequestEffort('gpt-oss-120b'), null, 'default sends nothing')
  setLxdEffort('gpt-oss-120b', 'medium')
  eq(resolveLxdRequestEffort('gpt-oss-120b'), 'medium', 'explicit pick rides the wire')
})

console.log('\nLXD request shaping:')

test('sends the picked effort for a model that publishes it', () => {
  setLxdEffort('gpt-oss-120b', 'high')
  eq(shape('gpt-oss-120b').reasoning_effort, 'high', 'reasoning_effort')
})

test('sends none/max for the DeepSeek V4 ladder', () => {
  setLxdEffort('deepseek-v4-pro-0813', 'max')
  eq(shape('deepseek-v4-pro-0813').reasoning_effort, 'max', 'max is a real stop here')
  setLxdEffort('deepseek-v4-pro-0813', 'none')
  eq(shape('deepseek-v4-pro-0813').reasoning_effort, 'none', 'none is a real stop here')
})

test('never sends an effort a model does not publish', () => {
  // The caller asks for medium, but nemotron only accepts high.
  const body = shape('nemotron-3-ultra', { isReasoning: true, reasoningEffort: 'medium' })
  eq(body.reasoning_effort, undefined, 'unsupported level is dropped, not clamped')
})

test('never sends an effort on a non-reasoning row', () => {
  const body = shape('llama-4-scout', { isReasoning: true, reasoningEffort: 'high' })
  eq(body.reasoning_effort, undefined, 'scout carries no effort field')
})

test('falls back to the caller thinking budget when the row is on Default', () => {
  setLxdEffort('gpt-oss-120b', 'default')
  const body = shape('gpt-oss-120b', { isReasoning: true, reasoningEffort: 'low' })
  eq(body.reasoning_effort, 'low', 'caller budget applies under Default')
})

test('clamps max_tokens to the per-model ceiling', () => {
  eq(shape('gpt-oss-120b').max_tokens, 4_096, 'gpt-oss ceiling')
  eq(shape('deepseek-v4-pro-0813').max_tokens, 32_000, 'documented per-request cap')
  eq(shape('minimax-m3').max_tokens, 16_384, 'minimax-m3 ceiling')
})

test('stamps the session id for prompt-cache affinity', () => {
  const body = shape('gpt-oss-120b', { sessionId: 'tau-session-1' })
  eq(body.prompt_cache_key, 'tau-session-1', 'prompt_cache_key')
  eq(body.user, 'tau-session-1', 'user')
  eq(
    lxdTransformer.buildHeaders!('key', { model: 'gpt-oss-120b', sessionId: 'tau-session-1' }),
    { 'x-session-affinity': 'tau-session-1' },
    'affinity header',
  )
})

test('drops the affinity fields when there is no session id', () => {
  const body = shape('gpt-oss-120b')
  eq(body.prompt_cache_key, undefined, 'no prompt_cache_key')
  eq(body.user, undefined, 'no user')
  eq(lxdTransformer.buildHeaders!('key', { model: 'gpt-oss-120b' }), {}, 'no affinity header')
})

test('strips fields outside the documented request surface', () => {
  const body = shape('gpt-oss-120b', { sessionId: 's' }) as unknown as Record<string, unknown>
  for (const field of [
    'thinking',
    'reasoning',
    'stream_options',
    'prompt_cache_retention',
    'transforms',
    'extra_body',
    'plugins',
    'route',
  ]) {
    eq(body[field], undefined, `${field} is stripped`)
  }
})

test('strips Anthropic cache_control rather than forwarding it', () => {
  eq(lxdTransformer.cacheControlMode('gpt-oss-120b'), 'none', 'cache control mode')
})

test('keeps sampling params inside the documented ranges', () => {
  const hot = { ...shape('gpt-oss-120b') }
  eq(hot.temperature, 0.7, 'in-range temperature is untouched')

  const body = lxdTransformer.transformRequest(
    { model: 'gpt-oss-120b', messages: [], temperature: 5, top_p: 3 } as OpenAIChatRequest,
    { model: 'gpt-oss-120b', isReasoning: false, reasoningEffort: null },
  )
  eq(body.temperature, 2, 'temperature clamped to 2')
  eq(body.top_p, 1, 'top_p clamped to 1')
})

test('every seeded model is a chat model with a usable context window', () => {
  const metas = listLxdModelMeta()
  assert(metas.length >= 12, `expected the full seed, got ${metas.length}`)
  for (const m of metas) {
    assert(m.contextWindow > 0, `${m.id} has a context window`)
    assert(lxdMaxOutputTokens(m.id) > 0, `${m.id} has an output ceiling`)
  }
})

console.log('\nLXD reasoning-content replay contract:')

test('requires the carry-back for thinking rows', () => {
  // Regression: the history dispatch used to be gated on provider ===
  // 'deepseek', so DeepSeek V4 served through LXD silently lost the
  // reasoning_content carry-back and the next tool turn 400d with
  // "reasoning_content in thinking mode must be passed back to the API".
  assert(lxdReasoningContentReplayRequired('deepseek-v4-pro-0813'), 'deepseek pro row')
  assert(lxdReasoningContentReplayRequired('qwen-3.8-2.4t-a95b'), 'qwen row')
  assert(lxdReasoningContentReplayRequired('nemotron-3-ultra'), 'nemotron row')
})

test('still requires it when the row sits on Default', () => {
  // LXD turns thinking ON by default for these rows: a bare deepseek-v4-pro
  // request bills 113 prompt tokens vs 34 with reasoning_effort "none", so
  // the relay injects a thinking template unless told otherwise.
  setLxdEffort('deepseek-v4-pro-0813', 'default')
  assert(lxdReasoningContentReplayRequired('deepseek-v4-pro-0813'), 'default still replays')
})

test('drops the requirement only on an explicit none', () => {
  setLxdEffort('deepseek-v4-pro-0813', 'none')
  assert(!lxdReasoningContentReplayRequired('deepseek-v4-pro-0813'), 'thinking off')
})

test('never requires it for a row with no reasoning ladder', () => {
  assert(!lxdReasoningContentReplayRequired('llama-4-scout'), 'scout')
  assert(!lxdReasoningContentReplayRequired('minimax-m3'), 'minimax-m3')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
