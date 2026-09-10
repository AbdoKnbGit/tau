/**
 * Context-window resolution tests.
 *
 * Run: bun run src/utils/model/contextWindows.test.ts
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The durable store reads <config>/cache/model-context-windows.json. Point it
// at an empty directory so a developer's own observations cannot decide these
// results; set before the modules below first resolve the path.
const configDir = mkdtempSync(join(tmpdir(), 'tau-context-windows-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

const { deriveTable, resetCatalogForTests } = await import('../modelPricingCatalog.js')
const { getProviderCatalogContextWindow, recordProviderModelContextWindows } =
  await import('./contextWindows.js')

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// Shaped like models.dev's api.json and trimmed to what these cases need. The
// numbers are the published ones as of September 2026.
const PAYLOAD = {
  'github-copilot': {
    models: {
      'gpt-4.1': { limit: { context: 128_000, input: 128_000, output: 16_384 } },
      'claude-opus-4.7': { limit: { context: 200_000, input: 168_000, output: 32_000 } },
      'gpt-5-mini': { limit: { context: 264_000, input: 128_000, output: 64_000 } },
    },
  },
  opencode: {
    models: {
      'claude-fable-5-1': { limit: { context: 1_000_000, output: 128_000 } },
      'gemini-3.8-flash': { limit: { context: 1_048_576, output: 65_536 } },
    },
  },
  openrouter: {
    models: {
      'openai/gpt-5': { limit: { context: 400_000, input: 272_000, output: 128_000 } },
    },
  },
  openai: {
    models: {
      'gpt-5.5': { limit: { context: 1_050_000, input: 922_000, output: 128_000 } },
    },
  },
  anthropic: {
    models: {
      'claude-sonnet-4-5': { limit: { context: 1_000_000, output: 64_000 } },
    },
  },
}

/** Install a current catalogue, so no lookup here can start a download. */
function useCatalogue(payload: unknown): void {
  resetCatalogForTests(deriveTable(payload, Date.now()))
}

console.log('context windows:')

test('OpenCode Zen claude-fable-5-1 gets its real 1M window, not the 200K default', () => {
  useCatalogue(PAYLOAD)
  const window = getProviderCatalogContextWindow('claude-fable-5-1', 'opencode')
  assert(window === 1_000_000, `expected 1M, got ${window}`)
})

test("Copilot gpt-4.1 gets the 128K Copilot serves, not OpenAI's 1M", () => {
  useCatalogue(PAYLOAD)
  const window = getProviderCatalogContextWindow('gpt-4.1', 'copilot')
  assert(window === 128_000, `expected 128K, got ${window}`)
})

test("the same id on OpenAI keeps OpenAI's own window", () => {
  useCatalogue(PAYLOAD)
  const window = getProviderCatalogContextWindow('gpt-4.1', 'openai')
  assert(window === 1_000_000, `expected 1M, got ${window}`)
})

test('a host that enforces a prompt ceiling reports the ceiling', () => {
  useCatalogue(PAYLOAD)
  const window = getProviderCatalogContextWindow('claude-opus-4.7', 'copilot')
  assert(window === 168_000, `expected 168K, got ${window}`)
})

test('picker variant suffixes resolve to the catalogued id', () => {
  useCatalogue(PAYLOAD)
  const window = getProviderCatalogContextWindow('gemini-3.8-flash-high', 'opencode')
  assert(window === 1_048_576, `expected 1,048,576, got ${window}`)
})

test("the provider's own catalogue still outranks models.dev", () => {
  useCatalogue(PAYLOAD)
  recordProviderModelContextWindows('copilot', [
    { id: 'gpt-5-mini', name: 'GPT-5 mini', contextWindow: 120_000 },
  ])
  const window = getProviderCatalogContextWindow('gpt-5-mini', 'copilot')
  assert(window === 120_000, `expected the live 120K, got ${window}`)
})

test("a provider's whole-window figure is held to the host's prompt ceiling", () => {
  // OpenRouter's own catalogue states gpt-5's whole 400K, but OpenAI rejects
  // a prompt past 272K. Sizing compaction by 400K would let one fail.
  useCatalogue(PAYLOAD)
  recordProviderModelContextWindows('openrouter', [
    { id: 'openai/gpt-5', name: 'GPT-5', contextWindow: 400_000 },
  ])
  const window = getProviderCatalogContextWindow('openai/gpt-5', 'openrouter')
  assert(window === 272_000, `expected the 272K ceiling, got ${window}`)
})

test("a provider's figure already under the ceiling is kept as it is", () => {
  // A backend may serve less than the model allows elsewhere.
  useCatalogue(PAYLOAD)
  recordProviderModelContextWindows('openai', [
    { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272_000 },
  ])
  const window = getProviderCatalogContextWindow('gpt-5.5', 'openai')
  assert(window === 272_000, `expected the provider's 272K, got ${window}`)
})

test("Anthropic's own platforms never take a window from models.dev", () => {
  // models.dev lists Sonnet 4.5 at 1M, which on Anthropic's API needs a beta
  // the session may not send. That decision belongs to getContextWindowForModel.
  useCatalogue(PAYLOAD)
  const window = getProviderCatalogContextWindow('claude-sonnet-4-5', 'firstParty')
  assert(window === undefined, `expected no catalogue answer, got ${window}`)
})

test('a host models.dev does not list still resolves from the static tables', () => {
  useCatalogue(PAYLOAD)
  const window = getProviderCatalogContextWindow('gemini-3.8-flash-high', 'antigravity')
  assert(window === 1_048_576, `expected the Gemini 3 family window, got ${window}`)
})

test('with no catalogue entry an unknown model stays unknown', () => {
  useCatalogue({})
  const window = getProviderCatalogContextWindow('claude-fable-5-1', 'opencode')
  assert(window === undefined, `expected no answer, got ${window}`)
})

if (previousConfigDir === undefined) {
  delete process.env.CLAUDE_CONFIG_DIR
} else {
  process.env.CLAUDE_CONFIG_DIR = previousConfigDir
}
rmSync(configDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
