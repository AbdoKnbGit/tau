/**
 * Run: bun run src/lanes/openai-compat/openrouter_boundary.test.ts
 *
 * End-to-end proof that when the system prompt carries
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY (emitted for OpenRouter — see
 * shouldEmitSystemPromptBoundary), the lane keeps volatile context OUT of the
 * cached system prefix AND keeps the whole request prefix byte-stable across
 * turns: the system message holds only the stable part, the volatile part is
 * pinned as a session-frozen leading user message, the literal marker never
 * reaches the wire, and every turn's message list is a pure prefix extension
 * of the previous turn's — the property implicit prefix caches (DeepSeek
 * automatic, Gemini implicit, Anthropic breakpoints) actually hit on.
 */

import type {
  AnthropicStreamEvent,
  ProviderMessage,
} from '../../services/api/providers/base_provider.js'
import { _resetSessionVolatileFreezeForTest } from '../shared/volatile_freeze.js'
import { OpenAICompatLane } from './loop.js'

const MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
const STABLE = 'You are a coding agent. Follow the rules.'
const VOLATILE = 'gitStatus: branch master, 3 files changed\nToday is 2026-07-01'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function captureBody(
  system: string,
  messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }],
  sessionId?: string,
): Promise<Record<string, any>> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('openrouter', 'sk-test', 'https://openrouter.ai/api/v1')

  const oldFetch = globalThis.fetch
  let body: Record<string, any> | null = null
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
    const sse = [
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: 'anthropic/claude-3.5-sonnet',
      messages,
      system,
      tools: [],
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'openrouter',
      sessionId,
    })
    for await (const ev of stream) events.push(ev)
    assert(body !== null, 'request body was not captured')
    return body!
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('openrouter')
  }
}

function messageText(m: any): string {
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) {
    return m.content.map((p: any) => p?.text ?? '').join('')
  }
  return ''
}

/**
 * What an implicit-cache upstream sees per message: role + text, with
 * cache_control markers and string-vs-array shape normalized away (gateways
 * re-serialize both identically before the upstream tokenizes).
 */
function normalizedConversation(body: Record<string, any>): string[] {
  return (body.messages as any[]).map(m => `${m.role}|${messageText(m)}`)
}

console.log('openrouter system boundary split:')

await test('the marker never reaches the wire', async () => {
  _resetSessionVolatileFreezeForTest()
  const body = await captureBody(`${STABLE}\n${MARKER}\n${VOLATILE}`)
  assert(
    !JSON.stringify(body).includes(MARKER),
    'literal boundary marker leaked into the request',
  )
})

await test('system message holds only the stable prefix', async () => {
  _resetSessionVolatileFreezeForTest()
  const body = await captureBody(`${STABLE}\n${MARKER}\n${VOLATILE}`)
  const sys = body.messages.find((m: any) => m.role === 'system')
  assert(sys, 'no system message')
  const text = messageText(sys)
  assert(text.includes(STABLE), `system missing stable text: ${text}`)
  assert(!text.includes('gitStatus'), `volatile leaked into system: ${text}`)
})

