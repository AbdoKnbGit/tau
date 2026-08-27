/**
 * models.dev price catalogue tests.
 *
 * Run: bun run src/utils/modelPricingCatalog.test.ts
 */

import {
  deriveTable,
  lookupCatalogPrice,
  resetCatalogForTests,
  isLocalProvider,
  _refreshRetryDelay,
  isModelPricingDisabled,
  resolveCatalogProvider,
  rowToPrice,
  type CatalogTable,
} from './modelPricingCatalog.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  resetCatalogForTests(null)
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const NOW = 1_700_000_000_000

console.log('model pricing catalogue:')

// ─── provider mapping ────────────────────────────────────────────────

test('maps Tau provider ids onto models.dev ids', () => {
  const cases: [string, string][] = [
    ['deepseek', 'deepseek'],
    ['openrouter', 'openrouter'],
    ['glm', 'zhipuai'],
    ['moonshot', 'moonshotai'],
    ['firstParty', 'anthropic'],
    ['gemini', 'google'],
    ['vertex', 'google-vertex'],
    ['fireworks', 'fireworks-ai'],
    ['nim', 'nvidia'],
    ['mimo', 'xiaomi'],
    ['kilocode', 'kilo'],
    ['copilot', 'github-copilot'],
    ['clinepass', 'cline-pass'],
  ]
  for (const [tau, expected] of cases) {
    assert(
      resolveCatalogProvider(tau) === expected,
      `${tau} should map to ${expected}, got ${resolveCatalogProvider(tau)}`,
    )
  }
})

test('refuses to price local runtimes', () => {
  // Inference on your own machine is free; a catalogue rate would be fiction.
  for (const provider of ['ollama', 'lmstudio']) {
    assert(
      resolveCatalogProvider(provider) === null,
      `${provider} runs locally and must not be priced`,
    )
  }
})

test('still resolves flat-fee providers, for an API-equivalent figure', () => {
  // A subscription has no per-token bill, but pricing the same usage at
  // published rates answers "what is this worth?" where no quota is visible.
  // The caller is responsible for labelling it as an estimate, not an invoice.
  for (const provider of ['copilot', 'kilocode', 'clinepass']) {
    assert(
      resolveCatalogProvider(provider) !== null,
      `${provider} should resolve so its usage can be valued`,
    )
  }
})

test('separates "runs locally" from "absent from the catalogue"', () => {
  // Local inference is genuinely free, so no money may be shown against it.
  // A provider merely missing from the catalogue may still cost real money
  // that simply is not published, so the two must not be conflated.
  for (const provider of ['ollama', 'lmstudio']) {
    assert(isLocalProvider(provider), `${provider} runs locally`)
  }
  for (const provider of ['antigravity', 'kiro', 'lxd', 'deepseek']) {
    assert(!isLocalProvider(provider), `${provider} is remote, priced or not`)
  }
})

// ─── deriving the table ──────────────────────────────────────────────

const PAYLOAD = {
  deepseek: {
    id: 'deepseek',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        cost: { input: 0.14, output: 0.28, reasoning: 0.28, cache_read: 0.0028 },
      },
      'half-specified': { id: 'half-specified', cost: { input: 1 } },
      'no-cost': { id: 'no-cost' },
    },
  },
  'nothing-priced': { id: 'nothing-priced', models: { a: { id: 'a' } } },
  malformed: null,
}

test('keeps only models quoting both an input and an output rate', () => {
  const table = deriveTable(PAYLOAD, NOW)
  const rows = table.providers.deepseek!
  assert(rows['deepseek-v4-flash'] !== undefined, 'a fully priced model is kept')
  assert(rows['half-specified'] === undefined, 'input without output cannot price')
  assert(rows['no-cost'] === undefined, 'a model with no cost block is skipped')
})

test('drops providers with nothing priced, and survives malformed entries', () => {
  const table = deriveTable(PAYLOAD, NOW)
  assert(table.providers['nothing-priced'] === undefined, 'empty provider dropped')
  assert(table.providers.malformed === undefined, 'null provider ignored')
  assert(table.fetchedAt === NOW, 'fetch time recorded')
})

test('tolerates a payload that is not an object at all', () => {
  for (const junk of [null, undefined, 'text', 42]) {
    const table = deriveTable(junk, NOW)
    assert(
      Object.keys(table.providers).length === 0,
      `${JSON.stringify(junk)} should derive an empty table, not throw`,
    )
  }
})

// ─── converting a row to a price ─────────────────────────────────────

test('converts a row to per-Mtok costs', () => {
  const price = rowToPrice([0.14, 0.28, 0.0028, 0.14])
  assert(price.inputTokens === 0.14, 'input rate')
  assert(price.outputTokens === 0.28, 'output rate')
  assert(price.promptCacheReadTokens === 0.0028, 'cache read rate')
  assert(price.promptCacheWriteTokens === 0.14, 'cache write rate')
  assert(price.webSearchRequests === 0, 'web search is not quoted, so uncharged')
})

