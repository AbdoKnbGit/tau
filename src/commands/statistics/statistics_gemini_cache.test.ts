/**
 * Statistics display tests for Antigravity Gemini cache accounting.
 *
 * Run: bun run src/commands/statistics/statistics_gemini_cache.test.ts
 */

import { modelUsageForStatisticsDisplay } from './model_usage_display.js'

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

async function main(): Promise<void> {
  console.log('statistics Antigravity Gemini cache display:')

  await test('Antigravity Gemini low-hit input is already uncached', () => {
    const usage = modelUsageForStatisticsDisplay('gemini-3.5-flash-medium', {
      inputTokens: 565_328,
      outputTokens: 4_524,
      cacheReadInputTokens: 480_529,
      cacheCreationInputTokens: 0,
    }, 'antigravity')

    assert(usage.inputTokens === 565_328, `inputTokens=${usage.inputTokens}`)
    assert(usage.cacheReadInputTokens === 480_529, `cacheReadInputTokens=${usage.cacheReadInputTokens}`)
    assert(usage.outputTokens === 4_524, `outputTokens=${usage.outputTokens}`)
  })

  await test('Claude on Antigravity keeps standard input display', () => {
    const usage = modelUsageForStatisticsDisplay('claude-sonnet-4-6', {
      inputTokens: 565_328,
      outputTokens: 4_524,
      cacheReadInputTokens: 480_529,
      cacheCreationInputTokens: 0,
    }, 'antigravity')

    assert(usage.inputTokens === 565_328, `inputTokens=${usage.inputTokens}`)
    assert(usage.cacheReadInputTokens === 480_529, `cacheReadInputTokens=${usage.cacheReadInputTokens}`)
  })

  await test('already-normalized Antigravity Gemini input is not double-subtracted', () => {
    const usage = modelUsageForStatisticsDisplay('gemini-3.5-flash-medium', {
      inputTokens: 565_328,
      outputTokens: 4_524,
      cacheReadInputTokens: 3_203_525,
      cacheCreationInputTokens: 0,
    }, 'antigravity')

    assert(usage.inputTokens === 565_328, `inputTokens=${usage.inputTokens}`)
    assert(usage.cacheReadInputTokens === 3_203_525, `cacheReadInputTokens=${usage.cacheReadInputTokens}`)
  })

  await test('a cold worker stays at 20% reuse through repeated formatting', () => {
    const raw = {
      inputTokens: 80_000,
      outputTokens: 900,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 0,
    }
    const once = modelUsageForStatisticsDisplay('gemini-3.8-flash-low', raw, 'antigravity')
    const twice = modelUsageForStatisticsDisplay('gemini-3.8-flash-low', once, 'antigravity')
    const percent = twice.cacheReadInputTokens /
      (twice.inputTokens + twice.cacheReadInputTokens)
    assert(percent === 0.2, `reuse=${percent}; expected 20%`)
    assert(twice.inputTokens === raw.inputTokens, 'rendering changed usage')
  })

  await test('other providers and models preserve every usage field', () => {
    const raw = {
      inputTokens: 80_000,
      outputTokens: 900,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 1_000,
    }
    for (const model of ['gpt-5.4', 'google/gemini-3-flash', 'gemini-2.5-pro']) {
      assert(modelUsageForStatisticsDisplay(model, raw, 'openrouter') === raw, model)
    }
  })

  await test('overlapping Gemini ids retain existing behavior outside Antigravity', () => {
    const raw = {
      inputTokens: 80_000,
      outputTokens: 900,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 0,
    }
    for (const provider of ['gemini', 'openrouter', 'openai']) {
      const usage = modelUsageForStatisticsDisplay('gemini-3.8-flash-low', raw, provider)
      assert(usage.inputTokens === 60_000, provider)
      assert(usage.cacheReadInputTokens === raw.cacheReadInputTokens, provider)
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
