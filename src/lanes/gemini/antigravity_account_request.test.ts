/** Run: bun run src/lanes/gemini/antigravity_account_request.test.ts */

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const testHome = realpathSync(mkdtempSync(join(os.tmpdir(), 'tau-antigravity-request-')))
// All auth, rotation, and Code Assist files stay in the temporary directory.
mock.module('os', () => ({ ...os, homedir: () => testHome }))
// The model picker imports SDK build-only modules; request handling does not
// use it. Keep real onboarding, auth selection, cache, wrapping, and transport.
mock.module('../../services/api/providers/gemini_provider.js', () => ({
  resolveCliModelsForPicker: () => [],
}))
const codeAssist = await import('../../services/api/providers/gemini_code_assist.js')
const { geminiApi, TAU_QUERY_SOURCE_FIELD, TAU_STABLE_SESSION_ID_FIELD } =
  await import('./api.js')

const MODEL = 'gemini-3.7-flash-high'
const MODELS = [...codeAssist.ANTIGRAVITY_MODEL_IDS]
const WIRE_ALIASES: Record<string, string> = {
  'gemini-3.5-flash-high': 'gemini-3-flash-agent',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-extra-low',
  'gemini-3.1-pro-high': 'gemini-pro-agent',
}
for (const generation of ['3.6', '3.7', '3.8']) {
  for (const level of ['low', 'medium', 'high']) {
    WIRE_ALIASES[`gemini-${generation}-flash-${level}`] = `gemini-${generation}-flash-tiered`
  }
}
const SESSION = '-123456789'
const originalFetch = globalThis.fetch
const originalEnv = {
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  GEMINI_CLOUD_PROJECT: process.env.GEMINI_CLOUD_PROJECT,
  TAU_ANTIGRAVITY_GEMINI_ENDPOINT: process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT,
}
type Generation = {
  token: string
  envelope: {
    model: string
    project: string
    userAgent: string
    requestType: string
    request: Record<string, unknown>
  }
}
const generations: Generation[] = []
const loads: string[] = []
let transientQuotaRemaining = 0
let credentialMismatches = 0
let requestedModel = MODEL

function quotaFailure(): Response {
  return Response.json({ error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Resource has been exhausted (e.g. check quota).',
  } }, { status: 429 })
}

