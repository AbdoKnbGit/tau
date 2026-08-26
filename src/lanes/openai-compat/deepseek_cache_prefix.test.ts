/**
 * Run: bun run src/lanes/openai-compat/deepseek_cache_prefix.test.ts
 *
 * DeepSeek's context caching is automatic and prefix-exact: a request is billed
 * at the cache-hit rate only for the leading tokens that are byte-identical to
 * a request the upstream has already seen. Every byte from the first difference
 * onward is re-billed as a miss, so ONE churning byte near the head of the
 * prompt costs the whole conversation.
 *
 * This pins the two properties that keep the head stable:
 *   1. The volatile system tail (git status, env, memory, MCP instructions)
 *      never sits in the system message — it is split off at
 *      SYSTEM_PROMPT_DYNAMIC_BOUNDARY, frozen to its first value for the
 *      session, and pinned at a fixed leading position, so a mid-session MCP
 *      connect or a fresh git status cannot rewrite an already-cached prefix.
 *   2. Each turn's message list is a pure prefix extension of the previous
 *      turn's — the exact property the upstream cache hits on.
 *
 * Shape matters too: DeepSeek's chat-completions route takes plain strings for
 * text-only user turns, so the pinned block must not be an array of parts.
 */

import type {
  AnthropicStreamEvent,
  ProviderMessage,
} from '../../services/api/providers/base_provider.js'
import { _resetSessionVolatileFreezeForTest } from '../shared/volatile_freeze.js'
import { OpenAICompatLane } from './loop.js'

const MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
const STABLE = 'You are a coding agent. Follow the rules.'
const VOLATILE = 'gitStatus: branch master, 3 files changed\nToday is 2026-08-24'

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
  lane.registerProvider('deepseek', 'sk-test', 'https://api.deepseek.com/v1')

  const oldFetch = globalThis.fetch
  let body: Record<string, any> | null = null
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
    const sse =
      [
        { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_cache_hit_tokens: 0,
          },
        },
      ]
        .map(c => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: 'deepseek-v4-flash',
      messages,
      system,
      tools: [],
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'deepseek',
      sessionId,
    })
    for await (const ev of stream) events.push(ev)
    assert(body !== null, 'request body was not captured')
    return body!
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('deepseek')
  }
}

function messageText(m: any): string {
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) return m.content.map((p: any) => p?.text ?? '').join('')
  return ''
}

function normalizedConversation(body: Record<string, any>): string[] {
  return (body.messages as any[]).map(m => `${m.role}|${messageText(m)}`)
}

console.log('deepseek cache prefix:')

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

await test('volatile context is pinned at a fixed leading position', async () => {
  _resetSessionVolatileFreezeForTest()
  const body = await captureBody(
    `${STABLE}\n${MARKER}\n${VOLATILE}`,
    [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
    'ds-leading',
  )
  const msgs = body.messages as any[]
  assert(msgs[0]?.role === 'system', 'first message must be the system prompt')
  assert(
    msgs[1]?.role === 'user' && messageText(msgs[1]).includes('gitStatus'),
    `volatile must sit at index 1, got roles: ${msgs.map((m: any) => m.role).join(',')}`,
  )
  const later = msgs.slice(2).filter((m: any) => messageText(m).includes('gitStatus'))
  assert(later.length === 0, 'volatile context duplicated later in history')
})

await test('the pinned block uses string content (DeepSeek text turn shape)', async () => {
  _resetSessionVolatileFreezeForTest()
  const body = await captureBody(`${STABLE}\n${MARKER}\n${VOLATILE}`, undefined, 'ds-shape')
  const pinned = (body.messages as any[])[1]
  assert(
    typeof pinned?.content === 'string',
    `pinned block must be a string, got ${typeof pinned?.content}`,
  )
})

await test('volatile bytes freeze to the first turn for the session', async () => {
  _resetSessionVolatileFreezeForTest()
  const sessionId = 'ds-freeze'
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
  assert(JSON.stringify(turn1).includes('ORIGINAL'), 'turn 1 must carry its volatile text')
  const wire2 = JSON.stringify(turn2)
  assert(wire2.includes('ORIGINAL'), 'turn 2 must replay the frozen turn-1 bytes')
  assert(!wire2.includes('CHANGED'), 'fresh volatile text must not rewrite the frozen block')
})

await test('every turn is a pure prefix extension of the previous one', async () => {
  _resetSessionVolatileFreezeForTest()
  const sessionId = 'ds-prefix-extension'
  const u1: ProviderMessage = { role: 'user', content: 'first question' }
  const a1: ProviderMessage = { role: 'assistant', content: 'first answer' }
  const u2: ProviderMessage = { role: 'user', content: 'second question' }
  const a2: ProviderMessage = { role: 'assistant', content: 'second answer' }
  const u3: ProviderMessage = { role: 'user', content: 'third question' }

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

await test('a multi-step tool turn extends the prefix too', async () => {
  _resetSessionVolatileFreezeForTest()
  const sessionId = 'ds-tool-steps'
  const u1: ProviderMessage = { role: 'user', content: 'run the thing' }
  const a1: ProviderMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'I should run it.' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'echo hi' } },
    ],
  }
  const r1: ProviderMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hi' }],
  }

  const step1 = await captureBody(`${STABLE}\n${MARKER}\ngitStatus: s1`, [u1], sessionId)
  const step2 = await captureBody(
    `${STABLE}\n${MARKER}\ngitStatus: s2`,
    [u1, a1, r1],
    sessionId,
  )

  const c1 = normalizedConversation(step1)
  const c2 = normalizedConversation(step2)
  assert(
    JSON.stringify(c2.slice(0, c1.length)) === JSON.stringify(c1),
    `tool step 1 is not a prefix of step 2:\n${c1.join('\n')}\n---\n${c2.join('\n')}`,
  )
})

await test('a non-splitting compat provider never sees the literal marker', async () => {
  _resetSessionVolatileFreezeForTest()
  const lane = new OpenAICompatLane()
  lane.registerProvider('groq', 'gsk-test', 'https://api.groq.com/openai/v1')
  const oldFetch = globalThis.fetch
  let body: Record<string, any> | null = null
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
    const sse =
      [
        { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]
        .map(c => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch
  try {
    const stream = lane.streamAsProvider({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
      system: `${STABLE}\n${MARKER}\n${VOLATILE}`,
      tools: [],
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'groq',
    })
    for await (const _ of stream) void _
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('groq')
  }
  assert(body !== null, 'request body was not captured')
  const wire = JSON.stringify(body)
  assert(!wire.includes(MARKER), 'literal boundary marker leaked to a non-splitting provider')
  assert(wire.includes('gitStatus'), 'non-splitting providers must keep the full system prompt')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
