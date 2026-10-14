import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Exercise the shipped resolver, picker adapter and request transformers offline.
// Every mutable store is redirected before the bundle is imported.
const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-provider-effort-'))
const storeNames = ['DEEPSEEK', 'DIRECT', 'CLINE', 'COMMANDCODE', 'CLOUDFLARE',
  'LXD', 'MIMO', 'ALIBABA', 'OPENROUTER', 'OPENCODE', 'COMPAT']
process.env.CLAUDE_CONFIG_DIR = fixture
process.env.DISABLE_TELEMETRY = '1'
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG = '1'
process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'
process.env.TAU_DIRECT_MODEL_CATALOG_STORE = join(fixture, 'direct-catalog.json')
process.env.TAU_CLINE_MODELS_DEV_CACHE = join(fixture, 'cline-catalog.json')
process.env.TAU_OPENCODE_MODELS_DEV_CACHE = join(fixture, 'opencode-catalog.json')
for (const name of storeNames) process.env[`TAU_${name}_THINKING_STORE`] = join(fixture, `${name}.json`)
for (const name of ['CLAUDE_CODE_EFFORT_LEVEL', 'GLM_BASE_URL', 'MOONSHOT_BASE_URL',
  'MINIMAX_BASE_URL', 'DASHSCOPE_BASE_URL', 'ALIBABA_BASE_URL', 'MODELSTUDIO_BASE_URL']) delete process.env[name]
assert.match(readFileSync('src/utils/model/commandCodeThinking.ts', 'utf8'), /TAU_COMMANDCODE_THINKING_STORE/,
  'CommandCode must support a fixture store before these tests can run safely')
writeFileSync(join(fixture, 'settings.json'), JSON.stringify({ effortLevel: 'xhigh' }))
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Provider effort tests must not access the network') }

const r = await loadMcpRuntime({
  paths: ['src/utils/model/providerEffort.ts', 'src/lanes/openai-compat/transformers/index.ts',
    'src/utils/settings/settingsCache.ts', 'src/utils/model/openaiReasoning.ts', 'src/lanes/kilo/loop.ts',
    'src/lanes/cline/loop.ts', 'src/services/api/providers/providerShim.ts',
    'src/commands/effort/effort.tsx', 'src/components/EffortIndicator.ts', 'src/components/EffortCallout.tsx'],
  exports: ['API_PROVIDERS', 'getProviderEffort', 'usesProviderEffort', 'executeProviderEffort',
    'getProviderEffortPreview', 'getNextProviderEffort', 'commitProviderEffortSelection',
    'getInheritedEffort', 'selectInheritedEffort', 'setSessionSettingsCache', 'getSessionSettingsCache',
    'getCompatEffort', 'getCompatRequestEffort', 'compatEffortLevels',
    'getTransformer', 'getCommandCodeRequestEffort', 'getOpenAIReasoningLevel', 'setOpenAIReasoningLevel',
    'KiloLane', 'ClineLane', 'CompatChatProvider', 'CommandCodeProvider', 'GroqProvider',
    'DeepSeekProvider', 'LxdProvider', 'MimoProvider', 'AlibabaProvider', 'OpenRouterProvider',
    'GlmProvider', 'MoonshotProvider', 'MiniMaxProvider', 'showCurrentEffort', 'getEffortSuffix', 'getEffortNotificationText', 'shouldShowEffortCallout',
    'anthropicMessagesToOpenAI',
    `withProvider: (provider, fn) => { const previous = getAPIProvider; try { getAPIProvider = () => provider; return fn(); } finally { getAPIProvider = previous; } }`,
    `installCatalogFixtures: () => {
      // Catalog refresh/parsing has its own suites. Fix capability inputs here
      // so a developer's downloaded metadata cannot change wire expectations.
      getOpenRouterReasoningMeta = model => model === 'fixture/reasoning' ? {
        mandatory: false, defaultEnabled: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'medium', supportsMaxTokens: false,
      } : undefined;
      getAlibabaModelMeta = model => model === 'qwen3.8-max' ? {
        id: model, name: model, contextWindow: 1000000, maxOutputTokens: 131072,
        reasoning: true, toggle: true, efforts: ['low', 'medium', 'xhigh'],
        tools: true, vision: true, released: '', described: true,
      } : undefined;
      getClineModelMeta = model => model === 'fixture/reasoning' ? {
        reasoning: true, toggle: false, canTurnOff: false, efforts: ['low', 'high', 'max'],
      } : model === 'fixture/fixed' ? {
        reasoning: true, toggle: false, canTurnOff: false, efforts: [],
      } : undefined;
      getOpencodeModelMeta = (provider, model) => model === 'gpt-6-luna' ? {
        reasoning: true, toggle: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      } : model === 'glm-5.2' ? {
        reasoning: true, toggle: false, efforts: ['high', 'max'],
        replaysReasoningContent: true,
      } : model === 'step-5-preview-free' ? {
        reasoning: true, toggle: false, efforts: ['low', 'medium', 'high'],
        replaysReasoningContent: true,
      } : undefined;
    }`],
})
r.installCatalogFixtures()

