/**
 * Provider-name resolution used by agent frontmatter.
 *
 * Run: npx esbuild src/utils/model/providerNames.test.ts --bundle --platform=node
 *      --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
 */
import {
  isAPIProvider,
  listAPIProviderNames,
  PROVIDER_DISPLAY_NAMES,
  resolveAPIProviderName,
} from './providers.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

console.log('provider name resolution:')

test('canonical ids resolve to themselves', () => {
  for (const provider of listAPIProviderNames()) {
    assert(
      resolveAPIProviderName(provider) === provider,
      `${provider} did not round-trip`,
    )
  }
})

test('display names resolve to their canonical id', () => {
  for (const provider of listAPIProviderNames()) {
    const display = PROVIDER_DISPLAY_NAMES[provider]
    const resolved = resolveAPIProviderName(display)
    assert(
      resolved !== undefined && isAPIProvider(resolved),
      `display name "${display}" did not resolve`,
    )
  }
})

test('the reported failure case resolves', () => {
  // Agent file written by hand as `provider: Fireworks AI ` — previously
  // dropped, which ran the agent's Fireworks model on the session provider.
  assert(
    resolveAPIProviderName('Fireworks AI ') === 'fireworks',
    'Fireworks AI did not resolve to fireworks',
  )
})

test('case, spacing, dashes and underscores are tolerated', () => {
  const cases: Array<[string, string]> = [
    ['FIREWORKS', 'fireworks'],
    ['Anti-Gravity', 'antigravity'],
    ['first_party', 'firstParty'],
    ['Anthropic', 'firstParty'],
    ['NVIDIA NIM', 'nim'],
    ['open router', 'openrouter'],
    ['LM Studio', 'lmstudio'],
    ['  kiro  ', 'kiro'],
  ]
  for (const [input, expected] of cases) {
    const resolved = resolveAPIProviderName(input)
    assert(
      resolved === expected,
      `"${input}" resolved to ${String(resolved)}, expected ${expected}`,
    )
  }
})

test('unknown and empty values stay unresolved', () => {
  for (const input of ['', '   ', 'fireworks ai gateway', 'not-a-provider']) {
    assert(
      resolveAPIProviderName(input) === undefined,
      `"${input}" should not resolve`,
    )
  }
})

test('display names never shadow a canonical id', () => {
  // "Anthropic" maps to firstParty; no canonical id may be stolen by a label.
  for (const provider of listAPIProviderNames()) {
    assert(
      resolveAPIProviderName(provider) === provider,
      `canonical id ${provider} was shadowed by a display name`,
    )
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
