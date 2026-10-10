import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// Exercise the shipped resume path, metadata persistence, model resolver and
// AsyncLocalStorage scopes. Substitute task registration and the model-backed
// iterator so this is deterministic and never sends an API request.
// Run: node build.mjs && node --test test/mistral-subagent-resume.test.mjs
const tempRoot = mkdtempSync(join(tmpdir(), 'tau-mistral-resume-'))
process.env.CLAUDE_CONFIG_DIR = tempRoot
process.env.CLAUDE_CODE_TMPDIR = tempRoot
delete process.env.CLAUDE_CODE_SUBAGENT_MODEL

const bundlePath = resolve('dist/tau.mjs')
let bundle = readFileSync(bundlePath, 'utf8').replace(
  /\nvoid main\d*\(\);\r?\n/,
  '\n',
)
bundle += `
export function __mistralResumeTest(deps) {
  init_resumeAgent(); init_sessionStorage(); init_forcedProvider();
  getAgentTranscript = async () => ({ messages: [], contentReplacements: [] });
  registerAsyncAgent = ({ agentId }) => ({ agentId, abortController: new AbortController() });
  assembleToolPool = deps.assembleTools;
  beginAgentFileScope = () => {};
  runAgent = deps.runAgent;
  runAsyncAgentLifecycle = deps.lifecycle;
  getSystemPrompt = deps.systemPrompt;
  return { resumeAgentBackground, getMistralAgentResumeRoute, writeAgentMetadata,
    readAgentMetadata, getAPIProvider, setActiveProvider, getForcedProvider,
    runWithForcedProvider, runWithAgentProvider, getAgentResolvedModel };
}
`
const auditPath = join(
  dirname(bundlePath),
  `.mistral-resume-${process.pid}.mjs`,
)
let loadRuntime
try {
  writeFileSync(auditPath, bundle)
  loadRuntime = (await import(pathToFileURL(auditPath).href))
    .__mistralResumeTest
} finally {
  unlinkSync(auditPath)
}
test.after(() => rmSync(tempRoot, { recursive: true, force: true }))

let sequence = 0
function fixture() {
  let request
  let lifecycleProvider
  let iteratorProvider
  let promptRequest
  let toolsProvider
  let finish
  const done = new Promise(resolveDone => {
    finish = resolveDone
  })
  const runtime = loadRuntime({
    async *runAgent(params) {
      request = params
      await Promise.resolve()
      iteratorProvider = runtime.runWithAgentProvider(
        params.agentDefinition.provider,
        () => runtime.getAPIProvider(),
      )
    },
    async lifecycle(params) {
      try {
        await Promise.resolve()
        lifecycleProvider = runtime.getAPIProvider()
        for await (const _message of params.makeStream()) {
          /* consume */
        }
        finish({ metadata: params.metadata })
      } catch (error) {
        finish({ error })
      }
    },
    async systemPrompt(_tools, model) {
      promptRequest = { model, provider: runtime.getAPIProvider() }
      return ['Saved fork system prompt']
    },
    assembleTools() {
      toolsProvider = runtime.getAPIProvider()
      return []
    },
  })
  runtime.setActiveProvider('mistral')
  const agent = {
    agentType: 'resume-test',
    source: 'built-in',
    getSystemPrompt: () => 'Test',
  }
  const state = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
    },
    mcp: { tools: [] },
  }
  const context = {
    getAppState: () => state,
    setAppState: () => {},
    toolUseId: 'resume-test-use',
    options: {
      mainLoopModel: 'mistral-large-4-latest',
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [agent] },
    },
  }
  return {
    runtime,
    agent,
    context,
    request: () => request,
    lifecycleProvider: () => lifecycleProvider,
    iteratorProvider: () => iteratorProvider,
    promptRequest: () => promptRequest,
    toolsProvider: () => toolsProvider,
    async resume(meta) {
      const agentId = `a${String(++sequence).padStart(8, '0')}`
      await runtime.writeAgentMetadata(agentId, meta)
      await runtime.resumeAgentBackground({
        agentId,
        prompt: 'Continue.',
        toolUseContext: context,
        canUseTool: async () => ({ behavior: 'allow' }),
      })
      const result = await done
      if (result.error) throw result.error
      return result
    },
  }
}

