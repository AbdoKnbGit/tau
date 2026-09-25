/**
 * Run: bun run src/lanes/openai-compat/openrouter_gemini_cache.test.ts
 *
 * Focused regression tests for Gemini models routed through OpenRouter.
 * Scope is intentionally narrow: google/gemini-* model ids on the
 * openai-compat OpenRouter provider, not native Gemini / Antigravity.
 *
 * Cache strategy under test (live-measured, see or_gemini_cache.ts):
 * exactly ONE message breakpoint, anchored on the session-frozen volatile
 * context message and advanced only in quanta — never a stamp that moves
 * every turn, never a stamp on the fresh tail (except the bare first turn
 * of a volatile-less session, where the tail is next turn's anchor).
 */

import type {
  AnthropicStreamEvent,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { _resetSessionVolatileFreezeForTest } from '../shared/volatile_freeze.js'
import { OpenAICompatLane } from './loop.js'
import {
  applyGeminiOpenRouterCacheAnchor,
  pickGeminiOpenRouterAnchorIndex,
} from './or_gemini_cache.js'

const MODEL = 'google/gemini-3-flash-preview'
const MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
const STABLE = 'You are Tau. Keep the stable system prefix cacheable.'
const SYSTEM_WITH_VOLATILE = `${STABLE}\n${MARKER}\ngitStatus: dirty\nToday is 2026-07-02`

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

async function captureGeminiOpenRouter({
  system = STABLE,
  messages = [{ role: 'user', content: 'hi' }] as ProviderMessage[],
  tools = [] as ProviderTool[],
  sessionId = 'sess-gemini-or',
  usage = {
    prompt_tokens: 120,
    completion_tokens: 8,
    total_tokens: 128,
    prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 20 },
  },
}: {
  system?: string
  messages?: ProviderMessage[]
  tools?: ProviderTool[]
  sessionId?: string
  usage?: Record<string, unknown>
} = {}): Promise<{ body: Record<string, any>; events: AnthropicStreamEvent[] }> {
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
        usage,
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
      model: MODEL,
      messages,
      system,
      tools,
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'openrouter',
      sessionId,
    })
    for await (const ev of stream) events.push(ev)
    assert(body !== null, 'request body was not captured')
    return { body: body!, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('openrouter')
  }
}

function textOf(message: any): string {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content.map((part: any) => part?.text ?? '').join('')
  }
  return ''
}

function cacheStampedMessages(body: Record<string, any>): any[] {
  return (body.messages as any[]).filter(message =>
    JSON.stringify(message).includes('"cache_control"'),
  )
}

const EXAMPLE_TOOL: ProviderTool = {
  name: 'ExampleTool',
  description: 'Example tool',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
}

console.log('openrouter gemini cache:')

await test('routes google/gemini through OpenRouter with stable cache affinity fields', async () => {
  _resetSessionVolatileFreezeForTest()
  const { body } = await captureGeminiOpenRouter()

  assert(body.model === MODEL, `model=${body.model}`)
  assert(body.session_id === 'sess-gemini-or', `session_id=${body.session_id}`)
  assert(body.prompt_cache_key === 'sess-gemini-or', `prompt_cache_key=${body.prompt_cache_key}`)
  assert(body.usage?.include === true, `usage=${JSON.stringify(body.usage)}`)
})

await test('keeps volatile system context out of the system cache block for Gemini', async () => {
  _resetSessionVolatileFreezeForTest()
  const { body } = await captureGeminiOpenRouter({ system: SYSTEM_WITH_VOLATILE })

  const messages = body.messages as any[]
  const system = messages.find(message => message.role === 'system')
  assert(system, 'missing system message')
  assert(textOf(system).includes(STABLE), `system missing stable prefix: ${textOf(system)}`)
  assert(!textOf(system).includes('gitStatus'), `volatile leaked into system: ${textOf(system)}`)
  assert(
    messages[1]?.role === 'user' && textOf(messages[1]).includes('gitStatus'),
    `volatile context should be pinned after system: ${messages.map(m => m.role).join(',')}`,
  )
  assert(
    !JSON.stringify(body).includes(MARKER),
    'literal boundary marker leaked into the request',
  )
})

await test('anchors the single Gemini breakpoint on the frozen volatile message, plus the tool stamp', async () => {
  _resetSessionVolatileFreezeForTest()
  const { body } = await captureGeminiOpenRouter({
    system: SYSTEM_WITH_VOLATILE,
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ],
    tools: [EXAMPLE_TOOL],
  })

  const stamped = cacheStampedMessages(body)
  assert(stamped.length === 1, `expected exactly one message breakpoint, got ${stamped.length}`)
  assert(textOf(stamped[0]).includes('dynamic_context'),
    `anchor should sit on the volatile context message: ${JSON.stringify(stamped[0])}`)
  assert(
    !(body.messages as any[]).some(message =>
      textOf(message).includes('second question') &&
        JSON.stringify(message).includes('"cache_control"'),
    ),
    `current user tail must not be cache-stamped: ${JSON.stringify(body.messages)}`,
  )
  assert(
    body.tools?.[0]?.cache_control?.type === 'ephemeral',
    `Gemini OpenRouter keeps the last-tool stamp (anchor trigger recipe): ${JSON.stringify(body.tools)}`,
  )
})

