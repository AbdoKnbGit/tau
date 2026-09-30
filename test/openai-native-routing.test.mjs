import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Keep fixture requests, installation identity and settings away from real
// credentials. All network traffic is intercepted below.
const tempRoot = realpathSync(tmpdir())
const fixtureDirectory = mkdtempSync(join(tempRoot, 'tau-openai-native-'))
process.env.CLAUDE_CONFIG_DIR = fixtureDirectory
process.env.DISABLE_TELEMETRY = '1'
const openaiEnv = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CHATGPT_ACCESS_TOKEN',
  'OPENAI_CHATGPT_ACCOUNT_ID', 'OPENAI_CHATGPT_ID_TOKEN', 'CLAUDEX_NATIVE_LANES']
for (const key of openaiEnv) delete process.env[key]

const r = await loadMcpRuntime({
  paths: ['src/services/api/providers/providerShim.ts',
    'src/services/api/providers/nativeLaneReadiness.ts', 'src/utils/powerMode.ts'],
  exports: ['createProviderShim', 'providerUsesNativeLane', 'providerWillUseNativeLane',
    'resetReadiness: () => { readinessResolver = null; eagerLatchedProviders.clear(); }',
    'installNativeLaneReadinessResolver',
    'reloadOpenAILaneAuth', 'codexLane', 'registerLane', 'setSessionPowerMode',
    `installCredentials: credentials => {
      getProviderApiKey = provider => provider === 'openai' ? credentials.apiKey : 'other-provider-fixture';
      getProviderRuntimeApiKey = () => 'other-provider-fixture';
      getProviderAuthMethod = provider => provider === 'openai' && !credentials.apiKey ? 'oauth' : 'api_key';
      getProviderBaseUrl = () => 'https://other-provider.invalid/v1';
      getOpenAISessionToken = () => credentials.sessionToken;
      initLanes = () => { throw new Error('Unrelated provider initialization failed'); };
    }`],
})

const credentials = { apiKey: null, sessionToken: null }
r.installCredentials(credentials)
Object.defineProperty(r.codexApi, 'installationId', {
  get: () => '00000000-0000-4000-8000-000000000001',
})
const requests = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /^https:\/\/(chatgpt\.com|api\.openai\.com|fixture\.invalid)\//)
  requests.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) })
  const events = [
    { type: 'response.created', response: { id: 'resp-fixture' } },
    { type: 'response.output_text.delta', delta: 'ok' },
    { type: 'response.completed', response: { id: 'resp-fixture', usage: {
      input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 2,
    } } },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } })
}

test.after(() => {
  globalThis.fetch = originalFetch
  const resolved = realpathSync(fixtureDirectory)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup path')
  rmSync(resolved, { recursive: true, force: true })
})

test.beforeEach(() => {
  for (const key of openaiEnv) delete process.env[key]
  credentials.apiKey = null
  credentials.sessionToken = 'oauth-fixture'
  requests.length = 0
  r.codexApi.clearChain()
  r.setSessionPowerMode('normal')
  r.resetReadiness()
  r.installNativeLaneReadinessResolver(r.providerUsesNativeLane)
})

async function send({ sessionId = 'conversation-fixture', system = 'Fixture instructions', stream = true } = {}) {
  const shim = r.createProviderShim('openai', 'repl_main_thread')
  assert.equal(shim._provider.name, 'codex')
  const response = await shim.beta.messages.create({
    model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }],
    system, tools: [], max_tokens: 64, sessionId, stream,
  })
  if (stream) {
    const events = []
    for await (const event of response) events.push(event)
    assert.match(events.find(event => event.type === 'message_start').message.id, /^codex-/)
  } else {
    assert.match(response.id, /^codex-/)
  }
  return requests.at(-1)
}

for (const flag of [undefined, 'off', 'legacy', '0', 'false', '-codex', '-openai', 'gemini']) {
  test(`OpenAI stays native with lane setting ${flag ?? '(default)'}`, async () => {
    if (flag !== undefined) process.env.CLAUDEX_NATIVE_LANES = flag
    assert.equal(r.providerUsesNativeLane('openai'), true)
    assert.equal(r.providerWillUseNativeLane('openai'), true)
    const request = await send()
    assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(request.headers.get('originator'), 'codex_cli_rs')
    assert.equal(request.headers.get('authorization'), 'Bearer oauth-fixture')
  })
}

