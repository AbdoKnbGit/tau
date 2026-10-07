import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Test the shipped code with real settings files and intercepted transports.
// Never read credentials or settings from the developer's installation.
const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-effort-'))
process.env.CLAUDE_CONFIG_DIR = fixture
process.env.DISABLE_TELEMETRY = '1'
delete process.env.USER_TYPE
delete process.env.CLAUDE_CODE_EFFORT_LEVEL
const settingsPath = join(fixture, 'settings.json')
writeFileSync(settingsPath, '{}')

const r = await loadMcpRuntime({
  paths: ['src/utils/effort.ts', 'src/commands/effort/effort.tsx',
    'src/state/AppStateStore.ts', 'src/services/api/providers/providerShim.ts',
    'src/utils/settings/applySettingsChange.ts', 'src/commands/model/model.tsx',
    'src/tools/AgentTool/runAgent.ts'],
  exports: ['SettingsSchema', 'getInitialSettings', 'getInitialEffortSetting',
    'getSettingsForSource', 'updateSettingsForSource', 'resetSettingsCache',
    'setFlagSettingsInline', 'toPersistableEffort', 'parseEffortValue',
    'getDefaultAppState', 'getDisplayedEffortLevel', 'getEffortSuffix', 'applySettingsChange',
    'executeEffort', 'showCurrentEffort', 'getOpenAIReasoningLevel',
    'setOpenAIReasoningLevel', 'getNextOpenAIReasoningLevel', 'getAllReasoningLevels',
    'modelSupportsReasoning', 'resolveReasoning', 'OpenAIProvider',
    'createProviderShim', 'commitModelSelection',
    `resolveSurfFixture: target => {
      const originalConfig = getGlobalConfig;
      const originalEnabled = isSurfEnabled;
      const originalRecord = recordSurfTurnStart;
      try {
        getGlobalConfig = () => ({ surfPhaseTargets: { subagent: target } });
        isSurfEnabled = () => true;
        recordSurfTurnStart = () => {};
        return resolveSurfSubagentModel({ hasToolSpecifiedModel: false, agentPinsModel: false });
      } finally {
        getGlobalConfig = originalConfig;
        isSurfEnabled = originalEnabled;
        recordSurfTurnStart = originalRecord;
      }
    }`,
    `installFixtures: directory => {
      setOriginalCwd(directory); setCwdState(directory);
      getEnabledSettingSources = () => ['userSettings', 'flagSettings'];
      getAPIProvider = () => 'openai';
      getProviderApiKey = () => 'fixture-key';
      getProviderAuthMethod = () => 'api_key';
      getOpenAISessionToken = () => null;
    }`],
})
r.installFixtures(fixture)
const requests = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/(api\.openai\.com|chatgpt\.com)\//)
  const body = JSON.parse(options.body)
  requests.push({ url: String(url), body })
  const response = { id: 'resp-fixture', model: body.model, output: [],
    usage: { input_tokens: 1024, output_tokens: 1, input_tokens_details: { cached_tokens: 1024 } } }
  if (body.stream) {
    const events = String(url).endsWith('/responses')
      ? [{ type: 'response.created', response },
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response }]
      : [{ id: 'chat-fixture', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } })
  }
  return new Response(JSON.stringify(String(url).endsWith('/responses') ? response : {
    id: 'chat-fixture', model: body.model,
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1024, completion_tokens: 1 },
  }), { headers: { 'Content-Type': 'application/json' } })
}

test.after(() => {
  globalThis.fetch = originalFetch
  const resolved = realpathSync(fixture)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup')
  rmSync(resolved, { recursive: true, force: true })
})

function configure(effortLevel) {
  writeFileSync(settingsPath, JSON.stringify({ effortLevel }))
  r.resetSettingsCache()
  r.getInitialSettings()
}

test.beforeEach(() => {
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  for (const key of ['OPENAI_BASE_URL', 'OPENAI_CHATGPT_ACCESS_TOKEN', 'OPENAI_CHATGPT_ACCOUNT_ID']) delete process.env[key]
  r.setOpenAIReasoningLevel(undefined)
  r.setFlagSettingsInline(undefined)
  configure(undefined)
  r.codexApi.clearChain()
  requests.length = 0
})

