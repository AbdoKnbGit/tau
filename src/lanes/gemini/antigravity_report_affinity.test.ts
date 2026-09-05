/** Run: bun run src/lanes/gemini/antigravity_report_affinity.test.ts */

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const testHome = realpathSync(mkdtempSync(join(os.tmpdir(), 'tau-antigravity-affinity-')))
mock.module('os', () => ({ ...os, homedir: () => testHome }))
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')

// Exercise the real HTTP request paths while keeping authentication and
// onboarding entirely local to this test process.
mock.module('../../services/api/providers/gemini_code_assist.js', () => ({
  ...codeAssist,
  ensureCodeAssistReady: async () => 'report-affinity-test-project',
  warmupCodeAssist: () => {},
}))
mock.module('../../services/api/providers/gemini_provider.js', () => ({
  resolveCliModelsForPicker: () => [],
}))

const { geminiApi, TAU_QUERY_SOURCE_FIELD, TAU_STABLE_SESSION_ID_FIELD } =
  await import('./api.js')

const MODEL = 'gemini-3.7-flash-high'
const MODELS = [...codeAssist.ANTIGRAVITY_MODEL_IDS]
const SESSION = '-123456789'
const PROD = codeAssist.CODE_ASSIST_BASE
const DAILY = codeAssist.ANTIGRAVITY_GENERATION_BASE
const originalFetch = globalThis.fetch
const previousEndpoint = process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
const previousTokens = {
  antigravityOAuthToken: (geminiApi as any).antigravityOAuthToken,
  cliOAuthToken: (geminiApi as any).cliOAuthToken,
}
const requests: Array<{ base: string; body: any }> = []
let forceChatFallback = false

function reset(): void {
  codeAssist._resetAntigravityGeminiAffinityForTest()
  codeAssist._resetAntigravityGeminiHostCooldownForTest()
  requests.length = 0
  forceChatFallback = false
}

async function request(streaming: boolean, querySource: string, model = MODEL): Promise<void> {
  const body = {
    model,
    contents: [{ role: 'user', parts: [{ text: 'Write the final report.' }] }],
    [TAU_STABLE_SESSION_ID_FIELD]: SESSION,
    [TAU_QUERY_SOURCE_FIELD]: querySource,
  }
  if (streaming) {
    const chunks = []
    for await (const chunk of geminiApi.streamGenerateContent(body)) chunks.push(chunk)
    assert.equal(chunks[0]?.candidates?.[0]?.content?.parts?.[0]?.text, '# Report')
  } else {
    const result = await geminiApi.generateContent(body)
    assert.equal(result.candidates?.[0]?.content?.parts?.[0]?.text, '# Report')
  }
}

try {
  delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
  geminiApi.configure({ antigravityOAuthToken: 'test-only-token', cliOAuthToken: undefined })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const base = url.split(':streamGenerateContent')[0]!.split(':generateContent')[0]!
    assert.ok([PROD, DAILY].includes(base), `unexpected network target: ${url}`)
    const body = JSON.parse(String(init?.body))
    requests.push({ base, body })
    assert.equal(body.project, 'report-affinity-test-project')
    assert.equal(body.request.sessionId, SESSION)
    assert.equal(body.request[TAU_QUERY_SOURCE_FIELD], undefined)
    if (forceChatFallback && base === PROD) {
      return new Response('not served here', { status: 404 })
    }
    const response = { candidates: [{ content: { parts: [{ text: '# Report' }] } }] }
    return url.includes(':streamGenerateContent')
      ? new Response(`data: ${JSON.stringify({ response })}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
      : Response.json({ response })
  }) as typeof fetch

  for (const model of MODELS) {
    for (const streaming of [true, false]) {
    reset()
    await request(streaming, 'report', model)
    assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), undefined,
      'a report must not establish the conversation host pin')

    codeAssist.recordAntigravityGeminiServedBase(SESSION, PROD)
    codeAssist.recordAntigravityGeminiHostExhausted(PROD)
    requests.length = 0
    await request(streaming, 'report', model)
    await request(streaming, 'report', model)
    assert.deepEqual(requests.map(value => value.base), [DAILY, DAILY])
    assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), PROD,
      'successful reports on another host must not migrate the conversation')

    // Report fallback serves must not advance the chat's migration streak.
    // Claude has no own pin; its reports must not affect the Gemini process
    // pin either. Exercise that with real Gemini chat requests around them.
    const chatModel = codeAssist.isAntigravityGeminiModel(model) ? model : MODEL
    forceChatFallback = true
    await request(streaming, 'repl_main_thread', chatModel)
    assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), PROD,
      'one real chat fallback must still leave the original pin intact')
    await request(streaming, 'report', model)
    assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), PROD,
      `${model}: interleaved report advanced the chat's pending migration`)
    await request(streaming, 'repl_main_thread', chatModel)
    assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), DAILY,
      'two real chat fallbacks must still migrate the pin')

    // A report served by the pin must not reset a genuine chat fallback.
    reset()
    codeAssist.recordAntigravityGeminiServedBase(SESSION, PROD)
    codeAssist.recordAntigravityGeminiServedBase(SESSION, DAILY)
    await request(streaming, 'report', model)
    codeAssist.recordAntigravityGeminiServedBase(SESSION, DAILY)
    assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), DAILY,
      'an interleaved report must not reset the conversation migration streak')
    }
  }
  console.log(`Antigravity report endpoint affinity tests passed: ${MODELS.length} models and aliases, streaming and non-streaming`)
} finally {
  globalThis.fetch = originalFetch
  Object.assign(geminiApi, previousTokens)
  if (previousEndpoint === undefined) delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
  else process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT = previousEndpoint
  reset()
  mock.restore()
  rmSync(testHome, { recursive: true, force: true })
}
