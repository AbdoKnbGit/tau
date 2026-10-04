/**
 * Claude on Antigravity through the Gemini lane: refusals and cache refresh.
 *
 * Run: bun run src/lanes/gemini/antigravity_claude_lane.test.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const sandbox = realpathSync(mkdtempSync(join(realpathSync(os.tmpdir()), 'tau-agy-claude-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))

let finish: string | undefined = 'STOP'
let parts: Record<string, unknown>[] = [{ text: 'Done.' }]
const requests: Record<string, any>[] = []

mock.module('./api.js', () => ({
  TAU_STABLE_SESSION_ID_FIELD: '__tauStableSessionId',
  TAU_QUERY_SOURCE_FIELD: '__tauQuerySource',
  isGeminiRetryableNetworkError: () => false,
  geminiApi: {
    supportsServerCache: () => false,
    async *streamGenerateContent(request: Record<string, unknown>) {
      requests.push(structuredClone(request))
      yield {
        usageMetadata: { promptTokenCount: 30_000, candidatesTokenCount: 1, cachedContentTokenCount: 29_000 },
        candidates: [{ content: { role: 'model', parts }, finishReason: finish }],
      }
    },
  },
}))

let scheduled: ((signal: AbortSignal) => Promise<void>) | undefined
let cancels = 0
mock.module('./antigravity_claude_keepalive.js', () => ({
  cancelAntigravityClaudeKeepAlive: () => { cancels++; scheduled = undefined },
  scheduleAntigravityClaudeKeepAlive: (refresh: (signal: AbortSignal) => Promise<void>) => { scheduled = refresh },
}))

const { GeminiLane } = await import('./loop.js')

async function run(model: string, querySource = 'repl_main_thread') {
  const events: any[] = []
  for await (const event of new GeminiLane().streamAsProvider({
    model,
    providerHint: 'antigravity',
    sessionId: 'agy-claude-session',
    querySource,
    signal: new AbortController().signal,
    system: 'Answer briefly.',
    messages: [{ role: 'user', content: 'Summarize the notes.' }],
    tools: [],
    max_tokens: 32_000,
    thinking: { type: 'disabled' },
  })) events.push(event)
  return events
}

const stopReason = (events: any[]) => events.findLast(e => e.type === 'message_delta')?.delta?.stop_reason

let passed = 0
async function test(name: string, fn: () => Promise<void>) {
  scheduled = undefined
  cancels = 0
  requests.length = 0
  finish = 'STOP'
  parts = [{ text: 'Done.' }]
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

console.log('antigravity claude lane:')

await test('a SAFETY finish with no output is a refusal', async () => {
  finish = 'SAFETY'
  parts = []
  assert.equal(stopReason(await run('claude-opus-5-5-high')), 'refusal')
})

await test('a SAFETY finish on Gemini is left as it was', async () => {
  finish = 'SAFETY'
  parts = []
  assert.equal(stopReason(await run('gemini-3.8-flash-high')), 'end_turn')
})

await test('a normal Claude reply schedules a one-token refresh of the same prompt', async () => {
  assert.equal(stopReason(await run('claude-sonnet-5-5-low')), 'end_turn')
  assert.equal(cancels, 1, 'the turn must replace any earlier refresher')
  assert.ok(scheduled, 'no refresh scheduled')
  const turn = requests[0]!
  await scheduled!(new AbortController().signal)
  const ping = requests[1]!
  assert.equal(ping.generationConfig.maxOutputTokens, 1)
  assert.deepEqual(ping.contents, turn.contents, 'refresh must re-read the same prompt')
  assert.deepEqual(ping.systemInstruction, turn.systemInstruction)
  assert.equal(ping.model, turn.model)
})

await test('agents and Gemini do not schedule refreshes', async () => {
  await run('claude-sonnet-5-5-low', 'agent:custom')
  assert.equal(scheduled, undefined, 'agent request scheduled a refresh')
  await run('gemini-3.8-flash-high')
  assert.equal(scheduled, undefined, 'Gemini request scheduled a refresh')
  assert.equal(cancels, 1, 'a main-thread turn on any model cancels the refresher')
})

console.log(`\n${passed} passed, 0 failed`)
