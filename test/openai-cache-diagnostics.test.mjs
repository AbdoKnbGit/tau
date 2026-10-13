import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const bundle = await build({
  entryPoints: ['src/lanes/codex/cacheDiagnostics.ts'], bundle: true,
  packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node20',
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { CodexCacheDiagnostics } = module.exports
const apiBundle = await build({
  entryPoints: ['src/lanes/codex/api.ts'], bundle: true,
  packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node20',
})
const apiModule = { exports: {} }
new Function('require', 'module', 'exports', apiBundle.outputFiles[0].text)(createRequire(import.meta.url), apiModule, apiModule.exports)
const { CodexApiClient } = apiModule.exports
const tempRoot = realpathSync(tmpdir())
const fixture = mkdtempSync(join(tempRoot, 'tau-cache-diagnostics-'))
const previousEnv = process.env.TAU_CODEX_CACHE_LOG
const previousSocketEnv = process.env.TAU_CODEX_WEBSOCKET
let fileNumber = 0

test.beforeEach(() => {
  process.env.TAU_CODEX_CACHE_LOG = join(fixture, `${++fileNumber}.jsonl`)
  delete process.env.TAU_CODEX_WEBSOCKET
})
test.after(() => {
  if (previousEnv === undefined) delete process.env.TAU_CODEX_CACHE_LOG
  else process.env.TAU_CODEX_CACHE_LOG = previousEnv
  if (previousSocketEnv === undefined) delete process.env.TAU_CODEX_WEBSOCKET
  else process.env.TAU_CODEX_WEBSOCKET = previousSocketEnv
  const resolved = realpathSync(fixture)
  const child = relative(tempRoot, resolved)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'unsafe fixture cleanup path')
  rmSync(resolved, { recursive: true, force: true })
})

const message = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const request = (overrides = {}) => ({
  model: 'gpt-6.1-sol', instructions: 'private instructions',
  tools: [{ type: 'function', name: 'private_tool', description: 'private schema' }],
  reasoning: { effort: 'medium', summary: 'auto' }, store: false, stream: true,
  prompt_cache_key: 'private-session-id', client_metadata: { private: 'private-installation-id' },
  input: [message('private user prompt')], ...overrides,
})
const usage = { input_tokens: 1250, input_tokens_details: { cached_tokens: 1024 } }
const readRecords = () => readFileSync(process.env.TAU_CODEX_CACHE_LOG, 'utf8').trim().split('\n').map(JSON.parse)
const log = (diagnostics, body, transport = 'websocket', counts = usage, connection = 1) => {
  const capture = diagnostics.capture(body)
  assert.ok(capture)
  diagnostics.logCompletion(capture, transport, counts, connection)
  return readRecords().at(-1)
}

test('disabled diagnostics never inspect a request or serialize usage', () => {
  delete process.env.TAU_CODEX_CACHE_LOG
  const diagnostics = new CodexCacheDiagnostics()
  const forbidden = new Proxy({}, { get() { throw new Error('inspected while disabled') }, ownKeys() { throw new Error('enumerated while disabled') } })
  assert.equal(diagnostics.capture(forbidden), undefined)
  assert.doesNotThrow(() => diagnostics.logCompletion(undefined, 'http', forbidden))
})

test('logs append-only prefixes without changing requests or exposing private content', () => {
  const diagnostics = new CodexCacheDiagnostics()
  const body = request({ input: [message('private user prompt'), { type: 'reasoning', id: 'private-response-id', encrypted_content: 'private encrypted reasoning' }] })
  const before = JSON.stringify(body)
  const first = log(diagnostics, body)
  assert.equal(JSON.stringify(body), before)
  const second = log(diagnostics, { ...body, input: [...body.input, { type: 'function_call', name: 'private_tool', arguments: 'private arguments', call_id: 'private-call-id' }] })
  assert.deepEqual(second.diagnostics.prefix, { status: 'append_only', previousInvocation: 1, previousItemCount: 2, commonItems: 2 })
  assert.equal(second.diagnostics.configChanged, false)
  assert.deepEqual(second.diagnostics.changedConfig, [])
  assert.equal(first.diagnostics.conversation, second.diagnostics.conversation)
  assert.equal(second.diagnostics.effort, 'medium')
  assert.equal(second.processId, process.pid)
  assert.equal(second.prompt, 1250)
  assert.equal(second.cached, 1024)
  assert.equal(second.connection, 1)
  const text = readFileSync(process.env.TAU_CODEX_CACHE_LOG, 'utf8')
  for (const secret of ['private user prompt', 'private instructions', 'private schema', 'private_tool', 'private encrypted reasoning', 'private arguments', 'private-call-id', 'private-session-id', 'private-installation-id', 'private-response-id']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`)
  }
})

test('distinguishes history mutation, shortening, repetition and configuration changes', () => {
  const diagnostics = new CodexCacheDiagnostics()
  const body = request({ input: [message('a'), { type: 'function_call_output', call_id: 'call', output: 'original' }] })
  log(diagnostics, body)
  assert.equal(log(diagnostics, body).diagnostics.prefix.status, 'identical')
  const changed = { ...body, input: [body.input[0], { ...body.input[1], output: 'changed' }] }
  const mutated = log(diagnostics, changed).diagnostics
  assert.deepEqual(mutated.prefix.firstChanged, { index: 1, previousType: 'function_call_output', currentType: 'function_call_output' })
  assert.equal(mutated.prefix.status, 'mutated')
  assert.equal(mutated.prefix.commonItems, 1)
  assert.equal(mutated.configChanged, false)
  const shortened = log(diagnostics, { ...body, input: [body.input[0]], reasoning: { effort: 'low' }, tools: [] }).diagnostics
  assert.equal(shortened.prefix.status, 'shortened')
  assert.deepEqual(shortened.changedConfig, ['tools', 'reasoning'])
  assert.equal(shortened.configChanged, true)
})

test('concurrent conversations and model switches do not overwrite each other', () => {
  const diagnostics = new CodexCacheDiagnostics()
  const a = diagnostics.capture(request())
  const b = diagnostics.capture(request({ prompt_cache_key: 'agent-b' }))
  diagnostics.logCompletion(b, 'http', usage)
  diagnostics.logCompletion(a, 'websocket', usage, 3)
  diagnostics.logCompletion(a, 'websocket', usage, 3)
  assert.equal(readRecords().length, 2, 'one completed record per invocation')
  const nextA = log(diagnostics, request({ input: [message('private user prompt'), message('next')] })).diagnostics
  assert.equal(nextA.prefix.previousInvocation, 1)
  assert.equal(nextA.prefix.status, 'append_only')
  assert.equal(log(diagnostics, request({ model: 'gpt-6-sol' })).diagnostics.prefix.status, 'first')
  assert.equal(log(diagnostics, request()).diagnostics.prefix.status, 'shortened')
})

test('missing usage stays null, while explicit zero and alternate usage formats are preserved', () => {
  const diagnostics = new CodexCacheDiagnostics()
  const missing = log(diagnostics, request(), 'http', {})
  assert.equal(missing.prompt, null)
  assert.equal(missing.cached, null)
  const zero = log(diagnostics, request(), 'http', { input_tokens: 0, input_tokens_details: { cached_tokens: 0 } })
  assert.equal(zero.prompt, 0)
  assert.equal(zero.cached, 0)
  const alternate = log(diagnostics, request(), 'http', { prompt_tokens: 2048, cache_read_input_tokens: 1024 })
  assert.equal(alternate.prompt, 2048)
  assert.equal(alternate.cached, 1024)
  const invalid = log(diagnostics, request(), 'http', { input_tokens: NaN, cached_tokens: -1 })
  assert.equal(invalid.prompt, null)
  assert.equal(invalid.cached, null)
})

test('diagnostics fail closed and never throw for unwritable logs or malformed input', () => {
  const diagnostics = new CodexCacheDiagnostics()
  process.env.TAU_CODEX_CACHE_LOG = fixture
  assert.doesNotThrow(() => diagnostics.logCompletion(diagnostics.capture(request()), 'http', usage))
  const cyclic = request()
  cyclic.input.push(cyclic)
  assert.equal(diagnostics.capture(cyclic), undefined)
  assert.equal(diagnostics.capture({ input: null }), undefined)
})

test('retained history is bounded and incomplete comparisons are explicitly unknown', () => {
  const diagnostics = new CodexCacheDiagnostics()
  const body = request({ input: Array.from({ length: 2050 }, (_, index) => message(String(index))) })
  log(diagnostics, body)
  const changed = structuredClone(body)
  changed.input[2049] = message('changed beyond retained prefix')
  const partial = log(diagnostics, changed).diagnostics
  assert.equal(partial.retainedInputItems, 2048)
  assert.equal(partial.prefix.status, 'unknown')
  assert.equal(partial.prefix.commonItems, 2048)
  for (let index = 0; index < 32; index++) diagnostics.capture(request({ prompt_cache_key: `agent-${index}` }))
  assert.equal(log(diagnostics, body).diagnostics.prefix.status, 'first', 'least recently used conversation was evicted')
})

test('missing conversation IDs are not joined and new instances use independent hash keys', () => {
  const diagnostics = new CodexCacheDiagnostics()
  log(diagnostics, request({ prompt_cache_key: undefined }))
  const missing = log(diagnostics, request({ prompt_cache_key: undefined })).diagnostics
  assert.equal(missing.conversation, null)
  assert.equal(missing.prefix.status, 'first')
  const first = log(diagnostics, request()).diagnostics
  const second = log(new CodexCacheDiagnostics(), request()).diagnostics
  assert.notEqual(first.runId, second.runId)
  assert.notEqual(first.inputHash, second.inputHash)
})

test('fallback recapture preserves the original invocation and real previous request baseline', () => {
  const diagnostics = new CodexCacheDiagnostics()
  const first = log(diagnostics, request()).diagnostics
  const httpBody = request({ input: [message('rewritten old prompt')] })
  const socketBody = { ...httpBody, client_metadata: { 'x-codex-turn-state': 'private-routing-token' } }
  const socketCapture = diagnostics.capture(socketBody)
  const httpCapture = diagnostics.capture(httpBody, socketCapture)
  diagnostics.logCompletion(httpCapture, 'http', usage)
  diagnostics.logCompletion(socketCapture, 'websocket', usage, 99)
  const records = readRecords()
  assert.equal(records.length, 2, 'the failed socket attempt is never logged as another response')
  const last = records.at(-1).diagnostics
  assert.equal(last.invocation, first.invocation + 1)
  assert.equal(last.prefix.previousInvocation, first.invocation)
  assert.equal(last.prefix.status, 'mutated')
  assert.equal(last.prefix.firstChanged.index, 0)
  assert.equal(last.configChanged, false, 'actual HTTP configuration matches the previous completed request')
})

test('late fallback replacement cannot overwrite a newer request history', () => {
  const diagnostics = new CodexCacheDiagnostics()
  log(diagnostics, request())
  const older = diagnostics.capture(request({ input: [message('older')] }))
  const newerBody = request({ input: [message('newer')] })
  const newer = diagnostics.capture(newerBody)
  const fallback = diagnostics.capture(request({ input: [message('older HTTP')] }), older)
  diagnostics.logCompletion(fallback, 'http', usage)
  diagnostics.logCompletion(newer, 'websocket', usage, 2)
  const next = log(diagnostics, newerBody).diagnostics
  assert.equal(next.prefix.previousInvocation, newer.snapshot.invocation)
  assert.equal(next.prefix.status, 'identical')
})

test('diagnostic-only session identity correlates requests without adding to their bodies', () => {
  const diagnostics = new CodexCacheDiagnostics()
  const body = request({ prompt_cache_key: undefined })
  const before = JSON.stringify(body)
  const first = diagnostics.capture(body, undefined, 'header-session')
  const second = diagnostics.capture(body, undefined, 'header-session')
  diagnostics.logCompletion(first, 'http', usage)
  diagnostics.logCompletion(second, 'http', usage)
  assert.equal(second.snapshot.prefix.status, 'identical')
  assert.equal(second.snapshot.prefix.previousInvocation, first.snapshot.invocation)
  assert.equal(JSON.stringify(body), before)
})

// Local transport integration uses the actual API client and real HTTP/WS
// serialization, with fixture credentials and no developer settings or dist.
async function localApi(t, { refuseUpgrade = false, holdPair = false } = {}) {
  const seen = { http: [], websocket: [], upgrades: [], waiting: [] }
  const response = { id: 'fixture-response', status: 'completed', usage, output: [] }
  const events = [
    { type: 'response.created', response: { id: response.id } },
    { type: 'response.output_text.delta', delta: 'fixture output' },
    { type: 'response.completed', response },
  ]
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw)
      seen.http.push({ body, headers: req.headers })
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
      }
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades.push(req.headers)
    if (refuseUpgrade) {
      socket.on('error', () => {})
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', raw => {
        seen.websocket.push({ body: JSON.parse(raw.toString()), headers: req.headers })
        const finish = () => { for (const event of events) ws.send(JSON.stringify(event)) }
        if (holdPair) {
          seen.waiting.push(finish)
          if (seen.waiting.length === 2) for (const complete of seen.waiting.splice(0)) complete()
        } else finish()
      })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = new CodexApiClient()
  Object.defineProperty(api, 'installationId', { get: () => '00000000-0000-4000-8000-000000000001' })
  api.configure({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    chatgptAccessToken: 'fixture-oauth-token', chatgptAccountId: 'fixture-account',
  })
  t.after(async () => {
    api.clearChain()
    for (const socket of wss.clients) socket.terminate()
    await new Promise(resolve => wss.close(resolve))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { api, seen }
}

async function collect(api, body) {
  const events = []
  for await (const event of api.streamResponses(body, AbortSignal.timeout(5000))) events.push(event)
  assert.equal(events.at(-1)?.type, 'response.completed')
}

test('WS diagnostics preserve outbound body and effort and log one completion per call', async t => {
  const { api, seen } = await localApi(t)
  const file = process.env.TAU_CODEX_CACHE_LOG
  const body = request({ reasoning: { effort: 'xhigh', summary: 'auto' } })
  const before = JSON.stringify(body)
  delete process.env.TAU_CODEX_CACHE_LOG
  await collect(api, body)
  assert.equal(existsSync(file), false)
  process.env.TAU_CODEX_CACHE_LOG = file
  await collect(api, body)
  await collect(api, { ...body, include: [] })
  assert.deepEqual(seen.websocket[0].body, seen.websocket[1].body)
  assert.deepEqual(seen.websocket[1].body, seen.websocket[2].body)
  assert.equal(seen.websocket[1].body.reasoning.effort, 'xhigh')
  assert.equal(JSON.stringify(body), before)
  const records = readRecords()
  assert.equal(records.length, 2)
  assert.ok(records.every(row => row.transport === 'websocket' && row.diagnostics.effort === 'xhigh'))
  assert.equal(records[0].connection, records[1].connection)
  assert.equal(records[1].diagnostics.configChanged, false, 'implicit and explicit empty include serialize identically')
  assert.equal(records[1].diagnostics.prefix.status, 'identical')
})

test('upgrade fallback records one invocation against the real preceding request', async t => {
  const { api, seen } = await localApi(t, { refuseUpgrade: true })
  process.env.TAU_CODEX_WEBSOCKET = '0'
  await collect(api, request())
  delete process.env.TAU_CODEX_WEBSOCKET
  await collect(api, request({ input: [message('changed prefix')] }))
  const records = readRecords()
  assert.equal(seen.upgrades.length, 1)
  assert.equal(seen.http.length, 2)
  assert.equal(records.length, 2)
  assert.ok(records.every(row => row.transport === 'http' && row.connection === undefined))
  assert.deepEqual(records.map(row => row.diagnostics.invocation), [1, 2])
  assert.equal(records[1].diagnostics.prefix.previousInvocation, 1)
  assert.equal(records[1].diagnostics.prefix.status, 'mutated')
  assert.equal(records[1].diagnostics.configChanged, false)
  assert.equal(seen.http[1].body.reasoning.effort, 'medium')
})

test('nonstream API diagnostics retain the original HTTP request and completion usage', async t => {
  const { api, seen } = await localApi(t)
  const file = process.env.TAU_CODEX_CACHE_LOG
  const body = request({ reasoning: { effort: 'low' } })
  delete process.env.TAU_CODEX_CACHE_LOG
  await api.createResponse(body, AbortSignal.timeout(5000))
  assert.equal(existsSync(file), false)
  process.env.TAU_CODEX_CACHE_LOG = file
  const result = await api.createResponse(body, AbortSignal.timeout(5000))
  assert.deepEqual(result.usage, usage)
  assert.deepEqual(seen.http[0].body, seen.http[1].body)
  assert.equal(seen.http[1].body.stream, false)
  assert.equal(seen.http[1].body.reasoning.effort, 'low')
  const records = readRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].transport, 'http')
  assert.equal(records[0].prompt, usage.input_tokens)
  assert.equal(records[0].cached, usage.input_tokens_details.cached_tokens)
})

test('concurrent conversations correlate independently on separate kept sockets', async t => {
  const { api, seen } = await localApi(t, { holdPair: true })
  const a = request({ prompt_cache_key: 'agent-a', reasoning: { effort: 'low' } })
  const b = request({ prompt_cache_key: 'agent-b', reasoning: { effort: 'medium' } })
  await Promise.all([collect(api, a), collect(api, b)])
  await Promise.all([
    collect(api, { ...a, input: [...a.input, message('a follow-up')] }),
    collect(api, { ...b, input: [...b.input, message('b follow-up')] }),
  ])
  assert.equal(seen.http.length, 0)
  assert.equal(seen.upgrades.length, 2)
  const records = readRecords()
  assert.equal(records.length, 4)
  assert.equal(new Set(records.map(row => row.connection)).size, 2)
  assert.equal(new Set(records.map(row => row.diagnostics.conversation)).size, 2)
  for (const effort of ['low', 'medium']) {
    const group = records.filter(row => row.diagnostics.effort === effort)
    assert.equal(group.length, 2)
    assert.equal(group[0].connection, group[1].connection)
    assert.equal(group[1].diagnostics.prefix.status, 'append_only')
    assert.equal(group[1].diagnostics.prefix.previousInvocation, group[0].diagnostics.invocation)
  }
})
