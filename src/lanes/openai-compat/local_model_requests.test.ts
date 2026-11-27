/**
 * What the compat lane sends to local model servers, through the real lane
 * with a mocked network: Ollama's native /api/chat (local and `:cloud`
 * models), LM Studio's OpenAI-compatible route, another OpenAI-compatible
 * server on this machine, and DeepSeek as the hosted control that local
 * settings must never reach.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initOpenAICompatLane, openaiCompatLane } from './index.js'
import { ollamaCpuShareNotice, resetLocalModelSettingsForTests } from './local_model_settings.js'
import { localCompactionProfile, localTokenEstimate } from '../../utils/model/localModelContext.js'
import { onLocalModelNotice, resetLocalModelNoticesForTests } from '../../utils/model/localModelNotices.js'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'

const OLLAMA = 'http://127.0.0.1:11434/v1'
const LMSTUDIO = 'http://127.0.0.1:1234/v1'
const DEEPSEEK = 'https://api.deepseek.test/v1'
// Another OpenAI-compatible server on this machine (llama.cpp, vLLM, Jan).
const GENERIC = 'http://127.0.0.1:8080/v1'
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
  'TAU_LOCAL_THINKING',
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
  /** LM Studio counts a prompt at this share of Tau's 4-characters estimate. */
  lmStudioCountRatio?: number
  /** An OpenAI-compatible server that rejects stream_options with a 400. */
  refusesStreamOptions?: boolean
  /** An OpenAI-compatible server that rejects reasoning_effort and chat_template_kwargs with a 422. */
  refusesThinkingFields?: boolean
  /** An OpenAI-compatible server streams this as `reasoning_content` before the answer. */
  reasons?: string
  /**
   * An OpenAI-compatible server streams no text at all, as a thinking model
   * does when its one token is the start of its thinking. Asked without
   * streaming, it answers "ok".
   */
  emptyStream?: boolean
  /**
   * Ollama /api/ps: the context the model is loaded with when the request
   * starts. Without this or `ownDefault`, /api/ps answers 404.
   */
  loadedAt?: number
  /** The context Ollama picks when it loads the model with no options. */
  ownDefault?: number
  /** /api/ps: the loaded model's size and the part of it in GPU memory. */
  gpuShare?: { size: number; sizeVram: number }
  /** Ollama /api/chat streams this as `message.thinking` before the answer. */
  thinks?: string
  /** Ollama /api/chat refuses any request with a `think` field. */
  refusesThink?: boolean
}

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map(line => JSON.stringify(line)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

// Usage only when the request asks for it, as OpenAI-compatible servers do.
function sse(model: string, promptTokens?: number, reasoning?: string): Response {
  const chunks = [
    ...(reasoning ? [{ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] }] : []),
    { id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    {
      id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(promptTokens !== undefined && { usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } }),
    },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function run(input: {
  providerHint: 'ollama' | 'lmstudio' | 'deepseek' | 'generic'
  model: string
  /** Where the generic OpenAI-compatible server runs (default: this machine). */
  genericUrl?: string
  system?: string
  temperature?: number
  maxTokens?: number
  /** Tau's /thinking switch. */
  thinking?: { type: 'enabled' } | { type: 'disabled' }
  /** Who asks: the main conversation unless a test says otherwise. */
  querySource?: string
  server?: Server
}): Promise<{ sent: Sent[]; text: string; thinking: string; blocks: string[] }> {
  initOpenAICompatLane({
    ollama: { baseUrl: OLLAMA },
    lmstudio: { baseUrl: LMSTUDIO },
    deepseek: { apiKey: 'sk-test-key-0123456789', baseUrl: DEEPSEEK },
  })
  openaiCompatLane.registerProvider('generic', '', input.genericUrl ?? GENERIC)
  const sent: Sent[] = []
  const server = input.server ?? {}
  const answersPs = server.loadedAt !== undefined || server.ownDefault !== undefined
  let loadedAt = server.loadedAt
  // Ollama clamps a context to the model's own limit, as 0.40 does.
  const show = typeof server.show === 'object' ? server.show : { model_info: { 'qwen3.context_length': 262_144 } }
  const limit = Object.entries((show.model_info ?? {}) as Record<string, unknown>)
    .find(([name, value]) => name.endsWith('.context_length') && typeof value === 'number')?.[1] as number | undefined
  const clamp = (numCtx: number) => Math.min(numCtx, limit ?? Number.POSITIVE_INFINITY)
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
    if (href.endsWith('/api/ps')) {
      if (!answersPs) return new Response('not found', { status: 404 })
      const share = server.gpuShare && { size: server.gpuShare.size, size_vram: server.gpuShare.sizeVram }
      return Response.json({ models: loadedAt === undefined ? [] : [{ name: input.model, model: input.model, context_length: loadedAt, ...share }] })
    }
    if (href.endsWith('/api/generate')) {
      loadedAt = server.ownDefault === undefined ? undefined : clamp(server.ownDefault)
      return Response.json({ model: body.model, done: true, done_reason: 'load' })
    }
    if (href.endsWith('/api/chat')) {
      loadedAt = clamp(body.options.num_ctx)
      const refuse = server.refuseBelow
      if (refuse && body?.truncate === false && loadedAt < refuse.numCtx) {
        return Response.json({
          error: `request (${refuse.requestTokens} tokens) exceeds the available context size (${loadedAt} tokens), try increasing it`,
        }, { status: 400 })
      }
      if (server.refusesThink && body.think !== undefined) {
        return Response.json({ error: `"${body.model}" does not support thinking` }, { status: 400 })
      }
      return ndjson([
        ...(server.thinks ? [{ model: body.model, message: { role: 'assistant', content: '', thinking: server.thinks }, done: false }] : []),
        { model: body.model, message: { role: 'assistant', content: 'ok' }, done: false },
        { model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 1 },
      ])
    }
    if (href.endsWith('/api/v1/models')) return Response.json({ models: server.lmStudioModels ?? [] })
    if (href.endsWith('/chat/completions')) {
      if (server.refusesStreamOptions && body?.stream_options) {
        return Response.json({ error: "'stream_options' is not supported" }, { status: 400 })
      }
      if (server.refusesThinkingFields && (body?.chat_template_kwargs || body?.reasoning_effort)) {
        const field = body.chat_template_kwargs ? 'chat_template_kwargs' : 'reasoning_effort'
        return Response.json({ detail: [{ loc: ['body', field], msg: 'Extra inputs are not permitted' }] }, { status: 422 })
      }
      if (body?.stream === false) {
        return Response.json({
          id: 'x', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        })
      }
      if (server.emptyStream) {
        const last = { id: 'x', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }
        return new Response(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const estimate = (JSON.stringify(body.messages).length + (body.tools ? JSON.stringify(body.tools).length : 0)) / 4
      const promptTokens = server.lmStudioCountRatio === undefined ? 10 : Math.ceil(estimate * server.lmStudioCountRatio)
      return sse(body?.model ?? 'model', body?.stream_options?.include_usage ? promptTokens : undefined, server.reasons)
    }
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
      ...(input.thinking !== undefined && { thinking: input.thinking }),
      querySource: input.querySource ?? 'repl_main_thread',
      signal: new AbortController().signal,
      providerHint: input.providerHint,
    })
    for await (const event of stream) events.push(event)
    const deltas = (kind: string) => events
      .map(event => {
        if (event.type !== 'content_block_delta') return ''
        const delta = event.delta as { type?: string; text?: string; thinking?: string }
        if (delta?.type !== kind) return ''
        return (kind === 'text_delta' ? delta.text : delta.thinking) ?? ''
      })
      .join('')
    // The kinds of content blocks, in order.
    const blocks = events.flatMap(event =>
      event.type === 'content_block_start' ? [String((event.content_block as { type?: unknown }).type)] : [])
    return { sent, text: deltas('text_delta'), thinking: deltas('thinking_delta'), blocks }
  } finally {
    globalThis.fetch = oldFetch
  }
}

const chats = (sent: Sent[]) => sent.filter(entry => entry.url.endsWith('/api/chat') || entry.url.endsWith('/chat/completions'))

// What Tau asked the server before its first request.
const callsBeforeFirstChat = (sent: Sent[]) =>
  sent.slice(0, sent.findIndex(entry => entry.url.endsWith('/api/chat') || entry.url.endsWith('/chat/completions')))

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  resetLocalModelSettingsForTests()
  resetLocalModelNoticesForTests()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Ollama, a model on this machine', () => {
  test("a small request gets the context the conversation uses, fits the answer limit, refuses truncation, keeps the model's sampling", async () => {
    const { sent, text } = await run({ providerHint: 'ollama', model: 'qwen3:4b', temperature: 1 })
    expect(text).toBe('ok')
    const [chat] = chats(sent)
    expect(chat!.body.truncate).toBe(false)
    expect(chat!.body.keep_alive).toBe('30m')
    // The least Tau works in, so the conversation's own requests do not reload the model.
    expect(chat!.body.options.num_ctx).toBe(32_768)
    expect(chat!.body.options.num_predict).toBe(32_000)
    expect('temperature' in chat!.body.options).toBe(false)
    // A server that says nothing about the model, and a small request: no /api/show.
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

  test('a fixed OLLAMA_NUM_CTX is sent as given, without asking Ollama for its context first', async () => {
    process.env.OLLAMA_NUM_CTX = '20000'
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000), server: { ownDefault: 262_144 } })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(20_000)
    expect(callsBeforeFirstChat(sent)).toEqual([])
    expect(sent.some(entry => entry.url.endsWith('/api/generate'))).toBe(false)
  })

  test("a refused request grows to Ollama's exact count and is sent once more", async () => {
    const { sent, text } = await run({
      providerHint: 'ollama',
      model: 'qwen3:4b',
      system: 'x '.repeat(40_000),
      server: { refuseBelow: { numCtx: 40_960, requestTokens: 30_000 } },
    })
    const sentChats = chats(sent)
    expect(sentChats.map(chat => chat.body.options.num_ctx)).toEqual([32_768, 40_960])
    expect(sentChats[1]!.body.options.num_predict).toBe(10_960)
    expect(text).toBe('ok')
  })

  test('a model Ollama already holds is used at its context, without loading it again', async () => {
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000), server: { loadedAt: 65_536 } })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(65_536)
    expect(chats(sent)[0]!.body.options.num_predict).toBe(32_000)
    expect(sent.some(entry => entry.url.endsWith('/api/generate'))).toBe(false)
  })

  test('a big machine: Ollama loads the model at 256K on its own, and Tau keeps that context', async () => {
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000), server: { ownDefault: 262_144 } })
    const order = sent.map(entry => `${entry.method} ${new URL(entry.url).pathname}`)
    expect(order.slice(0, 3)).toEqual(['GET /api/ps', 'POST /api/generate', 'GET /api/ps'])
    // A plain load: no context or other options, so Ollama decides.
    expect(sent[1]!.body).toEqual({ model: 'qwen3:4b', keep_alive: '30m', stream: false })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(262_144)
  })

  test("a small machine: Ollama's own 4K cannot hold Tau's prompt, so Tau asks for what it needs", async () => {
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000), server: { ownDefault: 4096 } })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(32_768)
  })

  test('OLLAMA_NUM_CTX_MAX: Tau sizes the context itself and does not ask Ollama', async () => {
    process.env.OLLAMA_NUM_CTX_MAX = '65536'
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000), server: { ownDefault: 262_144 } })
    expect(chats(sent)[0]!.body.options.num_ctx).toBe(32_768)
    // Only the model's own limit is read first, as before.
    expect(callsBeforeFirstChat(sent).map(entry => new URL(entry.url).pathname)).toEqual(['/api/show'])
    expect(sent.some(entry => entry.url.endsWith('/api/generate'))).toBe(false)
  })

  test('a model split between GPU and CPU gets a one-time notice after the answer; the request is the same', async () => {
    const notices: string[] = []
    const stop = onLocalModelNotice(notice => notices.push(notice.text))
    try {
      const server = { loadedAt: 32_768, gpuShare: { size: 4_000_000_000, sizeVram: 3_360_000_000 } }
      const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', system: 'x '.repeat(40_000), server })
      expect(notices).toEqual([ollamaCpuShareNotice('qwen3:4b', 16, 32_768)])
      // The check is a read after the answer, not part of the request.
      const firstChat = sent.findIndex(entry => entry.url.endsWith('/api/chat'))
      expect(sent.slice(firstChat + 1).map(entry => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual(['GET /api/ps'])
      // The same context next turn: no second check, no second notice.
      const again = await run({ providerHint: 'ollama', model: 'qwen3:4b', server })
      expect(again.sent.filter(entry => entry.url.endsWith('/api/ps'))).toHaveLength(0)
      expect(notices).toHaveLength(1)
    } finally {
      stop()
    }
  })

  test('a model fully on the GPU, or a machine running it all on the CPU, gets no notice', async () => {
    const notices: string[] = []
    const stop = onLocalModelNotice(notice => notices.push(notice.text))
    try {
      await run({ providerHint: 'ollama', model: 'full:1b', server: { loadedAt: 32_768, gpuShare: { size: 4_000_000_000, sizeVram: 4_000_000_000 } } })
      await run({ providerHint: 'ollama', model: 'cpu:1b', server: { loadedAt: 32_768, gpuShare: { size: 4_000_000_000, sizeVram: 0 } } })
      expect(notices).toEqual([])
    } finally {
      stop()
    }
  })

  test('past the context it may use, the advice says how to allow more', async () => {
    const { sent, text } = await run({
      providerHint: 'ollama',
      model: 'qwen3:4b',
      system: 'x '.repeat(40_000),
      server: { ownDefault: 4096, refuseBelow: { numCtx: 131_072, requestTokens: 36_000 } },
    })
    const sizes = chats(sent).map(chat => chat.body.options.num_ctx)
    expect(sizes).toHaveLength(2)
    expect(sizes[1]!).toBeGreaterThan(sizes[0]!)
    expect(text).toContain('This request is 36000 tokens')
    expect(text).toContain('set OLLAMA_NUM_CTX_MAX to let Tau ask for more')
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
    // Ollama clamped the context to the model's 8K, and refused.
    expect(chats(sent).map(chat => chat.body.options.num_ctx)).toEqual([32_768])
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

describe('Ollama thinking', () => {
  const thinks = { model_info: { 'qwen3.context_length': 40_960 }, capabilities: ['completion', 'tools', 'thinking'] }
  const noThinking = { model_info: { 'llama.context_length': 131_072 }, capabilities: ['completion', 'tools'] }

  test('by default no think field is sent and nothing extra is asked: the model keeps its own default', async () => {
    const { sent } = await run({ providerHint: 'ollama', model: 'qwen3:4b', server: { show: thinks } })
    expect('think' in chats(sent)[0]!.body).toBe(false)
    expect(sent.some(entry => entry.url.endsWith('/api/show'))).toBe(false)
  })

  test('/thinking on sends think: true to a model that lists thinking, and nothing to one that does not', async () => {
    const on = { type: 'enabled' } as const
    const capable = await run({ providerHint: 'ollama', model: 'qwen3:4b', thinking: on, server: { show: thinks } })
    expect(chats(capable.sent)[0]!.body.think).toBe(true)
    const other = await run({ providerHint: 'ollama', model: 'llama3.1:8b', thinking: on, server: { show: noThinking } })
    expect('think' in chats(other.sent)[0]!.body).toBe(false)
  })

  test('TAU_LOCAL_THINKING decides, whatever /thinking says: off, or a level', async () => {
    process.env.TAU_LOCAL_THINKING = 'off'
    const off = await run({ providerHint: 'ollama', model: 'qwen3:4b', thinking: { type: 'enabled' }, server: { show: thinks } })
    expect(chats(off.sent)[0]!.body.think).toBe(false)
    process.env.TAU_LOCAL_THINKING = 'low'
    const low = await run({ providerHint: 'ollama', model: 'gpt-oss:20b', server: { show: thinks } })
    expect(chats(low.sent)[0]!.body.think).toBe('low')
  })

  test('a server that refuses think gets the request again without it, and the model never gets it again', async () => {
    const server = { show: thinks, refusesThink: true }
    const first = await run({ providerHint: 'ollama', model: 'qwen3:4b', thinking: { type: 'enabled' }, server })
    expect(first.text).toBe('ok')
    expect(chats(first.sent).map(chat => chat.body.think)).toEqual([true, undefined])
    const second = await run({ providerHint: 'ollama', model: 'qwen3:4b', thinking: { type: 'enabled' }, server })
    expect(chats(second.sent).map(chat => 'think' in chat.body)).toEqual([false])
  })

  test("the thinking a model streams is shown as thinking, ahead of the answer", async () => {
    const { thinking, text, blocks } = await run({ providerHint: 'ollama', model: 'qwen3:4b', server: { thinks: 'Adding 17 and 25.' } })
    expect(thinking).toBe('Adding 17 and 25.')
    expect(text).toBe('ok')
    expect(blocks).toEqual(['thinking', 'text'])
  })
})

describe("Ollama's cloud models keep the request Tau has always sent", () => {
  test('no think field and no thinking shown, even with /thinking on', async () => {
    const show = { capabilities: ['completion', 'tools', 'thinking'] }
    const { sent, thinking, blocks } = await run({
      providerHint: 'ollama',
      model: 'glm-5.1:cloud',
      thinking: { type: 'enabled' },
      server: { show, thinks: 'cloud reasoning' },
    })
    expect('think' in chats(sent)[0]!.body).toBe(false)
    expect(thinking).toBe('')
    expect(blocks).toEqual(['text'])
  })

  test('TAU_LOCAL_THINKING does not reach a cloud model', async () => {
    process.env.TAU_LOCAL_THINKING = 'off'
    const { sent } = await run({ providerHint: 'ollama', model: 'glm-5.1:cloud', server: { show: { capabilities: ['thinking'] } } })
    expect('think' in chats(sent)[0]!.body).toBe(false)
  })

  test('16K context, the full answer limit, Tau temperature, no truncate field, no /api/show, no GPU check', async () => {
    const server = { loadedAt: 16_384, gpuShare: { size: 4_000_000_000, sizeVram: 1_000_000_000 } }
    const { sent } = await run({ providerHint: 'ollama', model: 'glm-5.1:cloud', system: 'x '.repeat(40_000), server })
    const [chat] = chats(sent)
    expect(Object.keys(chat!.body)).toEqual(['model', 'messages', 'stream', 'keep_alive', 'options'])
    expect(chat!.body.options).toEqual({ num_ctx: 16_384, num_predict: 32_000, temperature: 0.7 })
    expect(sent.filter(entry => !entry.url.endsWith('/api/chat'))).toEqual([])
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

  const loaded32k = [{
    type: 'llm',
    key: 'local-model',
    display_name: 'Local Model',
    max_context_length: 131_072,
    loaded_instances: [{ id: 'local-model', config: { context_length: 32_768 } }],
  }]

  test("LM Studio is asked for its exact token counts, and they calibrate Tau's estimate", async () => {
    const { sent } = await run({
      providerHint: 'lmstudio',
      model: 'local-model',
      system: 'x '.repeat(24_000),
      server: { lmStudioModels: loaded32k, lmStudioCountRatio: 0.9 },
    })
    expect(chats(sent)[0]!.body.stream_options).toEqual({ include_usage: true })
    // 0.9 of the estimate, plus the 5% margin a counted model gets.
    const scaled = localTokenEstimate('local-model', 10_000)
    expect(scaled).toBeGreaterThan(9400)
    expect(scaled).toBeLessThan(9500)
  })

  test('auto-compact plans for the context LM Studio loaded the model with', async () => {
    await run({
      providerHint: 'lmstudio',
      model: 'local-model',
      system: 'x '.repeat(24_000),
      server: { lmStudioModels: loaded32k, lmStudioCountRatio: 0.9 },
    })
    expect(localCompactionProfile('lmstudio', 'local-model')?.window).toBe(32_768)
  })

  test('a server that refuses stream_options gets the request again without it, and never again', async () => {
    const server = { lmStudioModels: loaded32k, refusesStreamOptions: true }
    const first = await run({ providerHint: 'lmstudio', model: 'local-model', server })
    expect(first.text).toBe('ok')
    expect(chats(first.sent).map(chat => 'stream_options' in chat.body)).toEqual([true, false])
    const second = await run({ providerHint: 'lmstudio', model: 'local-model', server })
    expect(chats(second.sent).map(chat => 'stream_options' in chat.body)).toEqual([false])
  })

  test('a request larger than the loaded context is not sent, and its message is one compaction recognizes', async () => {
    const { sent, text } = await run({ providerHint: 'lmstudio', model: 'local-model', system: 'x '.repeat(40_000), server: { lmStudioModels: loaded } })
    expect(chats(sent)).toHaveLength(0)
    expect(text.startsWith('Prompt is too long (LM Studio): LM Studio has "local-model" loaded with 8,192 context tokens')).toBe(true)
  })
})

describe('thinking on LM Studio and other local servers', () => {
  const lmStudioModel = (reasoning?: Record<string, unknown>) => [{
    type: 'llm',
    key: 'local-model',
    display_name: 'Local Model',
    max_context_length: 131_072,
    loaded_instances: [{ id: 'local-model', config: { context_length: 32_768 } }],
    ...(reasoning && { capabilities: { reasoning } }),
  }]
  const onByDefault = lmStudioModel({ allowed_options: ['off', 'on'], default: 'on' })
  const offByDefault = lmStudioModel({ allowed_options: ['off', 'on'], default: 'off' })
  const thinkingFieldsOf = (body: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(body).filter(([key]) => key === 'reasoning_effort' || key === 'chat_template_kwargs'))

  test('LM Studio: nothing extra by default, and its reasoning is shown as thinking', async () => {
    const { sent, thinking, text, blocks } = await run({
      providerHint: 'lmstudio', model: 'local-model', server: { lmStudioModels: onByDefault, reasons: 'Adding 17 and 25.' },
    })
    expect(thinkingFieldsOf(chats(sent)[0]!.body)).toEqual({})
    expect(thinking).toBe('Adding 17 and 25.')
    expect(text).toBe('ok')
    expect(blocks).toEqual(['thinking', 'text'])
  })

  test('LM Studio: TAU_LOCAL_THINKING=off sends reasoning_effort none, which LM Studio reads as thinking off', async () => {
    process.env.TAU_LOCAL_THINKING = 'off'
    const { sent } = await run({ providerHint: 'lmstudio', model: 'local-model', server: { lmStudioModels: onByDefault } })
    expect(thinkingFieldsOf(chats(sent)[0]!.body)).toEqual({ reasoning_effort: 'none' })
  })

  test('LM Studio: /thinking on turns on a model whose thinking starts off, and leaves one that thinks alone', async () => {
    const on = { type: 'enabled' } as const
    const startsOff = await run({ providerHint: 'lmstudio', model: 'local-model', thinking: on, server: { lmStudioModels: offByDefault } })
    expect(thinkingFieldsOf(chats(startsOff.sent)[0]!.body)).toEqual({ reasoning_effort: 'medium' })
    const thinksAlready = await run({ providerHint: 'lmstudio', model: 'local-model', thinking: on, server: { lmStudioModels: onByDefault } })
    expect(thinkingFieldsOf(chats(thinksAlready.sent)[0]!.body)).toEqual({})
  })

  test('LM Studio: a model with no thinking options gets nothing, whatever is asked', async () => {
    process.env.TAU_LOCAL_THINKING = 'off'
    const { sent } = await run({ providerHint: 'lmstudio', model: 'local-model', thinking: { type: 'enabled' }, server: { lmStudioModels: lmStudioModel() } })
    expect(thinkingFieldsOf(chats(sent)[0]!.body)).toEqual({})
  })

  test('a server behind the LM Studio provider (no LM Studio listing) gets the fields such servers take, only when asked', async () => {
    const plain = await run({ providerHint: 'lmstudio', model: 'other-server-model' })
    expect(thinkingFieldsOf(chats(plain.sent)[0]!.body)).toEqual({})
    const on = await run({ providerHint: 'lmstudio', model: 'other-server-model', thinking: { type: 'enabled' } })
    expect(thinkingFieldsOf(chats(on.sent)[0]!.body)).toEqual({ chat_template_kwargs: { enable_thinking: true } })
    process.env.TAU_LOCAL_THINKING = 'off'
    const off = await run({ providerHint: 'lmstudio', model: 'other-server-model' })
    expect(thinkingFieldsOf(chats(off.sent)[0]!.body)).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    process.env.TAU_LOCAL_THINKING = 'high'
    const high = await run({ providerHint: 'lmstudio', model: 'other-server-model' })
    expect(thinkingFieldsOf(chats(high.sent)[0]!.body)).toEqual({ reasoning_effort: 'high' })
  })

  test('another server on this machine gets the same; one that refuses the fields gets the request again without them, and never again', async () => {
    process.env.TAU_LOCAL_THINKING = 'on'
    const plain = await run({ providerHint: 'generic', model: 'my-model' })
    expect(thinkingFieldsOf(chats(plain.sent)[0]!.body)).toEqual({ chat_template_kwargs: { enable_thinking: true } })
    const first = await run({ providerHint: 'generic', model: 'strict-model', server: { refusesThinkingFields: true } })
    expect(first.text).toBe('ok')
    expect(chats(first.sent).map(chat => 'chat_template_kwargs' in chat.body)).toEqual([true, false])
    const second = await run({ providerHint: 'generic', model: 'strict-model', server: { refusesThinkingFields: true } })
    expect(chats(second.sent).map(chat => 'chat_template_kwargs' in chat.body)).toEqual([false])
  })

  test('a server that is not on this machine gets nothing, whatever TAU_LOCAL_THINKING says', async () => {
    const before = await run({ providerHint: 'generic', model: 'my-model', genericUrl: 'https://llm.example.test/v1' })
    process.env.TAU_LOCAL_THINKING = 'off'
    const after = await run({ providerHint: 'generic', model: 'my-model', genericUrl: 'https://llm.example.test/v1' })
    expect(chats(after.sent)[0]!.body).toEqual(chats(before.sent)[0]!.body)
    expect(thinkingFieldsOf(chats(after.sent)[0]!.body)).toEqual({})
  })
})

describe('loading the prompt ahead of the first message', () => {
  const preload = 'local_preload'
  const thinks = { model_info: { 'qwen3.context_length': 40_960 }, capabilities: ['completion', 'tools', 'thinking'] }
  const withoutAnswerLimit = (body: any) => {
    const copy = structuredClone(body)
    delete copy.options?.num_predict
    delete copy.max_tokens
    return copy
  }

  for (const [label, env] of [['auto', {}], ['OLLAMA_NUM_CTX_MAX', { OLLAMA_NUM_CTX_MAX: '131072' }], ['a fixed OLLAMA_NUM_CTX', { OLLAMA_NUM_CTX: '24576' }]] as const) {
    test(`Ollama (${label}): a preload is the first request with a one-token answer, at the same context`, async () => {
      Object.assign(process.env, env)
      const ahead = await run({ providerHint: 'ollama', model: 'qwen3:4b', querySource: preload, server: { show: thinks } })
      resetLocalModelSettingsForTests()
      const first = await run({ providerHint: 'ollama', model: 'qwen3:4b', server: { show: thinks } })
      const [early] = chats(ahead.sent)
      const [real] = chats(first.sent)
      expect(early!.body.options.num_predict).toBe(1)
      expect(real!.body.options.num_predict).toBeGreaterThan(1)
      expect(early!.body.options.num_ctx).toBe(real!.body.options.num_ctx)
      expect(withoutAnswerLimit(early!.body)).toEqual(withoutAnswerLimit(real!.body))
    })
  }

  test('once the conversation has reached the model, a preload sends nothing', async () => {
    await run({ providerHint: 'ollama', model: 'qwen3:4b', server: { show: thinks } })
    const late = await run({ providerHint: 'ollama', model: 'qwen3:4b', querySource: preload, server: { show: thinks } })
    expect(late.sent).toEqual([])
    expect(late.text).toBe('')
  })

  test("a helper's request on the same model is not the conversation: the preload still goes", async () => {
    await run({ providerHint: 'ollama', model: 'qwen3:4b', querySource: 'compact', server: { show: thinks } })
    const ahead = await run({ providerHint: 'ollama', model: 'qwen3:4b', querySource: preload, server: { show: thinks } })
    expect(chats(ahead.sent).map(chat => chat.body.options.num_predict)).toEqual([1])
  })

  test('a request that starts during a preload waits for it, then goes', async () => {
    initOpenAICompatLane({ ollama: { baseUrl: OLLAMA } })
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const oldFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href = String(url)
      if (href.endsWith('/api/show')) return Response.json(thinks)
      if (!href.endsWith('/api/chat')) return new Response('not found', { status: 404 })
      const body = JSON.parse(String(init?.body))
      const kind = body.options.num_predict === 1 ? 'preload' : 'first message'
      order.push(`${kind} sent`)
      if (kind === 'preload') await held
      return ndjson([
        { model: body.model, message: { role: 'assistant', content: 'ok' }, done: false },
        { model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 1 },
      ])
    }) as typeof fetch
    const drain = async (querySource: string) => {
      for await (const _ of openaiCompatLane.streamAsProvider({
        model: 'qwen3:4b', messages: [{ role: 'user', content: 'hello' }], system: 'stable system prompt', tools: [],
        max_tokens: 32_000, querySource, signal: new AbortController().signal, providerHint: 'ollama',
      })) { /* drain */ }
      order.push(`${querySource === preload ? 'preload' : 'first message'} done`)
    }
    try {
      const ahead = drain(preload)
      while (!order.includes('preload sent')) await new Promise(resolve => setTimeout(resolve, 5))
      const first = drain('repl_main_thread')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(order).toEqual(['preload sent'])
      release()
      await Promise.all([ahead, first])
      expect(order).toEqual(['preload sent', 'preload done', 'first message sent', 'first message done'])
    } finally {
      globalThis.fetch = oldFetch
    }
  })

  test('LM Studio: a preload is the first request with max_tokens 1', async () => {
    const loaded = [{ type: 'llm', key: 'local-model', max_context_length: 131_072, loaded_instances: [{ id: 'local-model', config: { context_length: 32_768 } }] }]
    const ahead = await run({ providerHint: 'lmstudio', model: 'local-model', querySource: preload, server: { lmStudioModels: loaded } })
    resetLocalModelSettingsForTests()
    const first = await run({ providerHint: 'lmstudio', model: 'local-model', server: { lmStudioModels: loaded } })
    const [early] = chats(ahead.sent)
    const [real] = chats(first.sent)
    expect(early!.body.max_tokens).toBe(1)
    expect(real!.body.max_tokens).toBeGreaterThan(1)
    expect(withoutAnswerLimit(early!.body)).toEqual(withoutAnswerLimit(real!.body))
  })

  test("an empty one-token answer is a preload's normal end: one request, no fallback, no retry", async () => {
    const loaded = [{ type: 'llm', key: 'local-model', max_context_length: 131_072, loaded_instances: [{ id: 'local-model', config: { context_length: 32_768 } }] }]
    const lmStudio = await run({ providerHint: 'lmstudio', model: 'local-model', querySource: preload, server: { lmStudioModels: loaded, emptyStream: true } })
    expect(chats(lmStudio.sent).map(chat => chat.body.max_tokens)).toEqual([1])
    const other = await run({ providerHint: 'generic', model: 'my-model', querySource: preload, server: { emptyStream: true } })
    expect(chats(other.sent).map(chat => chat.body.max_tokens)).toEqual([1])
  })

  test("an empty answer to a real request still gets LM Studio's fallback", async () => {
    const loaded = [{ type: 'llm', key: 'local-model', max_context_length: 131_072, loaded_instances: [{ id: 'local-model', config: { context_length: 32_768 } }] }]
    const first = await run({ providerHint: 'lmstudio', model: 'local-model', server: { lmStudioModels: loaded, emptyStream: true } })
    expect(chats(first.sent).length).toBeGreaterThan(1)
    expect(first.text).toBe('ok')
  })

  test("a cloud model, a remote server and a hosted provider send what they always did, whoever asks", async () => {
    const cloud = await run({ providerHint: 'ollama', model: 'glm-5.1:cloud', querySource: preload })
    expect(chats(cloud.sent)[0]!.body.options.num_predict).toBe(32_000)
    const remote = await run({ providerHint: 'generic', model: 'my-model', genericUrl: 'https://llm.example.test/v1', querySource: preload })
    const remoteMain = await run({ providerHint: 'generic', model: 'my-model', genericUrl: 'https://llm.example.test/v1' })
    expect(chats(remote.sent)[0]!.body).toEqual(chats(remoteMain.sent)[0]!.body)
    const hosted = await run({ providerHint: 'deepseek', model: 'deepseek-chat', querySource: preload })
    const hostedMain = await run({ providerHint: 'deepseek', model: 'deepseek-chat' })
    expect(chats(hosted.sent)[0]!.body).toEqual(chats(hostedMain.sent)[0]!.body)
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

  test('DeepSeek gets the same request whatever TAU_LOCAL_THINKING says', async () => {
    const before = await run({ providerHint: 'deepseek', model: 'deepseek-chat', thinking: { type: 'enabled' } })
    process.env.TAU_LOCAL_THINKING = 'off'
    const after = await run({ providerHint: 'deepseek', model: 'deepseek-chat', thinking: { type: 'enabled' } })
    expect(chats(after.sent)[0]!.body).toEqual(chats(before.sent)[0]!.body)
  })
})
