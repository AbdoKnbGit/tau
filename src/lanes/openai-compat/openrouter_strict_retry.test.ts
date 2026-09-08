/**
 * Run: bun run src/lanes/openai-compat/openrouter_strict_retry.test.ts
 *
 * End-to-end proof for the strict-tool-schema self-heal on OpenRouter, and
 * for what it costs the upstream prompt cache.
 *
 * Some upstreams behind OpenRouter run OpenAI's strict function-schema
 * validator and answer 400 with "'required' is required to be supplied and to
 * be an array including every key in properties" — meta/muse-spark-1.3-*
 * being the row that surfaced it. The lane learns that from the error, rebuilds
 * the tool schemas in strict form and retries once.
 *
 * Tools sit at the head of the cached prefix, so rebuilding them mid-session is
 * a cache reset. These tests pin the two properties that keep that bounded:
 *   - the retry happens ONCE and then the row is remembered, so a later request
 *     is strict from its first byte;
 *   - the tool-prefix cache breakpoint survives the rebuild, and the
 *     conversation prefix is a pure extension across turns afterwards.
 */

process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'
process.env.TAU_OPENROUTER_STRICT_TOOLS_STORE =
  `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/tau-or-strict-retry-test.json`

import type {
  AnthropicStreamEvent,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { _resetSessionVolatileFreezeForTest } from '../shared/volatile_freeze.js'
import { _resetOpenRouterStrictToolSchemaForTests } from '../../utils/model/openrouterStrictSchema.js'
import { OpenAICompatLane } from './loop.js'

const MODEL = 'meta/muse-spark-1.3-contributor'

/** The 400 Muse Spark answers, in the envelope OpenRouter wraps it in. */
const STRICT_400 = JSON.stringify({
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: {
      raw: JSON.stringify({
        error: {
          code: null,
          message: "'required' is required to be supplied and to be an array"
            + " including every key in properties. Missing 'isolation'.",
          param: 'parameters',
          type: 'invalid_request_error',
        },
      }),
      provider_name: 'Meta',
    },
  },
})

/** An Agent-shaped tool: two required parameters, three optional ones. */
const AGENT_TOOL: ProviderTool = {
  name: 'Agent',
  description: 'Launch a subagent.',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      prompt: { type: 'string' },
      isolation: { type: 'string', enum: ['worktree', 'remote'] },
      model: { type: 'string' },
      subagent_type: { type: 'string' },
    },
    required: ['description', 'prompt'],
    additionalProperties: false,
  },
}

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

const SSE = [
  { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
  {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  },
].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

/**
 * Drive one turn through the lane, capturing every request body it sends.
 * `failFirstN` requests answer the strict-schema 400 before the stub succeeds.
 */
async function captureBodies(
  messages: ProviderMessage[],
  { failFirstN = 0, sessionId = 'sess-strict' } = {},
): Promise<Array<Record<string, any>>> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('openrouter', 'sk-test', 'https://openrouter.ai/api/v1')

  const oldFetch = globalThis.fetch
  const bodies: Array<Record<string, any>> = []
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    if (bodies.length <= failFirstN) {
      return new Response(STRICT_400, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: MODEL,
      messages,
      system: 'You are a coding agent.',
      tools: [AGENT_TOOL],
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'openrouter',
      sessionId,
    })
    for await (const ev of stream) events.push(ev)
    return bodies
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('openrouter')
  }
}

function agentParams(body: Record<string, any>): any {
  return body.tools?.find((t: any) => t.function?.name === 'Agent')?.function?.parameters
}

function messageText(m: any): string {
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) return m.content.map((p: any) => p?.text ?? '').join('')
  return ''
}

/** Role + text per message, with cache markers and shape normalized away. */
function normalizedConversation(body: Record<string, any>): string[] {
  return (body.messages as any[]).map(m => `${m.role}|${messageText(m)}`)
}

console.log('openrouter strict tool-schema self-heal:')

await test('the first request is sent as-is, with optional parameters optional', async () => {
  _resetSessionVolatileFreezeForTest()
  _resetOpenRouterStrictToolSchemaForTests()
  const bodies = await captureBodies([{ role: 'user', content: 'hi' }])
  assert(bodies.length === 1, `expected one request, got ${bodies.length}`)
  assert(
    JSON.stringify(agentParams(bodies[0]!).required) === JSON.stringify(['description', 'prompt']),
    'an unlearned row must not pay the strict-schema tax up front',
  )
})

