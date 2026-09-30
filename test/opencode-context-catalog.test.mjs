import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const tempRoot = realpathSync(tmpdir())
const directory = mkdtempSync(join(tempRoot, 'tau-opencode-context-'))
process.env.CLAUDE_CONFIG_DIR = directory
process.env.TAU_OPENCODE_MODELS_DEV_CACHE = join(directory, 'initial.json')
process.env.DISABLE_TELEMETRY = '1'
delete process.env.CLAUDEX_DISABLE_MODEL_PRICING
delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unexpected network request in catalog fixture') }
test.after(() => {
  globalThis.fetch = originalFetch
  const resolved = realpathSync(directory)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(resolved, { recursive: true, force: true })
})

const r = await loadMcpRuntime({
  paths: ['src/utils/model/opencodeModelsDevCatalog.ts', 'src/utils/model/contextWindows.ts',
    'src/utils/context.ts', 'src/utils/model/providerCatalog.ts', 'src/utils/forcedProvider.ts'],
  exports: ['getOpencodeModelMeta', 'getOpencodeContextWindow', 'deriveOpencodeModelsDevCache',
    'getProviderCatalogContextWindow', 'getContextWindowForModel', 'recordProviderModelContextWindows',
    'loadProviderModels', 'runWithForcedProvider', 'waitForOpencodeModelsDev',
    `installModelList: rows => {
      getProvider = () => ({ listModels: async () => rows });
      resolveProviderAuth = async () => ({ token: 'fixture', method: 'api_key' });
      persistProviderContextWindows = () => {};
    }`],
})
r.installModelList([])
let serial = 0
function seed(payload) {
  const file = join(directory, `catalog-${serial++}.json`)
  writeFileSync(file, JSON.stringify(r.deriveOpencodeModelsDevCache(payload, Date.now())))
  process.env.TAU_OPENCODE_MODELS_DEV_CACHE = file
}
function windowFor(provider, model) {
  return r.runWithForcedProvider({ provider }, () => r.getContextWindowForModel(model))
}
const fixture = {
  opencode: { models: {
    'mimo-v2.6-flash-free': { limit: { context: 200_000, output: 32_000 } },
    'mimo-v2.5-free': { limit: { context: 200_000, output: 32_000 } },
    'longcat-2.5-preview-free': { limit: { context: 1_000_000, output: 131_072 } },
    'qwen3.8-max': { limit: { context: 262_144 } },
    'hy3-free': { limit: { context: 190_000, input: 192_000 } },
    'gpt-5.6-luna': { limit: { context: 1_050_000, input: 922_000 } },
    'space-bunny-free': { limit: { context: 1_048_576, input: 524_288 } },
    'big-pickle': { limit: { context: 200_000, input: 160_000 } },
    'future-model-free': { limit: { context: 765_432 } },
  } },
  'opencode-go': { models: {
    'mimo-v2.6-flash': { limit: { context: 1_048_576 } },
    'mimo-v2.5': { limit: { context: 1_000_000 } },
    'qwen3.8-max': { limit: { context: 1_000_000 } },
  } },
}
test.beforeEach(() => seed(fixture))

test('MiMo free rows retain their published 200K; Go variants use their own windows', () => {
  assert.equal(windowFor('opencode', 'mimo-v2.6-flash-free'), 200_000)
  assert.equal(windowFor('opencode', 'mimo-v2.5-free'), 200_000)
  assert.equal(windowFor('opencodego', 'mimo-v2.6-flash'), 1_048_576)
  assert.equal(windowFor('opencodego', 'mimo-v2.5'), 1_000_000)
  assert.equal(windowFor('opencode', 'qwen3.8-max'), 262_144)
  assert.equal(windowFor('opencodego', 'qwen3.8-max'), 1_000_000)
})

test('fresh model metadata overrides old stored guesses, even with shared capability overrides', () => {
  r.recordProviderModelContextWindows('opencode', [{ id: 'longcat-2.5-preview-free', name: 'LongCat', contextWindow: 200_000 }])
  assert.equal(windowFor('opencode', 'longcat-2.5-preview-free'), 1_000_000)
  assert.equal(windowFor('opencode', 'future-model-free'), 765_432)
  assert.equal(windowFor('opencode', 'mimo-v2.6-flash-free[1m]'), 200_000)
  assert.equal(windowFor('opencode', 'opencode/qwen3.8-max::effort=high'), 262_144)
})