test.after(() => {
  globalThis.fetch = originalFetch
  const resolved = realpathSync(fixture)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup')
  rmSync(resolved, { recursive: true, force: true })
})

function configure(effortLevel) {
  r.setSessionSettingsCache({ settings: { effortLevel }, errors: [] })
}
test.beforeEach(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  configure(undefined)
  r.setOpenAIReasoningLevel(undefined)
})

const excluded = ['firstParty', 'bedrock', 'vertex', 'foundry', 'openai', 'gemini', 'antigravity']
// Each adjustable provider has a concrete wire case, including Cline Pass.
const cases = [
  ['openrouter', 'fixture/reasoning', 'low', 'high'],
  ['agentrouter', 'claude-opus-4-6', 'low', 'high'],
  ['modelrouter', 'gpt-5.4', 'low', 'high'],
  ['vercel', 'openai/gpt-5.4', 'low', 'high'],
  ['requesty', 'openai/gpt-5.4', 'low', 'high'],
  ['opencode', 'gpt-6-luna', 'low', 'xhigh'],
  ['opencodego', 'glm-5.2', 'high', 'max'],
  ['commandcode', 'gpt-5.5', 'low', 'high'],
  ['lxd', 'gpt-oss-120b', 'low', 'high'],
  ['mimo', 'mimo-v2.6-pro', 'low', 'high'],
  ['fireworks', 'accounts/fireworks/models/gpt-oss-120b', 'low', 'high'],
  ['cloudflare', '@cf/openai/gpt-oss-120b', 'low', 'high'],
  ['groq', 'openai/gpt-oss-120b', 'low', 'high'],
  ['mistral', 'zai-glm-5-3', 'low', 'high'],
  ['deepseek', 'deepseek-v4-pro', 'low', 'high'],
  ['glm', 'glm-5.3', 'low', 'high'],
  ['moonshot', 'kimi-k3', 'low', 'high'],
  ['alibaba', 'qwen3.8-max', 'low', 'xhigh'],
  ['cline', 'fixture/reasoning', 'low', 'high'],
  ['clinepass', 'fixture/reasoning', 'low', 'max'],
  ['kilocode', 'openai/gpt-5.4', 'low', 'high'],
]
const noEffortProviders = ['nim', 'minimax', 'ollama', 'lmstudio', 'copilot', 'cursor', 'iflow', 'kiro']

