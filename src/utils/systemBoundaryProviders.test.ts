/**
 * Run: bun run src/utils/systemBoundaryProviders.test.ts
 *
 * Guards which providers get the SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker. It MUST
 * be emitted for the lanes that strip+split on it (so their volatile context
 * stays out of the cached prefix) and MUST NOT be emitted for providers that
 * would forward the literal marker text to the model.
 */

import { providerSplitsSystemBoundary } from './systemBoundaryProviders.js'

let passed = 0
let failed = 0

function check(provider: string, expected: boolean): void {
  const actual = providerSplitsSystemBoundary(provider)
  if (actual === expected) {
    passed++
    console.log(`  ok  ${provider} → ${expected}`)
  } else {
    failed++
    console.log(`  FAIL ${provider}: expected ${expected}, got ${actual}`)
  }
}

console.log('system boundary splitting providers:')

// Native lanes that strip the marker — must split.
check('gemini', true)
check('antigravity', true)
check('openrouter', true)
// DeepSeek's automatic prefix cache hits only on a byte-identical prefix, so
// the OpenAI-compat lane splits on the marker and pins the volatile block as a
// frozen leading user message (buildDeepSeekCacheStableMessages).
check('deepseek', true)

// Providers that do NOT strip the marker — must stay out, or the literal
// marker text would reach the model.
check('groq', false)
check('mistral', false)
check('agentrouter', false)
check('firstParty', false) // first-party path handles the marker separately

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
