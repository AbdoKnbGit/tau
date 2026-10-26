import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// Exercise the shipped resume path for agents other than Mistral workers:
// metadata validation, the saved route and its provider scope. Task
// registration and the model-backed iterator are substituted, so nothing is
// sent to a provider.
// Run: node build.mjs && node --test test/subagent-model-resume.test.mjs
const tempRoot = mkdtempSync(join(tmpdir(), 'tau-subagent-resume-'))
const originalCwd = process.cwd()
process.env.CLAUDE_CONFIG_DIR = tempRoot
process.env.CLAUDE_CODE_TMPDIR = tempRoot
delete process.env.CLAUDE_CODE_SUBAGENT_MODEL

const bundlePath = resolve('dist/tau.mjs')
let bundle = readFileSync(bundlePath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
bundle += `
export function __subagentResumeTest(deps) {
  init_resumeAgent(); init_sessionStorage(); init_forcedProvider(); init_settings(); init_settings2();
  getAgentTranscript = async () => ({ messages: [], contentReplacements: [] });
  registerAsyncAgent = ({ agentId }) => ({ agentId, abortController: new AbortController() });
  assembleToolPool = deps.assembleTools;
  beginAgentFileScope = () => {};
  runAgent = deps.runAgent;
  runAsyncAgentLifecycle = deps.lifecycle;
  getSystemPrompt = deps.systemPrompt;
  return { resumeAgentBackground, getAgentResumeRoute, writeAgentMetadata,
    getAPIProvider, setActiveProvider, getForcedProvider, getForcedProviderContext,
    runWithForcedProvider, runWithAgentProvider, getAgentResolvedModel, updateSettingsForSource };
}
`
const auditPath = join(dirname(bundlePath), `.subagent-resume-${process.pid}.mjs`)
let loadRuntime
try {
  writeFileSync(auditPath, bundle)
  process.chdir(tempRoot)
  loadRuntime = (await import(pathToFileURL(auditPath).href)).__subagentResumeTest
} finally {
  unlinkSync(auditPath)
}
test.after(() => {
  process.chdir(originalCwd)
  rmSync(tempRoot, { recursive: true, force: true })
})

const SOL = 'gpt-6.1-sol'
const LUNA = 'gpt-6-luna'
const GEMINI_MEDIUM = 'gemini-3.8-flash-medium'

let sequence = 0
function fixture() {
  let request
  let lifecycleProvider
  let lifecycleSource
  const consumerProviders = []
  let scheduledProvider
  let iteratorProvider
  let toolsProvider
  let finish
  const done = new Promise(resolveDone => { finish = resolveDone })
  const runtime = loadRuntime({
    async *runAgent(params) {
      request = params
      await Promise.resolve()
      iteratorProvider = runtime.runWithAgentProvider(
        params.agentDefinition.provider,
        () => runtime.getAPIProvider(),
      )
      // Work the agent schedules from its own steps, as its progress
      // summaries do, stays on its route and so on its prompt cache.
      await new Promise(resolveTimer => setTimeout(() => {
        scheduledProvider = runtime.getAPIProvider()
        resolveTimer()
      }, 0))
      yield { type: 'progress' }
    },
    async lifecycle(params) {
      try {
        await Promise.resolve()
        lifecycleProvider = runtime.getAPIProvider()
        lifecycleSource = runtime.getForcedProviderContext()?.source ?? (runtime.getForcedProviderContext() ? 'explicit' : undefined)
        // What the lifecycle does with each message (progress updates that
        // re-render the main screen) happens between the agent's steps.
        for await (const _message of params.makeStream()) consumerProviders.push(runtime.getAPIProvider())
        finish({ metadata: params.metadata })
      } catch (error) {
        finish({ error })
      }
    },
    async systemPrompt() {
      return ['Saved fork system prompt']
    },
    assembleTools() {
      toolsProvider = runtime.getAPIProvider()
      return []
    },
  })
  runtime.setActiveProvider('openai')
  const agent = { agentType: 'resume-route-test', source: 'built-in', getSystemPrompt: () => 'Test' }
  const state = {
    toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map() },
    mcp: { tools: [] },
  }
  const context = {
    getAppState: () => state,
    setAppState: () => {},
    toolUseId: 'resume-route-use',
    options: {
      mainLoopModel: SOL, tools: [], mcpClients: [],
      agentDefinitions: { activeAgents: [agent] },
    },
  }
  return {
    runtime, agent, context,
    request: () => request,
    lifecycleProvider: () => lifecycleProvider,
    lifecycleSource: () => lifecycleSource,
    consumerProviders: () => consumerProviders,
    scheduledProvider: () => scheduledProvider,
    iteratorProvider: () => iteratorProvider,
    toolsProvider: () => toolsProvider,
    async resume(meta) {
      const agentId = `r${String(++sequence).padStart(8, '0')}`
      await runtime.writeAgentMetadata(agentId, meta)
      await runtime.resumeAgentBackground({
        agentId, prompt: 'Continue.', toolUseContext: context,
        canUseTool: async () => ({ behavior: 'allow' }),
      })
      const result = await done
      if (result.error) throw result.error
      return result
    },
  }
}