const levels = ['low', 'medium', 'high', 'xhigh', 'max']
for (const level of levels) {
  test(`fresh session reads, displays and sends persisted ${level}`, async () => {
    configure(level)
    assert.equal(r.SettingsSchema().parse({ effortLevel: level }).effortLevel, level)
    assert.equal(r.getInitialEffortSetting(), level)
    assert.equal(r.getDefaultAppState().effortValue, level)
    assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), level)
    assert.equal(r.getDisplayedEffortLevel('gpt-6-luna', level), level)
    assert.equal(r.getEffortSuffix('gpt-6-luna', level), ` with ${level} effort`)
    for (const thinking of [undefined, { type: 'disabled' }, { type: 'adaptive' }, { type: 'enabled', budget_tokens: 1024 }]) {
      assert.equal(r.resolveReasoning(thinking, 'gpt-6-luna').effort, level)
    }
    assert.equal((await sendNative()).body.reasoning.effort, level)
    for (const stream of [false, true]) {
      for (const model of ['gpt-6-luna', 'gpt-5.4-mini']) {
        const request = await sendLegacy({ model, stream, responses: model === 'gpt-6-luna' })
        assert.equal(request.body.reasoning?.effort ?? request.body.reasoning_effort,
          model === 'gpt-5.4-mini' && level === 'max' ? 'xhigh' : level)
      }
    }
  })

  test(`/effort ${level} survives an unrelated settings write and restart`, () => {
    assert.equal(r.toPersistableEffort(level), level)
    const result = r.executeEffort(level)
    assert.equal(result.effortUpdate?.value, level, result.message)
    assert.equal(r.updateSettingsForSource('userSettings', { alwaysThinkingEnabled: false }).error, null)
    r.resetSettingsCache()
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).effortLevel, level)
    assert.equal(r.getInitialEffortSetting(), level)
  })
}

function requestParams(overrides = {}) {
  return { model: 'gpt-6-luna', system: 'Stable fixture instructions',
    messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'ReadFixture',
      description: 'Read a fixture', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    max_tokens: 64, sessionId: 'effort-session', ...overrides }
}

async function sendNative(overrides = {}) {
  const shim = r.createProviderShim('openai', 'repl_main_thread')
  const response = await shim.beta.messages.create(requestParams({ stream: true, ...overrides }))
  if (overrides.stream !== false) for await (const _ of response) { /* consume */ }
  return requests.at(-1)
}

async function sendLegacy({ stream = false, responses = true, ...overrides } = {}) {
  const provider = new r.OpenAIProvider({ apiKey: 'fixture-key', sessionToken: responses ? 'fixture-token' : undefined })
  const params = requestParams(overrides)
  if (stream) {
    const response = await provider.stream(params)
    for await (const _ of response) { /* consume */ }
  } else await provider.create(params)
  return requests.at(-1)
}

test('environment, per-request CLI/agent values and merged settings have consistent precedence', async () => {
  configure('low')
  r.setFlagSettingsInline({ effortLevel: 'high' })
  r.resetSettingsCache()
  assert.equal(r.getInitialEffortSetting(), 'high')
  assert.equal((await sendNative()).body.reasoning.effort, 'high')
  r.setOpenAIReasoningLevel('max')
  for (const send of [sendNative, sendLegacy]) {
    assert.equal((await send({ effortValue: 'xhigh' })).body.reasoning.effort, 'xhigh')
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'LOW'
    assert.equal((await send({ effortValue: 'xhigh' })).body.reasoning.effort, 'low')
    assert.equal(r.getDisplayedEffortLevel('gpt-6-luna', 'xhigh'), 'low')
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  }
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).effortLevel, 'low', 'overrides are session-only')
})

test('auto/unset clears stale picker state and suppresses inherited effort and thinking budgets', async () => {
  configure('max')
  r.setOpenAIReasoningLevel('xhigh')
  const result = r.executeEffort('auto')
  assert.equal(result.effortUpdate?.value, undefined)
  assert.equal(r.getInitialEffortSetting(), undefined)
  assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), 'medium')
  for (const send of [sendNative, sendLegacy]) {
    assert.equal((await send({ effortValue: null })).body.reasoning, undefined)
    configure('max')
    for (const env of ['auto', 'unset']) {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = env
      const { body } = await send({ effortValue: 'xhigh', thinking: { type: 'enabled', budget_tokens: 16000 } })
      assert.equal(body.reasoning, undefined)
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(r.getDisplayedEffortLevel('gpt-6-luna', 'xhigh'), 'medium')
    }
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  }
})

