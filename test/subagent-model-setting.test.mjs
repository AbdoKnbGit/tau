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

const distPath = resolve('dist/tau.mjs')
let bundle = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
const agentToolName = bundle.match(/(AgentTool\d*) = buildTool\(/)?.[1]
assert.ok(agentToolName, 'AgentTool must be present in the built runtime')
bundle += `
export function __subagentModelSetting() {
  init_AgentTool(); init_agent(); init_agent2(); init_store(); init_forcedProvider();
  init_generalPurposeAgent(); init_exploreAgent(); init_planAgent(); init_statuslineSetup();
  init_agentModelManager(); init_settings(); init_settings2(); init_sessionStorage();
  init_messages(); init_runAgent();
  const realInner = runAgentWithoutProviderOverride;
  const realQuery = query;
  const readConfig = getGlobalConfig;
  return {
    AgentTool: ${agentToolName}, getAgentModel, getAgentModelDisplay, getAgentModelScope,
    getAPIProvider, runWithAgentProvider, runWithForcedProvider, getForcedProviderContext,
    getForcedProvider, getAgentResolvedModel, createStore, agentRunner: runAgent,
    updateSettingsForSource, getInitialSettings, readAgentMetadata, createUserMessage,
    setInnerAgentStream(makeStream) { runAgentWithoutProviderOverride = makeStream ?? realInner; },
    setQuery(fn) { query = fn ?? realQuery; },
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
async function runRealAgent({ definition, model, sessionProvider, mainLoopModel, onQuery }) {
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
