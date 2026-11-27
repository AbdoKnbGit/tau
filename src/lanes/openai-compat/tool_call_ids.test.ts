/**
 * Tool-call ids the compat lane hands to Tau, through the real lane with a
 * mocked network. When a server sends a call without an id (Ollama builds
 * before tool-call ids, some OpenAI-compatible servers) or with an empty one,
 * the id Tau makes up must still be unique across turns: two calls that share
 * an id are merged in the UI and deduped out of the next request (issue #54).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initOpenAICompatLane, openaiCompatLane } from './index.js'
import { resetLocalModelSettingsForTests } from './local_model_settings.js'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'

const OLLAMA = 'http://127.0.0.1:11434/v1'
const LMSTUDIO = 'http://127.0.0.1:1234/v1'
const ENV_KEYS = ['OLLAMA_NUM_CTX', 'OLLAMA_NUM_CTX_MAX', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_TRUNCATE', 'OLLAMA_HOST']
const saved = new Map<string, string | undefined>()

/** What the mocked server puts in the call's id field; undefined leaves it out. */
type IdField = { id?: string }

function ollamaToolCall(idField: IdField): Response {
  const lines = [
    { model: 'qwen3:4b', message: { role: 'assistant', content: '', tool_calls: [{ ...idField, function: { name: 'Read', arguments: { file_path: 'a.txt' } } }] }, done: false },
    { model: 'qwen3:4b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 5 },
  ]
  return new Response(lines.map(line => JSON.stringify(line)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function sseToolCall(idField: IdField): Response {
  const chunks = [
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...idField, type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] }, finish_reason: null }] },
    { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

// A stream that ends with no output, so the LM Studio lane retries without streaming.
function sseEmpty(): Response {
  const chunk = { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function toolUseIds(providerHint: 'ollama' | 'lmstudio', idField: IdField, opts: { nonStreaming?: boolean } = {}): Promise<string[]> {
  initOpenAICompatLane({ ollama: { baseUrl: OLLAMA }, lmstudio: { baseUrl: LMSTUDIO } })
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    let body: any = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = null }
    if (href.endsWith('/api/show')) return Response.json({ model_info: { 'qwen3.context_length': 262_144 } })
    if (href.endsWith('/api/chat')) return ollamaToolCall(idField)
    if (href.endsWith('/api/v1/models')) return Response.json({ models: [] })
    if (href.endsWith('/chat/completions')) {
      if (!opts.nonStreaming) return sseToolCall(idField)
      if (body?.stream) return sseEmpty()
      return Response.json({
        choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ ...idField, type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  try {
    const events: AnthropicStreamEvent[] = []
    for await (const event of openaiCompatLane.streamAsProvider({
      model: 'qwen3:4b',
      messages: [{ role: 'user', content: 'read a.txt' }],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 32_000,
      signal: new AbortController().signal,
      providerHint,
    })) events.push(event)
    return events.flatMap(event =>
      event.type === 'content_block_start' && event.content_block?.type === 'tool_use' ? [event.content_block.id as string] : [],
    )
  } finally {
    globalThis.fetch = oldFetch
  }
}

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

// Two turns of the same reply, as a conversation would see them.
async function twoTurns(providerHint: 'ollama' | 'lmstudio', idField: IdField, opts?: { nonStreaming?: boolean }) {
  const [first] = await toolUseIds(providerHint, idField, opts)
  const [second] = await toolUseIds(providerHint, idField, opts)
  return [first!, second!]
}

describe('tool-call ids the server left out', () => {
  test('Ollama /api/chat without ids: each turn gets its own id', async () => {
    const [first, second] = await twoTurns('ollama', {})
    expect(first).toStartWith('toolu_ollama_call_0_')
    expect(second).not.toBe(first)
    expect(first.length).toBeLessThanOrEqual(40)
  })

  test('OpenAI-compatible stream without ids: each turn gets its own id', async () => {
    const [first, second] = await twoTurns('lmstudio', {})
    expect(first).toStartWith('toolu_compat_call_0_')
    expect(second).not.toBe(first)
    expect(first.length).toBeLessThanOrEqual(40)
  })

  test('an empty id counts as missing', async () => {
    const [streamed] = await twoTurns('lmstudio', { id: '' })
    expect(streamed).toStartWith('toolu_compat_call_0_')
    const [native] = await twoTurns('ollama', { id: '' })
    expect(native).toStartWith('toolu_ollama_call_0_')
  })

  test('LM Studio non-streaming retry without ids: each turn gets its own id', async () => {
    const [first, second] = await twoTurns('lmstudio', {}, { nonStreaming: true })
    expect(first).toStartWith('toolu_compat_lmstudio_')
    expect(second).not.toBe(first)
    expect(first.length).toBeLessThanOrEqual(40)
  })
})

describe('tool-call ids the server sent', () => {
  test('are kept exactly as they were', async () => {
    expect(await twoTurns('ollama', { id: 'call_vwvpq8xu' })).toEqual(['toolu_ollama_call_vwvpq8xu', 'toolu_ollama_call_vwvpq8xu'])
    expect(await twoTurns('lmstudio', { id: 'call_abc123' })).toEqual(['toolu_compat_call_abc123', 'toolu_compat_call_abc123'])
    expect(await twoTurns('lmstudio', { id: 'call_abc123' }, { nonStreaming: true })).toEqual(['toolu_compat_call_abc123', 'toolu_compat_call_abc123'])
  })
})
