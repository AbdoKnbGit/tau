import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// Exercise the shipped resolver, /agents label, spawn scope and runAgent with
// the Sub-agent model setting written to a real user settings file. Only the
// model loop (query) or runAgent's inner iterator is replaced, so nothing is
// sent to a provider.
// Run: node build.mjs && node --test test/subagent-model-setting.test.mjs
const tempRoot = mkdtempSync(join(tmpdir(), 'tau-subagent-model-'))
const originalEnv = { ...process.env }
const originalCwd = process.cwd()
process.env.CLAUDE_CODE_TMPDIR = tempRoot
process.env.CLAUDE_CONFIG_DIR = tempRoot
process.env.NODE_ENV = 'production'
delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
delete process.env.ANTHROPIC_SMALL_FAST_MODEL
delete process.env.CLAUDE_AUTO_BACKGROUND_TASKS
process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
// xAI keeps its per-model effort picks in a file of its own.
process.env.TAU_XAI_THINKING_STORE = join(tempRoot, 'xai-thinking.json')

const distPath = resolve('dist/tau.mjs')
let bundle = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
const agentToolName = bundle.match(/(AgentTool\d*) = buildTool\(/)?.[1]
assert.ok(agentToolName, 'AgentTool must be present in the built runtime')
bundle += `
export function __subagentModelSetting() {
  init_AgentTool(); init_agent(); init_agent2(); init_store(); init_forcedProvider();
  init_generalPurposeAgent(); init_exploreAgent(); init_planAgent(); init_statuslineSetup();
  init_agentModelManager(); init_settings(); init_settings2(); init_sessionStorage();
  init_messages(); init_runAgent(); init_subagentModelPick(); init_xaiThinking();
  init_model(); init_tokenEstimation(); init_QueryGuard(); init_processUserInput();
  init_handlePromptSubmit();
  const realInner = runAgentWithoutProviderOverride;
  const realQuery = query;
  const realRunAgent = runAgent;
  const realClient = getAnthropicClient;
  const realProcessUserInput = processUserInput;
  const readConfig = getGlobalConfig;
  return {
    AgentTool: ${agentToolName}, getAgentModel, getAgentModelDisplay, getAgentModelScope,
    getAPIProvider, runWithAgentProvider, runWithForcedProvider, getForcedProviderContext,
    getForcedProvider, getAgentResolvedModel, createStore, agentRunner: runAgent,
    updateSettingsForSource, getInitialSettings, readAgentMetadata, createUserMessage,
    getSubagentSettingTarget, resolveSubagentModelPick, setXaiEffort, clearXaiEffort,
    getMainLoopModel, getSmallFastModel, countMessagesTokensWithAPI, handlePromptSubmit, QueryGuard,
    setInnerAgentStream(makeStream) { runAgentWithoutProviderOverride = makeStream ?? realInner; },
    setQuery(fn) { query = fn ?? realQuery; },
    setAgentStream(makeStream) { runAgent = makeStream ?? realRunAgent; },
    setAnthropicClient(fn) { getAnthropicClient = fn ?? realClient; },
    setProcessUserInput(fn) { processUserInput = fn ?? realProcessUserInput; },
    setSurfTarget(target) {
      isSurfEnabled = () => !!target;
      getGlobalConfig = () => ({ ...readConfig(), surfPhaseTargets: { subagent: target } });
    },
    builtins: {
      general: GENERAL_PURPOSE_AGENT, explore: EXPLORE_AGENT, plan: PLAN_AGENT,
      statusline: STATUSLINE_SETUP_AGENT,
    },
    setSessionProvider(provider) { _sessionActiveProvider = provider; },
  };
}
`
const auditPath = join(dirname(distPath), `.subagent-model-${process.pid}.mjs`)
writeFileSync(auditPath, bundle)
let runtime
try {
  // Settings are read from the working directory too: keep the repo's out.
  process.chdir(tempRoot)
  runtime = (await import(pathToFileURL(auditPath).href)).__subagentModelSetting()
} finally {
  unlinkSync(auditPath)
}

const OPUS_46 = 'claude-opus-4-6-thinking'
const OPUS_55 = 'claude-opus-5-5-high'
const SONNET_46 = 'claude-sonnet-4-6'
const SONNET_55_LOW = 'claude-sonnet-5-5-low'
const GEMINI_HIGH = 'gemini-3.8-flash-high'
const GEMINI_LOW = 'gemini-3.8-flash-low'
const GEMINI_MEDIUM = 'gemini-3.8-flash-medium'
const SOL = 'gpt-6.1-sol'
const LUNA = 'gpt-6-luna'
const LARGE_3 = 'mistral-large-2512'
const MISTRAL_PARENT = 'mistral-large-4'
const TIERS = ['haiku', 'sonnet', 'opus']

function setSetting(value) {
  // The key is written whole, as /config does: a merge cannot drop entries.
  assert.equal(runtime.updateSettingsForSource('userSettings', { subagentModel: undefined }).error, null)
  if (value !== undefined) {
    assert.equal(runtime.updateSettingsForSource('userSettings', { subagentModel: value }).error, null)
  }
  assert.deepEqual(runtime.getInitialSettings().subagentModel, value)
}

const file = (model, extra = {}) => ({
  agentType: `file-${model ?? 'none'}`, source: 'projectSettings', getSystemPrompt: () => 'Test.',
  ...(model !== undefined && { model }), ...extra,
})

function resolveFor(agent, parent, caller) {
  return runtime.runWithAgentProvider(agent.provider, () => runtime.getAgentModel(
    agent.model, parent, caller, 'default', agent.provider, runtime.getAgentModelScope(agent)))
}

function onProvider(provider, fn) {
  runtime.setSessionProvider(provider)
  return fn()
}

test.beforeEach(() => {
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  runtime.setSurfTarget(undefined)
  runtime.setInnerAgentStream(undefined)
  runtime.setQuery(undefined)
  runtime.setAgentStream(undefined)
  runtime.setAnthropicClient(undefined)
  runtime.setProcessUserInput(undefined)
  delete process.env.ANTHROPIC_MODEL
  setSetting(undefined)
})
test.after(() => {
  process.chdir(originalCwd)
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('built-in agents carry the setting scope; the fork never does', () => {
  const { general, explore, plan, statusline } = runtime.builtins
  assert.equal(general.model, undefined)
  assert.equal(explore.model, 'haiku')
  assert.equal(plan.model, 'inherit')
  assert.equal(statusline.model, 'sonnet')
  for (const agent of [general, explore, plan, statusline]) {
    assert.deepEqual(runtime.getAgentModelScope(agent), { builtIn: true, agentType: agent.agentType })
  }
  assert.deepEqual(runtime.getAgentModelScope(file('haiku')), { builtIn: false, agentType: 'file-haiku' })
})

test('Auto keeps the routing every provider had before the setting', () => {
  const { general, explore, plan, statusline } = runtime.builtins
  onProvider('antigravity', () => {
    for (const [parent, agentModel] of [[OPUS_46, SONNET_46], [OPUS_55, SONNET_55_LOW], [GEMINI_HIGH, GEMINI_LOW]]) {
      for (const agent of [general, explore, plan, statusline, file(undefined)]) {
        for (const caller of [undefined, ...TIERS]) {
          assert.equal(resolveFor(agent, parent, caller), agentModel, `${agent.agentType}/${parent}/${caller}`)
        }
      }
    }
  })
  onProvider('openai', () => {
    assert.equal(resolveFor(general, SOL), SOL)
    assert.equal(resolveFor(plan, SOL), SOL)
    assert.equal(resolveFor(file(undefined), SOL), SOL)
    for (const tier of TIERS) {
      assert.equal(resolveFor(general, SOL, tier), LUNA, `general ${tier}`)
      assert.equal(resolveFor(plan, SOL, tier), LUNA, `plan ${tier}`)
    }
    assert.equal(resolveFor(explore, SOL), LUNA)
    assert.equal(resolveFor(statusline, SOL), LUNA)
  })
  onProvider('mistral', () => {
    assert.equal(resolveFor(general, MISTRAL_PARENT), LARGE_3)
    assert.equal(resolveFor(explore, MISTRAL_PARENT), LARGE_3)
    assert.equal(resolveFor(plan, MISTRAL_PARENT), MISTRAL_PARENT)
    assert.equal(resolveFor(general, MISTRAL_PARENT, 'haiku'), LARGE_3)
  })
  onProvider('moonshot', () => {
    for (const agent of [general, explore, plan]) {
      for (const caller of [undefined, 'haiku']) {
        assert.equal(resolveFor(agent, 'kimi-k2.6', caller), 'kimi-k2.6', `${agent.agentType}/${caller}`)
      }
    }
  })
})

test('Same as main model runs every scoped agent on the main model, whatever tier the caller guesses', () => {
  setSetting({ mode: 'inherit' })
  const { general, explore, plan, statusline } = runtime.builtins
  const cases = [
    ['antigravity', OPUS_46], ['antigravity', OPUS_55], ['antigravity', GEMINI_HIGH],
    ['openai', SOL], ['mistral', MISTRAL_PARENT], ['moonshot', 'kimi-k2.6'],
    ['openrouter', 'openai/gpt-6'], ['firstParty', 'claude-opus-4-6'],
  ]
  for (const [provider, parent] of cases) {
    onProvider(provider, () => {
      for (const agent of [general, explore, plan, statusline, file(undefined), file('  ')]) {
        for (const caller of [undefined, ...TIERS, ' HAIKU ']) {
          assert.equal(resolveFor(agent, parent, caller), parent, `${provider}/${agent.agentType}/${caller}`)
        }
      }
    })
  }
})

test('Custom uses the model saved for the provider the agent starts on, and Auto elsewhere', () => {
  setSetting({ mode: 'custom', models: { antigravity: GEMINI_MEDIUM } })
  const { general, explore, plan } = runtime.builtins
  const onAntigravity = () => onProvider('antigravity', () => {
    for (const agent of [general, explore, plan, file(undefined)]) {
      for (const caller of [undefined, ...TIERS]) {
        assert.equal(resolveFor(agent, OPUS_46, caller), GEMINI_MEDIUM, `${agent.agentType}/${caller}`)
      }
    }
  })
  onAntigravity()
  onProvider('openai', () => {
    assert.equal(resolveFor(general, SOL), SOL, 'no OpenAI pick: Auto')
    assert.equal(resolveFor(general, SOL, 'haiku'), LUNA, 'no OpenAI pick: Auto tier')
    assert.equal(resolveFor(explore, SOL), LUNA)
  })
  onAntigravity()
  setSetting({ mode: 'custom', models: { antigravity: GEMINI_MEDIUM, openai: 'gpt-6-sol' } })
  onProvider('openai', () => assert.equal(resolveFor(general, SOL, 'haiku'), 'gpt-6-sol'))
  onAntigravity()
})

test('a custom entry that is not a model id acts as Auto', () => {
  for (const value of ['haiku', 'inherit', '   ']) {
    setSetting({ mode: 'custom', models: { antigravity: value } })
    onProvider('antigravity', () =>
      assert.equal(resolveFor(runtime.builtins.general, OPUS_46), SONNET_46, JSON.stringify(value)))
  }
})

test('a concrete model from the caller still wins, and caller inherit is the main model', () => {
  for (const setting of [{ mode: 'inherit' }, { mode: 'custom', models: { antigravity: GEMINI_MEDIUM } }]) {
    setSetting(setting)
    onProvider('antigravity', () => {
      assert.equal(resolveFor(runtime.builtins.general, OPUS_46, GEMINI_HIGH), GEMINI_HIGH)
      assert.equal(resolveFor(runtime.builtins.explore, OPUS_46, ' INHERIT '), OPUS_46)
    })
    onProvider('mistral', () =>
      assert.equal(resolveFor(runtime.builtins.general, MISTRAL_PARENT, 'zai-glm-5-3'), 'zai-glm-5-3'))
  }
  setSetting(undefined)
  onProvider('openai', () => assert.equal(resolveFor(runtime.builtins.general, SOL, 'inherit'), SOL))
  onProvider('antigravity', () => assert.equal(resolveFor(runtime.builtins.general, OPUS_46, 'inherit'), OPUS_46))
})

test('an agent file that names its model keeps it in every mode; a guessed tier never replaces it', () => {
  for (const setting of [undefined, { mode: 'inherit' }, { mode: 'custom', models: { antigravity: GEMINI_MEDIUM, openai: 'gpt-6-sol' } }]) {
    setSetting(setting)
    const label = JSON.stringify(setting)
    onProvider('antigravity', () => {
      for (const caller of [undefined, ...TIERS]) {
        assert.equal(resolveFor(file(GEMINI_HIGH), OPUS_46, caller), GEMINI_HIGH, `${label} concrete/${caller}`)
        assert.equal(resolveFor(file('inherit'), OPUS_46, caller), OPUS_46, `${label} inherit/${caller}`)
        assert.equal(resolveFor(file(' INHERIT '), OPUS_46, caller), OPUS_46, `${label} INHERIT/${caller}`)
        assert.equal(resolveFor(file('haiku'), OPUS_46, caller), SONNET_46, `${label} tier/${caller}`)
      }
    })
    onProvider('openai', () => {
      assert.equal(resolveFor(file('haiku'), SOL), LUNA, `${label} openai tier`)
      assert.equal(resolveFor(file('inherit'), SOL, 'haiku'), SOL, `${label} openai inherit`)
      assert.equal(resolveFor(file('gpt-6-sol'), SOL, 'haiku'), 'gpt-6-sol', `${label} openai concrete`)
    })
  }
})

test('CLAUDE_CODE_SUBAGENT_MODEL keeps the old rules while set; blank counts as unset', () => {
  setSetting({ mode: 'inherit' })
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = ' gpt-6-sol '
  onProvider('openai', () => {
    assert.equal(resolveFor(runtime.builtins.general, SOL), 'gpt-6-sol')
    assert.equal(resolveFor(runtime.builtins.explore, SOL), 'gpt-6-sol')
    assert.equal(resolveFor(runtime.builtins.general, SOL, 'haiku'), LUNA, 'a caller tier beat the env model before')
  })
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = ' INHERIT '
  onProvider('antigravity', () => assert.equal(resolveFor(runtime.builtins.general, OPUS_46), OPUS_46))
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = '   '
  onProvider('openai', () => assert.equal(resolveFor(runtime.builtins.general, SOL, 'haiku'), SOL))
})

test('explicit providers and pinned agents keep their own rules', () => {
  setSetting({ mode: 'inherit' })
  onProvider('antigravity', () => {
    assert.equal(runtime.runWithForcedProvider({ provider: 'openai' }, () =>
      resolveFor(runtime.builtins.general, SOL, 'haiku')), LUNA)
    const pinned = file('kimi-k2.6', { provider: 'moonshot' })
    for (const caller of [undefined, ...TIERS]) {
      assert.equal(resolveFor(pinned, OPUS_46, caller), 'kimi-k2.6', `pinned/${caller}`)
    }
  })
})

test('the fork keeps its parent model, Antigravity included', () => {
  const fork = { builtIn: true, agentType: 'fork' }
  for (const setting of [undefined, { mode: 'inherit' }, { mode: 'custom', models: { antigravity: GEMINI_MEDIUM } }]) {
    setSetting(setting)
    onProvider('antigravity', () => {
      assert.equal(runtime.getAgentModel('inherit', OPUS_46, undefined, 'default', undefined, fork), OPUS_46)
      assert.equal(runtime.getAgentModel('inherit', GEMINI_HIGH, undefined, 'default', undefined, fork), GEMINI_HIGH)
    })
  }
})

test('/agents shows the rule in force and the model the agent runs on now', () => {
  assert.equal(runtime.updateSettingsForSource('userSettings', { model: OPUS_46 }).error, null)
  try {
    onProvider('antigravity', () => {
      const general = { source: 'built-in', agentType: 'general-purpose' }
      assert.equal(runtime.getAgentModelDisplay(undefined, undefined, general), `Sub-agent model: Auto → ${SONNET_46}`)
      setSetting({ mode: 'inherit' })
      assert.equal(runtime.getAgentModelDisplay(undefined, undefined, general), `Sub-agent model: Same as main model → ${OPUS_46}`)
      assert.equal(runtime.getAgentModelDisplay('haiku', undefined, { source: 'built-in', agentType: 'Explore' }),
        `Sub-agent model: Same as main model → ${OPUS_46}`)
      setSetting({ mode: 'custom', models: { antigravity: GEMINI_MEDIUM } })
      assert.equal(runtime.getAgentModelDisplay(undefined, undefined, general), `Sub-agent model: Custom: ${GEMINI_MEDIUM} → ${GEMINI_MEDIUM}`)
      setSetting({ mode: 'custom', models: { openai: 'gpt-6-sol' } })
      assert.equal(runtime.getAgentModelDisplay(undefined, undefined, general),
        `Sub-agent model: Custom: none for Antigravity, using Auto → ${SONNET_46}`)
      assert.equal(runtime.getAgentModelDisplay('haiku'), `Haiku → ${SONNET_46}`)
      assert.equal(runtime.getAgentModelDisplay('inherit'), `Inherit from parent → ${OPUS_46}`)
      assert.equal(runtime.getAgentModelDisplay(GEMINI_HIGH), GEMINI_HIGH)
      assert.equal(runtime.getAgentModelDisplay(undefined), `Sub-agent model: Custom: none for Antigravity, using Auto → ${SONNET_46}`)
      assert.equal(runtime.getAgentModelDisplay('kimi-k2.6', 'moonshot'), 'Moonshot AI / kimi-k2.6')
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = GEMINI_HIGH
      assert.equal(runtime.getAgentModelDisplay(undefined, undefined, general), `CLAUDE_CODE_SUBAGENT_MODEL → ${GEMINI_HIGH}`)
    })
  } finally {
    runtime.updateSettingsForSource('userSettings', { model: undefined })
  }
})

function workerOptions(definition = {}, model) {
  return {
    agentDefinition: { agentType: 'worker-test', ...definition }, model,
    toolUseContext: {
      options: { mainLoopModel: SOL },
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    },
  }
}

test('a running agent stays on the provider it started on; the spawn scope pins nothing else', async () => {
  const seen = []
  runtime.setInnerAgentStream(async function* () {
    try {
      await Promise.resolve()
      seen.push([runtime.getAPIProvider(), runtime.getForcedProvider(), runtime.getForcedProviderContext()?.source])
      yield 'first'
      await new Promise(resolve => setImmediate(resolve))
      seen.push([runtime.getAPIProvider(), runtime.getForcedProvider(), runtime.getForcedProviderContext()?.source])
      yield 'second'
    } finally {
      seen.push(['cleanup', runtime.getAPIProvider()])
    }
  })
  runtime.setSessionProvider('openai')
  const worker = runtime.agentRunner(workerOptions())
  assert.equal((await worker.next()).value, 'first')
  runtime.setSessionProvider('antigravity')
  assert.equal(runtime.getAPIProvider(), 'antigravity')
  assert.equal((await worker.next()).value, 'second')
  await worker.return()
  assert.deepEqual(seen, [
    ['openai', undefined, 'spawn'], ['openai', undefined, 'spawn'], ['cleanup', 'openai'],
  ])
  assert.equal(runtime.getForcedProviderContext(), undefined)
  assert.equal(runtime.getAPIProvider(), 'antigravity')
})

test('an enclosing scope is kept, and an agent pin still applies inside a spawn scope', async () => {
  const seen = []
  runtime.setInnerAgentStream(async function* (_options, route) {
    seen.push([runtime.getAPIProvider(), runtime.getForcedProviderContext()?.source ?? 'explicit', route?.model])
  })
  runtime.setSessionProvider('openai')
  await runtime.runWithForcedProvider({ provider: 'moonshot' }, () => runtime.agentRunner(workerOptions()).next())
  await runtime.runWithForcedProvider({ provider: 'openai', source: 'spawn' }, () =>
    runtime.agentRunner(workerOptions({ provider: 'moonshot', model: 'kimi-k2.6' })).next())
  // A Mistral-pinned agent under a spawn scope runs on Mistral, not the parent's provider.
  await runtime.runWithForcedProvider({ provider: 'openai', source: 'spawn' }, () =>
    runtime.agentRunner(workerOptions({ provider: 'mistral', model: LARGE_3 })).next())
  assert.deepEqual(seen, [
    ['moonshot', 'explicit', undefined],
    ['moonshot', 'agent', undefined],
    ['mistral', 'agent', LARGE_3],
  ])
  assert.equal(runtime.runWithForcedProvider({ provider: 'openai', source: 'spawn' }, () =>
    runtime.runWithAgentProvider('moonshot', () => runtime.getAPIProvider())), 'moonshot')
  assert.equal(runtime.getForcedProviderContext(), undefined)
})

// The real runAgent, with only the model loop replaced.
let sequence = 0
async function runRealAgent({ definition, model, sessionProvider, mainLoopModel, onQuery, onStore }) {
  runtime.setSessionProvider(sessionProvider)
  runtime.setQuery(async function* (params) {
    await onQuery?.(params)
    yield {
      type: 'assistant', uuid: `route-response-${sequence}`, timestamp: new Date().toISOString(),
      message: {
        id: `route-response-${sequence}`, role: 'assistant', model: params.toolUseContext.options.mainLoopModel,
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    }
  })
  const store = runtime.createStore({
    tasks: {},
    todos: {},
    toolPermissionContext: {
      mode: 'default', additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
    },
    mcp: { clients: [], tools: [] },
    speculation: { status: 'idle' },
  })
  onStore?.(store)
  const agentId = `a${String(++sequence).padStart(16, '0')}`
  const iterator = runtime.agentRunner({
    agentDefinition: { agentType: 'route-test', source: 'projectSettings', getSystemPrompt: () => 'Test.', ...definition },
    promptMessages: [runtime.createUserMessage({ content: 'Finish.' })],
    toolUseContext: {
      getAppState: store.getState, setAppState: store.setState,
      abortController: new AbortController(), messages: [], toolUseId: `route-tool-${sequence}`,
      options: {
        tools: [], commands: [], mcpClients: [], mainLoopModel, debug: false, verbose: false,
        isNonInteractiveSession: true, thinkingConfig: { type: 'disabled' },
        agentDefinitions: { activeAgents: [] },
      },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    isAsync: false,
    querySource: 'agent:custom',
    model,
    availableTools: [],
    override: {
      agentId, userContext: {}, systemContext: {}, systemPrompt: ['Test agent.'],
      abortController: new AbortController(),
    },
  })
  for await (const _message of iterator) { /* consume */ }
  // Agents without a saved route write their metadata without waiting.
  for (let attempt = 0; attempt < 100; attempt++) {
    const metadata = await runtime.readAgentMetadata(agentId)
    if (metadata) return metadata
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`no metadata for ${agentId}`)
}

test('runAgent saves the route it ran on, and not for pinned agents or explicit providers', async () => {
  setSetting({ mode: 'custom', models: { antigravity: GEMINI_MEDIUM } })
  let request
  const saved = await runRealAgent({
    sessionProvider: 'antigravity', mainLoopModel: OPUS_46, model: 'haiku',
    onQuery: params => {
      request = { provider: runtime.getAPIProvider(), model: params.toolUseContext.options.mainLoopModel }
    },
  })
  assert.deepEqual(request, { provider: 'antigravity', model: GEMINI_MEDIUM })
  assert.deepEqual(saved.route, { provider: 'antigravity', model: GEMINI_MEDIUM })
  assert.equal(saved.model, 'haiku')

  const pinned = await runRealAgent({
    sessionProvider: 'openai', mainLoopModel: SOL,
    definition: { provider: 'moonshot', model: 'kimi-k2.6' },
  })
  assert.equal(pinned.route, undefined)
  const explicit = await runtime.runWithForcedProvider({ provider: 'openai' }, () =>
    runRealAgent({ sessionProvider: 'antigravity', mainLoopModel: SOL }))
  assert.equal(explicit.route, undefined)
})

test('/surf moves a new agent, and its pin, to the sub-agent provider', async () => {
  runtime.setSurfTarget({ provider: 'moonshot', model: 'kimi-k2.6' })
  const seen = []
  const saved = await runRealAgent({
    sessionProvider: 'openai', mainLoopModel: SOL,
    onQuery: async params => {
      seen.push([runtime.getAPIProvider(), runtime.getForcedProviderContext()?.source, params.toolUseContext.options.mainLoopModel])
      // A later switch elsewhere must not move the agent off surf's provider.
      runtime.setSessionProvider('antigravity')
      await new Promise(resolve => setImmediate(resolve))
      seen.push([runtime.getAPIProvider()])
    },
  })
  assert.deepEqual(seen, [['moonshot', 'spawn', 'kimi-k2.6'], ['moonshot']])
  assert.deepEqual(saved.route, { provider: 'moonshot', model: 'kimi-k2.6' })
})

const GLOBAL_LUNA = { mode: 'global', global: { provider: 'openai', model: LUNA, effort: 'low' } }

test('Global runs every scoped agent on its provider and model, whatever the main provider', () => {
  setSetting(GLOBAL_LUNA)
  const { general, explore, plan, statusline } = runtime.builtins
  for (const [provider, parent] of [['antigravity', OPUS_46], ['mistral', MISTRAL_PARENT], ['openai', SOL], ['moonshot', 'kimi-k2.6']]) {
    onProvider(provider, () => {
      for (const agent of [general, explore, plan, statusline, file(undefined)]) {
        for (const caller of [undefined, ...TIERS]) {
          assert.equal(resolveFor(agent, parent, caller), LUNA, `${provider}/${agent.agentType}/${caller}`)
          assert.deepEqual(
            runtime.getSubagentSettingTarget(agent.model, caller, agent.provider, runtime.getAgentModelScope(agent)),
            { provider: 'openai', model: LUNA, effort: 'low' },
          )
        }
      }
    })
  }
  // A nested agent inside a Global agent's pin gets the same pick.
  onProvider('antigravity', () => runtime.runWithForcedProvider({ provider: 'openai', source: 'agent' }, () =>
    assert.equal(resolveFor(general, LUNA), LUNA)))
})

test('Global stays out of explicit choices and agent files with their own model', () => {
  setSetting(GLOBAL_LUNA)
  const scope = agent => runtime.getAgentModelScope(agent)
  onProvider('antigravity', () => {
    assert.equal(resolveFor(file(GEMINI_HIGH), OPUS_46, 'haiku'), GEMINI_HIGH)
    assert.equal(resolveFor(file('inherit'), OPUS_46), OPUS_46)
    assert.equal(runtime.getSubagentSettingTarget(GEMINI_HIGH, undefined, undefined, scope(file(GEMINI_HIGH))), undefined)
    assert.equal(resolveFor(runtime.builtins.general, OPUS_46, GEMINI_HIGH), GEMINI_HIGH, 'a concrete caller model wins')
    assert.equal(runtime.getSubagentSettingTarget(undefined, GEMINI_HIGH, undefined, scope(runtime.builtins.general)), undefined)
    const pinned = file('kimi-k2.6', { provider: 'moonshot' })
    assert.equal(resolveFor(pinned, OPUS_46, 'haiku'), 'kimi-k2.6')
    assert.equal(runtime.getSubagentSettingTarget(pinned.model, 'haiku', 'moonshot', scope(pinned)), undefined)
    assert.equal(runtime.runWithForcedProvider({ provider: 'openrouter' }, () =>
      runtime.getSubagentSettingTarget(undefined, undefined, undefined, scope(runtime.builtins.general))), undefined, 'team mode')
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = GEMINI_MEDIUM
    assert.equal(resolveFor(runtime.builtins.general, OPUS_46), GEMINI_MEDIUM)
    assert.equal(runtime.getSubagentSettingTarget(undefined, undefined, undefined, scope(runtime.builtins.general)), undefined)
  })
})

test('a Global pick that cannot be used acts as Auto', () => {
  for (const global of [undefined, { provider: 'openai' }, { provider: 'made-up', model: LUNA }, { provider: 'openai', model: 'haiku' }]) {
    setSetting({ mode: 'global', ...(global !== undefined && { global }) })
    onProvider('antigravity', () => {
      assert.equal(resolveFor(runtime.builtins.general, OPUS_46), SONNET_46, JSON.stringify(global))
      assert.equal(runtime.getSubagentSettingTarget(undefined, undefined, undefined, runtime.getAgentModelScope(runtime.builtins.general)), undefined)
    })
  }
})

test('/agents names the Global pick', () => {
  setSetting(GLOBAL_LUNA)
  onProvider('antigravity', () => assert.equal(
    runtime.getAgentModelDisplay(undefined, undefined, { source: 'built-in', agentType: 'general-purpose' }),
    `Sub-agent model: Global: OpenAI / ${LUNA} · low → ${LUNA}`,
  ))
})

test('the real runAgent runs a Global pick on its provider with its effort, and the session keeps its own', async () => {
  setSetting(GLOBAL_LUNA)
  let store
  let request
  const saved = await runRealAgent({
    sessionProvider: 'antigravity', mainLoopModel: OPUS_46, model: 'haiku',
    onStore: created => { store = created },
    onQuery: async params => {
      request = {
        provider: runtime.getAPIProvider(),
        source: runtime.getForcedProviderContext()?.source,
        model: params.toolUseContext.options.mainLoopModel,
        effort: params.toolUseContext.getAppState().effortValue,
      }
      // A switch in the parent while it runs moves nothing.
      runtime.setSessionProvider('mistral')
      await new Promise(resolve => setImmediate(resolve))
      request.after = runtime.getAPIProvider()
    },
  })
  assert.deepEqual(request, { provider: 'openai', source: 'agent', model: LUNA, effort: 'low', after: 'openai' })
  assert.equal(store.getState().effortValue, undefined, 'the session effort is untouched')
  assert.equal(runtime.getAPIProvider(), 'mistral', 'the session provider is its own')
  assert.deepEqual(saved.route, { provider: 'openai', model: LUNA, effort: 'low' })
})

test('the real runAgent applies the effort of a Custom pick to the agent alone', async () => {
  setSetting({ mode: 'custom', models: { openai: { model: 'gpt-6-sol', effort: 'high' } } })
  let store
  let request
  const saved = await runRealAgent({
    sessionProvider: 'openai', mainLoopModel: SOL,
    onStore: created => { store = created },
    onQuery: params => {
      request = {
        provider: runtime.getAPIProvider(),
        source: runtime.getForcedProviderContext()?.source,
        model: params.toolUseContext.options.mainLoopModel,
        effort: params.toolUseContext.getAppState().effortValue,
      }
    },
  })
  assert.deepEqual(request, { provider: 'openai', source: 'spawn', model: 'gpt-6-sol', effort: 'high' })
  assert.equal(store.getState().effortValue, undefined)
  assert.deepEqual(saved.route, { provider: 'openai', model: 'gpt-6-sol', effort: 'high' })
})

test('/surf still decides over Global when it routes the spawn', async () => {
  setSetting(GLOBAL_LUNA)
  runtime.setSurfTarget({ provider: 'moonshot', model: 'kimi-k2.6' })
  let request
  await runRealAgent({
    sessionProvider: 'antigravity', mainLoopModel: OPUS_46,
    onQuery: params => { request = [runtime.getAPIProvider(), params.toolUseContext.options.mainLoopModel] },
  })
  assert.deepEqual(request, ['moonshot', 'kimi-k2.6'])
})

test('the Agent tool tag names the provider a Global pick runs on', async () => {
  setSetting(GLOBAL_LUNA)
  runtime.setSessionProvider('antigravity')
  runtime.setAgentStream(async function* () {
    yield {
      type: 'assistant', uuid: 'tag-response', timestamp: new Date().toISOString(),
      message: { id: 'tag-response', role: 'assistant', model: 'mock-model',
        content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 2, output_tokens: 1 } },
    }
  })
  const store = runtime.createStore({
    tasks: {}, todos: {},
    toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
    mcp: { clients: [], tools: [] }, speculation: { status: 'idle' },
  })
  const agentType = 'tag-test'
  const result = await runtime.AgentTool.call({ subagent_type: agentType, description: 'Check the tag', prompt: 'Finish.', model: 'haiku' }, {
    getAppState: store.getState, setAppState: store.setState,
    abortController: new AbortController(), toolUseId: 'tag-tool', messages: [],
    options: { tools: [], mcpClients: [], mainLoopModel: OPUS_46,
      agentDefinitions: { activeAgents: [{ agentType, source: 'projectSettings', getSystemPrompt: () => 'Test.' }] } },
  }, async () => ({ behavior: 'allow' }), { message: { id: 'tag-message' } })
  assert.equal(result.data.status, 'completed')
  assert.deepEqual(runtime.getAgentResolvedModel(agentType), { model: LUNA, provider: 'openai' })
})

test('a model browser selection becomes a pick: decoded id, an effort that reaches the agent, or the reason it cannot', () => {
  const pick = (...args) => runtime.resolveSubagentModelPick(...args)
  assert.deepEqual(pick('firstParty', 'claude-opus-5-5::effort=high'),
    { ok: true, target: { provider: 'firstParty', model: 'claude-opus-5-5', effort: 'high' } })
  assert.deepEqual(pick('firstParty', 'claude-haiku-4-5'), { ok: true, target: { provider: 'firstParty', model: 'claude-haiku-4-5' } })
  assert.deepEqual(pick('openai', LUNA, 'xhigh'), { ok: true, target: { provider: 'openai', model: LUNA, effort: 'xhigh' } })
  assert.deepEqual(pick('openai', LUNA), { ok: true, target: { provider: 'openai', model: LUNA } })
  assert.deepEqual(pick('antigravity', OPUS_46), { ok: true, target: { provider: 'antigravity', model: OPUS_46 } })
  assert.deepEqual(pick('xai', 'grok-4.7', undefined, 'low'), { ok: true, target: { provider: 'xai', model: 'grok-4.7', effort: 'low' } })
  assert.deepEqual(pick('xai', 'grok-4.7', undefined, 'auto'), { ok: true, target: { provider: 'xai', model: 'grok-4.7' } })
  const native = pick('xai', 'grok-4.3', undefined, 'none')
  assert.equal(native.ok, false)
  assert.match(native.message, /"none" can only be set for grok-4\.3 everywhere/)
  runtime.setXaiEffort('grok-4.7', 'high')
  try {
    const conflict = pick('xai', 'grok-4.7', undefined, 'low')
    assert.equal(conflict.ok, false)
    assert.match(conflict.message, /grok-4\.7 has its own effort set in \/models \(high\)/)
    assert.deepEqual(pick('xai', 'grok-4.7', undefined, 'high'), { ok: true, target: { provider: 'xai', model: 'grok-4.7' } })
  } finally {
    runtime.clearXaiEffort('grok-4.7')
  }
})

// The reported failure: Global on DeepSeek while the session runs a Gemini
// model sent `gemini-3.8-flash-high` to DeepSeek.
const DEEPSEEK_FLASH = 'deepseek-flash'
const GLOBAL_DEEPSEEK = { mode: 'global', global: { provider: 'deepseek', model: DEEPSEEK_FLASH } }

test('cheap-model helpers and token counts in a Global agent use its model on its provider', async () => {
  setSetting(GLOBAL_DEEPSEEK)
  process.env.ANTHROPIC_MODEL = GEMINI_HIGH
  assert.equal(runtime.getMainLoopModel(), GEMINI_HIGH)
  const counted = []
  runtime.setAnthropicClient(async () => ({ beta: { messages: { countTokens: async request => {
    counted.push([runtime.getAPIProvider(), request.model])
    return { input_tokens: 3 }
  } } } }))
  let inside
  await runRealAgent({
    sessionProvider: 'antigravity', mainLoopModel: GEMINI_HIGH, model: 'haiku',
    onQuery: async params => {
      inside = {
        provider: runtime.getAPIProvider(),
        model: params.toolUseContext.options.mainLoopModel,
        smallFast: runtime.getSmallFastModel(),
        tokens: await runtime.countMessagesTokensWithAPI([{ role: 'user', content: 'Count.' }], []),
      }
    },
  })
  assert.deepEqual(inside, { provider: 'deepseek', model: DEEPSEEK_FLASH, smallFast: DEEPSEEK_FLASH, tokens: 3 })
  assert.deepEqual(counted, [['deepseek', DEEPSEEK_FLASH]])
  assert.equal(runtime.getAPIProvider(), 'antigravity')
  assert.notEqual(runtime.getSmallFastModel(), DEEPSEEK_FLASH, 'the session pairs helpers with its own model')
})

test('an agent held on its starting provider pairs helpers with its own model after the session moves', async () => {
  setSetting({ mode: 'custom', models: { openai: LUNA } })
  process.env.ANTHROPIC_MODEL = SOL
  let inside
  await runRealAgent({
    sessionProvider: 'openai', mainLoopModel: SOL, model: 'sonnet',
    onQuery: async () => {
      runtime.setSessionProvider('antigravity')
      process.env.ANTHROPIC_MODEL = OPUS_46
      await new Promise(resolve => setImmediate(resolve))
      inside = { provider: runtime.getAPIProvider(), smallFast: runtime.getSmallFastModel() }
    },
  })
  // OpenAI's helper model for a GPT parent, not the session's Antigravity model.
  assert.deepEqual(inside, { provider: 'openai', smallFast: LUNA })
})

test('a nested agent runs in its own copy of the enclosing scope, carrying its own model', async () => {
  setSetting(GLOBAL_DEEPSEEK)
  const parent = { provider: 'deepseek', source: 'agent', model: 'deepseek-v4-pro' }
  let inside
  await runtime.runWithForcedProvider(parent, () => runRealAgent({
    sessionProvider: 'antigravity', mainLoopModel: GEMINI_HIGH,
    onQuery: () => {
      const scope = runtime.getForcedProviderContext()
      inside = { copy: scope !== parent, provider: scope.provider, source: scope.source, model: scope.model }
    },
  }))
  assert.deepEqual(inside, { copy: true, provider: 'deepseek', source: 'agent', model: DEEPSEEK_FLASH })
  assert.deepEqual(parent, { provider: 'deepseek', source: 'agent', model: 'deepseek-v4-pro' })
})

test('a turn the queue starts from inside a sub-agent scope runs on the session provider', async () => {
  runtime.setSessionProvider('antigravity')
  const notification = '<task-notification>done</task-notification>'
  const seen = []
  runtime.setProcessUserInput(async () => {
    seen.push(['input', runtime.getAPIProvider(), runtime.getForcedProviderContext()])
    return { messages: [runtime.createUserMessage({ content: notification })], shouldQuery: true }
  })
  const submit = () => runtime.handlePromptSubmit({
    queuedCommands: [{ value: notification, mode: 'task-notification' }],
    helpers: { setCursorOffset() {}, clearBuffer() {}, resetHistory() {} },
    queryGuard: new runtime.QueryGuard(), commands: [], messages: [], mainLoopModel: GEMINI_HIGH,
    querySource: 'repl_main_thread',
    getToolUseContext: () => ({ getAppState: () => ({ toolPermissionContext: { mode: 'default' } }) }),
    setToolJSX() {}, setUserInputOnProcessing() {}, setAbortController() {}, setAppState() {},
    onInputChange() {}, setPastedContents() {},
    onQuery: async () => {
      seen.push(['query', runtime.getAPIProvider(), runtime.getForcedProviderContext()])
      await new Promise(resolve => setImmediate(resolve))
      seen.push(['after await', runtime.getAPIProvider()])
    },
  })
  // As React does when an agent's state update schedules the render whose
  // effect dequeues the notification: the work starts inside the agent's scope.
  await runtime.runWithForcedProvider({ provider: 'deepseek', source: 'agent', model: DEEPSEEK_FLASH }, () =>
    new Promise((resolve, reject) => setImmediate(() => submit().then(resolve, reject))))
  assert.deepEqual(seen, [
    ['input', 'antigravity', undefined],
    ['query', 'antigravity', undefined],
    ['after await', 'antigravity'],
  ])
})

test('a /surf-routed spawn moves the agent alone; the session stays on its own provider', async () => {
  runtime.setSurfTarget({ provider: 'moonshot', model: 'kimi-k2.6' })
  let inside
  await runRealAgent({
    sessionProvider: 'openai', mainLoopModel: SOL,
    onQuery: params => { inside = [runtime.getAPIProvider(), params.toolUseContext.options.mainLoopModel] },
  })
  assert.deepEqual(inside, ['moonshot', 'kimi-k2.6'])
  assert.equal(runtime.getAPIProvider(), 'openai', "the parent's next request still goes to its own provider")
})

test('/surf moves a nested agent off its parent provider with its model, and stays out of explicit choices', async () => {
  runtime.setSurfTarget({ provider: 'moonshot', model: 'kimi-k2.6' })
  const parent = { provider: 'deepseek', source: 'agent', model: DEEPSEEK_FLASH }
  let nested
  await runtime.runWithForcedProvider(parent, () => runRealAgent({
    sessionProvider: 'antigravity', mainLoopModel: GEMINI_HIGH,
    onQuery: params => { nested = [runtime.getAPIProvider(), params.toolUseContext.options.mainLoopModel] },
  }))
  assert.deepEqual(nested, ['moonshot', 'kimi-k2.6'])
  assert.deepEqual(parent, { provider: 'deepseek', source: 'agent', model: DEEPSEEK_FLASH })
  assert.equal(runtime.getAPIProvider(), 'antigravity')
  let explicit
  await runtime.runWithForcedProvider({ provider: 'openrouter' }, () => runRealAgent({
    sessionProvider: 'antigravity', mainLoopModel: GEMINI_HIGH,
    onQuery: params => { explicit = [runtime.getAPIProvider(), params.toolUseContext.options.mainLoopModel] },
  }))
  assert.equal(explicit[0], 'openrouter')
  assert.notEqual(explicit[1], 'kimi-k2.6', 'an explicit provider keeps its own model')
})