test('native tool shaping is stable before auth refresh and resolver installation', async () => {
  credentials.sessionToken = null
  r.codexLane.setHealthy(false)
  r.resetReadiness()
  assert.equal(r.providerWillUseNativeLane('openai'), true)
  assert.equal(r.providerUsesNativeLane('openai'), true)
  // Equivalent to the token refresh getAnthropicClient completes before it
  // creates the provider, after the tool-schema gate has already run.
  credentials.sessionToken = 'refreshed-fixture'
  const request = await send()
  assert.equal(request.headers.get('authorization'), 'Bearer refreshed-fixture')
  assert.equal(r.codexLane.isHealthy(), true)
})

test('request recreation and token rotation retain conversation cache state', async () => {
  const prefix = 'Stable instructions. '.repeat(200)
  const first = await send({ system: `${prefix}\n<env>\nDate: first\n</env>` })
  credentials.sessionToken = 'rotated-fixture'
  r.codexLane.setHealthy(false)
  const second = await send({ system: `${prefix}\n<env>\nDate: second\n</env>` })
  assert.equal(second.headers.get('authorization'), 'Bearer rotated-fixture')
  assert.equal(first.body.prompt_cache_key, 'conversation-fixture')
  assert.equal(second.body.prompt_cache_key, first.body.prompt_cache_key)
  assert.equal(second.headers.get('session_id'), first.headers.get('session_id'))
  assert.equal(second.body.instructions, first.body.instructions)
  assert.deepEqual(second.body.input, first.body.input)
  const fresh = await send({ sessionId: 'new-conversation' })
  assert.equal(fresh.body.prompt_cache_key, 'new-conversation')
})

test('native Codex handles API keys and non-streaming calls', async () => {
  credentials.sessionToken = null
  credentials.apiKey = 'api-key-fixture'
  const request = await send({ stream: false })
  assert.equal(request.url, 'https://api.openai.com/v1/responses')
  assert.equal(request.headers.get('authorization'), 'Bearer api-key-fixture')
})

test('removed credentials fail locally instead of using legacy or stale auth', async () => {
  await send()
  credentials.sessionToken = null
  assert.throws(() => r.createProviderShim('openai'), /Run \/login openai/)
  assert.equal(r.codexApi.isConfigured, false)
  assert.equal(requests.length, 1)
  credentials.apiKey = 'new-api-key-fixture'
  assert.equal((await send()).headers.get('authorization'), 'Bearer new-api-key-fixture')
})

test('login reload and account/endpoint changes clear old OpenAI hints', async () => {
  process.env.OPENAI_BASE_URL = 'https://fixture.invalid/v1'
  process.env.OPENAI_CHATGPT_ACCOUNT_ID = 'old-account'
  await r.reloadOpenAILaneAuth()
  const first = await send()
  assert.equal(first.url, 'https://fixture.invalid/v1/responses')
  assert.equal(first.headers.get('ChatGPT-Account-ID'), 'old-account')
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_CHATGPT_ACCOUNT_ID
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'new-account' } })).toString('base64url')
  credentials.sessionToken = `fixture.${claims}.signature`
  await r.reloadOpenAILaneAuth()
  const second = await send()
  assert.equal(second.url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(second.headers.get('ChatGPT-Account-ID'), 'new-account')
})

test('environment OAuth credentials use native Codex', async () => {
  credentials.sessionToken = null
  process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'env-oauth-fixture'
  assert.equal((await send()).headers.get('authorization'), 'Bearer env-oauth-fixture')
})

test('cheap mode also uses native OpenAI with no MCP tools', async () => {
  r.setSessionPowerMode('cheap')
  const request = await send()
  assert.ok(!request.body.tools?.length)
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses')
})

test('other providers still honor legacy flags and native readiness', () => {
  process.env.CLAUDEX_NATIVE_LANES = 'off'
  for (const provider of ['groq', 'deepseek', 'opencode']) {
    assert.equal(r.providerUsesNativeLane(provider), false)
    assert.notEqual(r.createProviderShim(provider)._provider.name, 'codex')
  }
  r.registerLane({ name: 'openai-compat', isHealthy: () => true })
  delete process.env.CLAUDEX_NATIVE_LANES
  for (const provider of ['groq', 'deepseek', 'opencode']) {
    assert.equal(r.providerUsesNativeLane(provider), true)
    assert.equal(r.createProviderShim(provider)._provider.name, 'openai-compat')
  }
  r.resetReadiness()
  assert.equal(r.providerWillUseNativeLane('deepseek'), false)
  r.installNativeLaneReadinessResolver(() => true)
  assert.equal(r.providerWillUseNativeLane('deepseek'), false, 'other providers retain their eager latch')
})
