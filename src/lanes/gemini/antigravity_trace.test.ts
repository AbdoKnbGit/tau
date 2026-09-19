/** Run: bun run src/lanes/gemini/antigravity_trace.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-trace-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')
mock.module('../../services/api/providers/gemini_code_assist.js', () => ({
  ...codeAssist,
  ensureCodeAssistReady: async () => 'trace-test-project',
  warmupCodeAssist: () => {},
}))
mock.module('../../services/api/providers/gemini_provider.js', () => ({ resolveCliModelsForPicker: () => [] }))
const cache = await import('./antigravity_cache.js')
const trace = await import('./antigravity_trace.js')
const { geminiApi, TAU_STABLE_SESSION_ID_FIELD, TAU_QUERY_SOURCE_FIELD } = await import('./api.js')

const MODEL = 'gemini-3.8-flash-medium'
const SYSTEM_TEXT = 'Distinctive system text that must never reach the debug log.'
const USER_TEXT = 'Distinctive user text that must never reach the debug log.'
const TOKEN = 'local-trace-token'
const LOG = join(sandbox, 'tau-cache-debug.jsonl')
const originalFetch = globalThis.fetch
const previousToken = (geminiApi as any).antigravityOAuthToken
const previousDebug = process.env.TAU_CACHE_DEBUG

type Reply =
  | { kind: 'ok'; cached?: number; stall?: boolean }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'throw' }
let replies: Reply[] = []
const calls: Array<{ url: string; headers: Record<string, string>; body: string; initKeys: string[] }> = []

function sse(events: unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body), initKeys: Object.keys(init ?? {}).sort() })
  const reply = replies.shift() ?? { kind: 'ok', cached: 16_384 }
  if (reply.kind === 'throw') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  if (reply.kind === 'status') {
    return new Response(reply.body ?? JSON.stringify({ error: { code: reply.status, status: 'UNAVAILABLE', message: 'project trace-test-project is busy', details: [{ reason: 'MODEL_CAPACITY_EXHAUSTED' }] } }), { status: reply.status })
  }
  const final = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 20_000,
      candidatesTokenCount: 3,
      ...(reply.cached !== undefined && { cachedContentTokenCount: reply.cached }),
    },
    responseId: `resp-${calls.length}`,
    modelVersion: 'gemini-3.8-flash-tiered-test',
  }
  if (!String(url).includes('streamGenerateContent')) return Response.json({ response: final, traceId: `trace-${calls.length}` })
  const provisional = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...' }] } }],
    usageMetadata: { promptTokenCount: 20_000 },
    responseId: `resp-${calls.length}`,
  }
  if (reply.stall) {
    // A body that sends one event and then never ends, for abandoned reads.
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(sse([{ response: provisional, traceId: 't' }]))) },
    }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  return new Response(sse([
    { response: provisional, traceId: `trace-${calls.length}` },
    { response: final, traceId: `trace-${calls.length}` },
  ]), { headers: { 'Content-Type': 'text/event-stream' } })
}) as typeof fetch

let requestSeq = 0
function makeRequest(contents: unknown[], opts: { session?: string; wireSession?: string; temperature?: number } = {}) {
  const request = {
    model: MODEL,
    systemInstruction: { parts: [{ text: SYSTEM_TEXT }] },
    tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Look up an item.', parameters: { type: 'object', properties: { item: { type: 'string' } } } }] }],
    // The signature-strip retry edits parts in place; keep fixtures intact.
    contents: structuredClone(contents),
    generationConfig: { temperature: opts.temperature ?? 1, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'medium' } },
    [TAU_STABLE_SESSION_ID_FIELD]: opts.wireSession ?? '-4242',
    [TAU_QUERY_SOURCE_FIELD]: 'repl_main_thread',
  }
  const requestId = `logical-${++requestSeq}`
  cache.trackAntigravityCacheRequest(request, { sessionId: opts.session ?? 'trace-session', model: MODEL, querySource: 'repl_main_thread', requestId })
  return { request, requestId }
}

async function stream(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of geminiApi.streamGenerateContent(request, signal)) chunks.push(chunk)
  return chunks
}

function rows(): any[] {
  return existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

function reset(): void {
  rmSync(LOG, { force: true })
  calls.length = 0
  replies = []
  codeAssist._resetAntigravityGeminiAffinityForTest()
  codeAssist._resetAntigravityGeminiHostCooldownForTest()
  trace._resetAntigravityTraceStateForTest()
}

const user = (text: string) => ({ role: 'user', parts: [{ text }] })
const model = (text: string) => ({ role: 'model', parts: [{ text }] })
const signedCall = { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { item: 'bolt' } }, thoughtSignature: 'sig-abc' }] }
const toolResult = { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { content: 'bolt: 3' } } }] }

try {
  ;(geminiApi as any).antigravityOAuthToken = TOKEN

  // ── 1. Flag-off parity: the traced run sends byte-identical requests. ──
  const normalize = (body: string) => body.replace(/"requestId":"[^"]*"/, '"requestId":"<id>"')
  const capture = async (debug: boolean) => {
    reset()
    if (debug) process.env.TAU_CACHE_DEBUG = '1'
    else delete process.env.TAU_CACHE_DEBUG
    // Streaming with a hop and a retry, then non-streaming.
    replies = [{ kind: 'status', status: 503 }, { kind: 'status', status: 503 }, { kind: 'ok', cached: 0 }, { kind: 'ok', cached: 16_384 }]
    await stream(makeRequest([user(USER_TEXT), signedCall, toolResult]).request)
    await geminiApi.generateContent(makeRequest([user(USER_TEXT)]).request)
    return calls.map(call => ({ url: call.url, headers: call.headers, body: normalize(call.body), initKeys: call.initKeys }))
  }
  const plain = await capture(false)
  assert.equal(rows().length, 0, 'diagnostics wrote rows with TAU_CACHE_DEBUG unset')
  const traced = await capture(true)
  assert.equal(plain.length, 4)
  assert.deepEqual(traced, plain, 'tracing changed an outgoing URL, header, body or fetch option')
  assert.ok(plain.every(call => !call.initKeys.includes('dispatcher')), 'the default path must not bring its own dispatcher')
  assert.ok(plain[0]!.body.includes('"thought_signature"'), 'fixture must exercise the wire rename')

  // ── 2. Correlation of a hop and a retry. ──
  const tracedRows = rows()
  const dispatches = tracedRows.filter(r => r.kind === 'dispatch')
  const attempts = tracedRows.filter(r => r.kind === 'attempt')
  assert.equal(tracedRows[0].kind, 'run', 'first row of a run records the build')
  assert.equal(tracedRows[0].build, 'source')
  assert.ok(tracedRows.every(r => r.runId === cache.ANTIGRAVITY_CACHE_DEBUG_RUN_ID), 'every row carries the run id')
  const streamDispatches = dispatches.filter(r => r.requestId === dispatches[0].requestId)
  assert.deepEqual(streamDispatches.map(r => r.attemptId.split(':')[1]), ['1.0', '1.1', '2.0'])
  assert.equal(streamDispatches[1].hopReason, 'status 503')
  assert.equal(streamDispatches[0].upstreamRequestId, streamDispatches[1].upstreamRequestId, 'hops of one attempt share the upstream request id')
  assert.notEqual(streamDispatches[1].upstreamRequestId, streamDispatches[2].upstreamRequestId, 'a retry is a new upstream request')
  const wireIds = calls.slice(0, 3).map(call => JSON.parse(call.body).requestId)
  assert.deepEqual(streamDispatches.map(r => r.upstreamRequestId), wireIds, 'dispatch rows must name the id actually sent')
  assert.deepEqual(streamDispatches.map(r => r.origin), ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'])
  assert.equal(streamDispatches[0].wireSessionId, '-4242')
  assert.equal(streamDispatches[0].sessionId, 'trace-session')
  assert.equal(streamDispatches[0].wireModel, 'gemini-3.8-flash-tiered')
  assert.deepEqual(streamDispatches[0].profile, { trajectory: 'off', transport: 'baseline' })
  assert.equal(streamDispatches[0].transport.dispatcher, 'global')
  const streamAttempts = attempts.filter(r => r.requestId === dispatches[0].requestId)
  assert.deepEqual(streamAttempts.map(r => r.outcome), ['http-error', 'http-error', 'completed'])
  assert.deepEqual(streamAttempts[0].errorBody, { status: 'UNAVAILABLE', reasons: ['MODEL_CAPACITY_EXHAUSTED'] })
  const done = streamAttempts[2]
  assert.equal(done.status, 200)
  assert.deepEqual(done.usage, { prompt: 20_000, cached: 0, cacheField: 'explicit', output: 3 })
  assert.equal(done.responseId, 'resp-3')
  assert.equal(done.modelVersion, 'gemini-3.8-flash-tiered-test')
  assert.equal(done.traceId, 'trace-3')
  for (const key of ['headersMs', 'firstChunkMs', 'firstContentMs', 'totalMs']) {
    assert.ok(Number.isFinite(done[key]) && done[key] >= 0, `${key} missing`)
  }
  assert.equal(done.connection.observed, false, 'a runtime without undici channels must not claim a connection')
  const nonStreaming = attempts.find(r => r.requestId !== dispatches[0].requestId)
  assert.equal(nonStreaming.outcome, 'completed')
  assert.equal(nonStreaming.usage.cached, 16_384)
  assert.equal(nonStreaming.traceId, 'trace-4')
  const log = readFileSync(LOG, 'utf8')
  for (const secret of [SYSTEM_TEXT, USER_TEXT, TOKEN, 'bolt: 3', 'trace-test-project']) {
    assert.ok(!log.includes(secret), `debug log leaked ${secret}`)
  }

  // ── 3. Verdicts compare with the last COMPLETED dispatch of the stream. ──
  reset()
  process.env.TAU_CACHE_DEBUG = '1'
  const base = [user(USER_TEXT), signedCall, toolResult]
  await stream(makeRequest(base).request)
  await stream(makeRequest([...base, model('ok'), user('next')]).request)
  // Failed request with a rewritten first block must not become the base.
  replies = [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }]
  await assert.rejects(stream(makeRequest([user('rewritten'), ...base.slice(1)]).request))
  await stream(makeRequest([...base, model('ok'), user('next'), model('ok'), user('again')]).request)
  // Same prompt, different generation config: prompt verdict stays ok.
  await stream(makeRequest([...base, model('ok'), user('next'), model('ok'), user('again')], { temperature: 0.5 }).request)
  // Wire session id changed: identity, not prompt.
  await stream(makeRequest([...base, model('ok'), user('next'), model('ok'), user('again'), model('ok'), user('more')], { temperature: 0.5, wireSession: '-777' }).request)
  const verdictRows = rows().filter(r => r.kind === 'dispatch')
  const byRequest = new Map<string, any[]>()
  for (const row of verdictRows) byRequest.set(row.requestId, [...(byRequest.get(row.requestId) ?? []), row])
  const firstOf = [...byRequest.values()].map(list => list[0])
  assert.equal(firstOf[0].verdict, 'cold')
  assert.equal(firstOf[1].verdict, 'ok: clean prefix extension')
  assert.ok(firstOf[1].gapMs >= 0, 'gap is measured from the previous completed response')
  assert.match(firstOf[2].verdict, /^BREAK: history block 0\/5 rewritten$/)
  assert.ok(firstOf[2].rewritten.after.every((part: string) => !part.includes('rewritten')), 'part descriptors must not carry text')
  assert.equal(firstOf[3].verdict, 'ok: clean prefix extension', 'a failed dispatch became the comparison base')
  assert.equal(firstOf[4].verdict, 'ok: identical prompt')
  assert.deepEqual(firstOf[4].configChanges, ['generationConfig'])
  assert.equal(firstOf[4].identityChanges, undefined)
  assert.equal(firstOf[5].verdict, 'ok: clean prefix extension')
  assert.deepEqual(firstOf[5].identityChanges, ['wireSessionId'])
  const failedAttempts = rows().filter(r => r.kind === 'attempt' && r.requestId === firstOf[2].requestId)
  assert.ok(failedAttempts.length >= 2 && failedAttempts.every(r => r.outcome === 'network-error' && r.error.causeCode === 'ECONNRESET'))

  // ── 4. Signature strip: the retried bytes are a prefix rewrite. ──
  reset()
  await stream(makeRequest(base).request)
  replies = [{ kind: 'status', status: 400, body: JSON.stringify({ error: { code: 400, message: 'Corrupted thought signature.', status: 'INVALID_ARGUMENT' } }) }]
  await stream(makeRequest([...base, model('ok'), user('next')]).request)
  const stripRows = rows().filter(r => r.kind === 'dispatch')
  assert.equal(stripRows.length, 3)
  assert.equal(stripRows[1].verdict, 'ok: clean prefix extension')
  assert.equal(stripRows[2].verdict, 'BREAK: history block 1/3 rewritten', 'signature strip must surface as a rewrite')
  assert.ok(stripRows[2].rewritten.before[0].includes('+sig') && !stripRows[2].rewritten.after[0].includes('+sig'))

  // ── 5. A consumer that stops reading leaves an abandoned attempt. ──
  reset()
  replies = [{ kind: 'ok', stall: true }]
  for await (const _chunk of geminiApi.streamGenerateContent(makeRequest(base).request)) break
  const controller = new AbortController()
  replies = [{ kind: 'ok', stall: true }]
  for await (const _chunk of geminiApi.streamGenerateContent(makeRequest(base).request, controller.signal)) {
    controller.abort()
    break
  }
  assert.deepEqual(rows().filter(r => r.kind === 'attempt').map(r => r.outcome), ['abandoned', 'aborted'])
  // Neither became the comparison base, and nothing is left in flight.
  replies = [{ kind: 'ok' }]
  await stream(makeRequest(base).request)
  const last = rows().filter(r => r.kind === 'dispatch').at(-1)
  assert.equal(last.verdict, 'cold')
  assert.equal(last.inflight, 0)

  // ── 6. Concurrent dispatches see each other in flight. ──
  reset()
  replies = [{ kind: 'ok', stall: true }]
  const held = geminiApi.streamGenerateContent(makeRequest(base, { session: 'agent-a' }).request)
  await held.next()
  await stream(makeRequest(base, { session: 'agent-b' }).request)
  await held.return(undefined)
  const concurrent = rows().filter(r => r.kind === 'dispatch')
  assert.deepEqual(concurrent.map(r => [r.inflight, r.streamInflight]), [[0, 0], [1, 0]])

  // ── 7. A requested keep-alive that cannot apply (Bun) is logged as skipped. ──
  reset()
  process.env.TAU_ANTIGRAVITY_KEEPALIVE = '1'
  try {
    await stream(makeRequest(base).request)
  } finally {
    delete process.env.TAU_ANTIGRAVITY_KEEPALIVE
  }
  assert.ok(!calls[0]!.initKeys.includes('dispatcher'), 'Bun cannot take an undici dispatcher')
  const skippedRow = rows().find(r => r.kind === 'dispatch')
  assert.deepEqual(skippedRow.profile, { trajectory: 'off', transport: 'baseline', transportSkipped: 'bun-runtime' })
  assert.deepEqual(skippedRow.transport.keepAlive, { effective: 'baseline', skipped: 'bun-runtime' })
  assert.equal(skippedRow.transport.dispatcher, 'global')

  // ── 8. The transport profile follows proxy routing and TLS settings. ──
  const { describeAntigravityTransport } = await import('./antigravity_transport.js')
  const savedEnv = { ...process.env }
  try {
    for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY']) delete process.env[name]
    const url = 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
    assert.deepEqual(describeAntigravityTransport(url), { dispatcher: 'global', route: 'direct', tls: 'default', runtime: 'bun' })
    process.env.HTTPS_PROXY = 'http://proxy.test:3128'
    process.env.NODE_OPTIONS = '--use-system-ca'
    assert.equal(describeAntigravityTransport(url).route, 'proxy')
    assert.equal(describeAntigravityTransport(url).tls, 'custom-ca')
    process.env.NO_PROXY = '.googleapis.com'
    assert.equal(describeAntigravityTransport(url).route, 'direct', 'NO_PROXY must be honored')
    process.env.CLAUDE_CODE_CLIENT_CERT = 'client.pem'
    assert.equal(describeAntigravityTransport(url).tls, 'mtls')
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name]
    Object.assign(process.env, savedEnv)
  }

  console.log('Antigravity dispatch trace passed: flag-off parity, hop/retry correlation, final-wire verdicts, identity vs config, signature strip, abandoned reads, overlap, no prompt text')
} finally {
  globalThis.fetch = originalFetch
  ;(geminiApi as any).antigravityOAuthToken = previousToken
  if (previousDebug === undefined) delete process.env.TAU_CACHE_DEBUG
  else process.env.TAU_CACHE_DEBUG = previousDebug
  codeAssist._resetAntigravityGeminiAffinityForTest()
  codeAssist._resetAntigravityGeminiHostCooldownForTest()
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
