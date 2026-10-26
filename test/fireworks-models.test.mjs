import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Every mutable store is redirected before the bundle is imported.
const fixture = mkdtempSync(join(tmpdir(), 'tau-fireworks-models-'))
process.env.HOME = fixture
process.env.USERPROFILE = fixture
process.env.LOCALAPPDATA = fixture
process.env.XDG_CACHE_HOME = fixture
process.env.CLAUDE_CONFIG_DIR = fixture
process.env.TAU_COMPAT_THINKING_STORE = join(fixture, 'compat-thinking.json')
process.env.DISABLE_TELEMETRY = '1'
process.env.CLAUDE_CODE_USE_FIREWORKS = '1'
delete process.env.CLAUDEX_DISABLE_MODEL_PRICING
delete process.env.FIREWORKS_MODELS
globalThis.fetch = async url => { throw new Error(`offline test: ${url}`) }

const r = await loadMcpRuntime({
  paths: [
    'src/utils/modelCost.ts', 'src/utils/model/contextWindows.ts', 'src/utils/model/compatEffort.ts',
    'src/utils/model/providerEffort.ts', 'src/lanes/shared/vision_capability.ts',
    'src/utils/modelPricingCatalog.ts', 'src/lanes/openai-compat/transformers/fireworks.ts',
  ],
  exports: [
    'getModelCosts', 'pricedModel', 'getProviderCatalogContextWindow', 'compatEffortLevels',
    'getProviderEffort', 'getNextProviderEffort', 'modelAcceptsImages', 'resetCatalogForTests',
    'deriveTable', 'fireworksTransformer',
  ],
})

const P = 'accounts/fireworks/models/'
const effort = (...values) => [{ type: 'effort', values }]
// The models.dev rows these tests read, as models.dev states them.
const MODELS_DEV = {
  'fireworks-ai': {
    models: {
      [`${P}glm-5p3`]: { reasoning: true, reasoning_options: effort('low', 'high', 'max'), modalities: { input: ['text'] }, limit: { context: 1_048_573 }, cost: { input: 1.4, output: 4.4, cache_read: 0.26 } },
      [`${P}minimax-m3p1-flash`]: { reasoning: true, reasoning_options: effort('low', 'medium', 'high', 'xhigh', 'max'), modalities: { input: ['text', 'image'] }, limit: { context: 1_000_000 }, cost: { input: 0.15, output: 0.6, cache_read: 0.015 } },
      [`${P}ember-1`]: { reasoning: true, reasoning_options: [{ type: 'toggle' }, ...effort('low', 'medium', 'high', 'max'), { type: 'budget_tokens', min: 1024 }], modalities: { input: ['text', 'image'] }, limit: { context: 1_048_576 }, cost: { input: 3, output: 15, cache_read: 0.3 } },
      [`${P}nemotron-lightning-3p5-30b-a3b`]: { reasoning: true, reasoning_options: [{ type: 'toggle' }], modalities: { input: ['text'] }, limit: { context: 262_144 }, cost: { input: 0.05, output: 0.2, cache_read: 0.01 } },
      [`${P}kimi-k3`]: { reasoning: true, reasoning_options: [{ type: 'toggle' }, ...effort('low', 'medium', 'high', 'max')], modalities: { input: ['text', 'image'] }, limit: { context: 1_048_576 }, cost: { input: 3, output: 15, cache_read: 0.3 } },
      'accounts/fireworks/routers/kimi-k3-fast': { reasoning: true, modalities: { input: ['text', 'image'] }, limit: { context: 1_048_576 }, cost: { input: 4.5, output: 22.5, cache_read: 0.45 } },
    },
  },
  anthropic: {
    models: { 'claude-opus-5-5': { cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } } },
  },
}

// A ladder is read once per model per process, so the one test that starts
// without a table runs first, on a model no other test asks about.
test('a thinking ladder read before the table arrived stays for the session', () => {
  r.resetCatalogForTests(null)
  assert.deepEqual(r.compatEffortLevels('fireworks', `${P}glm-5p3-flash`), [])
  r.resetCatalogForTests(r.deriveTable({ 'fireworks-ai': { models: { [`${P}glm-5p3-flash`]: { reasoning: true, reasoning_options: effort('low', 'high', 'max') } } } }, Date.now()))
  assert.deepEqual(r.compatEffortLevels('fireworks', `${P}glm-5p3-flash`), [])
})

test('the picker lists the Fireworks models, with Nexus Auto sent as `auto`', () => {
  r.resetCatalogForTests(r.deriveTable(MODELS_DEV, Date.now()))
  const rows = r.fireworksTransformer.staticCatalog()
  assert.deepEqual(rows.map(row => row.id), [
    'auto',
    `${P}minimax-m3p1-flash`, `${P}deepseek-v4p1-flash-1017`, `${P}ember-1`, `${P}deepseek-v4p1-flash`,
    `${P}glm-5p3`, `${P}glm-5p3-flash`, `${P}mimo-v2p6-pro-rl`, `${P}qwen3p8-flash-next-nvfp4`,
    `${P}nemotron-lightning-3p5-30b-a3b`, `${P}qwen3p8-max`, `${P}kimi-k3`,
  ])
  // MiMo V2.6 Pro RL's page lists function calling as not supported.
  assert.deepEqual(rows.filter(row => !row.supportsToolCalling).map(row => row.id), [`${P}mimo-v2p6-pro-rl`])
})