test('invalid settings do not erase other settings or send an invalid API value', async () => {
  for (const value of ['ultra', 'invalid', 42, null, {}, []]) {
    configure(value)
    assert.equal(r.getInitialEffortSetting(), undefined)
    assert.equal((await sendNative()).body.reasoning, undefined)
  }
  configure('xhigh')
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'invalid'
  assert.equal((await sendNative()).body.reasoning.effort, 'xhigh')
})

test('model clamping preserves the preference across models and normalizes provider prefixes', async () => {
  configure('max')
  for (const [model, expected] of [
    ['gpt-6-luna', 'max'], ['openai/gpt-6-luna', 'max'], ['GPT-6-LUNA', 'max'],
    ['gpt-5.5', 'xhigh'], ['gpt-5.4-mini', 'xhigh'], ['gpt-5.1-codex-max', 'xhigh'],
    ['gpt-5.1', 'high'], ['gpt-5', 'high'], ['o3', 'high'], ['o4-mini', 'high'],
  ]) {
    assert.equal(r.getOpenAIReasoningLevel(model), expected, model)
    assert.equal(r.resolveReasoning(undefined, model)?.effort, expected, model)
  }
  assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), 'max')
  assert.equal(r.getInitialEffortSetting(), 'max')
  assert.equal(r.getDisplayedEffortLevel('gpt-5.1', 'max'), 'high')
  assert.match(r.showCurrentEffort('max', 'gpt-5.1').message, /Current effort level: high/)
  for (const model of ['gpt-4.1', 'gpt-5-chat-latest', 'other-model', 'o1garbage']) {
    assert.equal(r.modelSupportsReasoning(model), false, model)
    assert.equal(r.resolveReasoning(undefined, model), undefined, model)
    const { body } = await sendLegacy({ model })
    assert.equal(body.reasoning, undefined, model)
    assert.equal(body.reasoning_effort, undefined, model)
  }
})

test('picker cycling starts from configured/session effort and obeys model limits', () => {
  configure('xhigh')
  assert.equal(r.getNextOpenAIReasoningLevel('right', 'gpt-6-luna'), 'max')
  assert.equal(r.getNextOpenAIReasoningLevel('right', 'gpt-6-luna', 'max'), 'low')
  assert.equal(r.getNextOpenAIReasoningLevel('left', 'gpt-6-luna', 'high'), 'medium')
  assert.equal(r.getNextOpenAIReasoningLevel('right', 'o3', 'max'), 'low')
  assert.equal(r.getInitialEffortSetting(), 'xhigh', 'picker is session-scoped')
})

test('settings cache invalidation refreshes standalone requests without module reinitialization', async () => {
  for (const level of ['xhigh', 'low', undefined, 'max']) {
    configure(level)
    r.resetSettingsCache()
    assert.equal((await sendNative()).body.reasoning?.effort, level)
    r.resetSettingsCache()
    assert.equal((await sendLegacy()).body.reasoning?.effort, level)
  }
})

test('concurrent native sessions retain their own effort and cache keys across settings loading', async () => {
  configure('xhigh')
  r.resetSettingsCache()
  await Promise.all(levels.map((effortValue, index) => sendNative({
    effortValue, sessionId: `effort-session-${index}`,
    messages: [{ role: 'user', content: `request-${index}` }],
  })))
  for (const { body } of requests) {
    const index = levels.indexOf(body.reasoning.effort)
    assert.equal(body.prompt_cache_key, `effort-session-${index}`)
    assert.ok(JSON.stringify(body.input).includes(`request-${index}`))
  }
  assert.equal(requests.length, levels.length)
})

test('concurrent request efforts do not mutate the session preference', async () => {
  configure('xhigh')
  const provider = new r.OpenAIProvider({ apiKey: 'fixture-key', sessionToken: 'fixture-token' })
  await Promise.all(levels.map(effortValue => provider.create(requestParams({ effortValue }))))
  assert.deepEqual(requests.map(r => r.body.reasoning.effort).sort(), [...levels].sort())
  assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), 'xhigh')
})

test('effort changes preserve prompt bytes, tool order, session affinity and store policy', async () => {
  for (const send of [sendNative, sendLegacy]) {
    const first = (await send({ effortValue: 'low' })).body
    const repeated = (await send({ effortValue: 'low' })).body
    assert.deepEqual(repeated, first)
    const changed = (await send({ effortValue: 'max' })).body
    assert.equal(changed.reasoning.effort, 'max')
    assert.deepEqual({ ...changed, reasoning: first.reasoning }, first)
    assert.equal(changed.store, false)
    assert.equal(changed.prompt_cache_key, 'effort-session')
    assert.equal(changed.effortValue, undefined, 'internal override must not leak to the wire')
  }
})