await test('volatile context is pinned as the leading user message', async () => {
  _resetSessionVolatileFreezeForTest()
  const body = await captureBody(
    `${STABLE}\n${MARKER}\n${VOLATILE}`,
    [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
    'sess-leading',
  )
  const msgs = body.messages as any[]
  assert(msgs[0]?.role === 'system', 'first message must be the system prompt')
  assert(
    msgs[1]?.role === 'user' && messageText(msgs[1]).includes('gitStatus'),
    `volatile must sit at index 1 (fixed position), got roles: ${msgs
      .map((m: any) => m.role)
      .join(',')}`,
  )
  // …and nowhere later: a moving copy is exactly the old cache-breaking bug.
  const later = msgs
    .slice(2)
    .filter((m: any) => messageText(m).includes('gitStatus'))
  assert(later.length === 0, 'volatile context duplicated later in history')
})

await test('volatile bytes freeze to the first turn for the session', async () => {
  _resetSessionVolatileFreezeForTest()
  const sessionId = 'sess-freeze'
  const turn1 = await captureBody(
    `${STABLE}\n${MARKER}\ngitStatus: ORIGINAL`,
    [{ role: 'user', content: 'q1' }],
    sessionId,
  )
  const turn2 = await captureBody(
    `${STABLE}\n${MARKER}\ngitStatus: CHANGED`,
    [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
    sessionId,
  )
  assert(
    JSON.stringify(turn1).includes('ORIGINAL'),
    'turn 1 must carry its own volatile text',
  )
  const wire2 = JSON.stringify(turn2)
  assert(wire2.includes('ORIGINAL'), 'turn 2 must replay the frozen turn-1 bytes')
  assert(
    !wire2.includes('CHANGED'),
    'fresh volatile text must not rewrite the frozen block',
  )
})

await test('every turn is a pure prefix extension of the previous one', async () => {
  _resetSessionVolatileFreezeForTest()
  const sessionId = 'sess-prefix-extension'
  const u1: ProviderMessage = { role: 'user', content: 'first question' }
  const a1: ProviderMessage = { role: 'assistant', content: 'first answer' }
  const u2: ProviderMessage = { role: 'user', content: 'second question' }
  const a2: ProviderMessage = { role: 'assistant', content: 'second answer' }
  const u3: ProviderMessage = { role: 'user', content: 'third question' }

  // The app-side volatile tail churns every turn (fresh git status); the
  // frozen leading block must absorb it so the request prefix never rewrites.
  const turn1 = await captureBody(`${STABLE}\n${MARKER}\ngitStatus: t1`, [u1], sessionId)
  const turn2 = await captureBody(
    `${STABLE}\n${MARKER}\ngitStatus: t2`,
    [u1, a1, u2],
    sessionId,
  )
  const turn3 = await captureBody(
    `${STABLE}\n${MARKER}\ngitStatus: t3`,
    [u1, a1, u2, a2, u3],
    sessionId,
  )

  const c1 = normalizedConversation(turn1)
  const c2 = normalizedConversation(turn2)
  const c3 = normalizedConversation(turn3)
  assert(
    JSON.stringify(c2.slice(0, c1.length)) === JSON.stringify(c1),
    `turn 1 is not a prefix of turn 2:\n${c1.join('\n')}\n---\n${c2.join('\n')}`,
  )
  assert(
    JSON.stringify(c3.slice(0, c2.length)) === JSON.stringify(c2),
    `turn 2 is not a prefix of turn 3:\n${c2.join('\n')}\n---\n${c3.join('\n')}`,
  )
  assert(
    c2.length > c1.length && c3.length > c2.length,
    'later turns must extend the conversation, not replace it',
  )
})

await test('every request extends the previous one byte for byte, encoding included', async () => {
  _resetSessionVolatileFreezeForTest()
  const sessionId = 'sess-encoding'
  const system = `${STABLE}\n${MARKER}\n${VOLATILE}`
  const call = (id: string): ProviderMessage => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }],
  })
  const result = (id: string): ProviderMessage => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: `output of ${id}` }],
  })
  const history: ProviderMessage[] = [{ role: 'user', content: 'run three commands' }]
  const requests = [await captureBody(system, [...history], sessionId)]
  for (const id of ['call_1', 'call_2', 'call_3']) {
    history.push(call(id), result(id))
    requests.push(await captureBody(system, [...history], sessionId))
  }
  // Three results answered at once, plus text riding in the same message:
  // the first result is never among the last two marked messages.
  history.push(
    {
      role: 'assistant',
      content: ['call_4', 'call_5', 'call_6'].map(id => (
        { type: 'tool_use' as const, id, name: 'Bash', input: { command: `echo ${id}` } })),
    },
    {
      role: 'user',
      content: [
        ...['call_4', 'call_5', 'call_6'].map(id => (
          { type: 'tool_result' as const, tool_use_id: id, content: `output of ${id}` })),
        { type: 'text', text: 'a reminder next to the results' },
      ],
    },
  )
  requests.push(await captureBody(system, [...history], sessionId))
  history.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'thanks' })
  requests.push(await captureBody(system, [...history], sessionId))

  // Cache markers move every request by design; everything else is sent.
  const wire = (body: Record<string, any>): string[] => (body.messages as any[]).map(m =>
    JSON.stringify(m, (key, value) => key === 'cache_control' ? undefined : value))
  for (let i = 1; i < requests.length; i++) {
    const before = wire(requests[i - 1]!)
    const after = wire(requests[i]!)
    assert(after.length > before.length, `request ${i} did not extend request ${i - 1}`)
    const k = before.findIndex((m, j) => m !== after[j])
    assert(k === -1, `request ${i} re-sent message ${k} differently:\n${before[k]}\n---\n${after[k]}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