function body(model) {
  return { model, messages: [
    { role: 'system', content: [{ type: 'text', text: 'Stable instructions', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: 'Read the fixture' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'Read', arguments: '{"path":"fixture.txt"}' } }] },
    { role: 'tool', tool_call_id: 'fixture-call', content: 'fixture data' },
    { role: 'user', content: 'Explain it' },
  ], tools: [{ type: 'function', function: { name: 'Read', description: 'Read a fixture', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  stream: true, max_tokens: 1024, prompt_cache_key: 'stable-session' }
}
function transformed(provider, model, effortValue, overrides = {}) {
  return r.getTransformer(provider === 'clinepass' ? 'cline' : provider).transformRequest(body(model), {
    provider, model, isReasoning: true, reasoningEffort: 'medium', effortValue,
    sessionId: 'stable-session', ...overrides,
  })
}
function wireEffort(provider, model, fallback) {
  if (provider === 'commandcode') return r.getCommandCodeRequestEffort(model, fallback)
  const request = transformed(provider, model, fallback)
  return request.reasoning_effort ?? request.reasoning?.effort
}
function stores() {
  return Object.fromEntries(storeNames.map(name => {
    const path = process.env[`TAU_${name}_THINKING_STORE`]
    return [name, existsSync(path) ? readFileSync(path, 'utf8') : null]
  }))
}

test('every registered provider has an explicit effort policy, with excluded lanes delegated unchanged', () => {
  assert.deepEqual([...r.API_PROVIDERS].sort(), [...excluded, ...cases.map(row => row[0]), ...noEffortProviders].sort())
  for (const provider of excluded) {
    assert.equal(r.usesProviderEffort(provider), false, provider)
    assert.equal(r.getProviderEffort(provider, 'gpt-6-luna', 'xhigh'), null, provider)
    assert.equal(r.executeProviderEffort(provider, 'gpt-6-luna', 'low', 'xhigh'), null, provider)
    assert.equal(r.commitProviderEffortSelection(provider, 'gpt-6-luna', 'low'), false, provider)
  }
  for (const provider of r.API_PROVIDERS.filter(p => !excluded.includes(p))) {
    r.withProvider(provider, () => assert.equal(r.shouldShowEffortCallout('claude-opus-4-8'), false))
  }
})

for (const [provider, model, configured, selected] of cases) {
  test(`${provider}: picker choice wins settings and /effort, auto inherits without changing global state`, () => {
    configure(configured)
    r.executeProviderEffort(provider, model, 'auto', configured)
    let state = r.getProviderEffort(provider, model, configured)
    assert.equal(state.supported, true)
    assert.equal(state.value, configured)
    assert.equal(state.source, 'configured')
    assert.equal(wireEffort(provider, model, configured), configured)
    const settingsBefore = structuredClone(r.getSessionSettingsCache())
    const result = r.executeProviderEffort(provider, model, selected, configured)
    assert.equal(result.effortUpdate, undefined, 'native selection must not overwrite AppState/global effort')
    state = r.getProviderEffort(provider, model, configured)
    assert.equal(state.value, selected)
    assert.equal(state.source, 'model')
    assert.equal(wireEffort(provider, model, configured), selected)
    assert.match(r.executeProviderEffort(provider, model, '', configured).message, new RegExp(selected))
    assert.equal(wireEffort(provider, model, null), selected, 'explicit model choice also beats unset fallback')
    r.executeProviderEffort(provider, model, 'auto', configured)
    assert.equal(r.getProviderEffort(provider, model, configured).source, 'configured')
    assert.equal(wireEffort(provider, model, configured), configured)
    assert.deepEqual(r.getSessionSettingsCache(), settingsBefore)
  })
}

test('fresh settings are read at use time, null suppresses inheritance and unsupported tiers are not fabricated', () => {
  r.executeProviderEffort('mimo', 'mimo-v2.6-pro', 'auto', null)
  configure('high')
  assert.equal(wireEffort('mimo', 'mimo-v2.6-pro', undefined), 'high')
  configure('low')
  assert.equal(wireEffort('mimo', 'mimo-v2.6-pro', undefined), 'low')
  assert.equal(wireEffort('mimo', 'mimo-v2.6-pro', null), 'medium')
  assert.equal(wireEffort('mimo', 'mimo-v2.6-pro', 'xhigh'), 'medium')
  assert.equal(r.getProviderEffort('mimo', 'mimo-v2.6-pro', 'xhigh').source, 'default')
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
  assert.equal(r.getInheritedEffort(), 'high')
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
  assert.equal(r.getInheritedEffort(), undefined)
})

test('Auto honors environment effort with concrete/unset request fallbacks while a manual model choice wins', () => {
  const provider = 'mimo', model = 'mimo-v2.6-pro'
  r.executeProviderEffort(provider, model, 'auto', null)
  configure('low')
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
  for (const fallback of ['low', null, undefined]) {
    assert.equal(r.getInheritedEffort(fallback), 'high')
    assert.equal(wireEffort(provider, model, fallback), 'high')
    assert.equal(r.getProviderEffort(provider, model, fallback).value, 'high')
  }
  r.executeProviderEffort(provider, model, 'low', 'high')
  assert.equal(wireEffort(provider, model, 'high'), 'low', 'manual model effort overrides inherited environment')
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
  assert.equal(wireEffort(provider, model, 'high'), 'low', 'manual model effort remains explicit when environment is Auto')
  r.executeProviderEffort(provider, model, 'auto', null)
  for (const fallback of ['high', null, undefined]) {
    assert.equal(r.getInheritedEffort(fallback), undefined)
    assert.equal(wireEffort(provider, model, fallback), 'medium', 'Auto environment suppresses configured effort')
  }
})

test('unknown and fixed models report no adjustable effort and do not get invented reasoning tiers', () => {
  for (const provider of r.API_PROVIDERS.filter(p => !excluded.includes(p))) {
    const model = provider === 'minimax' ? 'MiniMax-M2.7' : 'fixture-plain-chat'
    const state = r.getProviderEffort(provider, model, 'high')
    assert.equal(state.supported, false, provider)
    assert.equal(state.levels.length, 0, provider)
    assert.doesNotMatch(r.executeProviderEffort(provider, model, '', 'high').message, /Current effort level: (low|medium|high)/, provider)
    if (['commandcode', 'cursor', 'kiro'].includes(provider)) continue
    const request = transformed(provider, model, 'high', { isReasoning: false, reasoningEffort: null })
    assert.equal(request.reasoning_effort, undefined, provider)
    assert.equal(request.reasoning?.effort, undefined, provider)
  }
  assert.match(r.getProviderEffort('minimax', 'MiniMax-M2.7', 'high').label, /always on/)
})

test('toggle-only models expose on/off without pretending the setting is a numeric effort', () => {
  for (const [provider, model] of [['glm', 'glm-5.1'], ['moonshot', 'kimi-k2.6'], ['minimax', 'MiniMax-M3']]) {
    const state = r.getProviderEffort(provider, model, 'high')
    assert.deepEqual(state.levels, ['off', 'on'])
    r.executeProviderEffort(provider, model, 'off', 'high')
    assert.match(r.getProviderEffort(provider, model, 'high').label, /off/)
    assert.equal(transformed(provider, model, 'high').thinking.type, 'disabled')
    r.executeProviderEffort(provider, model, 'on', 'low')
    const request = transformed(provider, model, 'low')
    assert.equal(request.thinking.type, provider === 'minimax' ? 'adaptive' : 'enabled')
    assert.equal(request.reasoning_effort, undefined)
    r.executeProviderEffort(provider, model, 'auto', null)
  }
})

test('Fireworks uses effective model tiers and only translates binary On at the wire boundary', () => {
  const prefix = 'accounts/fireworks/models/'
  assert.deepEqual(r.compatEffortLevels('fireworks', `${prefix}glm-5p2`), ['none', 'high', 'max'])
  assert.deepEqual(r.compatEffortLevels('fireworks', `${prefix}qwen3p8-max`), ['none', 'low', 'medium', 'xhigh'])
  assert.deepEqual(r.compatEffortLevels('fireworks', `${prefix}deepseek-v4-pro`), ['none', 'low', 'high', 'max'])
  const model = `${prefix}glm-5p1`
  assert.deepEqual(r.getProviderEffort('fireworks', model, 'high').levels, ['default', 'none', 'on'])
  r.executeProviderEffort('fireworks', model, 'on', 'high')
  assert.equal(r.getProviderEffort('fireworks', model, 'high').value, 'on')
  assert.match(r.getProviderEffort('fireworks', model, 'high').label, /on/)
  assert.equal(wireEffort('fireworks', model, 'high'), 'medium')
  r.executeProviderEffort('fireworks', model, 'none', 'high')
  assert.equal(wireEffort('fireworks', model, 'high'), 'none')
  r.executeProviderEffort('fireworks', model, 'auto', null)
  assert.equal(r.getProviderEffort('fireworks', `${prefix}qwen3-coder`, 'high').supported, false)
})

test('gateway chat models have no effort control and Pro models reject unsupported low effort', () => {
  for (const provider of ['modelrouter', 'vercel', 'requesty', 'kilocode']) {
    const chat = 'openai/gpt-5.3-chat-latest'
    assert.equal(r.getProviderEffort(provider, chat, 'high').supported, false, provider)
    assert.equal(wireEffort(provider, chat, 'high'), undefined, provider)
    assert.deepEqual(r.compatEffortLevels(provider, 'openai/gpt-5-pro'), ['high'])
    assert.equal(wireEffort(provider, 'openai/gpt-5-pro', 'low'), undefined, provider)
  }
})

test('picker previews and cancelled/model-only selections cannot persist or mutate another model', () => {
  const provider = 'mimo', model = 'mimo-v2.6-pro', other = 'mimo-v2.6-flash'
  r.executeProviderEffort(provider, model, 'auto', 'low')
  r.executeProviderEffort(provider, other, 'auto', 'low')
  const before = stores()
  assert.equal(r.getProviderEffortPreview(provider, model, 'low', 'high').value, 'high')
  assert.equal(r.getNextProviderEffort(provider, model, 'right', 'low'), 'medium')
  assert.equal(r.commitProviderEffortSelection(provider, model, undefined), false)
  assert.equal(r.commitProviderEffortSelection(provider, model, 'high', false), false)
  assert.deepEqual(stores(), before)
  assert.equal(wireEffort(provider, model, 'low'), 'low')
  assert.equal(r.commitProviderEffortSelection(provider, model, 'high'), true)
  assert.equal(wireEffort(provider, model, 'low'), 'high')
  assert.equal(wireEffort(provider, other, 'low'), 'low')
  assert.equal(r.commitProviderEffortSelection(provider, model, 'auto'), true)
})

test('concurrent parent/agent fallbacks remain request-local and do not capture settings or change stores', async () => {
  const provider = 'mimo', model = 'mimo-v2.6-pro'
  r.executeProviderEffort(provider, model, 'auto', null)
  configure('xhigh')
  const before = stores()
  const values = await Promise.all(['low', 'high', 'medium', 'low'].map(async effort => {
    await Promise.resolve()
    return wireEffort(provider, model, effort)
  }))
  assert.deepEqual(values, ['low', 'high', 'medium', 'low'])
  assert.equal(r.getSessionSettingsCache().settings.effortLevel, 'xhigh')
  assert.deepEqual(stores(), before)
  assert.equal(r.getProviderEffort(provider, model, null).explicit, false)
})

test('provider selections cannot overwrite the prior OpenAI xhigh preference', () => {
  configure('xhigh')
  r.setOpenAIReasoningLevel('xhigh')
  r.executeProviderEffort('mimo', 'mimo-v2.6-pro', 'low', 'xhigh')
  assert.equal(wireEffort('mimo', 'mimo-v2.6-pro', 'xhigh'), 'low')
  assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), 'xhigh')
  assert.equal(r.getSessionSettingsCache().settings.effortLevel, 'xhigh')
  assert.equal(JSON.parse(readFileSync(join(fixture, 'settings.json'), 'utf8')).effortLevel, 'xhigh')
  r.executeProviderEffort('mimo', 'mimo-v2.6-pro', 'auto', null)
})

