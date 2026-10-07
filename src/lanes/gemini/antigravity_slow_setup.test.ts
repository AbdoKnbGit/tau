/** Run: bun run src/lanes/gemini/antigravity_slow_setup.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setImmediate as realImmediate } from 'node:timers'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-slow-setup-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('../shared/media_extract.js', () => ({ prefetchMediaText: async () => {} }))
mock.module('../shared/vision_capability.js', () => ({ decideImageSupport: () => false }))
mock.module('../../services/api/providers/gemini_provider.js', () => ({ resolveCliModelsForPicker: () => [] }))
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')
mock.module('../../services/api/providers/gemini_code_assist.js', () => ({
  ...codeAssist,
  ensureCodeAssistReady: async () => 'slow-test-project',
  warmupCodeAssist: () => {},
}))
const { geminiApi } = await import('./api.js')
const { GeminiLane } = await import('./loop.js')
const { LaneBackedProvider } = await import('../provider-bridge.js')
const { withProviderRetryState, ProviderSetupTimeoutError } = await import('../../services/api/providerRetryBudget.js')
const cache = await import('./antigravity_cache.js')

const original = { fetch: globalThis.fetch, setTimeout, clearTimeout, now: Date.now }
const envKeys = ['TAU_CACHE_DEBUG', 'TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS', 'CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_DISABLE_STREAM_WATCHDOG', 'CLAUDE_ENABLE_STREAM_WATCHDOG']
const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const timers = new Map<number, { at: number; callback: () => void }>()
let time = 1_800_000_000_000
let sequence = 0
let passed = 0
const sent: Array<{ url: string; body: string; signal?: AbortSignal | null }> = []
let respond: (url: string, init: RequestInit) => Promise<Response> | Response
const MODEL = 'gemini-3.8-flash-high'
const provider = new LaneBackedProvider(new GeminiLane(), 'antigravity')
const params = { model: MODEL, sessionId: 'slow-setup', querySource: 'repl_main_thread' as const,
  messages: [{ role: 'user' as const, content: 'Reply OK.' }], system: 'Shared context.', tools: [], max_tokens: 128 }

const flush = () => new Promise<void>(resolve => realImmediate(resolve))
async function tick(ms: number): Promise<void> {
  await flush()
  const end = time + ms
  while (true) {
    const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    time = next[1].at
    timers.delete(next[0])
    next[1].callback()
    await flush()
  }
  time = end
  await flush()
}

function success(): Response {
  return new Response(`data: ${JSON.stringify({ response: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 24000, cachedContentTokenCount: 23000, candidatesTokenCount: 1 },
  } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}

function delayedHeaders(ms: number, signal?: AbortSignal | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(success())
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function track<T>(promise: Promise<T>) {
  const result: { done: boolean; value?: T; error?: unknown } = { done: false }
  void promise.then(value => { result.done = true; result.value = value }, error => { result.done = true; result.error = error })
  return result
}

async function test(name: string, run: () => Promise<void>) {
  timers.clear()
  sent.length = 0
  for (const key of envKeys) delete process.env[key]
  codeAssist._resetAntigravityGeminiAffinityForTest()
  codeAssist._resetAntigravityGeminiHostCooldownForTest()
  codeAssist.recordAntigravityGeminiServedBase('slow-setup', codeAssist.ANTIGRAVITY_GENERATION_BASE)
  cache._resetAntigravityCacheStateForTest()
  cache._setAntigravityCommitWindowForTest(0)
  respond = (_url, init) => delayedHeaders(45000, init.signal)
  await run()
  passed++
  console.log(`  ok ${name}`)
}

try {
  geminiApi.configure({ antigravityOAuthToken: 'local-test-token', cliOAuthToken: undefined, apiKey: undefined })
  Date.now = () => time
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms = 0, ...args: any[]) => {
    const id = ++sequence
    timers.set(id, { at: time + ms, callback: () => callback(...args) })
    return id
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(Number(id)) }) as typeof clearTimeout
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    sent.push({ url, body: String(init?.body), signal: init?.signal })
    return respond(url, init ?? {})
  }) as typeof fetch

  for (const stream of [true, false]) {
    await test(`${stream ? 'stream' : 'non-stream'}: 45s warm response finishes once with cache intact`, async () => {
      const result = track(stream ? provider.stream(params) : provider.create(params))
      await tick(30001)
      assert.equal(result.done, false, 'healthy response was cancelled at 30s')
      assert.equal(sent.length, 1, '30s delay triggered another generation')
      assert.equal(sent[0]!.signal?.aborted, false)
      assert.ok(sent[0]!.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE))
      const wire = sent[0]!.body
      await tick(14999)
      assert.equal(result.error, undefined)
      assert.equal(result.done, true)
      if (stream) {
        const events = []
        for await (const event of result.value as any) events.push(event)
        assert.equal(events.filter(e => e.type === 'message_start').length, 1)
        assert.equal(events.findLast(e => e.type === 'message_delta').usage.cache_read_input_tokens, 23000)
        assert.equal(events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), 'OK')
      } else {
        assert.equal((result.value as any).usage.cache_read_input_tokens, 23000)
        assert.equal((result.value as any).content[0].text, 'OK')
      }
      await tick(300000)
      assert.equal(sent.length, 1, 'successful response was replayed')
      assert.equal(sent[0]!.body, wire)
      assert.equal(sent[0]!.signal?.aborted, false, 'setup timer cancelled a successful stream')
    })
  }

  await test('old 30s override reproduces six cancellations and the misleading fallback 429', async () => {
    process.env.TAU_ANTIGRAVITY_GEMINI_STICKY_TIMEOUT_MS = '30000'
    respond = (url, init) => url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE)
      ? delayedHeaders(45000, init.signal)
      : Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } }, { status: 429 })
    const state = new Map()
    const result = track((async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await withProviderRetryState(state, () => provider.create(params))
        } catch (error) {
          if (attempt === 2) throw error
        }
      }
    })())
    await tick(210000)
    assert.match((result.error as Error)?.message, /Gemini API error 429/)
    assert.equal(sent.length, 12)
    const daily = sent.filter(call => call.url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE))
    assert.equal(daily.length, 6)
    assert.ok(daily.every(call => call.signal?.aborted), 'old cutoff did not reproduce the logged failure')
  })

  await test('the setup deadline never cancels or replays a stream after output starts', async () => {
    respond = async (_url, init) => {
      await delayedHeaders(45000, init.signal)
      return new Response(new ReadableStream({ start(controller) {
        const frame = (text: string, finishReason?: string) => new TextEncoder().encode(`data: ${JSON.stringify({ response: {
          candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finishReason && { finishReason }) }],
        } })}\n\n`)
        controller.enqueue(frame('first'))
        setTimeout(() => { controller.enqueue(frame('second', 'STOP')); controller.close() }, 360000)
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const result = track(provider.stream(params))
    await tick(45000)
    assert.equal(result.error, undefined)
    assert.equal(result.done, true)
    const events: any[] = []
    const drained = track((async () => { for await (const event of result.value!) events.push(event) })())
    await tick(300000)
    assert.equal(drained.done, false)
    assert.equal(sent[0]!.signal?.aborted, false)
    await tick(60000)
    assert.equal(drained.error, undefined)
    assert.equal(drained.done, true)
    assert.equal(events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join(''), 'firstsecond')
    assert.equal(sent.length, 1)
  })

  await test('caller cancellation stops a slow warm request without another dispatch', async () => {
    const controller = new AbortController()
    const result = track(provider.stream({ ...params, signal: controller.signal }))
    await tick(10000)
    controller.abort()
    await flush()
    assert.equal((result.error as Error)?.name, 'AbortError')
    assert.equal(sent[0]!.signal?.aborted, true)
    await tick(300000)
    assert.equal(sent.length, 1)
  })

  await test('a hung warm host ends once at the shared 5-minute deadline, without a fake quota error', async () => {
    respond = (_url, init) => delayedHeaders(600000, init.signal)
    const state = new Map()
    const result = track(withProviderRetryState(state, () => provider.stream(params)))
    await tick(299999)
    assert.equal(result.done, false)
    assert.equal(sent.length, 1)
    await tick(1)
    assert.ok(result.error instanceof ProviderSetupTimeoutError)
    assert.equal(result.error.isRetryable, false)
    assert.doesNotMatch(result.error.message, /429|quota/i)
    assert.equal(sent[0]!.signal?.aborted, true)
    await assert.rejects(withProviderRetryState(state, () => provider.stream(params)), ProviderSetupTimeoutError)
    assert.equal(sent.length, 1, 'outer retry reset the deadline and dispatched again')
    respond = () => success()
    const fresh = await withProviderRetryState(new Map(), () => provider.create(params))
    assert.equal(fresh.content[0]?.text, 'OK', 'a later user request inherited the expired window')
    assert.equal(sent.length, 2)
  })

  await test('earlier failed setup time counts toward the next outer invocation', async () => {
    const state = new Map()
    const originalStream = provider.stream.bind(provider)
    // Establish the window in the real bridge, then end setup with an HTTP
    // failure after 200s. Use a minimal lane to isolate outer-window timing.
    const lane = { name: 'gemini', resolveModel: (model: string) => model,
      async *streamAsProvider({ signal }: any): AsyncGenerator<any> {
        await delayedHeaders(200000, signal)
        throw Object.assign(new Error('Gemini API error 429: temporary'), { status: 429, isRetryable: true })
      } }
    const failing = new LaneBackedProvider(lane as any, 'antigravity')
    const first = track(withProviderRetryState(state, () => failing.stream(params)))
    await tick(200000)
    assert.match((first.error as Error).message, /429/)
    respond = (_url, init) => delayedHeaders(200000, init.signal)
    const second = track(withProviderRetryState(state, () => originalStream(params)))
    await tick(99999)
    assert.equal(second.done, false)
    await tick(1)
    assert.ok(second.error instanceof ProviderSetupTimeoutError, 'second invocation received another five minutes')
    assert.equal(sent.length, 1)
  })

  await test('real HTTP errors still reach a working fallback', async () => {
    respond = url => url.startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE)
      ? new Response('temporarily unavailable', { status: 503 }) : success()
    const result = track(provider.create(params))
    await tick(1000)
    assert.equal(result.error, undefined)
    assert.equal(result.done, true)
    assert.equal(sent.length, 3)
    assert.ok(sent[2]!.url.startsWith(codeAssist.CODE_ASSIST_BASE))
    assert.equal((result.value as any).content[0].text, 'OK')
  })
  console.log(`Antigravity slow setup: ${passed} cases passed`)
} finally {
  globalThis.fetch = original.fetch
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  Date.now = original.now
  for (const key of envKeys) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
