import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// Exercise the shipped resolver and Agent tool. The production graph uses
// build-time macros, so expose its internal entry points from the built bundle.
// Only the network-backed runAgent iterator is substituted in dispatch tests.
const tempRoot = mkdtempSync(join(tmpdir(), 'tau-mistral-routing-'))
const originalEnv = { ...process.env }
process.env.CLAUDE_CODE_TMPDIR = tempRoot
process.env.CLAUDE_CONFIG_DIR = tempRoot
process.env.NODE_ENV = 'production'
delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
delete process.env.CLAUDE_AUTO_BACKGROUND_TASKS
process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'

const distPath = resolve('dist/tau.mjs')
let bundle = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
const agentToolName = bundle.match(/(AgentTool\d*) = buildTool\(/)?.[1]
assert.ok(agentToolName, 'AgentTool must be present in the built runtime')
bundle += `
export function __mistralAgentRouting() {
  init_AgentTool(); init_agent(); init_store(); init_forcedProvider();
  init_generalPurposeAgent(); init_exploreAgent(); init_planAgent();
  init_agentModelManager();
  const agentRunner = runAgent;
  const readConfig = getGlobalConfig;
  return {
    AgentTool: ${agentToolName}, getAgentModel, getAPIProvider,
    runWithAgentProvider, runWithForcedProvider, getForcedProviderContext,
    getAgentResolvedModel, createStore,
    agentRunner, parseAgentFromMarkdown, getSmallFastModel,
    setInnerAgentStream(makeStream) { runAgentWithoutProviderOverride = makeStream; },
    setSurfTarget(target) {
      isSurfEnabled = () => !!target;
      getGlobalConfig = () => ({ ...readConfig(), surfPhaseTargets: { subagent: target } });
    },
    builtins: { general: GENERAL_PURPOSE_AGENT, explore: EXPLORE_AGENT, plan: PLAN_AGENT },
    setSessionProvider(provider) { _sessionActiveProvider = provider; },
    setAgentStream(makeStream) { runAgent = makeStream; }
  };
}
`
const auditPath = join(dirname(distPath), `.mistral-routing-${process.pid}.mjs`)
writeFileSync(auditPath, bundle)
let runtime
try {
  runtime = (await import(pathToFileURL(auditPath).href)).__mistralAgentRouting()
} finally {
  unlinkSync(auditPath)
}

test.beforeEach(() => {
  runtime.setSessionProvider('mistral')
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  runtime.setSurfTarget(undefined)
})
test.after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  rmSync(tempRoot, { recursive: true, force: true })
})

