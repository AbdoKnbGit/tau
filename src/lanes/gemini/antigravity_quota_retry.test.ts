/** Run: bun run src/lanes/gemini/antigravity_quota_retry.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-quota-retry-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')
let onboardingCalls = 0
mock.module('../../services/api/providers/gemini_code_assist.js', () => ({
  ...codeAssist,
  ensureCodeAssistReady: async () => { onboardingCalls++; return 'quota-test-project' },
  warmupCodeAssist: () => {},
}))
mock.module('../../services/api/providers/gemini_provider.js', () => ({ resolveCliModelsForPicker: () => [] }))
const { geminiApi, GeminiApiError, TAU_QUERY_SOURCE_FIELD, TAU_STABLE_SESSION_ID_FIELD } = await import('./api.js')
const { isRetryableProviderError } = await import('../../services/api/transport_error.js')
const cache = await import('./antigravity_cache.js')
const { GeminiLane } = await import('./loop.js')
const { withProviderRetryState } = await import('../../services/api/providerRetryBudget.js')

const originalFetch = globalThis.fetch
const originalTimer = globalThis.setTimeout
const originalEnv = { ...process.env }
const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = []
const waits: number[] = []
let respond: (url: string, init?: RequestInit) => Response | Promise<Response> = () => quota()
let duringWait: (() => void) | undefined
let passed = 0
const MODEL = 'gemini-3.7-flash-high'
const SESSION = '-12345'

function quota(headers?: HeadersInit, details?: unknown[]): Response {
  return Response.json({ error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
    ...(details && { details }),
  } }, { status: 429, headers })
}

function success(url: string): Response {
  const response = {
    candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 24000, cachedContentTokenCount: 20000, candidatesTokenCount: 1 },
  }
  return url.includes(':streamGenerateContent')
    ? new Response(`data: ${JSON.stringify({ response })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    : Response.json({ response })
}

function reset(): void {
  sent.length = 0
  waits.length = 0
  onboardingCalls = 0
  duringWait = undefined
  respond = () => quota()
  codeAssist._resetAntigravityGeminiAffinityForTest()
  codeAssist._resetAntigravityGeminiHostCooldownForTest()
  cache._resetAntigravityCacheStateForTest()
  cache._setAntigravityCommitWindowForTest(0)
}

async function request(streaming: boolean, model = MODEL, source = 'repl_main_thread', signal?: AbortSignal) {
  const input = {
    model,
    systemInstruction: { parts: [{ text: 'Keep the shared inventory context unchanged.' }] },
    tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' } } } }] }],
    contents: [
      { role: 'user', parts: [{ text: 'Review the inventory.' }] },
      { role: 'model', parts: [{ text: 'Read the inventory.', thoughtSignature: 'unchanged-signature' }] },
      { role: 'user', parts: [{ text: 'Reply OK.' }] },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 128, thinkingConfig: { thinkingLevel: 'low' } },
    [TAU_STABLE_SESSION_ID_FIELD]: SESSION,
    [TAU_QUERY_SOURCE_FIELD]: source,
  }
  const before = JSON.stringify(input)
  try {
    if (streaming) {
      const chunks = []
      for await (const chunk of geminiApi.streamGenerateContent(input, signal)) chunks.push(chunk)
      assert.equal(chunks.length, 1, 'retry leaked extra stream chunks')
      assert.equal(chunks[0]?.usageMetadata?.cachedContentTokenCount, 20000)
    } else {
      const result = await geminiApi.generateContent(input, signal)
      assert.equal(result.usageMetadata?.cachedContentTokenCount, 20000)
    }
  } finally {
    assert.equal(JSON.stringify(input), before, 'retries changed the caller request')
  }
}

function assertIdenticalDispatches(dispatches = sent): void {
  for (const dispatch of dispatches) assert.deepEqual(dispatch, dispatches[0], 'retry changed URL, wire bytes, or headers')
  const envelope = JSON.parse(dispatches[0]!.body)
  assert.equal(envelope.project, 'quota-test-project')
  assert.equal(envelope.request.sessionId, SESSION)
  assert.ok(envelope.requestId)
  assert.ok(dispatches[0]!.body.includes('unchanged-signature'))
  assert.ok(!dispatches[0]!.body.includes('__tau'))
}

function assertSameRequest(): void {
  assertIdenticalDispatches()
  assert.equal(onboardingCalls, 1, '429 rebuilt auth/project state')
  const base = sent[0]!.url.split(':streamGenerateContent')[0]!.split(':generateContent')[0]!
  assert.equal(codeAssist.antigravityGeminiHostCooldownMs(base), 0, 'retry poisoned next request routing')
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  reset()
  await fn()
  passed++
  console.log(`  ok ${name}`)
}

const exhaustedQuota = (err: unknown): boolean => {
  assert.ok(err instanceof GeminiApiError)
  assert.equal(err.status, 429)
  assert.equal(err.isRetryable, false)
  assert.equal(isRetryableProviderError(err), false, 'outer retry must not restart native recovery')
  return true
}
const originalRandom = Math.random
try {
  Math.random = () => 0.5
  delete process.env.TAU_CACHE_DEBUG
  delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
  geminiApi.configure({ apiKey: undefined, cliOAuthToken: undefined, antigravityOAuthToken: 'local-test-token' })
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    assert.match(url, /^https:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com\/v1internal:(?:streamGenerateContent\?alt=sse|generateContent)$/)
    sent.push({ url, body: String(init?.body), headers: Object.fromEntries(new Headers(init?.headers)) })
    return respond(url, init)
  }) as typeof fetch
  globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    waits.push(ms ?? 0)
    return originalTimer(() => { duringWait?.(); fn(...args) }, 0)
  }) as typeof setTimeout

  for (const streaming of [true, false]) {
    const mode = streaming ? 'stream' : 'json'
    for (const model of codeAssist.ANTIGRAVITY_MODEL_IDS) {
      for (const source of ['repl_main_thread', 'report', 'compact', 'agent']) {
        await test(`${mode} ${model} ${source}: three invisible identical daily retries recover`, async () => {
          respond = url => sent.length <= 3 ? quota() : success(url)
          await request(streaming, model, source)
          assert.equal(sent.length, 4)
          assert.deepEqual(waits, [500, 1000, 2000])
          assert.ok(sent.every(call => new URL(call.url).hostname === 'daily-cloudcode-pa.googleapis.com'))
          assertSameRequest()
        })
      }
    }
    await test(`${mode}: exhausted daily stops after four attempts, including outer invocations`, async () => {
      const state = new Map()
      for (let i = 0; i < 3; i++) {
        await assert.rejects(withProviderRetryState(state, () => request(streaming)), exhaustedQuota)
      }
      assert.equal(sent.length, 4)
      assert.deepEqual(waits, [500, 1000, 2000])
      assertIdenticalDispatches()
    })
    await test(`${mode}: no retries or waits on success`, async () => {
      respond = success
      await request(streaming)
      assert.equal(sent.length, 1)
      assert.deepEqual(waits, [])
    })
    await test(`${mode}: mixed quota, capacity and connection errors share one allowance`, async () => {
      respond = url => {
        if (sent.length === 1) return quota()
        if (sent.length === 2) return new Response('Unavailable', { status: 503 })
        if (sent.length === 3) throw new TypeError('fetch failed')
        return success(url)
      }
      await request(streaming)
      assert.equal(sent.length, 4)
      assertSameRequest()
      assert.deepEqual(waits, [500, 1000, 2000])
    })
    await test(`${mode}: network error at the budget boundary cannot add a fifth request`, async () => {
      respond = () => {
        if (sent.length <= 3) return quota()
        throw new TypeError('fetch failed')
      }
      await assert.rejects(request(streaming), err => {
        assert.equal(isRetryableProviderError(err), false)
        return err instanceof TypeError
      })
      assert.equal(sent.length, 4)
      assertIdenticalDispatches()
    })
    for (const [header, body, expected] of [['0.25', '0.1s', 250], ['1', '20s', 20000], ['30', '2s', 30000]] as const) {
      await test(`${mode}: RetryInfo and Retry-After respect longer ${expected}ms hint`, async () => {
        respond = url => sent.length === 1 ? quota({ 'Retry-After': header }, [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: body },
        ]) : success(url)
        await request(streaming)
        assert.deepEqual(waits, [expected], 'server delay was shortened or replaced')
        assertSameRequest()
      })
    }
    for (const hint of ['60', 'Infinity']) {
      await test(`${mode}: long ${hint}s server cooldown stops immediately`, async () => {
        respond = () => quota({ 'Retry-After': hint })
        await assert.rejects(request(streaming), exhaustedQuota)
        assert.equal(sent.length, 1)
        assert.deepEqual(waits, [])
      })
    }
    await test(`${mode}: Antigravity quotaResetDelay is honored as a long cooldown`, async () => {
      respond = () => quota(undefined, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '5m12s' } }])
      await assert.rejects(request(streaming), exhaustedQuota)
      assert.equal(sent.length, 1)
      assert.deepEqual(waits, [])
    })
    for (const reason of ['INSUFFICIENT_G1_CREDITS_BALANCE', 'DAILY_LIMIT_EXCEEDED', 'BILLING_ACCOUNT_SPEND_LIMIT_EXCEEDED']) {
      await test(`${mode}: ${reason} has no pointless retries`, async () => {
        respond = () => quota(undefined, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }])
        await assert.rejects(request(streaming), exhaustedQuota)
        assert.equal(sent.length, 1)
        assert.deepEqual(waits, [])
      })
    }
    await test(`${mode}: abort during backoff prevents another dispatch`, async () => {
      const controller = new AbortController()
      respond = () => quota({ 'Retry-After': '0.5' })
      duringWait = () => controller.abort()
      await assert.rejects(request(streaming, MODEL, 'repl_main_thread', controller.signal), { name: 'AbortError' })
      assert.equal(sent.length, 1)
    })
    await test(`${mode}: already aborted does not dispatch`, async () => {
      await assert.rejects(request(streaming, MODEL, 'repl_main_thread', AbortSignal.abort()), { name: 'AbortError' })
      assert.equal(sent.length, 0)
    })
    for (const body of ['Invalid request', 'Corrupted thought signature']) {
      await test(`${mode}: ${body} does not rewrite history to retry`, async () => {
        respond = () => new Response(body, { status: 400 })
        await assert.rejects(request(streaming), err => err instanceof GeminiApiError && err.status === 400)
        assert.equal(sent.length, 1)
        assert.deepEqual(waits, [])
      })
    }
    await test(`${mode}: an account config change cannot switch the in-flight request`, async () => {
      duringWait = () => geminiApi.configure({ antigravityOAuthToken: 'different-account-token' })
      respond = url => sent.length === 1 ? quota() : success(url)
      try {
        await request(streaming)
        assertSameRequest()
      } finally { geminiApi.configure({ antigravityOAuthToken: 'local-test-token' }) }
    })
    await test(`${mode}: 401 refresh preserves envelope and account with only a new token`, async () => {
      const originalRefresh = (geminiApi as any)._refreshOAuthToken
      let refreshes = 0
      ;(geminiApi as any)._refreshOAuthToken = async () => { refreshes++; return 'refreshed-same-account-token' }
      respond = url => sent.length === 1 ? new Response('Unauthorized', { status: 401 }) : success(url)
      try {
        await request(streaming)
        assert.equal(refreshes, 1)
        assert.equal(sent.length, 2)
        assert.equal(sent[0]!.body, sent[1]!.body)
        assert.notEqual(sent[0]!.headers.authorization, sent[1]!.headers.authorization)
        assert.deepEqual(waits, [0])
      } finally { (geminiApi as any)._refreshOAuthToken = originalRefresh }
    })
  }

  await test('stream disconnect before first output is recovered on daily with identical bytes', async () => {
    respond = url => sent.length === 1 ? new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('fetch failed')) },
    })) : success(url)
    await request(true)
    assert.equal(sent.length, 2)
    assertSameRequest()
  })
  await test('empty stream before output is recovered within the same budget', async () => {
    respond = url => sent.length <= 3 ? new Response('data: [DONE]\n\n') : success(url)
    await request(true)
    assert.equal(sent.length, 4)
    assertSameRequest()
  })
  await test('partial streamed output is never replayed', async () => {
    respond = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n'))
      },
      pull(controller) { controller.error(new TypeError('fetch failed')) },
    }))
    const chunks = []
    await assert.rejects(async () => {
      for await (const chunk of geminiApi.streamGenerateContent({ model: MODEL, contents: [] })) chunks.push(chunk)
    }, err => {
      assert.equal(isRetryableProviderError(err), false)
      return err instanceof TypeError
    })
    assert.equal(chunks.length, 1)
    assert.equal(sent.length, 1)
  })
  await test('concurrent requests each own a three-retry budget', async () => {
    respond = url => {
      const streaming = url.includes(':streamGenerateContent')
      const calls = sent.filter(value => value.url.includes(':streamGenerateContent') === streaming)
      return calls.length <= 3 ? quota() : success(url)
    }
    await Promise.all([
      withProviderRetryState(new Map(), () => request(true)),
      withProviderRetryState(new Map(), () => request(false)),
    ])
    for (const streaming of [true, false]) {
      const calls = sent.filter(value => value.url.includes(':streamGenerateContent') === streaming)
      assert.equal(calls.length, 4)
      assertIdenticalDispatches(calls)
    }
  })
  await test('a later user request receives a fresh budget', async () => {
    await assert.rejects(request(true), exhaustedQuota)
    const oldCount = sent.length
    respond = url => sent.length - oldCount <= 3 ? quota() : success(url)
    await request(true)
    assert.equal(sent.length - oldCount, 4)
  })
  await test('Gemini CLI keeps its existing endpoint and backoff', async () => {
    geminiApi.configure({ cliOAuthToken: 'local-cli-token' })
    try {
      respond = url => sent.length === 1 ? quota() : success(url)
      await request(true, 'gemini-2.5-flash')
      assert.equal(sent.length, 2)
      assert.ok(sent.every(call => new URL(call.url).hostname === 'cloudcode-pa.googleapis.com'))
      assert.deepEqual(waits, [2000])
    } finally { geminiApi.configure({ cliOAuthToken: undefined }) }
  })
  const laneRequest = async (events: any[]) => {
    for await (const event of new GeminiLane().streamAsProvider({
      model: MODEL, providerHint: 'antigravity', sessionId: SESSION,
      messages: [{ role: 'user', content: 'Reply OK.' }], system: 'Be concise.', tools: [],
      max_tokens: 128, thinking: { type: 'disabled' }, signal: new AbortController().signal,
    })) events.push(event)
  }
  await test('lane hides retries and reports only the successful usage', async () => {
    const events: any[] = []
    respond = url => {
      assert.equal(events.length, 0, 'failed request emitted an assistant event')
      return sent.length <= 3 ? quota() : success(url)
    }
    await laneRequest(events)
    assert.equal(sent.length, 4)
    assert.equal(events.filter(e => e.type === 'message_start').length, 1)
    assert.equal(events.findLast(e => e.type === 'message_delta').usage.cache_read_input_tokens, 20000)
    assert.equal(events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), 'OK')
  })
  await test('lane exhaustion throws once without an assistant error turn', async () => {
    const events: any[] = []
    await assert.rejects(laneRequest(events), exhaustedQuota)
    assert.equal(sent.length, 4)
    assert.deepEqual(events, [])
  })
  console.log(`Antigravity daily retry: ${passed} cases passed`)
} finally {
  Math.random = originalRandom
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalTimer
  geminiApi.configure({ apiKey: undefined, cliOAuthToken: undefined, antigravityOAuthToken: undefined })
  for (const key of ['TAU_CACHE_DEBUG', 'TAU_ANTIGRAVITY_GEMINI_ENDPOINT', 'TAU_ANTIGRAVITY_GEMINI_ENDPOINT_TIMEOUT_MS', 'TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