await test('keeps the anchor byte-identical across turns below the quantum', async () => {
  _resetSessionVolatileFreezeForTest()
  const sessionId = 'sess-gemini-stable-anchor'
  const turn1 = await captureGeminiOpenRouter({
    sessionId,
    system: SYSTEM_WITH_VOLATILE,
    messages: [{ role: 'user', content: 'first question' }],
  })
  const turn2 = await captureGeminiOpenRouter({
    sessionId,
    system: SYSTEM_WITH_VOLATILE,
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ],
  })
  const turn3 = await captureGeminiOpenRouter({
    sessionId,
    system: SYSTEM_WITH_VOLATILE,
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
      { role: 'user', content: 'third question' },
    ],
  })

  const stamps = [turn1, turn2, turn3].map(t => cacheStampedMessages(t.body))
  for (const [i, s] of stamps.entries()) {
    assert(s.length === 1, `turn${i + 1} expected one breakpoint, got ${s.length}`)
  }
  const serialized = stamps.map(s => JSON.stringify(s[0]))
  assert(serialized[0] === serialized[1] && serialized[1] === serialized[2],
    `anchor must be byte-identical across turns: ${serialized.join(' vs ')}`)
  assert(serialized[0]!.includes('dynamic_context'),
    `anchor should be the volatile message: ${serialized[0]}`)
})

await test('advances the anchor past the quantum onto a settled message, never the fresh tail', async () => {
  _resetSessionVolatileFreezeForTest()
  const bigTurn = 'x'.repeat(9_000)
  const { body } = await captureGeminiOpenRouter({
    system: SYSTEM_WITH_VOLATILE,
    messages: [
      { role: 'user', content: `${bigTurn} q1` },
      { role: 'assistant', content: `${bigTurn} a1` },
      { role: 'user', content: `${bigTurn} q2` },
      { role: 'assistant', content: `${bigTurn} a2` },
      { role: 'user', content: 'fresh question' },
    ],
  })

  const stamped = cacheStampedMessages(body)
  assert(stamped.length === 1, `expected one breakpoint, got ${stamped.length}`)
  assert(!textOf(stamped[0]).includes('dynamic_context'),
    `36k chars of settled history must advance the anchor past the volatile head: ${JSON.stringify(stamped[0]).slice(0, 200)}`)
  assert(!textOf(stamped[0]).includes('fresh question'),
    'anchor must never sit on the fresh tail')
})

