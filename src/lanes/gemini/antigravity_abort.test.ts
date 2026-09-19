/** Run: bun run src/lanes/gemini/antigravity_abort.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-abort-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')
mock.module('../../services/api/providers/gemini_code_assist.js', () => ({
  ...codeAssist,
  ensureCodeAssistReady: async () => 'abort-test-project',
  warmupCodeAssist: () => {},
}))
mock.module('../../services/api/providers/gemini_provider.js', () => ({ resolveCliModelsForPicker: () => [] }))
const { geminiApi, TAU_STABLE_SESSION_ID_FIELD, TAU_QUERY_SOURCE_FIELD } = await import('./api.js')

// The server sends one event, then goes quiet (a long thinking pause) and
// only finishes HOLD_MS later. Like undici, the body errors when the
// request's signal aborts.
const HOLD_MS = 3000
const encoder = new TextEncoder()
const event = (text: string, done = false) => `data: ${JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(done && { finishReason: 'STOP' }) }] } })}\n\n`
const fetchSignals: AbortSignal[] = []
const originalFetch = globalThis.fetch
const previousToken = (geminiApi as any).antigravityOAuthToken

globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const signal = init?.signal ?? undefined
  if (signal) fetchSignals.push(signal)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(event('thinking...')))
      const timer = setTimeout(() => {
        try {
          controller.enqueue(encoder.encode(event(' done', true)))
          controller.close()
        } catch { /* already errored */ }
      }, HOLD_MS)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        controller.error(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}) as typeof fetch

try {
  ;(geminiApi as any).antigravityOAuthToken = 'abort-token'
  for (const model of ['gemini-3.8-flash-medium', 'gemini-3.1-pro-high']) {
    fetchSignals.length = 0
    codeAssist._resetAntigravityGeminiAffinityForTest()
    const controller = new AbortController()
    const stream = geminiApi.streamGenerateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Think for a long time.' }] }],
      [TAU_STABLE_SESSION_ID_FIELD]: '-42',
      [TAU_QUERY_SOURCE_FIELD]: 'repl_main_thread',
    }, controller.signal)
    const first = await stream.next()
    assert.equal(first.done, false)
    const abortedAt = Date.now()
    controller.abort()
    let outcome: string
    try {
      const next = await stream.next()
      outcome = next.done ? 'ended' : 'chunk'
    } catch (err: any) {
      outcome = err?.name ?? String(err)
    }
    const waited = Date.now() - abortedAt
    // The first endpoint of the Antigravity Gemini chain has a headers
    // timeout; the abort must still reach the response body after it.
    assert.ok(fetchSignals.length === 1 && fetchSignals[0]!.aborted, `${model}: the abort never reached the fetch`)
    assert.equal(outcome, 'AbortError', `${model}: the stream went on after the abort (${outcome})`)
    assert.ok(waited < 1000, `${model}: the aborted stream waited ${waited} ms for the server`)
  }
  console.log('Antigravity abort passed: an abort after the response headers cancels the body at once')
} finally {
  globalThis.fetch = originalFetch
  ;(geminiApi as any).antigravityOAuthToken = previousToken
  codeAssist._resetAntigravityGeminiAffinityForTest()
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
