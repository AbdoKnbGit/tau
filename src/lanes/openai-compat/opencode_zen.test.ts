import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaneProviderCallParams, NormalizedUsage } from '../types.js'
import type { AnthropicStreamEvent, ProviderTool } from '../../services/api/providers/base_provider.js'

const dir = mkdtempSync(join(tmpdir(), 'tau-zen-compat-'))
process.env.CLAUDE_CONFIG_DIR = dir
process.env.TAU_OPENCODE_THINKING_STORE = join(dir, 'thinking.json')
process.env.TAU_OPENCODE_MODELS_DEV_CACHE = join(dir, 'catalog.json')
process.env.OPENCODE_CLIENT = 'opencode-tau/test'
const { OpenAICompatLane } = await import('./loop.js')
const { streamOpenCodeZen } = await import('./opencode_zen.js')
const { CHEAP_MODE_CORE_TOOL_NAME_SET } = await import('../../constants/cheapModeTools.js')

const tools: ProviderTool[] = ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'mcp__files__read'].map(name => ({
  name,
  description: `${name} tool`,
  input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
}))
const params = (model = 'muse-spark-1.2-contributor-free'): LaneProviderCallParams => ({
  model, providerHint: 'opencode', sessionId: 'tau-session',
  system: 'You are a coding assistant.', tools, max_tokens: 1024,
  signal: new AbortController().signal,
  messages: [
    { role: 'user', content: 'Read a.txt' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
  ],
})
const usage: NormalizedUsage = {
  input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
}
const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

async function inspect(request: LaneProviderCallParams) {
  let sent!: LaneProviderCallParams
  const events: AnthropicStreamEvent[] = []
  const stream = streamOpenCodeZen(request, async function* (value) {
    sent = value
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_2', name: 'read', input: {} } }
    return usage
  })
  while (true) {
    const next = await stream.next()
    if (next.done) return { sent, events, usage: next.value }
    events.push(next.value)
  }
}

test('Zen maps real tools and history, restores calls, and preserves arguments, usage and caller data', async () => {
  const request = params()
  const original = JSON.stringify(request)
  const result = await inspect(request)
  expect(result.sent.tools.map(tool => tool.name)).toEqual(['bash', 'read', 'glob', 'grep', 'edit', 'write', 'mcp__files__read'])
  expect(result.sent.tools[1]!.input_schema).toBe(tools[1]!.input_schema)
  expect(result.sent.messages[1]!.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'read', input: { file_path: 'a.txt' } }])
  expect(result.sent.messages[2]).toEqual(request.messages[2])
  expect(result.events[0]!.content_block!.name).toBe('Read')
  expect(result.usage).toEqual(usage)
  expect(JSON.stringify(request)).toBe(original)
})

test('native sessions are stable, distinct and carry the reference descending timestamp', async () => {
  const first = await inspect(params())
  const session = first.sent.sessionId!
  expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  const timestamp = Number(BigInt.asUintN(48, ~BigInt(`0x${session.slice(4, 16)}`)) / 4096n)
  // The reference stores the low 48 bits of timestamp*4096, so the time
  // component wraps every 2^36 milliseconds.
  expect(Math.abs((Date.now() % 2 ** 36) - timestamp)).toBeLessThan(5000)
  expect((await inspect(params())).sent.sessionId).toBe(session)
  expect((await inspect({ ...params(), sessionId: 'another-session' })).sent.sessionId).not.toBe(session)
  expect((await inspect({ ...params(), sessionId: session })).sent.sessionId).toBe(session)
  expect((await inspect({ ...params(), sessionId: undefined })).sent.sessionId)
    .toBe((await inspect({ ...params(), sessionId: undefined })).sent.sessionId)
})

test('native-name collisions do not redirect one tool to another', async () => {
  const result = await inspect({ ...params(), tools: [...tools, { ...tools[1]!, name: 'read' }] })
  expect(result.sent.tools.map(tool => tool.name)).toContain('Read')
  expect(result.sent.tools.filter(tool => tool.name === 'read')).toHaveLength(1)
  expect(result.events[0]!.content_block!.name).toBe('read')
})

