/** Run: bun run src/lanes/gemini/antigravity_cache_transport.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'

const tempRoot = realpathSync(os.tmpdir())
const sandbox = realpathSync(mkdtempSync(join(tempRoot, 'tau-cache-transport-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')
mock.module('../../services/api/providers/gemini_code_assist.js', () => ({
  ...codeAssist,
  ensureCodeAssistReady: async () => 'test-cache-project',
  warmupCodeAssist: () => {},
}))
mock.module('../../services/api/providers/gemini_provider.js', () => ({ resolveCliModelsForPicker: () => [] }))
const cache = await import('./antigravity_cache.js')
const events: any[] = []
mock.module('./antigravity_cache.js', () => ({
  ...cache,
  writeAntigravityEndpointDebugEvent: (sessionId: string, event: string, detail: unknown) => events.push({ sessionId, event, ...(detail as object) }),
}))
const { geminiApi, TAU_STABLE_SESSION_ID_FIELD, TAU_QUERY_SOURCE_FIELD } = await import('./api.js')
const originalFetch = globalThis.fetch
const previousToken = (geminiApi as any).antigravityOAuthToken
const payloads: any[] = []

try {
  ;(geminiApi as any).antigravityOAuthToken = 'local-test-token'
  globalThis.fetch = (async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)))
    const response = { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 19_803, cachedContentTokenCount: 16_353, candidatesTokenCount: 1 } }
    return String(_url).includes('streamGenerateContent')
      ? new Response(`data: ${JSON.stringify({ response })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ response })
  }) as typeof fetch
  for (const streaming of [true, false]) {
    const context = { sessionId: 'conversation-session', model: 'gemini-3.8-flash-low', querySource: 'repl_main_thread', requestId: streaming ? 'trace-stream' : 'trace-nonstream' }
    const request = {
      model: context.model,
      systemInstruction: { parts: [{ text: 'Keep the inventory reference unchanged.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
      [TAU_STABLE_SESSION_ID_FIELD]: '-123456',
      [TAU_QUERY_SOURCE_FIELD]: context.querySource,
    }
    const before = JSON.stringify(request)
    cache.trackAntigravityCacheRequest(request, context)
    assert.equal(JSON.stringify(request), before)
    if (streaming) {
      for await (const _chunk of geminiApi.streamGenerateContent(request)) { /* consume the real parser */ }
    } else await geminiApi.generateContent(request)
    const served = events.find(e => e.requestId === context.requestId && e.event === 'served')
    assert.ok(served, 'served endpoint cannot be correlated with request usage')
    assert.equal(served.sessionId, '-123456')
    assert.equal(served.conversationSessionId, context.sessionId)
    assert.equal(served.model, context.model)
    assert.equal(served.querySource, context.querySource)
    const envelope = payloads.at(-1)
    assert.equal(envelope.request.sessionId, '-123456', 'wire affinity changed')
    assert.ok(!JSON.stringify(envelope).includes(context.requestId), 'local diagnostic ID leaked onto the wire')
    assert.ok(!JSON.stringify(envelope).includes('__tau'), 'internal marker leaked onto the wire')
  }
  console.log('Antigravity cache transport correlation passed: streaming and non-streaming, unchanged payload and affinity')
} finally {
  globalThis.fetch = originalFetch
  ;(geminiApi as any).antigravityOAuthToken = previousToken
  codeAssist._resetAntigravityGeminiAffinityForTest()
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
