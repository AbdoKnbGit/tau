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
    generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: 'low' } },
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

const retryableQuota = (err: unknown): boolean => {
  assert.ok(err instanceof GeminiApiError)
  assert.equal(err.status, 429)
  assert.equal(err.isRetryable, true)
  assert.equal(isRetryableProviderError(err), true, 'inline retries disabled the existing retry controller')
  return true
}

try {
  delete process.env.TAU_CACHE_DEBUG
  delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
  process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT_TIMEOUT_MS = '0'
  process.env.TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS = '0'
  geminiApi.configure({ apiKey: undefined, cliOAuthToken: undefined, antigravityOAuthToken: 'local-test-token' })
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    assert.match(url, /^https:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com\/v1internal:(?:streamGenerateContent\?alt=sse|generateContent)$/)
    sent.push({ url, body: String(init?.body), headers: Object.fromEntries(new Headers(init?.headers)) })
    return respond(url, init)
  }) as typeof fetch
  // Deterministic clock for wait hints, no real quota/network traffic.
  globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    waits.push(ms ?? 0)
    return originalTimer(() => { duringWait?.(); fn(...args) }, 0)
  }) as typeof setTimeout

  for (const streaming of [true, false]) {
    const mode = streaming ? 'stream' : 'json'
    for (const model of codeAssist.ANTIGRAVITY_MODEL_IDS) {
      for (const source of ['repl_main_thread', 'report']) {
        await test(`${mode} ${model} ${source}: three invisible identical retries recover`, async () => {
          respond = url => sent.length <= 3 ? quota() : success(url)
          await request(streaming, model, source)
          assert.equal(sent.length, 4)
          assert.deepEqual(waits, [0, 0, 0], 'bare 429 added backoff')
          assertSameRequest()
        })
      }
    }
    await test(`${mode}: exhausted primary still falls back to a healthy daily host`, async () => {
      respond = url => url.startsWith(codeAssist.CODE_ASSIST_BASE + ':') ? quota() : success(url)
      await request(streaming)
      assert.equal(sent.length, 5)
      assertIdenticalDispatches(sent.slice(0, 4))
      assert.ok(sent[4]!.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':'))
      assert.equal(sent[4]!.body, sent[0]!.body, 'endpoint fallback rebuilt the envelope')
      assert.deepEqual(sent[4]!.headers, sent[0]!.headers)
      assert.equal(onboardingCalls, 1)
      assert.deepEqual(waits, [0, 0, 0])
      assert.ok(codeAssist.antigravityGeminiHostCooldownMs(codeAssist.CODE_ASSIST_BASE) > 0)
      assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), codeAssist.ANTIGRAVITY_GENERATION_BASE)
    })
    await test(`${mode}: pinned primary retains fallback and report cooldown recovery`, async () => {
      codeAssist.recordAntigravityGeminiServedBase(SESSION, codeAssist.CODE_ASSIST_BASE)
      respond = url => url.startsWith(codeAssist.CODE_ASSIST_BASE + ':') ? quota() : success(url)
      await request(streaming)
      assert.equal(sent.length, 6, 'pinned host must keep its original extra attempt before fallback')
      assertIdenticalDispatches(sent.slice(0, 4))
      assert.ok(sent.slice(0, 5).every(call => call.url.startsWith(codeAssist.CODE_ASSIST_BASE + ':')))
      assert.ok(sent[5]!.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':'))
      assert.deepEqual(waits.slice(0, 3), [0, 0, 0])
      assert.equal(waits.length, 4)
      assert.ok(waits[3]! >= 350 && waits[3]! <= 650, 'original pinned-host backoff changed')
      assert.equal(onboardingCalls, 2)
      assert.ok(codeAssist.antigravityGeminiHostCooldownMs(codeAssist.CODE_ASSIST_BASE) > 0)
      assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), codeAssist.CODE_ASSIST_BASE, 'one fallback must retain pin hysteresis')
      await request(streaming, MODEL, 'report')
      assert.equal(sent.length, 7)
      assert.ok(sent[6]!.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':'), 'report ignored the exhausted-host cooldown')
    })
    await test(`${mode}: all hosts failing keeps recovery retryable with one added budget`, async () => {
      await assert.rejects(request(streaming), retryableQuota)
      assert.equal(sent.length, 7, 'the three inline retries must not restart per host or outer attempt')
      assertIdenticalDispatches(sent.slice(0, 4))
      assert.deepEqual(sent.map(call => new URL(call.url).hostname), [
        'cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com',
        'cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com',
        'daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com',
        'daily-cloudcode-pa.googleapis.com',
      ])
      assert.equal(waits.filter(ms => ms === 0).length, 3)
      assert.equal(onboardingCalls, 2)
    })
    await test(`${mode}: no retries on success`, async () => {
      respond = success
      await request(streaming)
      assert.equal(sent.length, 1)
      assert.deepEqual(waits, [])
    })
    await test(`${mode}: warm daily timeout probes production once then recovers on daily`, async () => {
      codeAssist.recordAntigravityGeminiServedBase(SESSION, codeAssist.ANTIGRAVITY_GENERATION_BASE)
      process.env.TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS = '30000'
      respond = (url, init) => {
        if (sent.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
          })
        }
        return url.startsWith(codeAssist.CODE_ASSIST_BASE + ':') ? quota() : success(url)
      }
      try {
        await request(streaming)
        assert.deepEqual(sent.map(call => new URL(call.url).hostname), [
          'daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com',
          'daily-cloudcode-pa.googleapis.com',
        ], 'fallback 429 delayed the warm-host recovery')
        assert.equal(waits.filter(ms => ms === 0).length, 0, 'fallback spent the fast-retry budget')
        assert.equal(waits.filter(ms => ms === 30000).length, 2, 'warm-host timeout changed')
        assert.equal(sent[0]!.body, sent[1]!.body, 'fallback changed the serialized envelope')
        for (const call of sent) {
          assert.deepEqual(JSON.parse(call.body).request, JSON.parse(sent[0]!.body).request, 'recovery changed the cache prefix')
          assert.deepEqual(call.headers, sent[0]!.headers)
        }
        assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), codeAssist.ANTIGRAVITY_GENERATION_BASE)
      } finally {
        process.env.TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS = '0'
      }
    })
    await test(`${mode}: a previously refusing fallback remains available for recovery`, async () => {
      codeAssist.recordAntigravityGeminiServedBase(SESSION, codeAssist.ANTIGRAVITY_GENERATION_BASE)
      respond = url => {
        if (url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':')) throw new TypeError('fetch failed')
        return sent.length === 2 ? quota() : success(url)
      }
      await request(streaming)
      assert.equal(sent.length, 4, 'recovery lost the fallback after its first refusal')
      assert.equal(waits.filter(ms => ms === 0).length, 0)
      assert.ok(sent[3]!.url.startsWith(codeAssist.CODE_ASSIST_BASE + ':'))
    })
    await test(`${mode}: outer invocations share one fast-retry allowance without losing fallback`, async () => {
      const state = new Map()
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(withProviderRetryState(state, () => request(streaming)), retryableQuota)
      }
      assert.equal(sent.length, 15, 'three outer invocations replenished the inline budget')
      assert.equal(waits.filter(ms => ms === 0).length, 3)
      assert.equal(sent.filter(call => call.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':')).length, 6, 'outer budget suppressed fallback recovery')
      const previousCount = sent.length
      respond = url => sent.length - previousCount <= 3 ? quota() : success(url)
      await withProviderRetryState(new Map(), () => request(streaming))
      assert.equal(sent.length - previousCount, 4, 'a new user operation inherited an exhausted allowance')
    })
    await test(`${mode}: explicit RetryInfo and Retry-After use the longer delay`, async () => {
      respond = url => sent.length === 1 ? quota({ 'Retry-After': '0.25' }, [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.1s' },
      ]) : success(url)
      await request(streaming)
      assert.deepEqual(waits, [250])
      assertSameRequest()
    })
    for (const hint of ['60', 'Infinity']) {
      await test(`${mode}: ${hint}s cooldown skips inline retries and preserves fallback`, async () => {
        respond = url => url.startsWith(codeAssist.CODE_ASSIST_BASE + ':') ? quota({ 'Retry-After': hint }) : success(url)
        await request(streaming)
        assert.equal(sent.length, 2)
        assert.ok(sent[1]!.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':'))
        assert.deepEqual(waits, [])
      })
    }
    await test(`${mode}: terminal quota skips inline retries and preserves endpoint checks`, async () => {
      respond = () => quota(undefined, [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'INSUFFICIENT_G1_CREDITS_BALANCE',
      }])
      await assert.rejects(request(streaming), err => {
        assert.ok(err instanceof GeminiApiError)
        assert.equal(err.status, 429)
        assert.equal(err.isRetryable, false)
        return true
      })
      assert.equal(sent.length, 2, 'terminal quota must retain the pre-existing host checks')
      assert.deepEqual(waits, [])
    })
    await test(`${mode}: abort while waiting prevents a second request`, async () => {
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
    await test(`${mode}: 400 is not a quota retry`, async () => {
      respond = () => new Response('Invalid request', { status: 400 })
      await assert.rejects(request(streaming), err => err instanceof GeminiApiError && err.status === 400)
      assert.equal(sent.length, 1)
      assert.deepEqual(waits, [])
    })
    await test(`${mode}: network failure after inline retries still falls back`, async () => {
      respond = url => {
        if (sent.length <= 3) return quota()
        if (sent.length === 4) throw new TypeError('fetch failed')
        return success(url)
      }
      await request(streaming)
      assert.equal(sent.length, 5)
      assertIdenticalDispatches(sent.slice(0, 4))
      assert.ok(sent[4]!.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':'))
    })
    await test(`${mode}: a new non-retryable error after 429 is surfaced unchanged`, async () => {
      respond = () => sent.length <= 3 ? quota() : new Response('Invalid request', { status: 400 })
      await assert.rejects(request(streaming), err => err instanceof GeminiApiError && err.status === 400)
      assert.equal(sent.length, 4)
      assertIdenticalDispatches()
      assert.deepEqual(waits, [0, 0, 0])
    })
  }

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
    }, /fetch failed/)
    assert.equal(chunks.length, 1)
    assert.equal(sent.length, 1)
  })

  await test('concurrent requests each own a three-retry budget', async () => {
    respond = url => {
      const streaming = url.includes(':streamGenerateContent')
      const calls = sent.filter(value => value.url.includes(':streamGenerateContent') === streaming)
      return calls.length <= 3 ? quota() : success(url)
    }
    await Promise.all([request(true), request(false)])
    for (const streaming of [true, false]) {
      const calls = sent.filter(value => value.url.includes(':streamGenerateContent') === streaming)
      assert.equal(calls.length, 4)
      for (const call of calls) assert.deepEqual(call, calls[0])
    }
  })

  await test('a later user request receives a fresh budget', async () => {
    respond = url => sent.length % 4 === 0 ? success(url) : quota()
    await request(true)
    assert.equal(sent.length, 4)
    await request(true)
    assert.equal(sent.length, 8)
  })

  await test('Gemini CLI keeps its existing backoff', async () => {
    geminiApi.configure({ cliOAuthToken: 'local-cli-token' })
    try {
      respond = url => sent.length === 1 ? quota() : success(url)
      await request(true, 'gemini-2.5-flash')
      assert.equal(sent.length, 2)
      assert.ok(waits.some(ms => ms >= 1400 && ms <= 2600), 'CLI incorrectly used instant Antigravity retries')
    } finally {
      geminiApi.configure({ cliOAuthToken: undefined })
    }
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
  await test('lane exhaustion throws once without persisting an assistant error turn', async () => {
    const events: any[] = []
    await assert.rejects(laneRequest(events), retryableQuota)
    assert.equal(sent.length, 7)
    assert.deepEqual(events, [])
  })
  console.log(`Antigravity quota retry: ${passed} cases passed`)
} finally {
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