test('each model offers the thinking values Fireworks documents, else those models.dev states', () => {
  r.resetCatalogForTests(r.deriveTable(MODELS_DEV, Date.now()))
  const levels = id => r.compatEffortLevels('fireworks', id)
  assert.deepEqual(levels('auto'), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(levels(`${P}minimax-m3p1-flash`), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(levels(`${P}minimax-m3`), ['low', 'medium', 'high', 'adaptive'], '`adaptive` stays MiniMax M3 only')
  assert.deepEqual(levels(`${P}ember-1`), ['none', 'low', 'medium', 'high', 'max'])
  assert.deepEqual(levels(`${P}glm-5p3`), ['low', 'high', 'max'])
  assert.deepEqual(levels(`${P}nemotron-lightning-3p5-30b-a3b`), ['none', 'on'])
  assert.deepEqual(levels(`${P}kimi-k3`), ['none', 'low', 'high', 'max'], 'documented tiers over the aliases models.dev lists')
  assert.deepEqual(levels(`${P}deepseek-v4p1-flash`), ['none', 'low', 'high', 'max'])
  assert.deepEqual(levels(`${P}qwen3p8-max`), ['none', 'low', 'medium', 'xhigh'])
  assert.deepEqual(levels(`${P}qwen3p8-flash-next-nvfp4`), [], 'nothing stated: the server default')
  assert.deepEqual(levels(`${P}mimo-v2p6-pro-rl`), [])
})

test('a bare Fireworks name gets what its full path gets', () => {
  r.resetCatalogForTests(r.deriveTable(MODELS_DEV, Date.now()))
  assert.deepEqual(r.compatEffortLevels('fireworks', 'ember-1'), ['none', 'low', 'medium', 'high', 'max'])
  assert.equal(r.modelAcceptsImages('fireworks', 'glm-5p3'), false)
  assert.equal(r.modelAcceptsImages('fireworks', 'minimax-m3p1-flash'), true)
  assert.equal(r.getProviderCatalogContextWindow('glm-5p3', 'fireworks'), 1_048_573)
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  assert.equal(r.getModelCosts('glm-5p3', usage)?.inputTokens, 1.4)
})

test('the picker offers auto (session/settings) before each model\'s levels', () => {
  r.resetCatalogForTests(r.deriveTable(MODELS_DEV, Date.now()))
  const model = `${P}glm-5p3`
  const state = r.getProviderEffort('fireworks', model, 'high')
  assert.deepEqual(state.levels, ['default', 'low', 'high', 'max'])
  assert.equal(state.value, 'high')
  assert.equal(state.source, 'configured', 'inherited from session/settings')
  assert.equal(r.getNextProviderEffort('fireworks', model, 'right', 'high', 'auto'), 'low')
  assert.equal(r.getNextProviderEffort('fireworks', model, 'left', 'high', 'auto'), 'max')
  // A session effort the model does not take falls back to its default.
  assert.equal(r.getProviderEffort('fireworks', model, 'medium').value, 'default')
})

test('vision and context come from models.dev, else from the model page', () => {
  r.resetCatalogForTests(r.deriveTable(MODELS_DEV, Date.now()))
  assert.equal(r.modelAcceptsImages('fireworks', `${P}glm-5p3`), false)
  assert.equal(r.modelAcceptsImages('fireworks', `${P}minimax-m3p1-flash`), true)
  assert.equal(r.modelAcceptsImages('fireworks', 'auto'), true)
  assert.equal(r.modelAcceptsImages('fireworks', `${P}mimo-v2p6-pro-rl`), true)
  assert.equal(r.modelAcceptsImages('fireworks', `${P}qwen3p8-flash-next-nvfp4`), true)
  assert.equal(r.getProviderCatalogContextWindow(`${P}glm-5p3`, 'fireworks'), 1_048_573)
  assert.equal(r.getProviderCatalogContextWindow('auto', 'fireworks'), 1_000_000)
  assert.equal(r.getProviderCatalogContextWindow(`${P}mimo-v2p6-pro-rl`, 'fireworks'), 1_000_000)
  assert.equal(r.getProviderCatalogContextWindow(`${P}qwen3p8-flash-next-nvfp4`, 'fireworks'), 262_144)
})

test('an auto turn is priced at the model that served it', () => {
  r.resetCatalogForTests(r.deriveTable(MODELS_DEV, Date.now()))
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const rates = model => {
    const costs = r.getModelCosts(r.pricedModel('auto', model), usage)
    return costs && [costs.inputTokens, costs.promptCacheReadTokens, costs.outputTokens]
  }
  assert.deepEqual(rates('glm-5p3'), [1.4, 0.26, 4.4])
  assert.deepEqual(rates('kimi-k3-fast'), [4.5, 0.45, 22.5], 'a fast tier bills at its router row')
  assert.deepEqual(rates('claude-opus-5-5'), [4, 0.4, 20], "a closed model bills at its vendor's rate")
  assert.equal(r.pricedModel('auto', undefined), 'auto')
  assert.equal(r.pricedModel(`${P}glm-5p3`, 'something-else'), `${P}glm-5p3`, 'a pinned model is priced as requested')
  assert.deepEqual(
    [r.getModelCosts(`${P}minimax-m3p1-flash`, usage)?.inputTokens, r.getModelCosts(`${P}minimax-m3p1-flash`, usage)?.outputTokens],
    [0.15, 0.6],
  )
  // On-demand only: billed by GPU time, so no per-token price.
  assert.equal(r.getModelCosts(`${P}mimo-v2p6-pro-rl`, usage), null)
})