test('saved Mistral route validates JSON shape and requires a concrete model', () => {
  const { runtime } = fixture()
  for (const metadata of [
    null,
    [],
    1,
    'mistral',
    {},
    { mistralRoute: null },
    { mistralRoute: [] },
    { mistralRoute: { provider: 'openai', model: 'gpt-5.6' } },
    ...[
      undefined,
      null,
      42,
      '',
      '  ',
      'inherit',
      ' InHerit ',
      'haiku',
      ' OPUS ',
      'sonnet[1m]',
    ].map(model => ({ mistralRoute: { provider: 'mistral', model } })),
  ]) {
    assert.equal(
      runtime.getMistralAgentResumeRoute(metadata),
      undefined,
      JSON.stringify(metadata),
    )
  }
  assert.deepEqual(
    runtime.getMistralAgentResumeRoute({
      mistralRoute: { provider: 'mistral', model: ' mistral-large-2512 ' },
    }),
    { provider: 'mistral', model: 'mistral-large-2512' },
  )
})

test('Mistral worker resumes its saved route after the parent changes provider and model', async () => {
  const f = fixture()
  f.runtime.setActiveProvider('openrouter')
  f.context.options.mainLoopModel = 'openai/gpt-5.6'
  const { metadata } = await f.resume({
    agentType: f.agent.agentType,
    model: 'haiku',
    mistralRoute: { provider: 'mistral', model: 'mistral-large-2512' },
  })
  assert.equal(f.request().model, 'mistral-large-2512')
  assert.equal(metadata.resolvedAgentModel, 'mistral-large-2512')
  assert.equal(f.lifecycleProvider(), 'mistral')
  assert.equal(f.toolsProvider(), 'mistral')
  assert.equal(f.iteratorProvider(), 'mistral')
  assert.equal(
    f.runtime.getAPIProvider(),
    'openrouter',
    'resume must not mutate the parent provider',
  )
  assert.equal(
    f.runtime.getForcedProvider(),
    undefined,
    'forced scope must not escape',
  )
})

test('saved Mistral pair outranks a changed agent provider/model pin', async () => {
  const f = fixture()
  f.agent.provider = 'openai'
  f.agent.model = 'gpt-5.6'
  await f.resume({
    agentType: f.agent.agentType,
    mistralRoute: { provider: 'mistral', model: 'mistral-medium-3-5' },
  })
  assert.equal(f.request().model, 'mistral-medium-3-5')
  assert.equal(f.iteratorProvider(), 'mistral')
  assert.deepEqual(f.runtime.getAgentResolvedModel(f.agent.agentType), {
    model: 'mistral-medium-3-5',
    provider: 'mistral',
  })
})

test('resume route is scoped inside an existing caller provider override', async () => {
  const f = fixture()
  await f.runtime.runWithForcedProvider(
    { provider: 'openrouter' },
    async () => {
      await f.resume({
        agentType: f.agent.agentType,
        mistralRoute: { provider: 'mistral', model: 'mistral-large-2512' },
      })
      assert.equal(f.runtime.getAPIProvider(), 'openrouter')
    },
  )
  assert.equal(f.lifecycleProvider(), 'mistral')
  assert.equal(f.iteratorProvider(), 'mistral')
  assert.equal(f.runtime.getForcedProvider(), undefined)
})

test('fork resume retains the original inherited model after parent changes', async () => {
  const f = fixture()
  f.runtime.setActiveProvider('openrouter')
  f.context.options.mainLoopModel = 'openai/gpt-5.6'
  await f.resume({
    agentType: 'fork',
    mistralRoute: { provider: 'mistral', model: 'mistral-large-4-latest' },
  })
  assert.equal(f.request().model, 'mistral-large-4-latest')
  assert.equal(f.request().useExactTools, true)
  assert.deepEqual(f.promptRequest(), {
    provider: 'mistral',
    model: 'mistral-large-4-latest',
  })
  assert.equal(f.lifecycleProvider(), 'mistral')
  assert.equal(f.runtime.getAPIProvider(), 'openrouter')
})

test('legacy metadata keeps its explicit model and existing provider resolution', async () => {
  const f = fixture()
  f.runtime.setActiveProvider('openrouter')
  await f.resume({ agentType: f.agent.agentType, model: 'openai/gpt-5.6' })
  assert.equal(f.request().model, 'openai/gpt-5.6')
  assert.equal(f.lifecycleProvider(), 'openrouter')
  assert.equal(f.iteratorProvider(), 'openrouter')
})

test('malformed saved route cannot override legacy model/provider selection', async () => {
  const f = fixture()
  f.runtime.setActiveProvider('openrouter')
  await f.resume({
    agentType: f.agent.agentType,
    model: 'openai/gpt-5.6',
    mistralRoute: { provider: 'mistral', model: 'inherit' },
  })
  assert.equal(f.request().model, 'openai/gpt-5.6')
  assert.equal(f.lifecycleProvider(), 'openrouter')
})
