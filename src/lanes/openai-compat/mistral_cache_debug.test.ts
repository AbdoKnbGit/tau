import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { beginMistralCacheDebug } from './mistral_cache_debug.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'

const previousDebug = process.env.TAU_CACHE_DEBUG
beforeEach(() => { process.env.TAU_CACHE_DEBUG = '1' })
afterEach(() => {
  if (previousDebug === undefined) delete process.env.TAU_CACHE_DEBUG
  else process.env.TAU_CACHE_DEBUG = previousDebug
})

const usage = {
  prompt_tokens: 100, input_tokens: 10, output_tokens: 5,
  cache_read_input_tokens: 90, cache_creation_input_tokens: 0, reasoning_tokens: 3,
}
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function body(task: string): OpenAIChatRequest {
  return {
    model: 'mistral-large-4',
    messages: [{ role: 'system', content: 'secret system ✓' }, { role: 'user', content: task }],
    tools: [{ type: 'function', function: { name: 'private_tool', description: 'secret tool', parameters: {} } }],
    prompt_cache_key: 'private-session-id',
    reasoning_effort: 'high', max_tokens: 1024, temperature: 0.5, tool_choice: 'auto',
  }
}
function recorder() {
  const rows: any[] = []
  return { rows, write: (line: string) => { rows.push(JSON.parse(line)) } }
}

test('disabled diagnostics and every other provider are no-ops', () => {
  const { rows, write } = recorder()
  delete process.env.TAU_CACHE_DEBUG
  expect(beginMistralCacheDebug('mistral', body('disabled'), 'repl_main_thread', 'compat-1', write)).toBeUndefined()
  process.env.TAU_CACHE_DEBUG = '1'
  expect(beginMistralCacheDebug('openrouter', body('other'), 'repl_main_thread', 'compat-1', write)).toBeUndefined()
  expect(rows).toHaveLength(0)
})

test('hashes exact wire JSON, redacts private data and keeps request correlation unique', () => {
  const { rows, write } = recorder()
  const request = body('secret task for redaction')
  request.tool_choice = { type: 'function', function: { name: 'private_tool' } }
  request.user = 'private-user-id'
  request.extra_body = { authorization: 'secret credential' }
  const original = JSON.stringify(request)
  const trace = beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-1', write)!
  trace.response({ status: 200, headers: new Headers({
    'x-request-id': 'request-123', authorization: 'secret header',
    'set-cookie': 'secret cookie', 'x-mistral-request-id': 'https://private-url',
  }) })
  trace.frame({ id: 'completion-123', choices: [{ delta: { content: 'secret output' } }] })
  trace.finish('success', usage)
  beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-1', write)
  const snapshot = rows[0]
  expect(snapshot.tools_sha256).toBe(sha256(request.tools))
  expect(snapshot.system_sha256).toBe(sha256([request.messages[0]]))
  expect(snapshot.messages_sha256).toBe(sha256(request.messages))
  expect(snapshot.prompt_cache_key_sha256).toBe(sha256(request.prompt_cache_key))
  expect(snapshot.tool_choice_sha256).toBe(sha256(request.tool_choice))
  expect(snapshot.tool_choice).toBeUndefined()
  expect(snapshot.reasoning_effort).toBe('high')
  expect(snapshot.max_tokens.value).toBe(1024)
  expect(rows[1].request_ids).toEqual({ 'x-request-id': 'request-123' })
  expect(rows[3].upstream_completion_id).toBe('completion-123')
  expect(rows[4].trace_id).not.toBe(snapshot.trace_id)
  expect(rows[4].messages_sha256).toBe(snapshot.messages_sha256)
  expect(JSON.stringify(rows)).not.toMatch(/secret|private|authorization|set-cookie/)
  expect(JSON.stringify(request)).toBe(original)
})

test('exact prior-prefix comparison works across large extensions and catches reasoning changes', () => {
  const { rows, write } = recorder()
  const request = body('prefix comparison')
  request.messages.push({ role: 'assistant', content: null, reasoning_content: 'reasoning A' })
  beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-2', write)
  const previousHash = rows[0].messages_sha256
  request.messages.push(...Array.from({ length: 200 }, (_, index) => ({ role: 'user' as const, content: String(index) })))
  beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-3', write)
  expect(rows[1].prefix_matches_previous).toBe(true)
  expect(rows[1].messages_at_previous_count_sha256).toBe(previousHash)
  request.messages[2]!.reasoning_content = 'reasoning B'
  beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-4', write)
  expect(rows[2].prefix_matches_previous).toBe(false)
  request.messages.length = 2
  beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-5', write)
  expect(rows[3].prefix_matches_previous).toBe(false)
})