test('a saved route needs a known provider other than Mistral and a concrete model', () => {
  const { runtime } = fixture()
  for (const metadata of [
    null, [], 1, 'openai', {}, { route: null }, { route: [] },
    { route: { provider: 'mistral', model: 'mistral-large-2512' } },
    { route: { provider: 'made-up', model: GEMINI_MEDIUM } },
    { route: { provider: 42, model: GEMINI_MEDIUM } },
    ...[undefined, null, 42, '', '  ', 'inherit', ' InHerit ', 'haiku', ' OPUS ', 'sonnet[1m]']
      .map(model => ({ route: { provider: 'antigravity', model } })),
  ]) {
    assert.equal(runtime.getAgentResumeRoute(metadata), undefined, JSON.stringify(metadata))
  }
  assert.deepEqual(
    runtime.getAgentResumeRoute({ route: { provider: 'antigravity', model: ` ${GEMINI_MEDIUM} ` } }),
    { provider: 'antigravity', model: GEMINI_MEDIUM },
  )
  assert.deepEqual(
    runtime.getAgentResumeRoute({ route: { provider: 'openai', model: LUNA, effort: ' LOW ' } }),
    { provider: 'openai', model: LUNA, effort: 'low' },
  )
  assert.deepEqual(
    runtime.getAgentResumeRoute({ route: { provider: 'openai', model: LUNA, effort: 'turbo' } }),
    { provider: 'openai', model: LUNA },
    'an effort that is not one is dropped, not the route',
  )
})

test('an agent resumes with the effort of its own it ran with', async () => {
  const f = fixture()
  await f.resume({ agentType: f.agent.agentType, route: { provider: 'antigravity', model: GEMINI_MEDIUM, effort: 'high' } })
  assert.equal(f.request().model, GEMINI_MEDIUM)
  assert.equal(f.request().resumeEffort, 'high')
  assert.equal(f.iteratorProvider(), 'antigravity')
})

test('a route without an effort resumes on the session effort, as before', async () => {
  const f = fixture()
  await f.resume({ agentType: f.agent.agentType, route: { provider: 'antigravity', model: GEMINI_MEDIUM } })
  assert.equal('resumeEffort' in f.request(), false)
})

test('an agent resumes on its saved route after the session changes provider and model', async () => {
  const f = fixture()
  const { metadata } = await f.resume({
    agentType: f.agent.agentType, model: 'haiku',
    route: { provider: 'antigravity', model: GEMINI_MEDIUM },
  })
  assert.equal(f.request().model, GEMINI_MEDIUM)
  assert.equal(metadata.resolvedAgentModel, GEMINI_MEDIUM)
  assert.equal(f.toolsProvider(), 'antigravity')
  assert.equal(f.iteratorProvider(), 'antigravity')
  assert.equal(f.scheduledProvider(), 'antigravity')
  // Only the agent runs on its route. The lifecycle around it stays on the
  // session's provider, as for a spawn: its progress updates re-render the
  // main screen, which must not read the agent's provider.
  assert.equal(f.lifecycleProvider(), 'openai')
  assert.equal(f.lifecycleSource(), undefined)
  assert.deepEqual(f.consumerProviders(), ['openai'])
  assert.deepEqual(f.runtime.getAgentResolvedModel(f.agent.agentType), { model: GEMINI_MEDIUM, provider: 'antigravity' })
  assert.equal(f.runtime.getAPIProvider(), 'openai', 'resume must not move the session')
  assert.equal(f.runtime.getForcedProviderContext(), undefined, 'the scope must not escape')
})

test('the Sub-agent model setting does not move a resumed agent off its route', async () => {
  const f = fixture()
  assert.equal(f.runtime.updateSettingsForSource('userSettings', { subagentModel: { mode: 'inherit' } }).error, null)
  try {
    await f.resume({ agentType: f.agent.agentType, route: { provider: 'antigravity', model: GEMINI_MEDIUM } })
    assert.equal(f.request().model, GEMINI_MEDIUM)
    assert.equal(f.iteratorProvider(), 'antigravity')
  } finally {
    f.runtime.updateSettingsForSource('userSettings', { subagentModel: undefined })
  }
})

test('a route on the session provider resumes there without naming the provider', async () => {
  const f = fixture()
  await f.resume({ agentType: f.agent.agentType, route: { provider: 'openai', model: 'gpt-6-sol' } })
  assert.equal(f.request().model, 'gpt-6-sol')
  assert.equal(f.iteratorProvider(), 'openai')
  assert.deepEqual(f.runtime.getAgentResolvedModel(f.agent.agentType), { model: 'gpt-6-sol' })
})

test('older metadata without a route resolves again, as before', async () => {
  const f = fixture()
  const { metadata } = await f.resume({ agentType: f.agent.agentType, model: 'haiku' })
  assert.equal(f.request().model, 'haiku')
  assert.equal(metadata.resolvedAgentModel, LUNA)
  assert.equal(f.lifecycleProvider(), 'openai')
  assert.equal(f.lifecycleSource(), undefined)
})

test('an agent file that now pins a provider decides instead of the saved route', async () => {
  const f = fixture()
  f.agent.source = 'projectSettings'
  f.agent.provider = 'moonshot'
  f.agent.model = 'kimi-k2.6'
  const { metadata } = await f.resume({
    agentType: f.agent.agentType, route: { provider: 'antigravity', model: GEMINI_MEDIUM },
  })
  assert.equal(f.request().model, undefined)
  assert.equal(metadata.resolvedAgentModel, 'kimi-k2.6')
  assert.equal(f.iteratorProvider(), 'moonshot')
})

test('an explicit caller provider in force decides instead of the saved route', async () => {
  const f = fixture()
  await f.runtime.runWithForcedProvider({ provider: 'openrouter' }, async () => {
    await f.resume({ agentType: f.agent.agentType, route: { provider: 'antigravity', model: GEMINI_MEDIUM } })
    assert.equal(f.runtime.getAPIProvider(), 'openrouter')
  })
  assert.equal(f.lifecycleProvider(), 'openrouter')
  assert.equal(f.lifecycleSource(), 'explicit')
  assert.equal(f.request().model, undefined)
  assert.equal(f.runtime.getForcedProvider(), undefined)
})