await test('a strict-schema 400 is retried once, strictly', async () => {
  _resetSessionVolatileFreezeForTest()
  _resetOpenRouterStrictToolSchemaForTests()
  const bodies = await captureBodies([{ role: 'user', content: 'hi' }], { failFirstN: 1 })
  assert(bodies.length === 2, `expected one retry, got ${bodies.length} requests`)

  const retried = agentParams(bodies[1]!)
  assert(
    JSON.stringify(retried.required)
      === JSON.stringify(['description', 'prompt', 'isolation', 'model', 'subagent_type']),
    `retry must require every property, got ${JSON.stringify(retried.required)}`,
  )
  assert(retried.additionalProperties === false, 'retry must close the object')
})

await test('the retry keeps the tool-prefix cache breakpoint', async () => {
  _resetSessionVolatileFreezeForTest()
  _resetOpenRouterStrictToolSchemaForTests()
  const bodies = await captureBodies([{ role: 'user', content: 'hi' }], { failFirstN: 1 })
  const first = bodies[0]!.tools
  const retry = bodies[1]!.tools
  assert(
    first[first.length - 1]?.cache_control?.type === 'ephemeral',
    'baseline: the last tool carries the breakpoint',
  )
  assert(
    retry[retry.length - 1]?.cache_control?.type === 'ephemeral',
    'rebuilding the tools must not drop the breakpoint',
  )
})

await test('the retry does not disturb the conversation prefix', async () => {
  _resetSessionVolatileFreezeForTest()
  _resetOpenRouterStrictToolSchemaForTests()
  const bodies = await captureBodies([{ role: 'user', content: 'hi' }], { failFirstN: 1 })
  assert(
    JSON.stringify(normalizedConversation(bodies[0]!))
      === JSON.stringify(normalizedConversation(bodies[1]!)),
    'only the tool schemas may change on the retry',
  )
})

await test('once learned, a later request is strict from its first byte', async () => {
  _resetSessionVolatileFreezeForTest()
  _resetOpenRouterStrictToolSchemaForTests()
  await captureBodies([{ role: 'user', content: 'hi' }], { failFirstN: 1 })

  const later = await captureBodies([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'again' },
  ])
  assert(later.length === 1, 'a learned row must not fail a second time')
  assert(
    JSON.stringify(agentParams(later[0]!).required)
      === JSON.stringify(['description', 'prompt', 'isolation', 'model', 'subagent_type']),
    'the learned verdict must survive into the next request',
  )
})

await test('after learning, every turn is a pure prefix extension', async () => {
  _resetSessionVolatileFreezeForTest()
  _resetOpenRouterStrictToolSchemaForTests()
  await captureBodies([{ role: 'user', content: 'hi' }], { failFirstN: 1 })

  const turn1 = await captureBodies([{ role: 'user', content: 'q1' }])
  const turn2 = await captureBodies([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ])

  // Tool schemas — the head of the cached prefix — must be byte-identical.
  assert(
    JSON.stringify(turn1[0]!.tools) === JSON.stringify(turn2[0]!.tools),
    'tool schemas drifted between turns; every turn would be a cold start',
  )

  const before = normalizedConversation(turn1[0]!)
  const after = normalizedConversation(turn2[0]!)
  assert(after.length > before.length, 'turn 2 should be longer than turn 1')
  for (let i = 0; i < before.length; i++) {
    assert(
      after[i] === before[i],
      `message ${i} changed between turns:\n  ${before[i]}\n  ${after[i]}`,
    )
  }
})

await test('reasoning rides outside the cached prefix', async () => {
  _resetSessionVolatileFreezeForTest()
  _resetOpenRouterStrictToolSchemaForTests()
  const bodies = await captureBodies([{ role: 'user', content: 'hi' }])
  const body = bodies[0]!
  const serialized = JSON.stringify({ messages: body.messages, tools: body.tools })
  assert(
    !serialized.includes('"reasoning"'),
    'the reasoning knob must stay a top-level parameter, never prompt content',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