await test('bare first turn without a volatile block stamps the tail that becomes the next anchor', async () => {
  _resetSessionVolatileFreezeForTest()
  const turn1 = await captureGeminiOpenRouter({
    sessionId: 'sess-gemini-bare',
    system: STABLE, // no boundary marker → no volatile message
    messages: [{ role: 'user', content: 'only question' }],
  })
  const stamped1 = cacheStampedMessages(turn1.body)
  assert(stamped1.length === 1 && textOf(stamped1[0]).includes('only question'),
    `bare turn1 should stamp the fresh tail: ${JSON.stringify(stamped1)}`)

  const turn2 = await captureGeminiOpenRouter({
    sessionId: 'sess-gemini-bare',
    system: STABLE,
    messages: [
      { role: 'user', content: 'only question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'next question' },
    ],
  })
  const stamped2 = cacheStampedMessages(turn2.body)
  assert(stamped2.length === 1 && textOf(stamped2[0]).includes('only question'),
    `turn2 anchor should be the same message turn1 cached: ${JSON.stringify(stamped2)}`)
})

await test('pickGeminiOpenRouterAnchorIndex is stable within a quantum and monotone across it', () => {
  const mk = (n: number) => ({ role: 'assistant', content: 'a'.repeat(n) })
  const sys = { role: 'system', content: 's'.repeat(500) }
  const head = { role: 'user', content: 'volatile-ish head' }
  const tail = { role: 'user', content: 'fresh' }

  // Below the quantum: anchor stays on the head candidate as history grows.
  const small1 = [sys, head, mk(3_000), tail]
  const small2 = [sys, head, mk(3_000), mk(3_000), tail]
  assert(pickGeminiOpenRouterAnchorIndex(small1 as any, 16_000) === 1, 'small1 anchor should be head')
  assert(pickGeminiOpenRouterAnchorIndex(small2 as any, 16_000) === 1, 'small2 anchor should stay head')

  // Crossing the quantum: anchor advances to a later settled message.
  const big = [sys, head, mk(9_000), mk(9_000), mk(2_000), tail]
  const pick = pickGeminiOpenRouterAnchorIndex(big as any, 16_000)
  assert(pick > 1 && pick < big.length - 1, `anchor should advance into settled history, got ${pick}`)

  // Growing the tail run does not move a settled anchor (byte stability).
  const bigger = [...big.slice(0, -1), { role: 'assistant', content: 'small' }, tail]
  assert(pickGeminiOpenRouterAnchorIndex(bigger as any, 16_000) === pick,
    'anchor must not move when growth stays within the quantum')
})

await test('applyGeminiOpenRouterCacheAnchor strips stray stamps and walks back over unstampable anchors', () => {
  const oldQuantum = process.env.TAU_OPENROUTER_GEMINI_QUANTUM
  process.env.TAU_OPENROUTER_GEMINI_QUANTUM = '4000'
  try {
    const messages: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'head' },
      // ~3.9k chars of tool_calls, no text content: the quantum target
      // (head + 4000) falls between this message (cum ≈ 3.9k) and the 300-
      // char tool result behind it (cum ≈ 4.2k), so the pick lands HERE —
      // and it cannot hold a stamp.
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{"n":"' + '9'.repeat(3_800) + '"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'r'.repeat(300), cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: 'done this step now' },
      { role: 'user', content: 'fresh' },
    ]
    applyGeminiOpenRouterCacheAnchor(messages)
    const stamped = messages.filter(m => JSON.stringify(m.content ?? '').includes('cache_control'))
    assert(stamped.length === 1, `exactly one stamp expected, got ${stamped.length}`)
    // The stray stamp on the tool result must be stripped, and the
    // tool_calls-only assistant pick must walk back to the nearest
    // stampable message instead of vanishing or hitting system.
    assert(stamped[0].role === 'user' && textOf(stamped[0]).includes('head'),
      `expected walk-back to the head user message: ${JSON.stringify(stamped[0])}`)
    assert(Array.isArray(stamped[0].content), 'stamped content promoted to parts')
  } finally {
    if (oldQuantum === undefined) delete process.env.TAU_OPENROUTER_GEMINI_QUANTUM
    else process.env.TAU_OPENROUTER_GEMINI_QUANTUM = oldQuantum
  }
})

await test('reports disjoint Gemini cache buckets without inflating context', async () => {
  _resetSessionVolatileFreezeForTest()
  const { events } = await captureGeminiOpenRouter()
  const finalDelta = events.findLast(event => event.type === 'message_delta') as
    | (AnthropicStreamEvent & { usage?: Record<string, number> })
    | undefined

  // Gemini cache writes cover the same bytes as the read (overlap), so
  // fresh input = prompt - cached, NOT prompt - cached - write.
  assert(finalDelta?.usage?.input_tokens === 30,
    `fresh input=${JSON.stringify(finalDelta?.usage)}`)
  assert(finalDelta?.usage?.cache_read_input_tokens === 70,
    `cache read=${JSON.stringify(finalDelta?.usage)}`)
  assert(finalDelta?.usage?.cache_creation_input_tokens === 20,
    `cache write=${JSON.stringify(finalDelta?.usage)}`)
  assert(finalDelta.usage.input_tokens + finalDelta.usage.cache_read_input_tokens +
    finalDelta.usage.cache_creation_input_tokens === 120, 'input buckets must equal prompt_tokens')
})

await test('advance-turn usage (write === read) still reports true fresh input', async () => {
  _resetSessionVolatileFreezeForTest()
  const { events } = await captureGeminiOpenRouter({
    usage: {
      prompt_tokens: 15_927,
      completion_tokens: 8,
      total_tokens: 15_935,
      prompt_tokens_details: { cached_tokens: 11_137, cache_write_tokens: 11_137 },
    },
  })
  const finalDelta = events.findLast(event => event.type === 'message_delta') as
    | (AnthropicStreamEvent & { usage?: Record<string, number> })
    | undefined
  assert(finalDelta?.usage?.input_tokens === 4_790,
    `advance turn fresh input must not clamp to 0: ${JSON.stringify(finalDelta?.usage)}`)
  assert(finalDelta?.usage?.cache_read_input_tokens === 0,
    `advance turn read=${JSON.stringify(finalDelta?.usage)}`)
  assert(finalDelta?.usage?.cache_creation_input_tokens === 11_137,
    `advance turn write=${JSON.stringify(finalDelta?.usage)}`)
  assert(finalDelta.usage.input_tokens + finalDelta.usage.cache_read_input_tokens +
    finalDelta.usage.cache_creation_input_tokens === 15_927, 'cache advance must not enlarge context')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