test('reduced tool sets stay reduced; no dummy tools or schema changes', async () => {
  expect((await inspect({ ...params(), tools: [] })).sent.tools).toEqual([])
  expect((await inspect({ ...params(), tools: [tools[1]!] })).sent.tools.map(tool => tool.name)).toEqual(['read'])
})

test('tool aliases retain hidden loading metadata and translate ToolSearch references', async () => {
  const read = { ...tools[1]! }
  Object.defineProperty(read, '__tau_should_defer', { value: true, enumerable: false })
  Object.defineProperty(read, '__tau_advisory_fields', { value: ['file_path'], enumerable: false })
  const references = [{ type: 'tool_reference', tool_name: 'Read' }]
  const result = await inspect({ ...params(), tools: [read], messages: [{
    role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: references as any }],
  }] })
  expect(result.sent.tools[0]!.__tau_should_defer).toBe(true)
  expect(result.sent.tools[0]!.__tau_advisory_fields).toEqual(['file_path'])
  expect(JSON.stringify(result.sent.tools)).not.toContain('__tau_')
  expect(JSON.stringify(result.sent.messages)).toContain('"tool_name":"read"')
  expect(references[0]!.tool_name).toBe('Read')
})

test('every selected cheap/normal tool keeps its schema, metadata and relative order', async () => {
  const core = [...CHEAP_MODE_CORE_TOOL_NAME_SET].map((name, index) => ({
    name, input_schema: { type: 'object', properties: { value: { enum: [index, null], default: index } }, required: ['value'] },
  }))
  const mcp: ProviderTool = {
    name: 'mcp__custom__lookup', description: 'Lookup', input_schema: {
      type: 'object', properties: { filters: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
      required: ['filters'], additionalProperties: false,
    },
  }
  for (const selected of [core, [...core, mcp, { ...mcp, name: 'Agent' }, { ...mcp, name: 'Skill' }]]) {
    const result = await inspect({ ...params(), tools: selected })
    expect(result.sent.tools).toHaveLength(selected.length)
    result.sent.tools.forEach((tool, i) => expect(tool.input_schema).toBe(selected[i]!.input_schema))
    expect(result.sent.tools.find(tool => tool.name === 'mcp__custom__lookup')).toBe(selected.includes(mcp) ? mcp : undefined)
  }
})

test('identical turns preserve the cache key and byte-identical tool/history prefix', async () => {
  const first = (await inspect(params())).sent
  const second = (await inspect(params())).sent
  expect(second.sessionId).toBe(first.sessionId)
  expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools))
  expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages))
  expect(second.system).toBe(first.system)
})

test('early cancellation closes the underlying stream', async () => {
  let closed = false
  const stream = streamOpenCodeZen(params(), async function* () {
    try {
      yield { type: 'content_block_start', content_block: { type: 'text', text: '' } }
      return usage
    } finally { closed = true }
  })
  await stream.next()
  await stream.return(usage)
  expect(closed).toBe(true)
})