test('compaction respects a separate input ceiling without inflating smaller windows', () => {
  assert.equal(windowFor('opencode', 'gpt-5.6-luna'), 922_000)
  assert.equal(windowFor('opencode', 'space-bunny-free'), 524_288)
  assert.equal(windowFor('opencode', 'big-pickle'), 160_000)
  assert.equal(windowFor('opencode', 'hy3-free'), 190_000)
})

test('the model picker records limits after metadata has loaded', async () => {
  for (const [provider, source] of [['opencode', 'opencode'], ['opencodego', 'opencode-go']]) {
    const rows = Object.keys(fixture[source].models).map(id => ({ id, name: id, contextWindow: 200_000 }))
    r.installModelList(rows)
    const listed = await r.loadProviderModels(provider)
    for (const model of listed) {
      const limit = fixture[source].models[model.id].limit
      assert.equal(model.contextWindow, Math.min(limit.context, limit.input ?? Infinity), model.id)
    }
  }
})

test('OpenCode metadata cannot override another provider with the same model id', () => {
  const model = 'future-model-free'
  r.recordProviderModelContextWindows('groq', [{ id: model, name: model, contextWindow: 80_000 }])
  assert.equal(r.getProviderCatalogContextWindow(model, 'groq'), 80_000)
  assert.equal(windowFor('opencode', model), 765_432)
})

test('v2 cache refreshes within the TTL to obtain context limits', async () => {
  const file = join(directory, `catalog-${serial++}.json`)
  writeFileSync(file, JSON.stringify({ version: 2, fetchedAt: Date.now(), providers: {
    opencode: { 'future-model-free': { r: true, e: ['low', 'high'] } },
  } }))
  process.env.TAU_OPENCODE_MODELS_DEV_CACHE = file
  assert.equal(r.getOpencodeModelMeta('opencode', 'future-model-free').reasoning, true)
  const savedFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async url => {
    assert.equal(url, 'https://models.dev/api.json')
    calls++
    return Response.json(fixture)
  }
  try {
    await r.waitForOpencodeModelsDev(500)
    assert.equal(calls, 1)
    assert.equal(windowFor('opencode', 'future-model-free'), 765_432)
  } finally { globalThis.fetch = savedFetch }
})

test('offline v2 migration preserves existing route capabilities', async () => {
  const file = join(directory, `catalog-${serial++}.json`)
  writeFileSync(file, JSON.stringify({ version: 2, fetchedAt: Date.now(), providers: {
    opencode: { 'offline-model': { r: true, s: 'anthropic' } },
  } }))
  process.env.TAU_OPENCODE_MODELS_DEV_CACHE = file
  await r.waitForOpencodeModelsDev(500)
  assert.equal(r.getOpencodeModelMeta('opencode', 'offline-model').sdk, 'anthropic')
})

if (process.env.TAU_OPENCODE_LIVE_AUDIT === '1') {
  test('every live models.dev Zen/Go row resolves to its published limits', async t => {
    const response = await originalFetch('https://models.dev/api.json', { signal: AbortSignal.timeout(60_000) })
    assert.equal(response.ok, true)
    const payload = await response.json()
    seed(payload)
    for (const [provider, source] of [['opencode', 'opencode'], ['opencodego', 'opencode-go']]) {
      const models = payload[source].models
      assert.ok(Object.keys(models).length > 0)
      for (const [id, model] of Object.entries(models)) {
        const expected = Math.min(model.limit.context, model.limit.input ?? Infinity)
        assert.equal(windowFor(provider, id), expected, `${provider}/${id}`)
        assert.equal(r.getOpencodeModelMeta(provider, id).contextWindow, model.limit.context)
      }
      t.diagnostic(`${source}: ${Object.keys(models).length} model limits match models.dev`)
    }
  })
}
