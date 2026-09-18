/**
 * Prompt-suggestion forks only where the fork can read its parent's cache.
 *
 * Run: bun run src/services/PromptSuggestion/forkCacheGuard.test.ts
 */
import { getForkCacheSuppressReason } from './forkCacheGuard.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const saved = process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS
  delete process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  } finally {
    if (saved === undefined) delete process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS
    else process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS = saved
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('prompt-suggestion fork cache guard:')

  await test('suppresses on Antigravity Gemini models', () => {
    for (const model of [
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'gemini-3.7-flash-low',
      'gemini-3.5-flash-medium',
      'gemini-3.1-pro-high',
      'models/gemini-3.8-flash-low',
    ]) {
      const reason = getForkCacheSuppressReason('antigravity', model)
      assert(reason === 'provider_cache_not_shared', `${model}: ${reason}`)
    }
  })

  await test('keeps suggestions for Claude resold through Antigravity', () => {
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
      assert(getForkCacheSuppressReason('antigravity', model) === null, model)
    }
  })

  await test('keeps suggestions on other providers, whatever the model name', () => {
    for (const provider of ['firstParty', 'bedrock', 'vertex', 'openrouter', 'gemini']) {
      assert(
        getForkCacheSuppressReason(provider, 'gemini-3.8-flash-medium') === null,
        provider,
      )
    }
  })

  await test('no model known: no opinion', () => {
    assert(getForkCacheSuppressReason('antigravity', undefined) === null, 'undefined model')
    assert(getForkCacheSuppressReason('antigravity', '') === null, 'empty model')
  })

  await test('TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS=1 opts back in', () => {
    process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS = '1'
    assert(
      getForkCacheSuppressReason('antigravity', 'gemini-3.8-flash-medium') === null,
      'opt-in ignored',
    )
    process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS = '0'
    assert(
      getForkCacheSuppressReason('antigravity', 'gemini-3.8-flash-medium') !== null,
      'falsy value must not opt in',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