test('effort changes preserve serialized prompt/tool order and provider cache affinity fields', () => {
  for (const [provider, model, configured, selected] of cases.filter(row => row[0] !== 'commandcode')) {
    r.executeProviderEffort(provider, model, 'auto', null)
    const first = transformed(provider, model, configured)
    const second = transformed(provider, model, selected)
    assert.equal(JSON.stringify(first.messages), JSON.stringify(second.messages), `${provider}: prompt prefix`)
    assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools), `${provider}: tools`)
    for (const key of ['session_id', 'prompt_cache_key', 'prompt_cache_retention', 'provider', 'user']) {
      assert.deepEqual(first[key], second[key], `${provider}: ${key}`)
    }
  }
})

test('dedicated Kilo request builder obeys the same request-scoped choice as its compat fallback', () => {
  const provider = 'kilocode', model = 'openai/gpt-5.4'
  r.executeProviderEffort(provider, model, 'auto', null)
  const build = effortValue => r.KiloLane.prototype._buildRequestBody({
    model, messages: body(model).messages, tools: body(model).tools, maxTokens: 1024,
    effortValue, thinking: { type: 'enabled', budget_tokens: 16000 },
  })
  assert.equal(build('low').reasoning.effort, 'low')
  assert.equal(build(null).reasoning, undefined, 'thinking budget must not silently replace Auto')
  r.executeProviderEffort(provider, model, 'high', 'low')
  assert.equal(build('low').reasoning.effort, 'high')
  r.executeProviderEffort(provider, model, 'auto', null)
})