test('canceling a picker preview cannot change the effective session effort', async () => {
  configure('high')
  assert.equal(r.getNextOpenAIReasoningLevel('right', 'gpt-6-luna', 'high'), 'xhigh')
  assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), 'high')
  assert.equal((await sendNative()).body.reasoning.effort, 'high')
})

test('settings reload clears a removed effort but preserves distinct session overrides', () => {
  configure('max')
  let state = r.getDefaultAppState()
  const apply = () => r.applySettingsChange('userSettings', update => { state = update(state) })
  configure(undefined)
  apply()
  assert.equal(state.effortValue, undefined)
  configure('low')
  apply()
  assert.equal(state.effortValue, 'low')
  state = { ...state, effortValue: 'high' }
  configure(undefined)
  apply()
  assert.equal(state.effortValue, 'high')
  apply()
  assert.equal(state.effortValue, 'high')
})

test('compatible providers do not inherit OpenAI settings or picker effort', async () => {
  configure('max')
  r.setOpenAIReasoningLevel('xhigh')
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
  class CompatibleProvider extends r.OpenAIProvider { name = 'compatible-fixture' }
  const provider = new CompatibleProvider({ apiKey: 'fixture-key' })
  await provider.create(requestParams({ effortValue: 'low' }))
  assert.equal(requests.at(-1).body.reasoning_effort, undefined)
})

test('environment parsing rejects malformed numeric overrides and handles whitespace', () => {
  for (const value of ['12junk', '1.5', 'NaN', 'Infinity', {}, [], true]) {
    assert.equal(r.parseEffortValue(value), undefined)
  }
  assert.equal(r.parseEffortValue('  XHIGH  '), 'xhigh')
  configure('xhigh')
  process.env.CLAUDE_CODE_EFFORT_LEVEL = '  AUTO  '
  assert.equal(r.resolveReasoning(undefined, 'gpt-6-luna'), undefined)
  process.env.CLAUDE_CODE_EFFORT_LEVEL = '12junk'
  assert.equal(r.resolveReasoning(undefined, 'gpt-6-luna').effort, 'xhigh')
  assert.equal(r.resolveReasoning(undefined, 'gpt-6-luna', 'ultracode').effort, 'max')
  assert.equal(r.resolveReasoning(undefined, 'gpt-5.2-pro', 'low').effort, 'medium')
})

test('native non-streaming and OAuth requests receive configured effort', async () => {
  configure('xhigh')
  assert.equal((await sendNative({ stream: false })).body.reasoning.effort, 'xhigh')
  const lane = new r.CodexLane()
  r.codexApi.configure({ apiKey: '', baseUrl: '', chatgptAccessToken: 'fixture-token' })
  for await (const _ of lane.streamAsProvider({ ...requestParams(), signal: new AbortController().signal })) { /* consume */ }
  assert.match(requests.at(-1).url, /^https:\/\/chatgpt\.com\//)
  assert.equal(requests.at(-1).body.reasoning.effort, 'xhigh')
})

test('model command commits picker effort to request state and preserves it on a plain model switch', async () => {
  configure('low')
  let state = r.getDefaultAppState()
  const select = effort => r.commitModelSelection({
    model: 'gpt-6-luna', effort, isFastMode: false,
    setAppState: update => { state = update(state) },
    previousModel: 'gpt-6-luna', onDone: () => {},
  })
  select('xhigh')
  assert.equal(state.effortValue, 'xhigh')
  select(undefined)
  assert.equal(state.effortValue, 'xhigh')
  assert.equal((await sendNative({ effortValue: state.effortValue })).body.reasoning.effort, 'xhigh')
  assert.equal(r.getInitialEffortSetting(), 'low', 'model picker does not persist a session override')
})

test('surf subagent effort is returned as scoped state without changing the parent preference', async () => {
  configure('low')
  const target = r.resolveSurfFixture({ provider: 'openai', model: 'gpt-6-luna', effort: 'max' })
  assert.deepEqual(target, { model: 'gpt-6-luna', effort: 'max' })
  assert.equal(r.getOpenAIReasoningLevel('gpt-6-luna'), 'low')
  assert.equal((await sendNative({ effortValue: target.effort })).body.reasoning.effort, 'max')
  assert.equal((await sendNative()).body.reasoning.effort, 'low')
})
