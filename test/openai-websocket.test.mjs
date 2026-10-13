import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { WebSocketServer } from 'ws'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// The Codex lane's ChatGPT transport: Responses over one kept WebSocket per
// conversation, HTTP when the upgrade is refused. Everything talks to a local
// server; credentials and settings never come from the developer's install.
const tempRoot = realpathSync(tmpdir())
const fixtureDirectory = mkdtempSync(join(tempRoot, 'tau-openai-ws-'))
process.env.CLAUDE_CONFIG_DIR = fixtureDirectory
process.env.DISABLE_TELEMETRY = '1'
const openaiEnv = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CHATGPT_ACCESS_TOKEN',
  'OPENAI_CHATGPT_ACCOUNT_ID', 'OPENAI_CHATGPT_ID_TOKEN', 'CLAUDEX_NATIVE_LANES', 'TAU_CODEX_WEBSOCKET',
  'CLAUDE_CODE_EFFORT_LEVEL']
for (const key of openaiEnv) delete process.env[key]

const r = await loadMcpRuntime({
  paths: ['src/services/api/providers/providerShim.ts',
    'src/services/api/providers/nativeLaneReadiness.ts'],
  exports: ['createProviderShim', 'providerUsesNativeLane',
    'resetReadiness: () => { readinessResolver = null; eagerLatchedProviders.clear(); }',
    'installNativeLaneReadinessResolver',
    `installCredentials: credentials => {
      getProviderApiKey = provider => provider === 'openai' ? null : 'other-provider-fixture';
      getProviderRuntimeApiKey = () => 'other-provider-fixture';
      getProviderAuthMethod = provider => provider === 'openai' ? 'oauth' : 'api_key';
      getProviderBaseUrl = () => 'https://other-provider.invalid/v1';
      getOpenAISessionToken = () => credentials.sessionToken;
      initLanes = () => { throw new Error('Unrelated provider initialization failed'); };
    }`],
})
r.installCredentials({ sessionToken: 'oauth-fixture' })
Object.defineProperty(r.codexApi, 'installationId', {
  get: () => '00000000-0000-4000-8000-000000000001',
})

const events = id => [
  { type: 'response.created', response: { id } },
  { type: 'response.output_text.delta', delta: 'ok' },
  { type: 'response.completed', response: { id, usage: {
    input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 2,
  } } },
]

// One local server for both transports. `refuse` answers upgrades with 426.
const seen = { connections: [], socketRequests: [], httpRequests: [], refuse: false, turnState: false }
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    seen.httpRequests.push(JSON.parse(raw))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(events('resp-http').map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
})
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (seen.refuse) {
    // The client drops the connection as soon as it reads the refusal.
    socket.on('error', () => {})
    socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n')
    return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    seen.connections.push(req.headers)
    ws.on('message', data => {
      seen.socketRequests.push(JSON.parse(data.toString()))
      if (seen.turnState) ws.send(JSON.stringify({ type: 'response.metadata', headers: { 'x-codex-turn-state': 'routing-fixture' } }))
      for (const event of events(`resp-ws-${seen.socketRequests.length}`)) ws.send(JSON.stringify(event))
    })
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  r.codexApi.clearChain()
  for (const client of wss.clients) client.terminate()
  wss.close()
  await new Promise(resolve => server.close(resolve))
  const resolved = realpathSync(fixtureDirectory)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup path')
  rmSync(resolved, { recursive: true, force: true })
})

test.beforeEach(() => {
  for (const key of openaiEnv) delete process.env[key]
  process.env.OPENAI_BASE_URL = baseUrl
  seen.connections.length = 0
  seen.socketRequests.length = 0
  seen.httpRequests.length = 0
  seen.refuse = false
  seen.turnState = false
  r.codexApi.clearChain()
  r.resetReadiness()
  r.installNativeLaneReadinessResolver(r.providerUsesNativeLane)
})

async function send(sessionId = 'conversation-fixture', overrides = {}) {
  const shim = r.createProviderShim('openai', 'repl_main_thread')
  assert.equal(shim._provider.name, 'codex')
  const response = await shim.beta.messages.create({
    model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }],
    system: 'Fixture instructions', tools: [], max_tokens: 64, sessionId, stream: true,
    ...overrides,
  })
  const received = []
  for await (const event of response) received.push(event)
  assert.ok(received.some(event => event.type === 'message_stop'), 'stream did not finish')
}