test('dedicated Cline builder and command/notification read the same selected effort', () => {
  const provider = 'cline', model = 'fixture/reasoning'
  r.executeProviderEffort(provider, model, 'high', 'low')
  const request = r.ClineLane.prototype._buildRequestBody({
    model, messages: body(model).messages, tools: body(model).tools, maxTokens: 1024,
    effortValue: 'low', promptCache: true,
  })
  assert.equal(request.reasoning.effort, 'high')
  assert.equal(request.reasoning_effort, 'high')
  assert.deepEqual(request.cache_control, { type: 'ephemeral' })
  r.withProvider(provider, () => {
    assert.match(r.showCurrentEffort('low', model).message, /high.*selected for this model/)
    assert.equal(r.getEffortSuffix(model, 'low'), ' with high effort')
    assert.match(r.getEffortNotificationText('low', model), /^high/)
  })
  r.executeProviderEffort(provider, model, 'auto', null)
})

test('missing OpenRouter metadata does not turn an inherited low setting into budget-derived medium', () => {
  const model = 'openai/gpt-5.4'
  assert.equal(r.getProviderEffort('openrouter', model, 'low').supported, false)
  assert.equal(transformed('openrouter', model, 'low').reasoning, undefined)
  assert.equal(transformed('openrouter', model, null).reasoning, undefined)
})

