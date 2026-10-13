import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { WebSocketServer } from 'ws'
import { build } from 'esbuild'

const built = await build({ stdin: { contents: "export * from './src/lanes/codex/api.ts'; export * from './src/lanes/codex/turnState.ts'", resolveDir: process.cwd() }, bundle: true,
  packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node20' })
const module = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { CodexApiClient, CodexTurnStates } = module.exports
const HEADER = 'x-codex-turn-state'
const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-codex-turn-'))
const oldLog = process.env.TAU_CODEX_CACHE_LOG
const oldWs = process.env.TAU_CODEX_WEBSOCKET
const clients = []
const seen = { http: [], ws: [], upgrades: [] }
let refuse = false, handshakeToken = false, metadataToken = true, calls = 0
const usage = { input_tokens: 1500, input_tokens_details: { cached_tokens: 1024 } }
const token = (session, index) => `private-routing-${session}-${index}`
const events = session => [
  ...(metadataToken ? [{ type: 'response.metadata', headers: { 'X-Codex-Turn-State': token(session, ++calls) } }] : []),
  { type: 'response.created', response: { id: 'response-fixture' } },
  { type: 'response.completed', response: { id: 'response-fixture', usage } },
]
const server = createServer((req, res) => {
  let text = ''
  req.on('data', chunk => { text += chunk })
  req.on('end', () => {
    const body = JSON.parse(text)
    seen.http.push({ body, headers: req.headers })
    res.setHeader(HEADER, token(req.headers.session_id, 'http'))
    if (body.stream === false) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'nonstream', usage }))
    } else {
      res.setHeader('Content-Type', 'text/event-stream')
      res.end(events(req.headers.session_id).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    }
  })
})
const wss = new WebSocketServer({ noServer: true })
wss.on('headers', (headers, req) => {
  if (handshakeToken) headers.push(`${HEADER}: ${token(req.headers.session_id, 'upgrade')}`)
})
server.on('upgrade', (req, socket, head) => {
  if (refuse) {
    socket.on('error', () => {})
    socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n')
    return
  }
  seen.upgrades.push(req.headers)
  wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => {
    seen.ws.push(JSON.parse(data.toString()))
    for (const event of events(req.headers.session_id)) ws.send(JSON.stringify(event))
  }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
function client(oauth = true) {
  const api = new CodexApiClient()
  Object.defineProperty(api, 'installationId', { get: () => 'installation-fixture' })
  api.configure({ baseUrl, ...(oauth ? { chatgptAccessToken: 'oauth-fixture' } : { apiKey: 'api-key-fixture' }) })
  clients.push(api)
  return api
}
const body = (session = 'main') => ({ model: 'gpt-6.1-sol', instructions: 'private prompt',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  prompt_cache_key: session, reasoning: { effort: 'medium', summary: 'auto' }, tools: [] })
async function send(api, session = 'main', turn = 'turn-1') {
  const request = body(session)
  const before = JSON.stringify(request)
  for await (const _event of api.streamResponses(request, undefined, turn)) { /* consume */ }
  assert.equal(JSON.stringify(request), before, 'caller request mutated')
}
test.beforeEach(() => {
  for (const api of clients) api.clearChain()
  seen.http.length = seen.ws.length = seen.upgrades.length = 0
  refuse = handshakeToken = false
  metadataToken = true
  calls = 0
  delete process.env.TAU_CODEX_CACHE_LOG
  delete process.env.TAU_CODEX_WEBSOCKET
})
test.after(async () => {
  for (const api of clients) api.clearChain()
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  await new Promise(resolve => server.close(resolve))
  for (const [key, value] of [['TAU_CODEX_CACHE_LOG', oldLog], ['TAU_CODEX_WEBSOCKET', oldWs]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const resolved = realpathSync(fixture), child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(resolved, { recursive: true, force: true })
})

test('replays the first metadata token within a turn and resets on a new turn on the same socket', async () => {
  const api = client()
  await send(api)
  await send(api)
  await send(api)
  await send(api, 'main', 'turn-2')
  await send(api, 'main', 'turn-2')
  assert.deepEqual(seen.ws.map(x => x.client_metadata[HEADER]), [undefined, token('main', 1), token('main', 1), undefined, token('main', 4)])
  assert.equal(seen.upgrades.length, 1)
  for (const request of seen.ws) {
    assert.equal(request.turnId, undefined)
    assert.equal(request.reasoning.effort, 'medium')
  }
})

test('parallel agents keep independent tokens', async () => {
  const api = client()
  await Promise.all([send(api, 'a'), send(api, 'b')])
  const first = new Map(seen.ws.map((x, index) => [x.prompt_cache_key, token(x.prompt_cache_key, index + 1)]))
  await Promise.all([send(api, 'b'), send(api, 'a')])
  for (const request of seen.ws.slice(2)) assert.equal(request.client_metadata[HEADER], first.get(request.prompt_cache_key))
  assert.equal(seen.upgrades.length, 2)
})

test('late responses, missing turn IDs and evicted sessions cannot contaminate the current turn', () => {
  const states = new CodexTurnStates()
  const old = states.get('main', 'old')
  const current = states.get('main', 'current')
  old.capture('late-old-response')
  assert.equal(current.value, undefined)
  current.captureHeaders({ 'X-Codex-Turn-State': ['first-token', 'second-token'] })
  current.capture('replacement')
  assert.equal(states.get('main', 'current').value, 'first-token')
  assert.equal(states.get('main', 'old').value, 'late-old-response', 'a distinct fork cannot erase an active parent turn')
  assert.equal(states.get('main').value, undefined)
  const invalid = states.get('invalid', 'turn')
  for (const value of ['', 'a\r\nb', 123, null]) invalid.capture(value)
  assert.equal(invalid.value, undefined)
  for (let i = 0; i < 64; i++) states.get(`agent-${i}`, 'turn')
  assert.equal(states.get('main', 'current').value, undefined)
  states.get('main', 'current').capture('before-clear')
  states.clear()
  assert.equal(states.get('main', 'current').value, undefined)
})

test('captures upgrade headers once without reusing them on later turns', async () => {
  handshakeToken = true
  const api = client()
  await send(api)
  await send(api)
  await send(api, 'main', 'turn-2')
  await send(api, 'main', 'turn-2')
  assert.deepEqual(seen.ws.map(x => x.client_metadata[HEADER]), [undefined, token('main', 'upgrade'), undefined, token('main', 3)])
})

test('reconnects with the held routing token and retains it across an HTTP fallback', async () => {
  const api = client()
  await send(api)
  for (const ws of wss.clients) ws.terminate()
  await new Promise(resolve => setTimeout(resolve, 20))
  await send(api)
  assert.equal(seen.upgrades.at(-1)[HEADER], token('main', 1))
  process.env.TAU_CODEX_WEBSOCKET = '0'
  await send(api)
  assert.equal(seen.http.at(-1).headers[HEADER], token('main', 1))
  assert.equal(seen.http.at(-1).body.client_metadata[HEADER], undefined)
})

test('API-key HTTP preserves response-header state only within the same turn', async () => {
  const api = client(false)
  await send(api)
  await send(api)
  await send(api, 'main', 'turn-2')
  assert.deepEqual(seen.http.map(x => x.headers[HEADER]), [undefined, token('main', 'http'), undefined])
  assert.equal(seen.ws.length, 0)
})

test('standalone calls and a changed login never inherit routing state', async () => {
  const api = client()
  await send(api, 'main', null)
  await send(api, 'main', null)
  await send(api)
  api.configure({ chatgptAccessToken: 'different-login' })
  await send(api)
  assert.ok(seen.ws.every(x => x.client_metadata[HEADER] === undefined))
})

test('cache diagnostics preserve wire content and distinguish concurrent conversations', async () => {
  metadataToken = false
  const api = client()
  await send(api)
  process.env.TAU_CODEX_CACHE_LOG = join(fixture, 'ws.jsonl')
  await send(api)
  await Promise.all([send(api, 'a'), send(api, 'b')])
  assert.deepEqual(seen.ws[0], seen.ws[1])
  const records = readFileSync(process.env.TAU_CODEX_CACHE_LOG, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 3)
  assert.equal(new Set(records.map(x => x.diagnostics.conversation)).size, 3)
  assert.ok(records.every(x => x.transport === 'websocket' && x.cached === 1024 && x.diagnostics.effort === 'medium'))
})

test('logs one completion after upgrade fallback and for non-streaming responses', async () => {
  refuse = true
  const api = client()
  process.env.TAU_CODEX_CACHE_LOG = join(fixture, 'http.jsonl')
  await send(api)
  await api.createResponse(body())
  const log = readFileSync(process.env.TAU_CODEX_CACHE_LOG, 'utf8')
  const records = log.trim().split('\n').map(JSON.parse)
  assert.equal(records.length, 2)
  assert.ok(records.every(x => x.transport === 'http' && x.cached === 1024 && x.prompt === 1500))
  assert.ok(!log.includes('private prompt') && !log.includes('private-routing') && !log.includes('oauth-fixture'))
})
