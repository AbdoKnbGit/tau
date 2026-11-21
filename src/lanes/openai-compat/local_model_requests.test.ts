/**
 * What the compat lane sends to local model servers, through the real lane
 * with a mocked network: Ollama's native /api/chat (local and `:cloud`
 * models), LM Studio's OpenAI-compatible route, and DeepSeek as the hosted
 * control that local settings must never reach.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initOpenAICompatLane, openaiCompatLane } from './index.js'
import { resetLocalModelSettingsForTests } from './local_model_settings.js'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'

const OLLAMA = 'http://127.0.0.1:11434/v1'
const LMSTUDIO = 'http://127.0.0.1:1234/v1'
const DEEPSEEK = 'https://api.deepseek.test/v1'
const ENV_KEYS = [
  'OLLAMA_NUM_CTX',
  'OLLAMA_NUM_CTX_MAX',
  'OLLAMA_KEEP_ALIVE',
  'OLLAMA_TRUNCATE',
  'OLLAMA_HOST',
  'TAU_LOCAL_MAX_OUTPUT_TOKENS',
  'TAU_LOCAL_TEMPERATURE',
  'TAU_LOCAL_TOP_P',
  'TAU_LOCAL_TOP_K',
]
const saved = new Map<string, string | undefined>()

type Sent = { url: string; method: string; body: any }

type Server = {
  /** Ollama /api/show answer, or a status to fail with. */
  show?: Record<string, unknown> | number
  /** Ollama /api/chat: refuse requests below this context, as `truncate: false` does. */
  refuseBelow?: { numCtx: number; requestTokens: number }
  /** LM Studio /api/v1/models answer. */
  lmStudioModels?: unknown[]
}

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map(line => JSON.stringify(line)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function sse(model: string): Response {
  const chunks = [
    { id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function run(input: {
  providerHint: 'ollama' | 'lmstudio' | 'deepseek'
  model: string
  system?: string
  temperature?: number
  maxTokens?: number
  server?: Server
}): Promise<{ sent: Sent[]; text: string }> {
  initOpenAICompatLane({
    ollama: { baseUrl: OLLAMA },
    lmstudio: { baseUrl: LMSTUDIO },
    deepseek: { apiKey: 'sk-test-key-0123456789', baseUrl: DEEPSEEK },
  })
  const sent: Sent[] = []
  const server = input.server ?? {}
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    const method = init?.method ?? 'GET'
    let body: any = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    sent.push({ url: href, method, body })
    if (href.endsWith('/api/show')) {
      if (typeof server.show === 'number') return new Response('nope', { status: server.show })
      return Response.json(server.show ?? { model_info: { 'qwen3.context_length': 262_144 } })
    }
    if (href.endsWith('/api/chat')) {
      const refuse = server.refuseBelow
      if (refuse && body?.truncate === false && body.options.num_ctx < refuse.numCtx) {
        return Response.json({
          error: `request (${refuse.requestTokens} tokens) exceeds the available context size (${body.options.num_ctx} tokens), try increasing it`,
        }, { status: 400 })
      }
      return ndjson([
        { model: body.model, message: { role: 'assistant', content: 'ok' }, done: false },
        { model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 1 },
      ])
    }
    if (href.endsWith('/api/v1/models')) return Response.json({ models: server.lmStudioModels ?? [] })
    if (href.endsWith('/chat/completions')) return sse(body?.model ?? 'model')
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = openaiCompatLane.streamAsProvider({
      model: input.model,
      messages: [{ role: 'user', content: 'hello' }],
      system: input.system ?? 'stable system prompt',
      tools: [],
      max_tokens: input.maxTokens ?? 32_000,
      ...(input.temperature !== undefined && { temperature: input.temperature }),
      signal: new AbortController().signal,
      providerHint: input.providerHint,
    })
    for await (const event of stream) events.push(event)
    const text = events
      .map(event => {
        if (event.type !== 'content_block_delta') return ''
        const delta = event.delta
        return delta?.type === 'text_delta' ? delta.text : ''
      })
      .join('')
    return { sent, text }
  } finally {
    globalThis.fetch = oldFetch
  }
}

const chats = (sent: Sent[]) => sent.filter(entry => entry.url.endsWith('/api/chat') || entry.url.endsWith('/chat/completions'))

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  resetLocalModelSettingsForTests()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Ollama, a model on this machine', () => {
  test("a small request keeps 16K, fits the answer limit, refuses truncation, keeps the model's sampling", async () => {
    const { sent, text } = await run({ providerHint: 'ollama', model: 'qwen3:4b', temperature: 1 })
    expect(text).toBe('ok')
    const [chat] = chats(sent)
    expect(chat!.body.truncate).toBe(false)
    expect(chat!.body.keep_alive).toBe('30m')
    expect(chat!.body.options.num_ctx).toBe(16_384)
    expect(chat!.body.options.num_predict).toBeLessThan(16_384)
    expect(chat!.body.options.num_predict).toBeGreaterThan(16_000)
    expect('temperature' in chat!.body.options).toBe(false)
    // Within the 16K Tau always used, the model's own limit is not needed.
    expect(sent.some(entry => entry.url.endsWith('/api/show'))).toBe(false)
  })

  test("Tau's large prompt gets a context that holds it plus room for the answer", async () => {
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000) })
    const [chat] = chats(sent)
    expect(chat!.body.options.num_ctx).toBe(32_768)
    const promptBudget = 32_768 - chat!.body.options.num_predict
    expect(promptBudget).toBeGreaterThan(20_000)
    expect(chat!.body.options.num_predict).toBeGreaterThanOrEqual(1024)
  })

  test("the model's own limit caps auto", async () => {
    const { sent } = await run({
      providerHint: 'ollama',
      model: 'tiny:1b',
      system: 'x '.repeat(40_000),
      server: { show: { model_info: { 'llama.context_length': 8192 } } },
    })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(8192)
  })

  test('a fixed OLLAMA_NUM_CTX is sent as given, without asking /api/show', async () => {
    process.env.OLLAMA_NUM_CTX = '20000'
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000) })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(20_000)
    expect(sent.some(entry => entry.url.endsWith('/api/show'))).toBe(false)
  })

  test("a refused request grows to Ollama's exact count and is sent once more", async () => {
    const { sent, text } = await run({
      providerHint: 'ollama',
      model: 'qwen3:4b',
      server: { refuseBelow: { numCtx: 32_768, requestTokens: 20_000 } },
    })
    const sentChats = chats(sent)
    expect(sentChats.map(chat => chat.body.options.num_ctx)).toEqual([16_384, 32_768])
    expect(sentChats[1]!.body.options.num_predict).toBe(12_768)
    expect(text).toBe('ok')
  })

  test('past the ceiling the user gets the sizes and what to change', async () => {
    process.env.OLLAMA_NUM_CTX_MAX = '16384'
    const { sent, text } = await run({
      providerHint: 'ollama',
      model: 'qwen3:4b',
      server: { refuseBelow: { numCtx: 32_768, requestTokens: 20_000 } },
    })
    expect(chats(sent)).toHaveLength(1)
    expect(text).toContain('Prompt is too long (ollama 400)')
    expect(text).toContain('This request is 20000 tokens')
    expect(text).toContain('OLLAMA_NUM_CTX_MAX (now 16384)')
  })

  test("when the model's own limit is what blocks, the advice says so", async () => {
    const { sent, text } = await run({
      providerHint: 'ollama',
      model: 'tiny:1b',
      server: { show: { model_info: { 'llama.context_length': 8192 } }, refuseBelow: { numCtx: 32_768, requestTokens: 20_000 } },
    })
    expect(chats(sent).map(chat => chat.body.options.num_ctx)).toEqual([16_384])
    expect(text).toContain('This model takes at most 8192 tokens')
  })

  test('OLLAMA_TRUNCATE=1 restores silent truncation', async () => {
    process.env.OLLAMA_TRUNCATE = '1'
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b' })
    expect('truncate' in chats(sent)[0]!.body).toBe(false)
  })

  test('sampling and answer settings reach the options', async () => {
    process.env.TAU_LOCAL_TEMPERATURE = '0.2'
    process.env.TAU_LOCAL_TOP_P = '0.9'
    process.env.TAU_LOCAL_TOP_K = '20'
    process.env.TAU_LOCAL_MAX_OUTPUT_TOKENS = '2048'
    process.env.OLLAMA_KEEP_ALIVE = '2h'
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b' })
    const options = chats(sent)[0]!.body.options
    expect(options).toMatchObject({ temperature: 0.2, top_p: 0.9, top_k: 20, num_predict: 2048 })
    expect(chats(sent)[0]!.body.keep_alive).toBe('2h')
  })

  test('the same context is sent on the next turn, so Ollama keeps the model loaded', async () => {
    await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000) })
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b' })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(32_768)
  })
})

