/**
 * Xiaomi MiMo provider — catalog, effort ladder, auth, and request shaping.
 *
 * The assertions here deliberately pin the three things that bit the LXD
 * provider: the reasoning-content replay contract, the output-token field,
 * and the auth header.
 *
 * Run: bun run src/lanes/openai-compat/mimo.test.ts
 *  or: npx esbuild src/lanes/openai-compat/mimo.test.ts --bundle --platform=node
 *      --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the effort store at a scratch file BEFORE the store module loads it.
process.env.TAU_MIMO_THINKING_STORE = join(
  mkdtempSync(join(tmpdir(), 'mimo-thinking-')),
  'store.json',
)

import { mimoTransformer } from './transformers/mimo.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'
import {
  getMimoModelMeta,
  mimoMaxOutputTokens,
  mimoStaticCatalog,
  recordMimoCatalog,
} from '../../utils/model/mimoCatalog.js'
import {
  _resetMimoThinkingForTests,
  cycleMimoEffort,
  getMimoEffort,
  hasExplicitMimoEffort,
  mimoReasoningContentReplayRequired,
  setMimoEffort,
  supportsMimoEffortSelection,
} from '../../utils/model/mimoThinking.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    _resetMimoThinkingForTests()
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
  ctx: Partial<Parameters<typeof mimoTransformer.transformRequest>[1]> = {},
): Record<string, unknown> {
  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 900_000,
    temperature: 0.7,
    thinking: { type: 'enabled' },
    stream_options: { include_usage: true },
    store: true,
    transforms: ['middle-out'],
  } as unknown as OpenAIChatRequest
  return mimoTransformer.transformRequest(body, {
    model,
    isReasoning: false,
    reasoningEffort: null,
    ...ctx,
  }) as unknown as Record<string, unknown>
}

console.log('MiMo catalog:')

test('ships the two documented chat rows', () => {
  const ids = mimoStaticCatalog().map(m => m.id)
  eq(ids, ['mimo-v2.5-pro', 'mimo-v2.5'], 'catalog ids')
})

test('carries the published context windows and output caps', () => {
  eq(getMimoModelMeta('mimo-v2.5-pro')?.contextWindow, 1_000_000, 'pro context')
  eq(mimoMaxOutputTokens('mimo-v2.5-pro'), 128_000, 'pro output cap')
})

test('folds a live /v1/models row in without dropping it', () => {
  // The endpoint is auth-gated, so this only runs post-login; an unknown
  // future model must stay usable rather than being filtered away.
  recordMimoCatalog([{ id: 'mimo-v3-preview', name: 'MiMo V3 Preview', context_length: 2_000_000 }])
  eq(getMimoModelMeta('mimo-v3-preview')?.contextWindow, 2_000_000, 'new row recorded')
  assert(supportsMimoEffortSelection('mimo-v3-preview'), 'new row reasons by default')
})

console.log('\nMiMo effort ladder:')

test('every chat row exposes low/medium/high and defaults to medium', () => {
  for (const id of ['mimo-v2.5-pro', 'mimo-v2.5']) {
    assert(supportsMimoEffortSelection(id), `${id} shows a chip`)
    eq(getMimoEffort(id), 'medium', `${id} default is MiMo's own medium`)
  }
})

test('cycling wraps through the ladder in both directions', () => {
  eq(cycleMimoEffort('mimo-v2.5-pro', 'right'), 'high', 'medium -> high')
  eq(cycleMimoEffort('mimo-v2.5-pro', 'right'), 'low', 'high wraps to low')
  eq(cycleMimoEffort('mimo-v2.5-pro', 'left'), 'high', 'low wraps back to high')
})

test('the pick is per model, not global', () => {
  setMimoEffort('mimo-v2.5-pro', 'high')
  eq(getMimoEffort('mimo-v2.5-pro'), 'high', 'pro is high')
  eq(getMimoEffort('mimo-v2.5'), 'medium', 'the other row untouched')
})

console.log('\nMiMo reasoning-content replay contract:')

test('requires the carry-back on every reasoning row', () => {
  // MiMo sets requireReasoningContentOnAssistantMessages for all rows. This
  // is the exact contract whose absence broke the SECOND tool turn on LXD,
  // so it is asserted here rather than discovered in production.
  for (const id of ['mimo-v2.5-pro', 'mimo-v2.5']) {
    assert(mimoReasoningContentReplayRequired(id), `${id} needs the replay`)
  }
})

test('does not claim the contract for an unknown model', () => {
  assert(!mimoReasoningContentReplayRequired('not-a-mimo-model'), 'unknown row')
})

console.log('\nMiMo request shaping:')

test('renames max_tokens to max_completion_tokens', () => {
  // MiMo ignores max_tokens outright, silently substituting its own default.
  const body = shape('mimo-v2.5-pro')
  eq(body.max_tokens, undefined, 'max_tokens removed')
  eq(body.max_completion_tokens, 128_000, 'clamped to the per-model cap')
})

test('clamps the output field per model', () => {
  eq(shape('mimo-v2.5').max_completion_tokens, 128_000, 'v2.5 cap')
  eq(mimoTransformer.clampMaxTokens(999_999), 128_000, 'lane-level clamp')
})

test('always sends a reasoning_effort on a reasoning row', () => {
  setMimoEffort('mimo-v2.5-pro', 'high')
  eq(shape('mimo-v2.5-pro').reasoning_effort, 'high', 'picked level')
})

test('an explicit picker choice outranks the caller thinking budget', () => {
  // Caught live: without this precedence the caller's implicit budget
  // overwrote the chip on every request, so the picker did nothing.
  setMimoEffort('mimo-v2.5-pro', 'high')
  const body = shape('mimo-v2.5-pro', { isReasoning: true, reasoningEffort: 'low' })
  eq(body.reasoning_effort, 'high', 'the picked level wins')
})

test('an explicit medium still outranks the caller budget', () => {
  setMimoEffort('mimo-v2.5-pro', 'medium')
  assert(hasExplicitMimoEffort('mimo-v2.5-pro'), 'medium is a real preference')
  const body = shape('mimo-v2.5-pro', { isReasoning: true, reasoningEffort: 'low' })
  eq(body.reasoning_effort, 'medium', 'explicit medium wins')
})

test('with no pick, the caller thinking budget applies', () => {
  assert(!hasExplicitMimoEffort('mimo-v2.5-pro'), 'nothing stored')
  const body = shape('mimo-v2.5-pro', { isReasoning: true, reasoningEffort: 'low' })
  eq(body.reasoning_effort, 'low', 'budget fills in')
})

test('with no pick and no budget, MiMo default medium applies', () => {
  eq(shape('mimo-v2.5-pro').reasoning_effort, 'medium', 'vendor default')
})

test('strips fields MiMo does not accept', () => {
  const body = shape('mimo-v2.5-pro')
  for (const field of ['store', 'stream_options', 'thinking', 'reasoning', 'transforms']) {
    eq(body[field], undefined, `${field} is stripped`)
  }
})

test('strips Anthropic cache_control rather than forwarding it', () => {
  eq(mimoTransformer.cacheControlMode('mimo-v2.5-pro'), 'none', 'cache mode')
})

test('injects no speculative cache-affinity fields', () => {
  // The LXD build shipped prompt_cache_key / user / x-session-affinity on a
  // hunch and none of it was load-bearing. MiMo is a first-party vendor API
  // with no documented affinity knob, so nothing is invented here.
  const body = shape('mimo-v2.5-pro', { sessionId: 'tau-session-1' })
  eq(body.prompt_cache_key, undefined, 'no prompt_cache_key')
  eq(body.user, undefined, 'no user')
  const headers = mimoTransformer.buildHeaders!('secret-key', {
    model: 'mimo-v2.5-pro',
    sessionId: 'tau-session-1',
  })
  eq(headers['x-session-affinity'], undefined, 'no affinity header')
})

console.log('\nMiMo auth:')

test('authenticates with a bare api-key header, not Bearer', () => {
  assert(mimoTransformer.ownsAuthHeader?.() === true, 'transformer owns auth')
  eq(
    mimoTransformer.buildHeaders!('secret-key', { model: 'mimo-v2.5-pro' }),
    { 'api-key': 'secret-key' },
    'api-key header only',
  )
})

test('sends no auth header at all when there is no key', () => {
  eq(mimoTransformer.buildHeaders!('', { model: 'mimo-v2.5-pro' }), {}, 'empty')
})

test('points at the pay-as-you-go endpoint by default', () => {
  eq(mimoTransformer.defaultBaseUrl, 'https://api.xiaomimimo.com/v1', 'default base URL')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
