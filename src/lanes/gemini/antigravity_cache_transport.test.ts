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
const { resolveThinkingConfig } = await import('./thinking.js')
const { GeminiLane } = await import('./loop.js')
const originalFetch = globalThis.fetch
const previousToken = (geminiApi as any).antigravityOAuthToken
const previousThinking = process.env.TAU_GEMINI_THINKING
const previousThoughts = process.env.TAU_GEMINI_INCLUDE_THOUGHTS
const payloads: any[] = []

try {
  ;(geminiApi as any).antigravityOAuthToken = 'local-test-token'
  delete process.env.TAU_GEMINI_THINKING
  delete process.env.TAU_GEMINI_INCLUDE_THOUGHTS
  globalThis.fetch = (async (_url, init) => {
    assert.ok(String(_url).startsWith(codeAssist.ANTIGRAVITY_GENERATION_BASE + ':'), 'generation left the Antigravity host')
    assert.equal(new Headers(init?.headers).get('user-agent'), 'antigravity/hub/2.31.2 darwin/arm64', 'an older Hub identity can hide Gemini 4 models upstream')
    payloads.push(JSON.parse(String(init?.body)))
    const response = { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] } }], usageMetadata: { promptTokenCount: 19_803, cachedContentTokenCount: 16_353, candidatesTokenCount: 1 } }
    return String(_url).includes('streamGenerateContent')
      ? new Response(`data: ${JSON.stringify({ response })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ response })
  }) as typeof fetch
  const gemini4Models = ['carbon', 'argon', 'hydrogen'].flatMap(family =>
    ['low', 'medium', 'high'].map(level => `gemini-4-${family}-${level}`))
  for (const model of [...gemini4Models, 'gemini-3.8-flash-low']) {
    for (const streaming of [true, false]) {
      for (const querySource of ['repl_main_thread', 'agent:builtin:general-purpose']) {
        const sessionId = `${model}-${streaming}-${querySource}`
        const systemInstruction = { parts: [{ text: 'Keep the inventory reference unchanged.' }] }
        const tools = [{ functionDeclarations: [{ name: 'Read', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } }] }]
        const contents = [{ role: 'user', parts: [{ text: 'Reply OK.' }] }]
        const thinkingConfig = resolveThinkingConfig(model, -1)
        const level = model.endsWith('-high') ? 'high' : model.endsWith('-medium') ? 'medium' : 'low'
        let previousEnvelope: any
        for (const turn of [1, 2]) {
          const context = { sessionId, model, querySource, requestId: `trace-${sessionId}-${turn}` }
          const request = {
            model,
            systemInstruction,
            tools,
            generationConfig: { maxOutputTokens: 8192, thinkingConfig },
            contents: [...contents],
            [TAU_STABLE_SESSION_ID_FIELD]: '-123456',
            [TAU_QUERY_SOURCE_FIELD]: querySource,
          }
          const before = JSON.stringify(request)
          cache.trackAntigravityCacheRequest(request, context)
          if (streaming) {
            for await (const _chunk of geminiApi.streamGenerateContent(request)) { /* consume the real parser */ }
          } else await geminiApi.generateContent(request)
          assert.equal(JSON.stringify(request), before, 'transport mutated the caller history or config')
          const served = events.find(e => e.requestId === context.requestId && e.event === 'served')
          assert.ok(served, 'served endpoint cannot be correlated with request usage')
          assert.equal(served.sessionId, '-123456')
          assert.equal(served.conversationSessionId, sessionId)
          assert.equal(served.model, model)
          assert.equal(served.querySource, querySource)
          const envelope = payloads.at(-1)
          assert.equal(envelope.model, model === 'gemini-3.8-flash-low' ? 'gemini-3.8-flash-tiered' : model)
          assert.equal(envelope.userAgent, 'antigravity')
          assert.equal(envelope.project, 'test-cache-project')
          assert.equal(envelope.request.sessionId, '-123456', 'wire affinity changed')
          assert.deepEqual(envelope.request.systemInstruction, systemInstruction, 'stable system prefix changed')
          assert.deepEqual(envelope.request.tools, tools, 'stable tool prefix changed')
          assert.deepEqual(envelope.request.contents, contents, 'conversation prefix changed')
          assert.deepEqual(envelope.request.generationConfig, { thinkingConfig:
            model.startsWith('gemini-4-') && level !== 'high'
              ? { thinkingBudget: -1, includeThoughts: false }
              : { thinkingLevel: level, includeThoughts: false },
          })
          assert.ok(!('cachedContent' in envelope.request), 'explicit cache metadata leaked into implicit-cache transport')
          assert.ok(!JSON.stringify(envelope).includes(context.requestId), 'local diagnostic ID leaked onto the wire')
          assert.ok(!JSON.stringify(envelope).includes('__tau'), 'internal marker leaked onto the wire')
          if (previousEnvelope) {
            assert.deepEqual(envelope.request.contents.slice(0, previousEnvelope.request.contents.length), previousEnvelope.request.contents, 'follow-up rewrote earlier history')
            assert.deepEqual(envelope.request.generationConfig, previousEnvelope.request.generationConfig, 'reasoning config drifted between turns')
          }
          previousEnvelope = envelope
          contents.push({ role: 'model', parts: [{ text: 'OK' }] }, { role: 'user', parts: [{ text: 'Continue.' }] })
        }
      }
    }
  }
  // Exercise the real lane's thinking conversion before the wrapper. An
  // override must select the same upstream tier as the emitted config.
  for (const family of ['carbon', 'argon', 'hydrogen']) {
    for (const [level, override, tier] of [
      ['low', undefined, 'low'],
      ['medium', undefined, 'medium'],
      ['high', undefined, 'high'],
      ['high', 'low', 'low'],
      ['low', 'high', 'high'],
      ['high', 'off', 'low'],
    ] as const) {
      const model = `gemini-4-${family}-${level}`
      if (override === undefined) delete process.env.TAU_GEMINI_THINKING
      else process.env.TAU_GEMINI_THINKING = override
      const stream = new GeminiLane().streamAsProvider({
        model, messages: [{ role: 'user', content: 'Reply OK.' }],
        system: 'Keep this prefix unchanged.', tools: [], max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        signal: new AbortController().signal, providerHint: 'antigravity',
        sessionId: `${family}-pipeline-${model}-${override}`, querySource: 'repl_main_thread',
      })
      for await (const _event of stream) { /* exercise the real lane and transport */ }
      const envelope = payloads.at(-1)
      assert.equal(envelope.model, `gemini-4-${family}-${tier}`)
      assert.deepEqual(envelope.request.generationConfig.thinkingConfig, tier === 'high'
        ? { thinkingLevel: 'high', includeThoughts: true }
        : { thinkingBudget: -1, includeThoughts: true })
    }
  }
  delete process.env.TAU_GEMINI_THINKING
  // Vision: an attached image reaches Google as inline data on every Gemini 4 row.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='
  for (const model of gemini4Models) {
    const stream = new GeminiLane().streamAsProvider({
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'What is in this screenshot?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      ] }],
      system: 'Keep this prefix unchanged.', tools: [], max_tokens: 1024,
      signal: new AbortController().signal, providerHint: 'antigravity',
      sessionId: `vision-${model}`, querySource: 'repl_main_thread',
    } as any)
    for await (const _event of stream) { /* exercise the real lane and transport */ }
    const envelope = payloads.at(-1)
    assert.equal(envelope.model, model)
    const parts = envelope.request.contents.flatMap((content: any) => content.parts)
    assert.ok(parts.some((part: any) => part.inlineData?.mimeType === 'image/png' && part.inlineData.data === png),
      `${model}: the image did not reach the wire as inline data`)
  }
  console.log('Antigravity cache transport passed: all Gemini 4 levels and Flash 3.8 Low; streaming/non-streaming main/agent turns preserve prefix, reasoning and affinity; Gemini 4 images reach the wire')
} finally {
  globalThis.fetch = originalFetch
  ;(geminiApi as any).antigravityOAuthToken = previousToken
  if (previousThinking === undefined) delete process.env.TAU_GEMINI_THINKING
  else process.env.TAU_GEMINI_THINKING = previousThinking
  if (previousThoughts === undefined) delete process.env.TAU_GEMINI_INCLUDE_THOUGHTS
  else process.env.TAU_GEMINI_INCLUDE_THOUGHTS = previousThoughts
  codeAssist._resetAntigravityGeminiAffinityForTest()
  mock.restore()
  assert.ok(resolve(sandbox).startsWith(resolve(tempRoot) + sep))
  rmSync(sandbox, { recursive: true, force: true })
}