const LARGE_3 = 'mistral-large-2512'
const PARENT = 'mistral-large-4'
const ALIASES = ['haiku', 'sonnet', 'opus', 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan']
const resolveModel = (definition, caller, provider) =>
  runtime.runWithAgentProvider(provider, () =>
    runtime.getAgentModel(definition, PARENT, caller, 'default', provider))

test('Mistral omitted and tier selections use Large 3 independently of the parent', () => {
  for (const parent of [PARENT, 'zai-glm-5-3', LARGE_3]) {
    assert.equal(runtime.getAgentModel(undefined, parent), LARGE_3)
    for (const alias of ALIASES) {
      assert.equal(runtime.getAgentModel(alias, parent), LARGE_3, `definition ${alias}`)
      assert.equal(runtime.getAgentModel(undefined, parent, alias), LARGE_3, `caller ${alias}`)
      assert.equal(runtime.getAgentModel(` ${alias.toUpperCase()} `, parent), LARGE_3)
      assert.equal(runtime.getAgentModel(undefined, parent, ` ${alias.toUpperCase()} `), LARGE_3)
    }
  }
})

test('Mistral treats blank model specs as omitted and preserves concrete model spelling', () => {
  assert.equal(resolveModel('  ', '  '), LARGE_3)
  assert.equal(resolveModel(' Custom-Deployment-ID '), 'Custom-Deployment-ID')
  assert.equal(resolveModel(undefined, ' Custom-Deployment-ID '), 'Custom-Deployment-ID')
})

test('concrete definitions and explicit inherit outrank automatic tier selections', () => {
  for (const caller of [undefined, ...ALIASES]) {
    assert.equal(resolveModel('zai-glm-5-3', caller), 'zai-glm-5-3')
    assert.equal(resolveModel('zai-glm-5-3', caller, 'mistral'), 'zai-glm-5-3')
    assert.equal(resolveModel('inherit', caller), PARENT)
    assert.equal(resolveModel(' INHERIT ', caller), PARENT)
  }
})

test('an explicit caller model or inherit overrides a concrete definition', () => {
  for (const provider of [undefined, 'mistral']) {
    assert.equal(resolveModel('zai-glm-5-3', 'mistral-medium-3-5', provider), 'mistral-medium-3-5')
    assert.equal(resolveModel('zai-glm-5-3', ' INHERIT ', provider), PARENT)
    assert.equal(resolveModel('inherit', 'mistral-medium-3-5', provider), 'mistral-medium-3-5')
  }
})

test('a configured environment default applies only without a specific selection', () => {
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = ' Custom-Env-Deployment '
  for (const caller of [undefined, 'haiku', 'sonnet', 'opus']) {
    assert.equal(resolveModel(undefined, caller), 'Custom-Env-Deployment')
    assert.equal(resolveModel('haiku', caller), 'Custom-Env-Deployment')
    assert.equal(resolveModel('zai-glm-5-3', caller), 'zai-glm-5-3')
    assert.equal(resolveModel('inherit', caller), PARENT)
  }
  assert.equal(resolveModel(undefined, 'mistral-medium-3-5'), 'mistral-medium-3-5')
  assert.equal(resolveModel(undefined, 'inherit'), PARENT)
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = ' OPUS '
  assert.equal(resolveModel(undefined), LARGE_3)
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = ' INHERIT '
  assert.equal(resolveModel(undefined), PARENT)
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = '  '
  assert.equal(resolveModel(undefined), LARGE_3)
})

test('forced providers exclude the global environment default', () => {
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'some-unrelated-provider-model'
  assert.equal(resolveModel('haiku', undefined, 'mistral'), LARGE_3)
  assert.equal(runtime.runWithForcedProvider({ provider: 'mistral' }, () =>
    resolveModel(undefined)), LARGE_3)
  assert.equal(runtime.runWithForcedProvider({ provider: 'mistral' }, () =>
    resolveModel('zai-glm-5-3', 'haiku')), 'zai-glm-5-3')
})

test('actual built-in omitted, tier, and inherit models retain their distinct intent', () => {
  assert.equal(runtime.builtins.general.model, undefined)
  assert.equal(runtime.builtins.explore.model, 'haiku')
  assert.equal(runtime.builtins.plan.model, 'inherit')
  assert.equal(resolveModel(runtime.builtins.general.model), LARGE_3)
  assert.equal(resolveModel(runtime.builtins.explore.model), LARGE_3)
  assert.equal(resolveModel(runtime.builtins.plan.model), PARENT)
})

test('foreign agent pins use their own lane and concrete model', () => {
  assert.equal(resolveModel('kimi-k2.6', 'haiku', 'moonshot'), 'kimi-k2.6')
  assert.equal(resolveModel('gemini-3-flash', 'sonnet', 'antigravity'), 'gemini-3-flash')
  assert.equal(resolveModel('qwen3:30b', 'opus', 'ollama'), 'qwen3:30b')
  assert.equal(runtime.getAPIProvider(), 'mistral')
  assert.equal(runtime.getForcedProviderContext(), undefined)
})

test('an explicit team provider wins over an agent pin and preserves its concrete caller model', () => {
  const result = runtime.runWithForcedProvider({ provider: 'moonshot' }, () =>
    runtime.runWithAgentProvider('mistral', () => ({
      provider: runtime.getAPIProvider(),
      model: runtime.getAgentModel('mistral-medium-3-5', PARENT, 'kimi-k2.6', 'default', 'mistral'),
    })))
  assert.deepEqual(result, { provider: 'moonshot', model: 'kimi-k2.6' })
  assert.equal(runtime.getAPIProvider(), 'mistral')
})

test('non-Mistral omitted models and existing tier policies remain unchanged', () => {
  const cases = [
    ['moonshot', 'kimi-k2.6', 'kimi-k2.6'],
    ['ollama', 'qwen3:30b', 'qwen3:30b'],
    ['openai', 'gpt-6', 'gpt-5.6-luna'],
    ['openrouter', 'openai/gpt-6', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
  ]
  for (const [provider, parent, tierModel] of cases) {
    runtime.runWithForcedProvider({ provider }, () => {
      assert.equal(runtime.getAgentModel(undefined, parent), parent, `${provider} omitted`)
      assert.equal(runtime.getAgentModel('haiku', parent), tierModel, `${provider} tier`)
      assert.equal(runtime.getAgentModel('inherit', parent), parent, `${provider} inherit`)
    })
  }
})

test('concurrent agent provider scopes stay isolated across awaits and nested pins', async () => {
  const observations = await Promise.all([
    runtime.runWithAgentProvider('mistral', async () => {
      await new Promise(resolve => setImmediate(resolve))
      const model = runtime.getAgentModel(undefined, PARENT)
      const child = await runtime.runWithAgentProvider('moonshot', async () => {
        await new Promise(resolve => setImmediate(resolve))
        return [runtime.getAPIProvider(), runtime.getAgentModel('kimi-k2.6', PARENT)]
      })
      return [runtime.getAPIProvider(), model, child]
    }),
    runtime.runWithForcedProvider({ provider: 'ollama' }, async () => {
      await new Promise(resolve => setImmediate(resolve))
      return runtime.runWithAgentProvider('mistral', () =>
        [runtime.getAPIProvider(), runtime.getAgentModel(undefined, 'qwen3:30b')])
    }),
  ])
  assert.deepEqual(observations, [
    ['mistral', LARGE_3, ['moonshot', 'kimi-k2.6']],
    ['ollama', 'qwen3:30b'],
  ])
  assert.equal(runtime.getAPIProvider(), 'mistral')
  assert.equal(runtime.getForcedProviderContext(), undefined)
})

let sequence = 0
async function dispatch({ definition = {}, input = {}, sessionProvider = 'mistral', forcedProvider } = {}) {
  runtime.setSessionProvider(sessionProvider)
  const agentType = `mistral-routing-${++sequence}`
  let request
  runtime.setAgentStream(async function* (params) {
    request = {
      model: params.model,
      provider: runtime.getAPIProvider(),
      definition: params.agentDefinition,
    }
    yield {
      type: 'assistant', uuid: `${agentType}-response`, timestamp: new Date().toISOString(),
      message: {
        id: `${agentType}-response`, role: 'assistant', model: 'mock-model',
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      },
    }
  })
  const store = runtime.createStore({
    tasks: {},
    toolPermissionContext: {
      mode: 'default', additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
    },
    mcp: { clients: [], tools: [] },
    speculation: { status: 'idle' },
  })
  const context = {
    getAppState: store.getState, setAppState: store.setState,
    abortController: new AbortController(), toolUseId: `${agentType}-tool`, messages: [],
    options: {
      tools: [], mcpClients: [], mainLoopModel: PARENT,
      agentDefinitions: { activeAgents: [{
        agentType, source: 'projectSettings', getSystemPrompt: () => 'Test agent.', ...definition,
      }] },
    },
  }
  const call = () => runtime.AgentTool.call({
    subagent_type: agentType, description: 'Check Mistral routing', prompt: 'Finish.', ...input,
  }, context, async () => ({ behavior: 'allow' }), {
    message: { id: `${agentType}-message` },
  })
  const result = await (forcedProvider
    ? runtime.runWithForcedProvider({ provider: forcedProvider }, call)
    : call())
  assert.equal(result.data.status, 'completed')
  assert.ok(request, 'AgentTool dispatched a request')
  return { request, resolved: runtime.getAgentResolvedModel(agentType) }
}

test('AgentTool forwards a standalone concrete model_id on Mistral and records that model', async () => {
  const result = await dispatch({ input: { model_id: 'zai-glm-5-3', model: 'haiku' } })
  assert.equal(result.request.model, 'zai-glm-5-3')
  assert.equal(result.resolved.model, 'zai-glm-5-3')
})

test('AgentTool defaults omitted/tier requests to Large 3 while preserving a definition model', async () => {
  for (const input of [{}, { model: 'haiku' }, { model: 'sonnet' }, { model: 'opus' }]) {
    assert.equal((await dispatch({ input })).resolved.model, LARGE_3)
    assert.equal((await dispatch({ input, definition: { model: 'zai-glm-5-3' } })).resolved.model, 'zai-glm-5-3')
    assert.equal((await dispatch({ input, definition: { model: 'inherit' } })).resolved.model, PARENT)
  }
})

test('AgentTool decides standalone model_id using the selected agent effective provider', async () => {
  const mistralPin = await dispatch({
    sessionProvider: 'moonshot', definition: { provider: 'mistral', model: LARGE_3 },
    input: { model_id: 'zai-glm-5-3' },
  })
  assert.equal(mistralPin.request.model, 'zai-glm-5-3')
  assert.equal(mistralPin.resolved.model, 'zai-glm-5-3')
  const foreignPin = await dispatch({
    definition: { provider: 'moonshot', model: 'kimi-k2.6' },
    input: { model_id: 'zai-glm-5-3', model: 'haiku' },
  })
  assert.equal(foreignPin.request.model, 'haiku')
  assert.equal(foreignPin.resolved.model, 'kimi-k2.6')
})

test('AgentTool rejects standalone model_id for other lanes and with an invalid raw provider', async () => {
  const foreign = await dispatch({
    sessionProvider: 'moonshot', input: { model_id: 'zai-glm-5-3', model: 'haiku' },
  })
  assert.equal(foreign.request.model, 'haiku')
  const invalid = await dispatch({ input: { provider: 'made-up-provider', model_id: 'zai-glm-5-3' } })
  assert.equal(invalid.request.model, undefined)
  assert.equal(invalid.resolved.model, LARGE_3)
})

test('AgentTool explicit provider/model pairs and forced team scope take precedence', async () => {
  const explicit = await dispatch({
    definition: { provider: 'mistral', model: LARGE_3 },
    input: { provider: 'moonshot', model_id: 'kimi-k2.6', model: 'haiku' },
  })
  assert.equal(explicit.request.provider, 'moonshot')
  assert.equal(explicit.request.model, 'kimi-k2.6')
  assert.equal(explicit.resolved.model, 'kimi-k2.6')
  const forcedMistral = await dispatch({
    sessionProvider: 'moonshot', forcedProvider: 'mistral',
    definition: { provider: 'moonshot', model: 'kimi-k2.6' },
    input: { model_id: 'zai-glm-5-3' },
  })
  assert.equal(forcedMistral.request.provider, 'mistral')
  assert.equal(forcedMistral.request.model, 'zai-glm-5-3')
  assert.equal(forcedMistral.resolved.model, 'zai-glm-5-3')
})

test('Mistral frontmatter accepts every supported tier and helpers use Large 3', () => {
  for (const model of ALIASES) {
    const agent = runtime.parseAgentFromMarkdown('/agents/test.md', '/agents', {
      name: 'test', description: 'Test', provider: 'mistral', model,
    }, 'Test agent.', 'projectSettings')
    assert.equal(agent.provider, 'mistral')
    assert.equal(agent.providerConfigError, undefined)
  }
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  assert.equal(runtime.getSmallFastModel(), LARGE_3)
})

function workerOptions(definition = {}, model) {
  return {
    agentDefinition: { agentType: 'worker-test', ...definition }, model,
    toolUseContext: {
      options: { mainLoopModel: PARENT },
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    },
  }
}

test('running Mistral workers retain their route across parent switches and generator cleanup', async () => {
  const seen = []
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'zai-glm-5-3'
  runtime.setInnerAgentStream(async function* (_options, route) {
    try {
      await Promise.resolve()
      seen.push([runtime.getAPIProvider(), route.model])
      yield 'first'
      await Promise.resolve()
      seen.push([runtime.getAPIProvider(), route.model])
      yield 'second'
    } finally {
      seen.push(['cleanup', runtime.getAPIProvider()])
    }
  })
  const worker = runtime.agentRunner(workerOptions())
  assert.equal((await worker.next()).value, 'first')
  assert.equal(runtime.getForcedProviderContext(), undefined)
  runtime.setSessionProvider('moonshot')
  assert.equal((await worker.next()).value, 'second')
  await worker.return()
  assert.deepEqual(seen, [
    ['mistral', 'zai-glm-5-3'], ['mistral', 'zai-glm-5-3'], ['cleanup', 'mistral'],
  ])
  assert.equal(runtime.getAPIProvider(), 'moonshot')
  assert.equal(runtime.getForcedProviderContext(), undefined)
})

test('Mistral surf targets are local to the worker and cannot erase explicit choices', async () => {
  runtime.setSurfTarget({ provider: 'moonshot', model: 'kimi-k2.6', effort: 'high' })
  const seen = []
  runtime.setInnerAgentStream(async function* (_options, route) {
    seen.push([runtime.getAPIProvider(), route.model, route.surf?.effort])
  })
  await runtime.agentRunner(workerOptions()).next()
  await runtime.agentRunner(workerOptions({ model: 'inherit' })).next()
  await runtime.agentRunner(workerOptions({}, 'zai-glm-5-3')).next()
  await runtime.runWithForcedProvider({ provider: 'mistral' }, () =>
    runtime.agentRunner(workerOptions()).next())
  assert.deepEqual(seen, [
    ['moonshot', 'kimi-k2.6', 'high'], ['mistral', PARENT, undefined],
    ['mistral', 'zai-glm-5-3', undefined], ['mistral', LARGE_3, undefined],
  ])
  assert.equal(runtime.getAPIProvider(), 'mistral')
  assert.equal(runtime.getForcedProviderContext(), undefined)
})
