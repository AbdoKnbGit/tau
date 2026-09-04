/**
 * Run: bun run src/constants/attributionProviders.test.ts
 *
 * Guards which providers receive the `x-anthropic-billing-header` system prompt
 * block. It is emitted as block 0 — the head of every provider's cached prefix,
 * and AHEAD of SYSTEM_PROMPT_DYNAMIC_BOUNDARY, so the stable/volatile split the
 * cache-aware lanes perform cannot protect it. Two of its fields move on their
 * own (the first-user-message fingerprint, and the turn-scoped cc_workload), so
 * on a provider that reads none of it, it is a pure prefix-cache hazard.
 */

import { providerReadsAttributionHeader } from './attributionProviders.js'
import { computeFingerprint } from '../utils/fingerprint.js'

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

// Anthropic-operated endpoints: they parse the header (billing attribution,
// cch attestation, and the fingerprint their backends validate).
const ANTHROPIC_TERMINATED = ['firstParty', 'bedrock', 'vertex', 'foundry']

// Everything else: the header is inert text at the head of the cached prefix.
const THIRD_PARTY = [
  'deepseek', 'openrouter', 'glm', 'moonshot', 'minimax', 'mistral', 'groq',
  'fireworks', 'cloudflare', 'mimo', 'alibaba', 'lxd', 'nim', 'openai', 'gemini',
  'antigravity', 'copilot', 'opencode', 'opencodego', 'agentrouter',
  'modelrouter', 'kilocode', 'kiro', 'cline', 'clinepass', 'cursor', 'iflow',
  'requesty', 'vercel', 'commandcode', 'ollama', 'lmstudio',
]

console.log('attribution header provider gate:')

test('every Anthropic-operated endpoint keeps it', () => {
  for (const provider of ANTHROPIC_TERMINATED) {
    assert(
      providerReadsAttributionHeader(provider),
      `${provider} must keep the attribution header`,
    )
  }
})

test('no third-party provider gets it', () => {
  for (const provider of THIRD_PARTY) {
    assert(
      !providerReadsAttributionHeader(provider),
      `${provider} must not carry the attribution header`,
    )
  }
})

test('an unknown provider defaults to NOT sending it', () => {
  assert(!providerReadsAttributionHeader('some-future-gateway'), 'unknown must default off')
  assert(!providerReadsAttributionHeader(''), 'empty must default off')
})

test('the fingerprint really does move with the first user message', () => {
  // Why this is a cache hazard and not just ~20 dead tokens: /resume re-renders
  // the first user message (attachments merged into it were never persisted),
  // and chars [4], [7], [20] are all the fingerprint reads.
  const live = computeFingerprint('<system-reminder>\nThe following skills are…', '0.92.24')
  const resumed = computeFingerprint("<system-reminder>\nAs you answer the user's…", '0.92.24')
  assert(
    live !== resumed,
    `expected different fingerprints, both were ${live}`,
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