async function request(streaming: boolean, source: string, model = MODEL): Promise<void> {
  requestedModel = model
  const isReport = source === 'report'
  const input = {
    model,
    systemInstruction: { parts: [{ text: isReport ? 'Write a factual final report.' : 'You are a coding agent.' }] },
    contents: [{ role: 'user', parts: [{ text: isReport ? 'The session fixed the cache owner.' : 'Review the next cache change.' }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: false } },
    [TAU_STABLE_SESSION_ID_FIELD]: SESSION,
    [TAU_QUERY_SOURCE_FIELD]: source,
  }
  if (streaming) {
    const chunks = []
    for await (const chunk of geminiApi.streamGenerateContent(input)) chunks.push(chunk)
    assert.equal(chunks[0]?.candidates?.[0]?.content?.parts?.[0]?.text, '# Completed report')
  } else {
    const result = await geminiApi.generateContent(input)
    assert.equal(result.candidates?.[0]?.content?.parts?.[0]?.text, '# Completed report')
  }
}

try {
  delete process.env.TAU_ANTIGRAVITY_GEMINI_ENDPOINT
  // These common Gemini CLI settings must not choose an Antigravity project.
  process.env.GOOGLE_CLOUD_PROJECT = 'unrelated-cli-project'
  process.env.GEMINI_CLOUD_PROJECT = 'another-cli-project'
  const cacheDir = join(testHome, '.config', 'claude-code')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'gemini-code-assist.json'), JSON.stringify({
    version: 7,
    projectId: 'previous-account-project',
    entitledModelIds: ['previous-account-model'],
    onboardedAt: Date.now(),
  }))

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '')
    assert.ok(token === 'account-A' || token === 'account-B', 'unexpected request credential')
    const envelope = JSON.parse(String(init?.body))
    if (url.endsWith(':loadCodeAssist')) {
      loads.push(token)
      return Response.json({ cloudaicompanionProject: `project-${token}` })
    }
    if (url.endsWith(':retrieveUserQuota')) {
      assert.equal(envelope.project, `project-${token}`)
      return Response.json({ buckets: MODELS.map(model => ({ modelId: WIRE_ALIASES[model] ?? model, remainingFraction: 1 })) })
    }
    assert.match(url, /^https:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com\/v1internal:(?:streamGenerateContent\?alt=sse|generateContent)$/)
    generations.push({ token, envelope })
    assert.equal(envelope.model, WIRE_ALIASES[requestedModel] ?? requestedModel,
      `${requestedModel}: transport changed the selected model`)
    // Model the observed failure mode: a healthy credential gets a quota
    // refusal when the request reuses another account's cached project.
    if (envelope.project !== `project-${token}`) {
      credentialMismatches++
      return quotaFailure()
    }
    if (transientQuotaRemaining > 0) {
      transientQuotaRemaining--
      return quotaFailure()
    }
    const response = { candidates: [{ content: { parts: [{ text: '# Completed report' }] } }] }
    return url.includes(':streamGenerateContent')
      ? new Response(`data: ${JSON.stringify({ response })}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
      : Response.json({ response })
  }) as typeof fetch

  geminiApi.configure({ apiKey: undefined, cliOAuthToken: undefined, antigravityOAuthToken: 'account-A' })
  // Join configure's real background warmup before switching accounts.
  await codeAssist.ensureCodeAssistReady('account-A', 'antigravity')
  await request(true, 'repl_main_thread')
  assert.equal(generations[0]?.envelope.project, 'project-account-A')
  assert.deepEqual(loads, ['account-A'])

  geminiApi.configure({ antigravityOAuthToken: 'account-B' })
  for (const streaming of [true, false]) {
    for (const source of ['report', 'repl_main_thread']) {
      const start = generations.length
      await request(streaming, source)
      const calls = generations.slice(start)
      assert.equal(calls.length, 1, `${source} unnecessarily retried after changing accounts`)
      assert.equal(calls[0]?.token, 'account-B')
      assert.equal(calls[0]?.envelope.project, 'project-account-B')
    }
  }
  assert.deepEqual(loads, ['account-A', 'account-B'], 'warmup and requests must share account discovery')
  assert.equal(credentialMismatches, 0, 'generation paired a token with another account project')

  // Every configured Antigravity model, including each picker/wire alias and
  // the Claude family, must retain the live request around a distinct report.
  for (const model of MODELS) {
    for (const streaming of [true, false]) {
      const start = generations.length
      await request(streaming, 'repl_main_thread', model)
      const pinBefore = codeAssist.antigravityGeminiStickyBase(SESSION)
      await request(streaming, 'report', model)
      assert.equal(codeAssist.antigravityGeminiStickyBase(SESSION), pinBefore,
        `${model}: report changed the chat endpoint pin`)
      await request(streaming, 'repl_main_thread', model)
      const calls = generations.slice(start)
      assert.equal(calls.length, 3, `${model}: chat/report/chat made unexpected retries`)
      const [before, report, after] = calls
      assert.notDeepEqual(report!.envelope.request, before!.envelope.request,
        `${model}: fixture did not exercise a distinct report prompt`)
      assert.deepEqual(after!.envelope.request, before!.envelope.request,
        `${model}: report changed the following chat's prompt or session bytes`)
      for (const value of calls) {
        assert.equal(value.token, 'account-B', `${model}: account changed`)
        assert.equal(value.envelope.project, 'project-account-B', `${model}: project changed`)
        assert.equal(value.envelope.model, WIRE_ALIASES[model] ?? model, `${model}: model changed`)
        assert.equal(value.envelope.request.sessionId, SESSION, `${model}: session changed`)
      }
    }
  }
  assert.deepEqual(loads, ['account-A', 'account-B'], 'model changes must not rediscover or switch the account')

  for (const streaming of [true, false]) {
    const start = generations.length
    transientQuotaRemaining = 1
    await request(streaming, 'report')
    const retries = generations.slice(start)
    assert.equal(retries.length, 2, 'a transient report refusal must recover in the same account')
    assert.equal(retries[0]?.token, 'account-B')
    assert.equal(retries[1]?.token, 'account-B')
    assert.equal(retries[1]?.envelope.project, retries[0]?.envelope.project)
    assert.deepEqual(retries[1]?.envelope.request, retries[0]?.envelope.request,
      'retry changed the report prompt or stable session')
  }

  for (const { envelope } of generations) {
    assert.equal(envelope.userAgent, 'antigravity')
    assert.equal(envelope.requestType, 'agent')
    assert.equal(envelope.request.sessionId, SESSION, 'report left the live wire session')
    assert.equal(envelope.request[TAU_STABLE_SESSION_ID_FIELD], undefined)
    assert.equal(envelope.request[TAU_QUERY_SOURCE_FIELD], undefined)
  }
  console.log(`Antigravity account/request integration passed: ${MODELS.length} models and aliases, chat/report/chat, both transports, account switch, quota retry`)
} finally {
  globalThis.fetch = originalFetch
  geminiApi.configure({ apiKey: undefined, cliOAuthToken: undefined, antigravityOAuthToken: undefined })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  mock.restore()
  rmSync(testHome, { recursive: true, force: true })
}
