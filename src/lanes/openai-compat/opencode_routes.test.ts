/**
 * OpenCode Zen / Go routing: every row goes to the gateway route the official
 * client uses for it, in that route's wire format, and the reply comes back
 * as the Anthropic stream Tau consumes.
 *
 * Run: bun run src/lanes/openai-compat/opencode_routes.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the vision cache, thinking store and catalogue off the real config.
const dir = mkdtempSync(join(tmpdir(), 'tau-opencode-routes-'))
process.env.CLAUDE_CONFIG_DIR = dir
process.env.TAU_OPENCODE_THINKING_STORE = join(dir, 'thinking.json')
process.env.TAU_OPENCODE_MODELS_DEV_CACHE = join(dir, 'catalog.json')
// The client header otherwise reads a constant only the bundler defines.
process.env.OPENCODE_CLIENT = 'opencode-tau/test'

const { OpenAICompatLane } = await import('./loop.js')
const { openCodeRouteFor } = await import('./opencode_anthropic_route.js')
const { TRANSFORMERS } = await import('./transformers/index.js')
const catalog = await import('../../utils/model/opencodeModelsDevCatalog.js')
const thinking = await import('../../utils/model/opencodeThinking.js')

const effort = (values: string[]) => [{ type: 'effort', values }]
// The routing fields of a few models.dev rows, as published 2026-09-28.
const CATALOG = catalog.deriveOpencodeModelsDevCache({
  opencode: {
    models: {
      'claude-opus-5-5': { reasoning: true, reasoning_options: effort(['low', 'medium', 'high', 'xhigh', 'max']), provider: { npm: '@ai-sdk/anthropic' }, modalities: { input: ['text', 'image'] } },
      'gpt-5.5': { reasoning: true, reasoning_options: effort(['none', 'low', 'medium', 'high', 'xhigh']), provider: { npm: '@ai-sdk/openai' }, modalities: { input: ['text', 'image'] } },
      'gemini-3.7-flash': { reasoning: true, reasoning_options: effort(['low', 'medium', 'high']), provider: { npm: '@ai-sdk/google' }, modalities: { input: ['text', 'image'] } },
      'kimi-k2.6': { reasoning: true, reasoning_options: [{ type: 'toggle' }], interleaved: { field: 'reasoning_content' } },
      'qwen3.8-max': { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
    },
  },
  'opencode-go': {
    models: {
      'grok-4.7': { reasoning: true, reasoning_options: effort(['low', 'medium', 'high', 'xhigh']), provider: { npm: '@ai-sdk/openai' } },
      'minimax-m3': { reasoning: true, reasoning_options: [{ type: 'toggle' }], provider: { npm: '@ai-sdk/anthropic' } },
      'minimax-m2.7': { reasoning: true, reasoning_options: [], provider: { npm: '@ai-sdk/anthropic' } },
      'qwen3.8-flash': { reasoning: true, reasoning_options: effort(['low', 'medium', 'xhigh']), provider: { npm: '@ai-sdk/anthropic' } },
    },
  },
}, Date.now())

const sse = (events: object[]): string =>
  events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

const MESSAGES_SSE = sse([
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
])

const RESPONSES_SSE = sse([
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Plan.' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_text.delta', output_index: 1, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"file_path":' },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"a.txt"}' },
  { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.txt"}' } },
  { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 } } } },
])

const GEMINI_SSE = sse([
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Thinking.', thought: true }] } }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] } }] },
  {
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Read', args: { file_path: 'a.txt' } }, thoughtSignature: 'sig-1' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 300, candidatesTokenCount: 20, thoughtsTokenCount: 10 },
  },
])

const CHAT_SSE = sse([
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
]) + 'data: [DONE]\n\n'

const READ_TOOL = {
  name: 'Read',
  description: 'Read a file',
  input_schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
    additionalProperties: false,
  },
}

type Captured = { url: string; headers: Record<string, string>; body: any; events: any[]; requests: number }

async function capture(
  provider: 'opencode' | 'opencodego',
  model: string,
  messages: any[],
  reply?: () => Response,
): Promise<Captured> {
  const lane = new OpenAICompatLane()
  lane.registerProvider(
    provider,
    'test-key',
    provider === 'opencodego' ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1',
  )
  const oldFetch = globalThis.fetch
  let seen: Omit<Captured, 'events' | 'requests'> = { url: '', headers: {}, body: {} }
  let requests = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    requests++
    seen = { url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body ?? '{}')) }
    if (reply) return reply()
    const text = url.endsWith('/messages') ? MESSAGES_SSE
      : url.endsWith('/responses') ? RESPONSES_SSE
        : url.includes(':streamGenerateContent') ? GEMINI_SSE
          : CHAT_SSE
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    const events: any[] = []
    for await (const event of lane.streamAsProvider({
      model,
      messages,
      system: 'You are a coding agent.',
      tools: [READ_TOOL],
      max_tokens: 64_000,
      temperature: 1,
      thinking: { type: 'disabled' },
      signal: new AbortController().signal,
      sessionId: 'session-1',
      providerHint: provider,
    })) events.push(event)
    return { ...seen, events, requests }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider(provider)
  }
}

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

console.log('OpenCode routes:')

await test('each row goes to the route of the SDK models.dev names for it', () => {
  catalog._resetOpencodeModelsDevForTests(CATALOG)
  assert.equal(openCodeRouteFor('opencode', 'claude-opus-5-5'), 'messages')
  assert.equal(openCodeRouteFor('opencode', 'gpt-5.5'), 'responses')
  assert.equal(openCodeRouteFor('opencode', 'gemini-3.7-flash'), 'google')
  assert.equal(openCodeRouteFor('opencode', 'kimi-k2.6'), 'chat')
  assert.equal(openCodeRouteFor('opencode', 'qwen3.6-plus'), 'messages', 'pinned qwen row')
  assert.equal(openCodeRouteFor('opencode', 'qwen3.8-max'), 'chat')
  assert.equal(openCodeRouteFor('opencodego', 'minimax-m2.7'), 'messages')
  assert.equal(openCodeRouteFor('opencodego', 'grok-4.7'), 'responses')
  assert.equal(openCodeRouteFor('opencode', 'jev-1.13-free'), 'systemone')
})

await test('without the catalogue the documented families decide', () => {
  catalog._resetOpencodeModelsDevForTests(null)
  assert.equal(openCodeRouteFor('opencode', 'claude-sonnet-9'), 'messages')
  assert.equal(openCodeRouteFor('opencode', 'gpt-7'), 'responses')
  assert.equal(openCodeRouteFor('opencode', 'gemini-4-pro'), 'google')
  assert.equal(openCodeRouteFor('opencode', 'kimi-k9'), 'chat')
  catalog._resetOpencodeModelsDevForTests(CATALOG)
})

await test('a chip only where the route can carry the pick', () => {
  assert(thinking.supportsOpencodeThinkingSelection('opencode', 'gpt-5.5'), 'gpt-5.5')
  assert(!thinking.supportsOpencodeThinkingSelection('opencodego', 'grok-4.7'), 'grok: the SDK sends no reasoning')
  assert(!thinking.supportsOpencodeThinkingSelection('opencodego', 'minimax-m2.7'), 'minimax: fixed by OpenCode')
  assert(thinking.supportsOpencodeThinkingSelection('opencodego', 'qwen3.8-flash'), 'qwen3.8-flash')
})

await test('Claude goes to /messages with adaptive thinking and a clean history', async () => {
  thinking._resetOpencodeThinkingForTests({ 'claude-opus-5-5': 'xhigh' })
  const r = await capture('opencode', 'claude-opus-5-5', [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'another model', signature: '' },
        { type: 'thinking', thinking: '', signature: 'sig-anthropic' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' }, _gemini_thought_signature: 'g' },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] },
  ])
  assert.equal(r.url, 'https://opencode.ai/zen/v1/messages')
  assert.equal(r.headers['x-api-key'], 'test-key')
  assert.equal(r.headers.Authorization, undefined)
  assert.deepEqual(r.body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(r.body.output_config, { effort: 'xhigh' })
  assert.equal(r.body.temperature, undefined)
  assert.equal(r.body.max_tokens, 32_000)
  const assistant = r.body.messages[1].content
  assert.deepEqual(assistant.filter((b: any) => b.type === 'thinking').map((b: any) => b.signature), ['sig-anthropic'])
  assert.equal(assistant.find((b: any) => b.type === 'tool_use')._gemini_thought_signature, undefined)

  thinking._resetOpencodeThinkingForTests({})
  const d = await capture('opencode', 'claude-opus-5-5', [{ role: 'user', content: 'hi' }])
  assert.equal(d.body.thinking, undefined, 'Default leaves the model its own default')
  assert.equal(d.body.output_config, undefined)
})

await test('MiniMax M3 on Go gets OpenCode\'s adaptive default on /messages', async () => {
  const r = await capture('opencodego', 'minimax-m3', [{ role: 'user', content: 'hi' }])
  assert.equal(r.url, 'https://opencode.ai/zen/go/v1/messages')
  assert.deepEqual(r.body.thinking, { type: 'adaptive' })
})

await test('GPT goes to /responses and streams back thinking, text and a tool call', async () => {
  thinking._resetOpencodeThinkingForTests({})
  const r = await capture('opencode', 'gpt-5.5', [{ role: 'user', content: 'hi' }])
  assert.equal(r.url, 'https://opencode.ai/zen/v1/responses')
  assert.equal(r.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(r.body.input[0], { role: 'developer', content: 'You are a coding agent.' })
  assert.deepEqual(r.body.reasoning, { effort: 'medium', summary: 'auto' })
  assert.deepEqual(r.body.text, { verbosity: 'low' })
  assert.equal(r.body.store, false)
  assert.equal(r.body.prompt_cache_key, 'session-1')
  assert.equal(r.body.max_output_tokens, 32_000)
  assert.equal(r.body.temperature, undefined)
  assert.equal(r.body.tools[0].type, 'function')
  assert.equal(r.body.tools[0].strict, false)

  const kinds = r.events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type)
  assert.deepEqual(kinds, ['thinking', 'text', 'tool_use'])
  const args = r.events.find(e => e.delta?.type === 'input_json_delta').delta.partial_json
  assert.deepEqual(JSON.parse(args), { file_path: 'a.txt' })
  const end = r.events.find(e => e.type === 'message_delta')
  assert.equal(end.delta.stop_reason, 'tool_use')
  assert.deepEqual(end.usage, { output_tokens: 50, input_tokens: 200, cache_read_input_tokens: 800 })
})

await test('Grok on Go goes to /responses with no reasoning and its temperature', async () => {
  thinking._resetOpencodeThinkingForTests({ 'grok-4.7': 'high' })
  const r = await capture('opencodego', 'grok-4.7', [{ role: 'user', content: 'hi' }])
  assert.equal(r.url, 'https://opencode.ai/zen/go/v1/responses')
  assert.equal(r.body.input[0].role, 'system')
  assert.equal(r.body.reasoning, undefined)
  assert.equal(r.body.temperature, 1)
})

await test('Gemini goes to Google\'s route and keeps thought signatures on calls', async () => {
  thinking._resetOpencodeThinkingForTests({})
  const r = await capture('opencode', 'gemini-3.7-flash', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_g', name: 'Read', input: { file_path: 'a' }, _gemini_thought_signature: 'sig-prev' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_g', content: 'x' }] },
  ])
  assert.equal(r.url, 'https://opencode.ai/zen/v1/models/gemini-3.7-flash:streamGenerateContent?alt=sse')
  assert.equal(r.headers['x-goog-api-key'], 'test-key')
  assert.equal(r.headers.Authorization, undefined)
  assert.deepEqual(r.body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'high' })
  assert.equal(r.body.generationConfig.maxOutputTokens, 32_000)
  assert.deepEqual(r.body.systemInstruction, { parts: [{ text: 'You are a coding agent.' }] })
  assert.equal(r.body.contents[1].parts[0].thoughtSignature, 'sig-prev')
  assert.equal(r.body.contents[2].parts[0].functionResponse.name, 'Read')
  assert.equal(r.body.tools[0].functionDeclarations[0].parameters.$schema, undefined)

  const kinds = r.events.filter(e => e.type === 'content_block_start').map(e => e.content_block.type)
  assert.deepEqual(kinds, ['thinking', 'text', 'tool_use'])
  const call = r.events.find(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use')
  assert.equal(call.content_block._gemini_thought_signature, 'sig-1')
  const end = r.events.find(e => e.type === 'message_delta')
  assert.equal(end.delta.stop_reason, 'tool_use')
  assert.deepEqual(end.usage, { output_tokens: 30, input_tokens: 200, cache_read_input_tokens: 300 })
})

await test('Jev is explained, not requested, and hidden from both catalogs', async () => {
  const r = await capture('opencode', 'jev-1.13', [{ role: 'user', content: 'hi' }])
  assert.equal(r.url, '', 'no request is sent')
  const text = r.events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('')
  assert.match(text, /System One/)
  const ids = (provider: 'opencode' | 'opencodego') =>
    (TRANSFORMERS[provider].filterModelCatalog?.([{ id: 'jev-1.13' }, { id: 'kimi-k2.6' }]) ?? []).map(m => m.id)
  assert.deepEqual(ids('opencode'), ['kimi-k2.6'])
  assert.deepEqual(ids('opencodego'), ['kimi-k2.6'])
})

// A gateway rejection can still occur, for example with a reduced tool set.
const FREE_TIER_403 = () => new Response(
  '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}',
  { status: 403, headers: { 'content-type': 'application/json' } },
)
const replyText = (r: Captured): string =>
  r.events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('')

await test('a Zen free-tier refusal is explained on every route, with one request', async () => {
  const rows = [
    ['ling-3.0-flash-fin-free', 'chat/completions'],
    ['qwen3.6-plus-free', 'messages'],
    ['muse-spark-1.3-contributor-free', 'responses'],
  ] as const
  for (const [model, route] of rows) {
    const r = await capture('opencode', model, [{ role: 'user', content: 'hey' }], FREE_TIER_403)
    assert.equal(r.url, `https://opencode.ai/zen/v1/${route}`)
    assert.equal(r.requests, 1, `${model}: not retried`)
    const text = replyText(r)
    assert.match(text, /^opencode API error 403: OpenCode Zen rejected the free-tier request/)
    assert(text.includes(`for ${model}.`), text)
    assert(text.includes('standard tools enabled'), text)
    assert(text.includes('/models opencode'), text)
    assert(text.endsWith("OpenCode says: OpenCode's free tier can only be used from within OpenCode"), text)
  }
})

await test('other 403s on Zen, and Go, keep the raw error', async () => {
  const other = await capture('opencode', 'kimi-k2.6', [{ role: 'user', content: 'hey' }],
    () => new Response('{"error":{"message":"Forbidden"}}', { status: 403 }))
  assert.equal(replyText(other), 'opencode API error 403: {"error":{"message":"Forbidden"}}')
  const go = await capture('opencodego', 'minimax-m3', [{ role: 'user', content: 'hey' }], FREE_TIER_403)
  assert.equal(replyText(go), `opencodego API error 403: ${await FREE_TIER_403().text()}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
