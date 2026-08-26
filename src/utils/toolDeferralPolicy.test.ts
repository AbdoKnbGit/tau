/**
 * Tool-deferral cache policy tests.
 *
 * Run: bun run src/utils/toolDeferralPolicy.test.ts
 *
 * Client-side tool discovery rewrites the front of the request every time
 * ToolSearch loads a schema. On providers whose prompt cache is an exact
 * prefix cache Tau cannot re-anchor, that voids the whole conversation cache.
 * These tests pin which providers are excluded, and -- more importantly --
 * that BOTH deferral gates agree, since the Antigravity opt-out drifted apart
 * once already (see the comment in utils/toolSearch.ts).
 */

import assert from 'node:assert/strict'
import type { APIProvider } from './model/providers.js'
import {
  providerModelSupportsClientSideToolDiscovery,
  providerSupportsClientSideToolDiscovery,
  providerUsesExactPrefixCache,
  shouldDisableToolDeferralForProvider,
} from './toolDeferralPolicy.js'

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

console.log('tool deferral cache policy:')

// Automatic prefix cache, or a session-pinned prompt_cache_key.
const EXCLUDED: APIProvider[] = [
  'deepseek', 'mimo', 'fireworks', 'moonshot', 'cloudflare', 'mistral', 'lxd',
] as APIProvider[]

// Explicit cache_control breakpoints, or no prefix-cache pin at all.
const STILL_LAZY: APIProvider[] = [
  'openrouter', 'opencode', 'vercel', 'requesty', 'copilot', 'iflow',
  'minimax', 'glm', 'ollama', 'lmstudio',
] as APIProvider[]

test('the excluded set is exactly the exact-prefix-cache providers', () => {
  for (const p of EXCLUDED) {
    assert.equal(providerUsesExactPrefixCache(p), true, `${p} should be excluded`)
  }
  for (const p of STILL_LAZY) {
    assert.equal(providerUsesExactPrefixCache(p), false, `${p} must NOT be excluded`)
  }
})

test('excluded providers get no client-side tool discovery', () => {
  for (const p of EXCLUDED) {
    assert.equal(
      providerModelSupportsClientSideToolDiscovery(p),
      false,
      `${p} still advertises client-side discovery`,
    )
  }
})

test('excluded providers have tool deferral disabled outright', () => {
  for (const p of EXCLUDED) {
    assert.equal(
      shouldDisableToolDeferralForProvider(p, 'normal' as any),
      true,
      `${p} still defers tools`,
    )
  }
})

test('both gates agree for every provider (no drift)', () => {
  const all = [...EXCLUDED, ...STILL_LAZY]
  for (const p of all) {
    if (!providerUsesExactPrefixCache(p)) continue
    const discovery = providerModelSupportsClientSideToolDiscovery(p)
    const deferralOff = shouldDisableToolDeferralForProvider(p, 'normal' as any)
    assert.equal(
      discovery === false && deferralOff === true,
      true,
      `${p}: gates disagree (discovery=${discovery}, deferralDisabled=${deferralOff})`,
    )
  }
})

test('providers that keep lazy tools still resolve discovery', () => {
  for (const p of STILL_LAZY) {
    if (!providerSupportsClientSideToolDiscovery(p)) continue
    assert.equal(
      providerModelSupportsClientSideToolDiscovery(p),
      true,
      `${p} lost client-side discovery it should still have`,
    )
  }
})

test('cheap mode still disables deferral everywhere', () => {
  for (const p of [...EXCLUDED, ...STILL_LAZY]) {
    assert.equal(
      shouldDisableToolDeferralForProvider(p, 'cheap' as any),
      true,
      `${p} deferred tools in cheap mode`,
    )
  }
})

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\n${passed} passed`)