describe("Ollama's cloud models keep the request Tau has always sent", () => {
  test('16K context, the full answer limit, Tau temperature, no truncate field, no /api/show', async () => {
    const { sent } = await run({ providerHint: 'ollama', model: 'glm-5.1:cloud', system: 'x '.repeat(40_000) })
    const [chat] = chats(sent)
    expect(Object.keys(chat!.body)).toEqual(['model', 'messages', 'stream', 'keep_alive', 'options'])
    expect(chat!.body.options).toEqual({ num_ctx: 16_384, num_predict: 32_000, temperature: 0.7 })
    expect(sent.some(entry => entry.url.endsWith('/api/show'))).toBe(false)
  })
})

describe('LM Studio', () => {
  const loaded = [{
    type: 'llm',
    key: 'local-model',
    display_name: 'Local Model',
    max_context_length: 131_072,
    loaded_instances: [{ id: 'local-model', config: { context_length: 8192 } }],
  }]

  test('the answer limit fits the loaded context and the model keeps its preset sampling', async () => {
    const { sent, text } = await run({ providerHint: 'lmstudio', model: 'local-model', temperature: 1, server: { lmStudioModels: loaded } })
    expect(text).toBe('ok')
    const [chat] = chats(sent)
    expect(chat!.body.max_tokens).toBeLessThan(8192)
    expect(chat!.body.max_tokens).toBeGreaterThan(7000)
    expect('temperature' in chat!.body).toBe(false)
  })

  test('user sampling settings are sent', async () => {
    process.env.TAU_LOCAL_TEMPERATURE = '0.4'
    process.env.TAU_LOCAL_TOP_K = '40'
    const { sent } = await run({ providerHint: 'lmstudio', model: 'local-model', server: { lmStudioModels: loaded } })
    expect(chats(sent)[0]!.body).toMatchObject({ temperature: 0.4, top_k: 40 })
  })

  test('without loaded-context details the limit is only capped by the user setting', async () => {
    process.env.TAU_LOCAL_MAX_OUTPUT_TOKENS = '4096'
    const { sent } = await run({ providerHint: 'lmstudio', model: 'other-server-model' })
    expect(chats(sent)[0]!.body.max_tokens).toBe(4096)
  })
})

describe('a hosted provider on the same lane is untouched', () => {
  test('DeepSeek keeps its temperature and limit and gets no local fields, whatever the local settings say', async () => {
    process.env.TAU_LOCAL_TEMPERATURE = '0.2'
    process.env.TAU_LOCAL_TOP_K = '20'
    process.env.TAU_LOCAL_MAX_OUTPUT_TOKENS = '1024'
    const { sent } = await run({ providerHint: 'deepseek', model: 'deepseek-chat', temperature: 1, maxTokens: 4000 })
    const body = chats(sent)[0]!.body
    expect(body.temperature).toBe(1)
    expect(body.max_tokens).toBe(4000)
    expect('top_k' in body).toBe(false)
    expect('top_p' in body).toBe(false)
    expect('truncate' in body).toBe(false)
    expect(sent.some(entry => entry.url.includes('/api/'))).toBe(false)
  })
})