test('helpers and independent agent prompts do not replace the main comparison baseline', () => {
  const { rows, write } = recorder()
  const request = body('source separation')
  beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-6', write)
  beginMistralCacheDebug('mistral', { ...request, messages: [...request.messages, { role: 'user', content: 'suggestion branch' }] }, 'prompt_suggestion', 'compat-7', write)
  request.messages.push({ role: 'assistant', content: 'actual answer' })
  beginMistralCacheDebug('mistral', request, 'repl_main_thread', 'compat-8', write)
  expect(rows[1].stream_sha256).not.toBe(rows[0].stream_sha256)
  expect(rows[2].prefix_matches_previous).toBe(true)
  beginMistralCacheDebug('mistral', body('agent A'), 'agent:builtin:general-purpose', 'compat-9', write)
  beginMistralCacheDebug('mistral', body('agent B'), 'agent:builtin:general-purpose', 'compat-10', write)
  expect(rows[3].stream_sha256).not.toBe(rows[4].stream_sha256)
})

test('raw usage distinguishes omitted cached tokens, explicit zero and invalid values', () => {
  const { rows, write } = recorder()
  const trace = beginMistralCacheDebug('mistral', body('usage frames'), 'repl_main_thread', 'compat-11', write)!
  trace.frame({ id: 'completion-usage', usage: { prompt_tokens: 100 } })
  trace.frame({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } } })
  trace.frame({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 }, completion_tokens: 5 } })
  trace.frame({ usage: { prompt_tokens_details: { cached_tokens: 'secret invalid counter' }, private_field: 'secret field' } })
  trace.finish('success', usage)
  trace.finish('aborted', usage)
  const frames = rows.filter(row => row.event === 'usage')
  expect(frames[0].cached_tokens).toEqual({ present: false })
  expect(frames[1].cached_tokens).toEqual({ present: true, type: 'number', value: 0 })
  expect(frames[2].cached_tokens.value).toBe(90)
  expect(frames[3].cached_tokens).toEqual({ present: true, type: 'string' })
  const ends = rows.filter(row => row.event === 'end')
  expect(ends).toHaveLength(1)
  expect(ends[0].usage_frames).toBe(4)
  expect(ends[0].normalized_usage.cache_read_input_tokens.value).toBe(90)
  expect(JSON.stringify(rows)).not.toContain('secret')
})

test('failure and cancellation outcomes keep partial normalized usage and no error text', () => {
  for (const outcome of ['aborted', 'transport_error', 'http_error', 'stream_error', 'empty_response', 'consumer_closed'] as const) {
    const { rows, write } = recorder()
    const trace = beginMistralCacheDebug('mistral', body(`failure ${outcome}`), 'prompt_suggestion', 'compat-12', write)!
    trace.finish(outcome, usage)
    expect(rows[1].outcome).toBe(outcome)
    expect(rows[1].normalized_usage.input_tokens.value).toBe(10)
    expect(rows[1].usage_frames).toBe(0)
  }
})

test('disk failures and malformed diagnostic inputs never escape to inference', () => {
  const trace = beginMistralCacheDebug('mistral', body('writer failure'), undefined, 'compat-13', () => { throw new Error('disk full') })!
  expect(trace).toBeDefined()
  expect(() => trace.response({ status: 200, headers: new Headers() })).not.toThrow()
  expect(() => trace.frame({ usage: { prompt_tokens: 10 } })).not.toThrow()
  expect(() => trace.frame(new Proxy({}, { get() { throw new Error('bad frame') } }))).not.toThrow()
  expect(() => trace.finish('success', usage)).not.toThrow()
  const malformed = body('bad request')
  Object.defineProperty(malformed, 'tools', { get() { throw new Error('bad property') } })
  expect(beginMistralCacheDebug('mistral', malformed, undefined, 'compat-14', () => {})).toBeUndefined()
})
