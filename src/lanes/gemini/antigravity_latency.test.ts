/**
 * Antigravity Gemini latency defaults.
 *
 * Run: bun run src/lanes/gemini/antigravity_latency.test.ts
 */

import { resolveThinkingConfig } from './thinking.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
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

function main(): void {
  console.log('antigravity gemini latency:')

  test('Antigravity Gemini low keeps reasoning level but does not stream thoughts by default', () => {
    const cfg = resolveThinkingConfig('gemini-3.5-flash-low', -1)
    assert(cfg.thinkingLevel === 'low', `thinkingLevel=${String(cfg.thinkingLevel)}`)
    assert(cfg.includeThoughts === false, `includeThoughts=${String(cfg.includeThoughts)}`)
  })

  test('explicit thinking request still streams thoughts', () => {
    const cfg = resolveThinkingConfig('gemini-3.5-flash-low', 1024, {
      type: 'enabled',
      budget_tokens: 1024,
    })
    assert(cfg.thinkingLevel === 'low', `thinkingLevel=${String(cfg.thinkingLevel)}`)
    assert(cfg.includeThoughts === true, `includeThoughts=${String(cfg.includeThoughts)}`)
  })

  test('Gemini 3.7 Flash variants preserve their Antigravity thinking level', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const cfg = resolveThinkingConfig(`gemini-3.7-flash-${level}`, -1)
      assert(cfg.thinkingLevel === level, `${level} thinkingLevel=${String(cfg.thinkingLevel)}`)
      assert(cfg.includeThoughts === false, `${level} includeThoughts=${String(cfg.includeThoughts)}`)
    }
  })

  test('TAU_GEMINI_INCLUDE_THOUGHTS can opt back into visible thoughts', () => {
    process.env.TAU_GEMINI_INCLUDE_THOUGHTS = '1'
    try {
      const cfg = resolveThinkingConfig('gemini-3.5-flash-low', -1)
      assert(cfg.includeThoughts === true, `includeThoughts=${String(cfg.includeThoughts)}`)
    } finally {
      delete process.env.TAU_GEMINI_INCLUDE_THOUGHTS
    }
  })

  test('non-Antigravity Gemini keeps legacy adaptive thought behavior', () => {
    const cfg = resolveThinkingConfig('gemini-2.5-pro', -1)
    assert(cfg.thinkingBudget === -1, `thinkingBudget=${String(cfg.thinkingBudget)}`)
    assert(cfg.includeThoughts === true, `includeThoughts=${String(cfg.includeThoughts)}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