test('legacy transports send native selections in streaming and non-streaming requests', async () => {
  const legacy = [
    ['groq', 'openai/gpt-oss-120b', r.GroqProvider],
    ['deepseek', 'deepseek-v4-pro', r.DeepSeekProvider],
    ['lxd', 'gpt-oss-120b', r.LxdProvider],
    ['mimo', 'mimo-v2.6-pro', r.MimoProvider],
    ['openrouter', 'fixture/reasoning', r.OpenRouterProvider],
    ['alibaba', 'qwen3.8-max', r.AlibabaProvider, 'xhigh'],
    ['glm', 'glm-5.3', r.GlmProvider],
    ['moonshot', 'kimi-k3', r.MoonshotProvider],
    ['commandcode', 'gpt-5.5', r.CommandCodeProvider],
    ...['modelrouter', 'vercel', 'requesty', 'opencode', 'opencodego', 'fireworks', 'cloudflare'].map(provider => {
      const row = cases.find(row => row[0] === provider)
      return [provider, row[1], null, row[3]]
    }),
  ]
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /\/chat\/completions$/)
    const request = JSON.parse(opts.body)
    requests.push(request)
    const response = request.stream
      ? `data: ${JSON.stringify({ id: 'fixture', model: request.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ id: 'fixture', model: request.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    return new Response(response, { headers: { 'Content-Type': request.stream ? 'text/event-stream' : 'application/json' } })
  }
  try {
    configure('xhigh')
    r.setOpenAIReasoningLevel('xhigh')
    for (const [provider, model, Provider, level = 'high'] of legacy) {
      const config = { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' }
      const instance = Provider ? new Provider(config) : new r.CompatChatProvider(provider, config)
      assert.equal(instance.name, provider, 'a legacy gateway must never identify itself as OpenAI')
      r.executeProviderEffort(provider, model, level, 'low')
      for (const stream of [false, true]) {
        const params = { model, system: 'Stable instructions', messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 64, sessionId: 'legacy-effort-fixture', effortValue: 'low' }
        if (stream) {
          const result = await instance.stream(params)
          for await (const event of result) { /* fully consume the intercepted stream */ }
        } else await instance.create(params)
        const request = requests.at(-1)
        assert.equal(request.reasoning_effort ?? request.reasoning?.effort, level, `${provider} stream=${stream}`)
      }
      r.executeProviderEffort(provider, model, 'auto', null)
    }
    // Off must survive the legacy CommandCode finalize hook, not disappear
    // and let a thinking-enabled server default take over.
    r.executeProviderEffort('commandcode', 'gpt-5.5', 'none', 'high')
    await new r.CommandCodeProvider({ apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' }).create({
      model: 'gpt-5.5', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 64, effortValue: 'high',
    })
    assert.equal(requests.at(-1).reasoning_effort, 'none')
    r.executeProviderEffort('commandcode', 'gpt-5.5', 'auto', null)
    assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), 'xhigh')
  } finally { globalThis.fetch = previousFetch }
})

test('native compat lanes forward model choices and isolate concurrent request fallbacks', async () => {
  const lane = new r.OpenAICompatLane()
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, opts) => {
    const request = JSON.parse(opts.body)
    requests.push(request)
    const events = String(url).endsWith('/responses')
      ? [{ type: 'response.completed', response: { id: 'fixture', model: request.model, output: [], usage: { input_tokens: 1, output_tokens: 1 } } }]
      : [{ id: 'fixture', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const send = async (provider, model, effortValue, sessionId) => {
    for await (const event of lane.streamAsProvider({
      providerHint: provider, model, effortValue, sessionId,
      system: 'Stable instructions', tools: [], messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64, thinking: { type: 'enabled', budget_tokens: 16000 },
      signal: new AbortController().signal,
    })) { /* consume to serialize the real native request */ }
  }
  const nativeCases = cases.filter(([provider]) => !['cline', 'clinepass', 'kilocode', 'commandcode'].includes(provider))
  try {
    for (const [provider, model, configured, selected] of nativeCases) {
      lane.registerProvider(provider, 'fixture-key', 'https://fixture.invalid/v1')
      r.executeProviderEffort(provider, model, selected, configured)
      await send(provider, model, configured, `effort-native-${provider}`)
      const request = requests.at(-1)
      assert.equal(request.reasoning_effort ?? request.reasoning?.effort, selected, provider)
      r.executeProviderEffort(provider, model, 'auto', null)
    }
    const before = stores()
    requests.length = 0
    await Promise.all(['low', 'high'].map((effort, i) => send('mimo', 'mimo-v2.6-pro', effort, `effort-worker-${i}`)))
    assert.deepEqual(requests.map(body => body.reasoning_effort).sort(), ['high', 'low'])
    assert.deepEqual(stores(), before)
  } finally {
    globalThis.fetch = previousFetch
    for (const [provider] of nativeCases) lane.unregisterProvider(provider)
  }
})

function reasoningHistoryParams(model, effortValue, sessionId) {
  return {
    model, effortValue, sessionId, max_tokens: 128,
    system: 'Stable instructions for the cache regression fixture',
    tools: [{ name: 'Read', description: 'Read a fixture',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    messages: [
      { role: 'user', content: 'Read the fixture' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will read that file.' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'The saved reasoning for this tool call.' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'cache-fixture-call', name: 'Read', input: { path: 'fixture.txt' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'cache-fixture-call', content: 'fixture contents' },
        { type: 'text', text: 'Explain those contents' },
      ] },
    ],
  }
}

async function withInterceptedChatRequests(run) {
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /\/chat\/completions$/)
    const request = JSON.parse(opts.body)
    requests.push({ body: request, headers: Object.fromEntries(new Headers(opts.headers)) })
    const response = request.stream
      ? `data: ${JSON.stringify({ id: 'cache-fixture', model: request.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ id: 'cache-fixture', model: request.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    return new Response(response, { headers: { 'Content-Type': request.stream ? 'text/event-stream' : 'application/json' } })
  }
  try { return await run(requests) }
  finally { globalThis.fetch = previousFetch }
}

function assertStableReplay(first, next, label, { ignoreReasoning = false, expectReasoning = true } = {}) {
  const prefix = messages => JSON.stringify(ignoreReasoning
    ? messages.map(({ reasoning_content, ...message }) => message) : messages)
  assert.equal(prefix(next.messages), prefix(first.messages), `${label}: serialized prompt prefix`)
  assert.equal(JSON.stringify(next.tools), JSON.stringify(first.tools), `${label}: serialized tools`)
  for (const key of ['session_id', 'prompt_cache_key', 'prompt_cache_retention', 'provider', 'user']) {
    assert.deepEqual(next[key], first[key], `${label}: ${key}`)
  }
  const assistant = next.messages.find(message => message.tool_calls?.some(call => call.id === 'cache-fixture-call'))
  assert.equal(assistant?.reasoning_content, expectReasoning ? 'The saved reasoning for this tool call.' : undefined, `${label}: replayed reasoning`)
  const assistantIndex = next.messages.indexOf(assistant)
  assert.equal(next.messages[assistantIndex + 1]?.role, 'tool', `${label}: tool adjacency`)
  assert.equal(next.messages[assistantIndex + 1]?.tool_call_id, 'cache-fixture-call', `${label}: tool identity`)
}

test('native Step Auto/manual selections preserve the complete prompt prefix and cache affinity', async () => {
  const provider = 'opencode', model = 'step-5-preview-free', sessionId = 'step-effort-cache-fixture'
  const lane = new r.OpenAICompatLane()
  lane.registerProvider(provider, 'fixture-key', 'https://fixture.invalid/v1')
  try {
    await withInterceptedChatRequests(async requests => {
      const send = async effortValue => {
        for await (const event of lane.streamAsProvider({
          ...reasoningHistoryParams(model, effortValue, sessionId), providerHint: provider,
          thinking: { type: 'enabled', budget_tokens: 16000 }, signal: new AbortController().signal,
        })) { /* intercept the complete native request */ }
        return requests.at(-1)
      }
      configure('low')
      r.executeProviderEffort(provider, model, 'auto', 'low')
      const autoLow = await send('low')
      assert.equal(autoLow.body.reasoning_effort, 'low')
      assert.equal(autoLow.body.prompt_cache_key, autoLow.headers['x-opencode-session'])
      assert.match(autoLow.body.prompt_cache_key, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      r.executeProviderEffort(provider, model, 'low', 'low')
      assert.deepEqual((await send('low')).body, autoLow.body, 'Auto Low and manual Low are identical requests')
      r.executeProviderEffort(provider, model, 'high', 'low')
      const manualHigh = await send('low')
      assert.equal(manualHigh.body.reasoning_effort, 'high')
      assertStableReplay(autoLow.body, manualHigh.body, 'manual High')
      r.executeProviderEffort(provider, model, 'auto', null)
      for (const effort of ['medium', 'high', null, 'max']) {
        configure(effort ?? undefined)
        const request = await send(effort)
        assert.equal(request.body.reasoning_effort, effort === 'max' || effort === null ? undefined : effort)
        assertStableReplay(autoLow.body, request.body, `Auto ${effort ?? 'unconfigured'}`)
        assert.equal(request.headers['x-opencode-session'], autoLow.headers['x-opencode-session'])
        assert.equal(request.headers['x-opencode-request'], autoLow.headers['x-opencode-request'])
      }
    })
  } finally {
    lane.unregisterProvider(provider)
    r.executeProviderEffort(provider, model, 'auto', null)
  }
})

test('native OpenCode without catalog metadata replays history independently of request/global effort', async () => {
  const provider = 'opencode', model = 'glm-5.1', sessionId = 'opencode-legacy-replay-fixture'
  const lane = new r.OpenAICompatLane()
  lane.registerProvider(provider, 'fixture-key', 'https://fixture.invalid/v1')
  r.executeProviderEffort(provider, model, 'auto', null)
  try {
    await withInterceptedChatRequests(async requests => {
      const send = async effortValue => {
        for await (const event of lane.streamAsProvider({
          ...reasoningHistoryParams(model, effortValue, sessionId), providerHint: provider,
          signal: new AbortController().signal,
        })) { /* intercept the complete native request */ }
        return requests.at(-1).body
      }
      configure(undefined)
      const high = await send('high')
      assert.equal(high.thinking.type, 'enabled')
      assertStableReplay(high, high, 'request High, no global effort')
      configure('high')
      const automatic = await send(null)
      assert.equal(automatic.thinking.type, 'disabled')
      assertStableReplay(high, automatic, 'request default, global High')
      configure(undefined)
      assertStableReplay(high, await send(null), 'request default, no global effort')
    })
  } finally { lane.unregisterProvider(provider) }
})

test('legacy DeepSeek preserves base message structure across off/on and carries required tool reasoning when enabled', async () => {
  const model = 'deepseek-v4-pro'
  const instance = new r.DeepSeekProvider({ apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' })
  try {
    await withInterceptedChatRequests(async requests => {
      let first
      for (const effort of ['none', 'low', 'high']) {
        r.executeProviderEffort('deepseek', model, effort, 'high')
        for (const stream of [false, true]) {
          const params = reasoningHistoryParams(model, 'high', 'deepseek-replay-fixture')
          if (stream) {
            for await (const event of await instance.stream(params)) { /* consume intercepted stream */ }
          } else await instance.create(params)
          const request = requests.at(-1).body
          first ??= request
          assert.equal(request.thinking.type, effort === 'none' ? 'disabled' : 'enabled')
          assert.equal(request.reasoning_effort, effort === 'none' ? undefined : effort)
          assertStableReplay(first, request, `${effort} stream=${stream}`, {
            ignoreReasoning: true,
            expectReasoning: effort !== 'none',
          })
          assert.deepEqual(request.messages.map(({ reasoning_content, ...message }) => message),
            r.anthropicMessagesToOpenAI(params.messages, params.system),
            'effort changes must preserve the existing message conversion without regrouping assistant turns')
        }
      }
      r.executeProviderEffort('deepseek', model, 'low', 'high')
      await instance.create(reasoningHistoryParams(model, 'high', 'deepseek-replay-fixture'))
      const manualLow = requests.at(-1).body
      r.executeProviderEffort('deepseek', model, 'auto', 'low')
      await instance.create(reasoningHistoryParams(model, 'low', 'deepseek-replay-fixture'))
      assert.deepEqual(requests.at(-1).body, manualLow, 'Auto Low and manual Low preserve the full legacy request')
      const olderHistory = reasoningHistoryParams(model, 'high', 'deepseek-replay-fixture')
      olderHistory.messages = olderHistory.messages.filter(message =>
        !Array.isArray(message.content) || !message.content.some(block => block.type === 'thinking'))
      await instance.create(olderHistory)
      assert.equal(requests.at(-1).body.messages.find(message => message.tool_calls)?.reasoning_content, '',
        'a previous non-thinking tool call needs an empty replay field when thinking is enabled')
    })
  } finally { r.executeProviderEffort('deepseek', model, 'auto', null) }
})

test('all legacy compat gateways preserve explicit/generated cache keys across effort and reset only on clear', async () => {
  await withInterceptedChatRequests(async requests => {
    for (const provider of ['modelrouter', 'vercel', 'requesty', 'opencode', 'opencodego', 'fireworks', 'cloudflare', 'lmstudio']) {
      const model = cases.find(row => row[0] === provider)?.[1] ?? 'fixture-plain-chat'
      const instance = new r.CompatChatProvider(provider, { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' })
      const send = async (effortValue, sessionId, stream = false) => {
        const params = reasoningHistoryParams(model, effortValue, sessionId)
        if (stream) {
          for await (const event of await instance.stream(params)) { /* consume intercepted stream */ }
        } else await instance.create(params)
        return requests.at(-1).body
      }
      const generated = await send('low', undefined)
      assert.equal(typeof generated.prompt_cache_key, 'string', `${provider}: generated cache key`)
      assert.ok(generated.prompt_cache_key.length > 0)
      assert.equal((await send('high', undefined, true)).prompt_cache_key, generated.prompt_cache_key, provider)
      const explicit = await send('low', '  legacy-stable-session  ')
      assert.equal(explicit.prompt_cache_key, 'legacy-stable-session', `${provider}: trimmed session key`)
      const reused = await send('high', undefined, true)
      assert.equal(reused.prompt_cache_key, explicit.prompt_cache_key, `${provider}: omitted session reuses key`)
      assert.equal(JSON.stringify(reused.messages), JSON.stringify(explicit.messages), `${provider}: effort preserves messages`)
      assert.equal(JSON.stringify(reused.tools), JSON.stringify(explicit.tools), `${provider}: effort preserves tools`)
      assert.equal((await send(null, '  ')).prompt_cache_key, explicit.prompt_cache_key, `${provider}: blank session reuses key`)
      instance.clearCacheSession()
      const reset = await send('high', undefined)
      assert.equal(typeof reset.prompt_cache_key, 'string')
      assert.notEqual(reset.prompt_cache_key, explicit.prompt_cache_key, `${provider}: clear rotates cache key`)
      assert.notEqual(reset.prompt_cache_key, generated.prompt_cache_key, `${provider}: clear creates a fresh key`)
      assert.equal((await send('low', undefined, true)).prompt_cache_key, reset.prompt_cache_key)
      assert.equal((await send(null, 'replacement-session')).prompt_cache_key, 'replacement-session')
    }
  })
})

test('legacy OpenCode, Cloudflare and LXD replay required tool reasoning without changing base prompt structure', async () => {
  const cases = [
    ['opencode', 'step-5-preview-free', ['low', 'high', null]],
    ['opencode', 'glm-5.1', ['low', 'high', null]],
    ['opencodego', 'glm-5.2', ['high', 'max', null]],
    ['cloudflare', '@cf/zai-org/glm-5-2', ['high', 'max', null]],
    ['lxd', 'deepseek-v4-flash-0731', ['high', 'max', 'none', null]],
  ]
  await withInterceptedChatRequests(async requests => {
    for (const [provider, model, efforts] of cases) {
      r.executeProviderEffort(provider, model, 'auto', null)
      const config = { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' }
      const instance = provider === 'lxd' ? new r.LxdProvider(config) : new r.CompatChatProvider(provider, config)
      let first
      for (const effortValue of efforts) {
        for (const stream of [false, true]) {
          const params = reasoningHistoryParams(model, effortValue, `legacy-replay-${provider}`)
          if (stream) {
            for await (const event of await instance.stream(params)) { /* consume intercepted stream */ }
          } else await instance.create(params)
          const request = requests.at(-1).body
          first ??= request
          assertStableReplay(first, request, `${provider}/${model}/${effortValue} stream=${stream}`)
          assert.deepEqual(request.messages.map(({ reasoning_content, ...message }) => message),
            r.anthropicMessagesToOpenAI(params.messages, params.system),
            `${provider}: required replay fields must not regroup the preexisting prompt`)
        }
      }
      const older = reasoningHistoryParams(model, efforts[0], `legacy-replay-${provider}`)
      older.messages = older.messages.filter(message =>
        !Array.isArray(message.content) || !message.content.some(block => block.type === 'thinking'))
      await instance.create(older)
      assert.equal(requests.at(-1).body.messages.find(message => message.tool_calls)?.reasoning_content, '',
        `${provider}: previous non-thinking tool calls need the required empty replay field`)
    }
  })
})