test('a ChatGPT login streams every request of a conversation over one kept socket', async () => {
  await send()
  await send()
  assert.equal(seen.httpRequests.length, 0)
  assert.equal(seen.connections.length, 1)
  assert.equal(seen.socketRequests.length, 2)
  const headers = seen.connections[0]
  assert.equal(headers['openai-beta'], 'responses_websockets=2026-02-06')
  assert.equal(headers.authorization, 'Bearer oauth-fixture')
  assert.equal(headers.originator, 'codex_cli_rs')
  assert.equal(headers.session_id, 'conversation-fixture')
})

test('the provider bridge carries turn identity without sending it as a request field', async () => {
  seen.turnState = true
  await send('conversation-fixture', { turnId: 'one-user-turn' })
  await send('conversation-fixture', { turnId: 'one-user-turn' })
  await send('conversation-fixture', { turnId: 'next-user-turn' })
  assert.deepEqual(seen.socketRequests.map(body => body.client_metadata['x-codex-turn-state']), [undefined, 'routing-fixture', undefined])
  assert.ok(seen.socketRequests.every(body => body.turnId === undefined))
  assert.equal(seen.connections.length, 1)
})

test('the socket carries the same request body HTTP would send', async () => {
  process.env.TAU_CODEX_WEBSOCKET = '0'
  await send()
  delete process.env.TAU_CODEX_WEBSOCKET
  r.codexApi.clearChain()
  await send()
  assert.equal(seen.httpRequests.length, 1)
  assert.equal(seen.socketRequests.length, 1)
  const { type, include, ...overSocket } = seen.socketRequests[0]
  const { include: httpInclude, ...overHttp } = seen.httpRequests[0]
  assert.equal(type, 'response.create')
  assert.deepEqual(include, httpInclude ?? [])
  assert.deepEqual(overSocket, overHttp)
})

test('GPT-6.1 Sol is listed by the native lane with the published total window', async () => {
  const shim = r.createProviderShim('openai', 'repl_main_thread')
  const models = await shim._provider.listModels()
  const model = models.find(model => model.id === 'gpt-6.1-sol')
  assert.equal(model?.name, 'GPT-6.1 Sol')
  assert.equal(model?.contextWindow, 1_050_000)
  assert.equal(model?.supportsToolCalling, true)
  assert.ok(model?.tags?.includes('reasoning'))
})

test('GPT-6.1 Sol sends all five efforts identically over HTTP and WebSocket with a stable prefix', async () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max']
  for (const websocket of [false, true]) {
    process.env.TAU_CODEX_WEBSOCKET = websocket ? '1' : '0'
    r.codexApi.clearChain()
    for (const effortValue of levels) {
      // Repeated requests prove the same model/effort has a stable body.
      for (let repeat = 0; repeat < 2; repeat++) {
        await send('conversation-fixture', { model: 'gpt-6.1-sol', effortValue })
      }
    }
  }
  assert.equal(seen.connections.length, 1)
  assert.equal(seen.httpRequests.length, levels.length * 2)
  assert.equal(seen.socketRequests.length, levels.length * 2)
  for (let i = 0; i < seen.httpRequests.length; i++) {
    const { type, ...socketBody } = seen.socketRequests[i]
    const httpBody = seen.httpRequests[i]
    assert.equal(type, 'response.create')
    assert.deepEqual(socketBody, httpBody)
    assert.equal(httpBody.model, 'gpt-6.1-sol')
    assert.deepEqual(httpBody.reasoning, { effort: levels[Math.floor(i / 2)], summary: 'auto' })
    assert.equal(httpBody.prompt_cache_key, 'conversation-fixture')
    assert.equal(httpBody.service_tier, undefined)
    assert.deepEqual({ ...httpBody, reasoning: seen.httpRequests[0].reasoning }, seen.httpRequests[0])
  }
})

test('another conversation gets its own socket', async () => {
  await send('conversation-a')
  await send('conversation-b')
  assert.equal(seen.connections.length, 2)
  assert.deepEqual(seen.connections.map(headers => headers.session_id), ['conversation-a', 'conversation-b'])
})

test('a refused upgrade sends the request over HTTP', async () => {
  seen.refuse = true
  await send()
  assert.equal(seen.connections.length, 0)
  assert.equal(seen.httpRequests.length, 1)
  assert.equal(seen.httpRequests[0].prompt_cache_key, 'conversation-fixture')
})
