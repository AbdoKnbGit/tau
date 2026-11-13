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

  test('Flash and Gemini 4 variants preserve their Antigravity thinking level', () => {
    // Preserve the chosen level for both shared and per-level wire models.
    for (const family of ['3.6-flash', '3.7-flash', '3.8-flash', '4-argon', '4-carbon', '4-hydrogen'] as const) {
      for (const level of ['low', 'medium', 'high'] as const) {
        const id = `gemini-${family}-${level}`
        const cfg = resolveThinkingConfig(id, -1)
        assert(cfg.thinkingLevel === level, `${id} thinkingLevel=${String(cfg.thinkingLevel)}`)
        assert(cfg.includeThoughts === false, `${id} includeThoughts=${String(cfg.includeThoughts)}`)
        assert(!('thinkingBudget' in cfg), `${id} must use level-based reasoning`)
      }
    }
  })

  test('Gemini 4 respects existing explicit thought and level overrides', () => {
    const previous = process.env.TAU_GEMINI_THINKING
    try {
      const cases = ['gemini-4-argon-high', 'gemini-4-carbon-high', 'gemini-4-hydrogen-high'].flatMap(model =>
        [['medium', 'medium'], ['off', 'low']].map(([override, expected]) => ({ model, override, expected })))
      for (const { model, override, expected } of cases) {
        process.env.TAU_GEMINI_THINKING = override
        const cfg = resolveThinkingConfig(model, 1024, {
          type: 'enabled', budget_tokens: 1024,
        })
        assert(cfg.thinkingLevel === expected, `${model}: override ${override} was lost`)
        assert(cfg.includeThoughts === true, `${model}: explicit thoughts were lost`)
      }
    } finally {
      if (previous === undefined) delete process.env.TAU_GEMINI_THINKING
      else process.env.TAU_GEMINI_THINKING = previous
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
