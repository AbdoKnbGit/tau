/**
 * Antigravity refuses two exact sentences of the system prompt with a fake
 * quota 429 (antigravity_system_text.ts). Its requests carry the rewordings;
 * every other Gemini request keeps the original text.
 *
 * Run: bun run src/lanes/gemini/antigravity_system_text.test.ts
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const sandbox = realpathSync(mkdtempSync(join(realpathSync(os.tmpdir()), 'tau-agy-systext-')))
mock.module('os', () => ({ ...os, homedir: () => sandbox, tmpdir: () => sandbox }))

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
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1 },
        candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
      }
    },
  },
}))
mock.module('./antigravity_claude_keepalive.js', () => ({
  cancelAntigravityClaudeKeepAlive: () => {},
  scheduleAntigravityClaudeKeepAlive: () => {},
}))

const { CYBER_RISK_INSTRUCTION } = await import('../../constants/cyberRiskInstruction.js')
const { ANTIGRAVITY_REFUSED_SYSTEM_SENTENCES: PAIRS, antigravityAcceptedSystemText } =
  await import('./antigravity_system_text.js')
const { GeminiLane } = await import('./loop.js')

const IDENTITY = 'You are Tau, a multi-provider AI coding CLI.'
const INTRO = 'You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.'
const SYSTEM = `${IDENTITY}\n\n${INTRO}\n\n${CYBER_RISK_INSTRUCTION}\nNever invent or guess URLs.`
const STYLED = SYSTEM.replace('with software engineering tasks.', 'according to your "Output Style" below, which describes how you should respond to user queries.')

async function systemInstructionFor(model: string, providerHint: string, system = SYSTEM): Promise<string> {
  requests.length = 0
  for await (const _ of new GeminiLane().streamAsProvider({
    model,
    providerHint,
    sessionId: 'agy-systext-session',
    querySource: 'repl_main_thread',
    signal: new AbortController().signal,
    system,
    messages: [{ role: 'user', content: 'hey' }],
    tools: [],
    max_tokens: 32_000,
    thinking: { type: 'disabled' },
  } as any)) { /* drain */ }
  assert.equal(requests.length, 1, 'expected one request')
  return requests[0]!.systemInstruction.parts.map((p: { text: string }) => p.text).join('')
}

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

console.log('antigravity system text:')

await test("Tau's prompt texts hold each refused sentence once", () => {
  assert.equal(INTRO.split(PAIRS[0]![0]).length - 1, 1)
  assert.equal(CYBER_RISK_INSTRUCTION.split(PAIRS[1]![0]).length - 1, 1)
})

await test('the swap changes those sentences and nothing else', () => {
  const out = antigravityAcceptedSystemText(SYSTEM)
  let expected = SYSTEM
  for (const [refused, accepted] of PAIRS) {
    assert.ok(!out.includes(refused), `still holds: ${refused}`)
    assert.ok(out.includes(accepted), `missing: ${accepted}`)
    expected = expected.replace(refused, accepted)
  }
  assert.equal(out, expected)
  assert.ok(out.startsWith(`${IDENTITY}\n\n`), 'identity line must stay as it is')
})

await test('text without the sentences comes back as it was', () => {
  assert.equal(antigravityAcceptedSystemText(IDENTITY), IDENTITY)
  assert.equal(
    antigravityAcceptedSystemText(STYLED),
    STYLED.replace(PAIRS[1]![0], PAIRS[1]![1]),
    'the output-style intro is accepted as it is',
  )
})

for (const model of ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-5-5-high']) {
  await test(`Antigravity ${model} sends the rewordings, the same on every turn`, async () => {
    const first = await systemInstructionFor(model, 'antigravity')
    for (const [refused, accepted] of PAIRS) {
      assert.ok(!first.includes(refused), `refused sentence reached Antigravity: ${refused}`)
      assert.ok(first.includes(accepted), `rewording missing: ${accepted}`)
    }
    assert.ok(first.includes(IDENTITY), 'identity line must stay')
    assert.equal(await systemInstructionFor(model, 'antigravity'), first, 'system text must be stable across turns')
  })
}

await test('plain Gemini keeps the original sentences', async () => {
  const text = await systemInstructionFor('gemini-2.5-pro', 'gemini')
  for (const [refused, accepted] of PAIRS) {
    assert.ok(text.includes(refused), `non-Antigravity request lost: ${refused}`)
    assert.ok(!text.includes(accepted))
  }
})

console.log(`\n${passed} passed, 0 failed`)