const replies = {
  chat: sse(
    { id: 'r', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"file_path":"b.txt"}' } }] }, finish_reason: null }] },
    { id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ) + 'data: [DONE]\n\n',
  responses: sse(
    { type: 'response.created', response: { id: 'r' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":"b.txt"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read', arguments: '{"file_path":"b.txt"}' } },
    { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 10, output_tokens: 2 } } },
  ),
  messages: sse(
    { type: 'message_start', message: { id: 'r', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_2', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"b.txt"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ),
}

for (const [model, route] of [
  ['muse-spark-1.2-contributor-free', 'responses'],
  ['qwen3.6-plus-free', 'messages'],
  ['big-pickle', 'chat'],
] as const) {
  test(`${model}: real lane sends compatible headers/tools/history and restores streamed calls`, async () => {
    const lane = new OpenAICompatLane()
    lane.registerProvider('opencode', 'public', 'https://opencode.ai/zen/v1')
    const originalFetch = globalThis.fetch
    let body: any
    let headers!: Headers
    let url = ''
    globalThis.fetch = (async (input, init) => {
      url = String(input)
      headers = new Headers(init?.headers)
      body = JSON.parse(String(init?.body))
      return new Response(replies[route], { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const events: AnthropicStreamEvent[] = []
      for await (const event of lane.streamAsProvider(params(model))) events.push(event)
      expect(url).toBe(`https://opencode.ai/zen/v1/${route === 'chat' ? 'chat/completions' : route}`)
      expect(headers.get('User-Agent')).toBe('opencode/1.18.32')
      expect(headers.get('x-opencode-client')).toBe('opencode-tau/test')
      expect(headers.get('x-opencode-session')).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      if (route === 'messages') expect(body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' })
      else expect(body.prompt_cache_key).toBe(headers.get('x-opencode-session'))
      expect(body.tools.map((tool: any) => tool.function?.name ?? tool.name)).toContain('read')
      const history = JSON.stringify(body.input ?? body.messages)
      expect(history).toContain('"name":"read"')
      expect(history).not.toContain('"name":"Read"')
      expect(events.find(event => event.content_block?.type === 'tool_use')?.content_block?.name).toBe('Read')
      const args = events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta!.partial_json).join('')
      expect(JSON.parse(args)).toEqual({ file_path: 'b.txt' })
    } finally {
      globalThis.fetch = originalFetch
      lane.unregisterProvider('opencode')
    }
  })
}

test('repeated Responses tool completion emits one executable call and makes one request', async () => {
  const lane = new OpenAICompatLane()
  lane.registerProvider('opencode', 'public', 'https://opencode.ai/zen/v1')
  const originalFetch = globalThis.fetch
  let requests = 0
  const completed = sse({ type: 'response.output_item.done', output_index: 0,
    item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'read', arguments: '{"file_path":"b.txt"}' } })
  globalThis.fetch = (async (_input, _init) => {
    requests++
    return new Response(replies.responses.replace(completed, completed + completed), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    const events: AnthropicStreamEvent[] = []
    for await (const event of lane.streamAsProvider(params())) events.push(event)
    expect(requests).toBe(1)
    const calls = events.filter(event => event.content_block?.type === 'tool_use')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.content_block!.name).toBe('Read')
    expect(events.filter(event => event.delta?.type === 'input_json_delta')).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    lane.unregisterProvider('opencode')
  }
})

for (const [provider, model] of [['opencodego', 'big-pickle'], ['generic', 'big-pickle'], ['opencode', 'kimi-k2.6']] as const) {
  test(`${provider}/${model}: Go, other providers and paid Zen rows keep tool/session behavior`, async () => {
    const lane = new OpenAICompatLane()
    lane.registerProvider(provider, 'test-key', 'https://example.test/v1')
    const originalFetch = globalThis.fetch
    let body: any
    let headers!: Headers
    globalThis.fetch = (async (_input, init) => {
      headers = new Headers(init?.headers)
      body = JSON.parse(String(init?.body))
      return new Response(sse({ id: 'r', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')
    }) as typeof fetch
    try {
      for await (const _ of lane.streamAsProvider({ ...params(model), providerHint: provider })) { /* drain */ }
      expect(body.tools.map((tool: any) => tool.function.name)).toContain('Read')
      if (provider !== 'generic') expect(headers.get('x-opencode-session')).toBe('tau-session')
      else expect(headers.has('x-opencode-session')).toBe(false)
      if (provider === 'opencodego') expect(headers.get('User-Agent')).toBe('opencode/1.15.9')
    } finally {
      globalThis.fetch = originalFetch
      lane.unregisterProvider(provider)
    }
  })
}
