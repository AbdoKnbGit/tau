/** Run: bun run src/lanes/gemini/antigravity_cache_stream.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-cache-stream-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))

const cache = await import('./antigravity_cache.js')
const MODEL = 'gemini-3.8-flash-low'
const SID = 'cache-stream-session'
const SOURCE = 'repl_main_thread'
const scope = cache.antigravityCacheScope(SID, MODEL, SOURCE)
let behavior: 'hit' | 'cold' | 'abort' | 'error' = 'hit'
let controller = new AbortController()
const requests: Record<string, unknown>[] = []
const requestIds: string[] = []
let inspectProvisional = () => {}

mock.module('./api.js', () => ({
  TAU_STABLE_SESSION_ID_FIELD: '__tauStableSessionId',
  TAU_QUERY_SOURCE_FIELD: '__tauQuerySource',
  isGeminiRetryableNetworkError: () => false,
  geminiApi: {
    supportsServerCache: () => false,
    async *streamGenerateContent(request: Record<string, unknown>) {
      requests.push(structuredClone(request))
      const context = cache.getAntigravityCacheRequestContext(request)
      if (context) requestIds.push(context.requestId)
      yield {
        usageMetadata: { promptTokenCount: 24_000 },
        candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] } }],
      }
      inspectProvisional()
      if (behavior === 'error') throw new Error('synthetic stream failure')
      if (behavior === 'abort') controller.abort()
      yield {
        usageMetadata: {
          promptTokenCount: 24_000,
          candidatesTokenCount: 1,
          ...(behavior === 'hit' ? { cachedContentTokenCount: 20_000 } : {}),
        },
      }
    },
  },
}))

const { GeminiLane } = await import('./loop.js')
const previousEnv = {
  TAU_CACHE_DEBUG: process.env.TAU_CACHE_DEBUG,
  TAU_ANTIGRAVITY_MAX_CACHE: process.env.TAU_ANTIGRAVITY_MAX_CACHE,
  TAU_ANTIGRAVITY_NO_PACING: process.env.TAU_ANTIGRAVITY_NO_PACING,
}
process.env.TAU_CACHE_DEBUG = '1'
delete process.env.TAU_ANTIGRAVITY_MAX_CACHE
delete process.env.TAU_ANTIGRAVITY_NO_PACING

async function run(model = MODEL, providerHint = 'antigravity') {
  controller = new AbortController()
  const events: any[] = []
  for await (const event of new GeminiLane().streamAsProvider({
    model,
    providerHint,
    sessionId: SID,
    querySource: SOURCE,
    signal: controller.signal,
    system: 'Answer the current task using the supplied tools when needed.',
    messages: [{ role: 'user', content: 'Check the workshop inventory.' }],
    tools: [{ name: 'inventory_lookup', description: 'Look up a workshop item.', input_schema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } }],
    max_tokens: 128,
    thinking: { type: 'disabled' },
  })) events.push(event)
  return events
}

try {
  cache._resetAntigravityCacheStateForTest()
  cache._setAntigravityCommitWindowForTest(0)
  const seed = { model: MODEL, sessionId: SID, querySource: SOURCE, requestId: 'seed' }
  cache.recordAntigravityCacheRead(SID, 20_000, 24_000, SOURCE, seed)
  inspectProvisional = () => {
    const state = cache._getAntigravityPaceStateForTest(scope)
    assert.equal(state?.rearms, 0, 'provisional zero consumed a recovery opportunity')
    assert.equal(state?.hitSeen, true, 'provisional zero unlatched a healthy cache')
  }
  for (let i = 0; i < 5; i++) {
    const events = await run()
    const final = events.findLast(e => e.type === 'message_delta')
    assert.equal(final.usage.input_tokens, 4000)
    assert.equal(final.usage.cache_read_input_tokens, 20_000)
  }
  assert.equal(cache._getAntigravityPaceStateForTest(scope)?.rearms, 0)
  assert.deepEqual(requests[0], requests[1], 'tracking changed the serialized prompt or affinity')
  assert.equal(new Set(requestIds).size, 5, 'requests require distinct out-of-band correlation')
  assert.ok(!JSON.stringify(requests).includes(requestIds[0]!), 'correlation ID leaked into model input')
  assert.equal((requests[0]!.tools as any[])[0].functionDeclarations[0].name, 'inventory_lookup', 'tool capability changed')

  behavior = 'cold'
  await run()
  assert.equal(cache._getAntigravityPaceStateForTest(scope)?.rearms, 1, 'true cold must still rearm after successful streaming hits')
  assert.equal(cache._getAntigravityPaceStateForTest(scope)?.hitSeen, false)
  inspectProvisional = () => {}

  const beforeInterrupted = { ...cache._getAntigravityPaceStateForTest(scope) }
  for (const mode of ['abort', 'error'] as const) {
    behavior = mode
    await run()
    assert.deepEqual(cache._getAntigravityPaceStateForTest(scope), beforeInterrupted, 'incomplete stream changed recovery state')
  }

  behavior = 'hit'
  const countBeforeOtherProviders = requestIds.length
  const otherEvents = await run('gemini-2.5-flash', 'gemini')
  await run('claude-sonnet-4-6', 'antigravity')
  assert.equal(requestIds.length, countBeforeOtherProviders, 'Gemini cache recovery leaked to another route')
  assert.equal(otherEvents.findLast(e => e.type === 'message_delta').usage.cache_read_input_tokens, 20_000)
  assert.deepEqual(cache._getAntigravityPaceStateForTest(scope), beforeInterrupted)

  const rows = readFileSync(join(sandbox, 'tau-cache-debug.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const finals = rows.filter(r => r.kind === 'usage' && r.requestId !== 'seed')
  assert.equal(finals.length, 6, 'must log exactly one final usage for each completed Antigravity Gemini response')
  assert.equal(finals.filter(r => r.cacheRead === 0).length, 1, 'provisional zeros were logged as completed misses')
  for (const row of finals) {
    assert.equal(row.final, true)
    assert.ok(rows.some(r => r.requestId === row.requestId && r.break), 'final usage cannot be joined to its request')
  }
  console.log('Antigravity streaming cache regressions passed: final usage, recovery budget, abort/error, scope, prompt identity, tools, correlation')
} finally {
  cache._resetAntigravityCacheStateForTest()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
