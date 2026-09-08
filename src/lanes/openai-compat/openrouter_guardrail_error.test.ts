/**
 * Run: bun run src/lanes/openai-compat/openrouter_guardrail_error.test.ts
 *
 * When an OpenRouter account's guardrail / data-policy settings filter out
 * every endpoint for a model, OpenRouter answers 404 with a machine-readable
 * reason list. Raw, that reaches the user as escaped JSON truncated before the
 * settings URL — the one piece of information that resolves it. These tests
 * pin the readable rendering, and pin that it stays scoped to that shape.
 */

process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'

import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { OpenAICompatLane } from './loop.js'

const MODEL = 'meta/muse-spark-1.3-contributor'

/** The exact 404 body OpenRouter returns for a training-policy mismatch. */
const GUARDRAIL_404 = JSON.stringify({
  error: {
    message: '0 endpoints out of 1 requested are available matching your guardrail'
      + ' restrictions and data policy. We removed them for the following reasons'
      + ' (an endpoint may have matched multiple reasons):\nPaid model training'
      + ' violation (account settings): 1 endpoint excluded; configurable at'
      + ' https://openrouter.ai/settings/privacy',
    code: 404,
    metadata: {
      input_endpoint_count: 1,
      ineligibility_reasons: [{
        reason: 'paid-model-training-violation-by-account',
        endpoint_count: 1,
        configure_url: 'https://openrouter.ai/settings/privacy',
      }],
    },
  },
})

/** A 404 that is NOT the guardrail shape — a model id that no longer exists. */
const PLAIN_404 = JSON.stringify({
  error: { message: 'No endpoints found for meta/muse-spark-9.9.', code: 404 },
})

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

/** Run one turn against a stubbed 404 and return the text the user sees. */
async function errorText(body: string, status = 404): Promise<string> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('openrouter', 'sk-test', 'https://openrouter.ai/api/v1')
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } })
  ) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are a coding agent.',
      tools: [],
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'openrouter',
    })
    for await (const ev of stream) events.push(ev)
    return events
      .filter((e: any) => e.type === 'content_block_delta')
      .map((e: any) => e.delta?.text ?? '')
      .join('')
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('openrouter')
  }
}

console.log('openrouter guardrail 404:')

await test('names the model, the reason and the settings page', async () => {
  const text = await errorText(GUARDRAIL_404)
  assert(text.includes(MODEL), `the model must be named:\n${text}`)
  assert(
    text.includes('paid-model-training-violation-by-account'),
    `the reason slug must survive:\n${text}`,
  )
  assert(
    text.includes('https://openrouter.ai/settings/privacy'),
    `the settings URL is the whole point:\n${text}`,
  )
  assert(text.includes('(1 endpoint)'), `the endpoint count must render:\n${text}`)
})

await test('says plainly that retrying cannot help', async () => {
  const text = await errorText(GUARDRAIL_404)
  assert(
    /account policy, not a request problem/i.test(text),
    `the user must not be left retrying:\n${text}`,
  )
  assert(/\/models/.test(text), `the way out must be named:\n${text}`)
})

await test('does not dump escaped JSON at the user', async () => {
  const text = await errorText(GUARDRAIL_404)
  assert(!text.includes('ineligibility_reasons'), `raw payload leaked:\n${text}`)
  // A literal backslash-n, i.e. the payload's escaped newlines reaching the
  // terminal verbatim — not the real line breaks this message is built from.
  assert(!/\\n/.test(text), `escaped newlines leaked:\n${text}`)
  assert(!text.includes('{"error"'), `raw JSON envelope leaked:\n${text}`)
})

await test('leaves an ordinary 404 alone', async () => {
  const text = await errorText(PLAIN_404)
  assert(
    !/account policy/i.test(text),
    `a plain 404 must not be described as a policy problem:\n${text}`,
  )
  assert(text.includes('openrouter API error 404'), `generic path still reports:\n${text}`)
})

await test('leaves other statuses alone', async () => {
  const text = await errorText(GUARDRAIL_404, 402)
  assert(
    !/account policy/i.test(text),
    `only the 404 refusal carries this shape:\n${text}`,
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
