/**
 * DeepSeek base-URL override wiring + proxy-path integrity.
 *
 * Regression guard for the gap where `DEEPSEEK_BASE_URL` was read in
 * auth.ts / configs.ts but never reached the openai-compat lane's request
 * path (initLanes dropped deepseekBaseUrl; initOpenAICompatLane hardcoded
 * the default). These tests drive the real singleton through
 * initOpenAICompatLane — exactly how the app boots — and assert the
 * captured request.
 *
 * Also guards the interaction the override newly exposes: pointing DeepSeek
 * at a loopback dev proxy must NOT degrade the request (tools kept, params
 * untouched, cache-hit usage still surfaced) — the proxy forwards to the
 * real upstream, which supports everything. Only bare/unknown local servers
 * (`generic`) keep the tool-stripping protection.
 *
 * Run: bun run src/lanes/openai-compat/deepseek_base_url.test.ts
 */

import { openaiCompatLane, initOpenAICompatLane } from './index.js'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const SAMPLE_TOOL = {
  name: 'get_weather',
  description: 'Get the weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}

type Captured = {
  url: string
  body: any
  headers: Record<string, any>
  events: AnthropicStreamEvent[]
}

/**
 * Boot the lane via initOpenAICompatLane, run one deepseek-v4-flash turn against
 * a mocked fetch, and return the captured /chat/completions request + events.
 */
async function captureDeepSeek(params: {
  opts?: Parameters<typeof initOpenAICompatLane>[0]
  tools?: any[]
  finalUsage?: Record<string, any>
} = {}): Promise<Captured> {
  initOpenAICompatLane(params.opts)

  const oldFetch = globalThis.fetch
  let captured: { url: string; body: any; headers: Record<string, any> } | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    if (u.includes('/chat/completions')) {
      captured = {
        url: u,
        headers: (init?.headers as Record<string, any>) ?? {},
        body: JSON.parse(String(init?.body ?? '{}')),
      }
    }
    const usage = params.finalUsage ?? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    const sse =
      [
        { id: 'x', object: 'chat.completion.chunk', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { id: 'x', object: 'chat.completion.chunk', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
      ]
        .map(c => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = openaiCompatLane.streamAsProvider({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'stable system prompt',
      tools: params.tools ?? [],
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'deepseek',
    })
    for await (const ev of stream) events.push(ev)
    assert(captured, 'no /chat/completions request was made')
    return { ...captured!, events }
  } finally {
    globalThis.fetch = oldFetch
    openaiCompatLane.unregisterProvider('deepseek')
  }
}

const LOCAL = 'http://127.0.0.1:8000/v1'
const KEY = 'sk-test-key-0123456789'

async function main(): Promise<void> {
  const savedKey = process.env.DEEPSEEK_API_KEY
  const savedUrl = process.env.DEEPSEEK_BASE_URL

  try {
    // ── Base-URL override wiring ──────────────────────────────────────

    await test('DEEPSEEK_BASE_URL env override reaches the request path', async () => {
      process.env.DEEPSEEK_API_KEY = KEY
      process.env.DEEPSEEK_BASE_URL = LOCAL
      const { url } = await captureDeepSeek()
      assert(url === `${LOCAL}/chat/completions`, `expected local proxy URL, got "${url}"`)
    })

    await test('opts.baseUrl takes precedence over DEEPSEEK_BASE_URL', async () => {
      process.env.DEEPSEEK_API_KEY = KEY
      process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9999/v1'
      const { url } = await captureDeepSeek({
        opts: { deepseek: { apiKey: KEY, baseUrl: 'http://localhost:8000/v1' } },
      })
      assert(url === 'http://localhost:8000/v1/chat/completions', `expected opts URL to win, got "${url}"`)
    })

    await test('default DeepSeek endpoint unchanged when nothing is set', async () => {
      process.env.DEEPSEEK_API_KEY = KEY
      delete process.env.DEEPSEEK_BASE_URL
      const { url } = await captureDeepSeek()
      assert(url === 'https://api.deepseek.com/v1/chat/completions', `expected default URL, got "${url}"`)
    })

    // ── Proxy path must not degrade the request ───────────────────────

    await test('tools survive when DeepSeek is pointed at a local proxy', async () => {
      delete process.env.DEEPSEEK_BASE_URL
      const { body } = await captureDeepSeek({
        opts: { deepseek: { apiKey: KEY, baseUrl: LOCAL } },
        tools: [SAMPLE_TOOL],
      })
      assert(Array.isArray(body.tools), `tools were dropped for proxied DeepSeek (tools=${JSON.stringify(body.tools)})`)
      assert(body.tools.length === 1, `expected 1 tool, got ${body.tools.length}`)
      assert(body.tool_choice === 'auto', `expected tool_choice 'auto', got ${JSON.stringify(body.tool_choice)}`)
    })

    await test('request body is identical whether proxied or direct', async () => {
      delete process.env.DEEPSEEK_BASE_URL
      const direct = await captureDeepSeek({
        opts: { deepseek: { apiKey: KEY } },
        tools: [SAMPLE_TOOL],
      })
      const proxied = await captureDeepSeek({
        opts: { deepseek: { apiKey: KEY, baseUrl: LOCAL } },
        tools: [SAMPLE_TOOL],
      })
      const a = JSON.stringify(direct.body)
      const b = JSON.stringify(proxied.body)
      assert(a === b, `body differs between direct and proxied:\n  direct=${a}\n  proxied=${b}`)
    })

    await test('DeepSeek cache-hit tokens still surface as cache_read (proxied)', async () => {
      delete process.env.DEEPSEEK_BASE_URL
      const { events } = await captureDeepSeek({
        opts: { deepseek: { apiKey: KEY, baseUrl: LOCAL } },
        finalUsage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      })
      const finalDelta = events.findLast(ev => ev.type === 'message_delta') as any
      // DeepSeek's prompt_tokens (100) includes the cached hit (80), so the
      // lane reports the non-cached remainder (20) as input and the 80 hit
      // as cache_read — the same subtractive convention every compat
      // provider uses.
      assert(finalDelta?.usage?.input_tokens === 20, `input_tokens=${finalDelta?.usage?.input_tokens}`)
      assert(
        finalDelta?.usage?.cache_read_input_tokens === 80,
        `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`,
      )
    })
  } finally {
    restoreEnv('DEEPSEEK_API_KEY', savedKey)
    restoreEnv('DEEPSEEK_BASE_URL', savedUrl)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