test('falls back to the input rate when a cache rate is unquoted', () => {
  // Treating an unstated cache read as free would understate a long session,
  // where cached tokens are most of the prompt.
  const price = rowToPrice([2, 8, null, null])
  assert(price.promptCacheReadTokens === 2, 'cache read falls back to input')
  assert(price.promptCacheWriteTokens === 2, 'cache write falls back to input')
})

// ─── lookup ──────────────────────────────────────────────────────────

const TABLE: CatalogTable = {
  version: 1,
  fetchedAt: NOW,
  providers: {
    deepseek: { 'deepseek-v4-flash': [0.14, 0.28, 0.0028, null] },
    zhipuai: { 'glm-4.6': [0.6, 2.2, null, null] },
  },
}

test('prices a model on an exact provider and id match', () => {
  resetCatalogForTests(TABLE)
  const price = lookupCatalogPrice('deepseek', 'deepseek-v4-flash')
  assert(price?.inputTokens === 0.14, `expected 0.14, got ${price?.inputTokens}`)
})

test('prices through a provider alias', () => {
  resetCatalogForTests(TABLE)
  const price = lookupCatalogPrice('glm', 'glm-4.6')
  assert(price?.outputTokens === 2.2, 'glm resolves to zhipuai')
})

test('never borrows another provider\'s rate for the same model id', () => {
  resetCatalogForTests(TABLE)
  assert(
    lookupCatalogPrice('openrouter', 'deepseek-v4-flash') === null,
    'a model served elsewhere must not inherit deepseek pricing',
  )
})

test('returns null for an unknown model rather than a neighbouring one', () => {
  resetCatalogForTests(TABLE)
  assert(lookupCatalogPrice('deepseek', 'deepseek-v9') === null, 'no fuzzy match')
})

test('returns null for a never-priced provider even if the id exists', () => {
  resetCatalogForTests({
    ...TABLE,
    providers: { ...TABLE.providers, ollama: { 'deepseek-v4-flash': [9, 9, null, null] } },
  })
  assert(
    lookupCatalogPrice('ollama', 'deepseek-v4-flash') === null,
    'local inference stays unpriced regardless of catalogue contents',
  )
})

test('opting out stops pricing even with a table already loaded', () => {
  // Off must mean off. Otherwise someone who disabled the catalogue keeps
  // getting prices from a file they were never told existed.
  resetCatalogForTests(TABLE)
  assert(
    lookupCatalogPrice('deepseek', 'deepseek-v4-flash') !== null,
    'precondition: priced while enabled',
  )

  process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
  try {
    assert(isModelPricingDisabled(), 'the flag should read as disabled')
    assert(
      lookupCatalogPrice('deepseek', 'deepseek-v4-flash') === null,
      'a disabled catalogue must price nothing',
    )
  } finally {
    delete process.env.CLAUDEX_DISABLE_MODEL_PRICING
  }

  assert(
    lookupCatalogPrice('deepseek', 'deepseek-v4-flash') !== null,
    'and pricing resumes once re-enabled',
  )
})

test('only explicit opt-out values disable the catalogue', () => {
  for (const value of ['1', 'true', 'YES', 'On']) {
    process.env.CLAUDEX_DISABLE_MODEL_PRICING = value
    assert(isModelPricingDisabled(), `${value} should disable`)
  }
  for (const value of ['0', 'false', 'no', '', 'maybe']) {
    process.env.CLAUDEX_DISABLE_MODEL_PRICING = value
    assert(!isModelPricingDisabled(), `${value} should not disable`)
  }
  delete process.env.CLAUDEX_DISABLE_MODEL_PRICING
  assert(!isModelPricingDisabled(), 'unset means enabled')
})

test('backs off failed refreshes instead of re-downloading 4MB each time', () => {
  // A null table can never satisfy the freshness check, so without a failure
  // backoff an offline session restarts the download on every unpriced
  // message. The delay grows and is capped.
  assert(_refreshRetryDelay(1) === 5 * 60_000, '1st retry after 5min')
  assert(_refreshRetryDelay(2) === 10 * 60_000, '2nd after 10min')
  assert(_refreshRetryDelay(3) === 20 * 60_000, '3rd after 20min')
  assert(_refreshRetryDelay(9) === 60 * 60_000, 'capped at an hour')
  assert(_refreshRetryDelay(0) === 5 * 60_000, 'a zero count still delays')
})

test('returns null when no table has been loaded', () => {
  resetCatalogForTests(null)
  assert(
    lookupCatalogPrice('deepseek', 'deepseek-v4-flash') === null,
    'no catalogue means unpriced, never a guess',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
