import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import test from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-suggestion-test-'))
process.env.CLAUDE_CONFIG_DIR = fixture
process.env.DISABLE_TELEMETRY = '1'
// Explicit opt-in must not bypass the provider's generation guard.
process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = '1'
delete process.env.USER_TYPE

const r = await loadMcpRuntime({
  paths: ['src/services/PromptSuggestion/promptSuggestion.ts', 'src/utils/model/providerRegistry.ts'],
  exports: ['API_PROVIDERS', 'generateSuggestion', 'tryGenerateSuggestion',
    `installSuggestionFixture: hooks => {
      getAPIProvider = () => hooks.provider;
      runForkedAgent = async options => {
        hooks.calls.push(options);
        return { messages: [{ type: 'assistant', requestId: 'suggestion-fixture',
          message: { content: [{ type: 'text', text: 'run the tests' }] } }] };
      };
    }`],
})
const hooks = { provider: 'openai', calls: [] }
r.installSuggestionFixture(hooks)

const appState = {
  promptSuggestionEnabled: true,
  elicitation: { queue: [] },
  toolPermissionContext: { mode: 'default' },
}
const messages = [1, 2].map(id => ({
  type: 'assistant', uuid: `assistant-${id}`,
  message: { content: [{ type: 'text', text: 'Task finished.' }],
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 4096 } },
}))
const params = model => ({
  systemPrompt: ['unchanged system'], userContext: {}, systemContext: {},
  toolUseContext: { options: { mainLoopModel: model, tools: [{ name: 'Read' }] } },
  forkContextMessages: messages,
})

test.after(async () => {
  const resolved = realpathSync(fixture)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup')
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test.beforeEach(() => {
  hooks.provider = 'openai'
  hooks.calls.length = 0
})

for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-luna', 'future-model', undefined]) {
  test(`OpenAI ${model ?? 'unknown model'} cannot start a direct/pipelined suggestion fork`, async () => {
    const cacheSafeParams = params(model)
    const before = JSON.stringify(cacheSafeParams)
    assert.deepEqual(await r.generateSuggestion(new AbortController(), 'user_intent', cacheSafeParams),
      { suggestion: null, generationRequestId: null })
    assert.equal(hooks.calls.length, 0)
    assert.equal(JSON.stringify(cacheSafeParams), before, 'parent request context changed')
  })
}

for (const source of ['cli', 'sdk']) {
  test(`OpenAI ${source} suppresses suggestions even with explicit opt-in and a warm parent`, async () => {
    assert.equal(await r.tryGenerateSuggestion(new AbortController(), messages, () => appState,
      params('gpt-6.1-sol'), source), null)
    assert.equal(hooks.calls.length, 0)
    assert.equal(appState.promptSuggestionEnabled, true, 'global preference must be preserved')
  })
}

test('other providers retain the same suggestion fork and parent context', async () => {
  const cacheSafeParams = params('gpt-6.1-sol')
  const before = JSON.stringify(cacheSafeParams)
  for (const provider of r.API_PROVIDERS.filter(provider => provider !== 'openai')) {
    hooks.provider = provider
    const controller = new AbortController()
    assert.deepEqual(await r.generateSuggestion(controller, 'user_intent', cacheSafeParams),
      { suggestion: 'run the tests', generationRequestId: 'suggestion-fixture' }, provider)
    const call = hooks.calls.at(-1)
    assert.equal(call.cacheSafeParams, cacheSafeParams, provider)
    assert.equal(call.querySource, 'prompt_suggestion', provider)
    assert.deepEqual(call.overrides, { abortController: controller }, provider)
    assert.equal(call.skipTranscript, true, provider)
    assert.equal(call.skipCacheWrite, true, provider)
    assert.equal((await call.canUseTool()).behavior, 'deny', provider)
  }
  assert.equal(hooks.calls.length, r.API_PROVIDERS.length - 1)
  assert.equal(JSON.stringify(cacheSafeParams), before)
})

test('provider switching changes suppression without disabling the saved preference', async () => {
  const generate = () => r.tryGenerateSuggestion(new AbortController(), messages, () => appState,
    params('gpt-6.1-sol'), 'sdk')
  hooks.provider = 'openrouter'
  assert.equal((await generate()).suggestion, 'run the tests')
  hooks.provider = 'openai'
  assert.equal(await generate(), null)
  hooks.provider = 'openrouter'
  assert.equal((await generate()).suggestion, 'run the tests')
  assert.equal(hooks.calls.length, 2)
  assert.equal(appState.promptSuggestionEnabled, true)
})
