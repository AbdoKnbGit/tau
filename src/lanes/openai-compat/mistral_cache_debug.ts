import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenAIChatRequest } from './transformers/shared_types.js'

type Outcome = 'success' | 'aborted' | 'transport_error' | 'http_error' | 'stream_error' | 'empty_response' | 'consumer_closed'
type NumericUsage = {
  prompt_tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  reasoning_tokens: number
}
type Writer = (line: string) => void

export interface MistralCacheDebug {
  response(response: Pick<Response, 'status' | 'headers'>): void
  frame(chunk: unknown): void
  finish(outcome: Outcome, usage: NumericUsage): void
}

const own = (value: unknown, key: string): boolean =>
  value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const previousStreams = new Map<string, { messages: number; sha256: string }>()
const MAX_STREAMS = 128

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
    ? value
    : undefined
}

function numericField(value: unknown, key: string): Record<string, unknown> {
  const field = record(value)[key]
  return {
    present: own(value, key),
    ...(own(value, key) && { type: field === null ? 'null' : typeof field }),
    ...(typeof field === 'number' && Number.isFinite(field) && { value: field }),
  }
}

function numericFields(value: unknown, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, numericField(value, key)]))
}

function requestSnapshot(body: OpenAIChatRequest, querySource: string | undefined): Record<string, unknown> {
  const { messages, tools, ...settings } = body
  const source = !querySource || querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    ? 'main'
    : querySource
  // Distinguish helper branches and separate agents of the same type without
  // writing their task prompts or retaining any conversation content.
  const stream = sha256([body.model, body.prompt_cache_key, source, messages.find(message => message.role === 'user')])
  const previous = previousStreams.get(stream)
  let previousPrefix = previous?.messages === 0 ? sha256([]) : undefined
  const hash = createHash('sha256').update('[')
  for (let index = 0; index < messages.length; index++) {
    if (index) hash.update(',')
    hash.update(JSON.stringify(messages[index]))
    if (previous?.messages === index + 1) {
      previousPrefix = hash.copy().update(']').digest('hex')
    }
  }
  const messagesHash = hash.update(']').digest('hex')
  previousStreams.delete(stream)
  previousStreams.set(stream, { messages: messages.length, sha256: messagesHash })
  if (previousStreams.size > MAX_STREAMS) previousStreams.delete(previousStreams.keys().next().value!)
  return {
    stream_sha256: stream,
    tools_sha256: sha256(tools),
    system_sha256: sha256(messages.filter(message => message.role === 'system')),
    messages_sha256: messagesHash,
    previous_message_count: previous?.messages,
    previous_messages_sha256: previous?.sha256,
    messages_at_previous_count_sha256: previousPrefix,
    prefix_matches_previous: previous ? previous.sha256 === previousPrefix : undefined,
    message_count: messages.length,
    tool_count: tools?.length ?? 0,
    settings_sha256: sha256(settings),
    prompt_cache_key_present: own(body, 'prompt_cache_key'),
    prompt_cache_key_sha256: own(body, 'prompt_cache_key') ? sha256(body.prompt_cache_key) : undefined,
    model: identifier(body.model),
    reasoning_effort: identifier(body.reasoning_effort),
    ...numericFields(body, ['max_tokens', 'temperature', 'top_p']),
    tool_choice: ['auto', 'required', 'none', 'any'].includes(body.tool_choice as string)
      ? body.tool_choice
      : undefined,
    tool_choice_sha256: own(body, 'tool_choice') ? sha256(body.tool_choice) : undefined,
  }
}

/** Mistral-only, opt-in diagnostics. No prompt text, tool definitions, error
 * text, credentials, URLs or session/user identifiers are written. The writer
 * argument is for isolated tests; production uses the separate temp JSONL. */
export function beginMistralCacheDebug(
  provider: string,
  body: OpenAIChatRequest,
  querySource: string | undefined,
  localRequestId: string,
  write: Writer = line => appendFileSync(join(tmpdir(), 'tau-mistral-cache-debug.jsonl'), line),
): MistralCacheDebug | undefined {
  if (provider !== 'mistral' || !process.env.TAU_CACHE_DEBUG) return undefined
  try {
    const common = {
      provider: 'mistral',
      trace_id: randomUUID(),
      local_request_id: identifier(localRequestId),
      query_source: identifier(querySource),
    }
    let finished = false
    let usageFrames = 0
    let completionId: string | undefined
    const emit = (event: string, fields: Record<string, unknown>) => {
      try {
        write(`${JSON.stringify({ ts: new Date().toISOString(), ...common, event, ...fields })}\n`)
      } catch {
        // Diagnostics must never affect inference, including disk failures.
      }
    }
    emit('request', requestSnapshot(body, querySource))
    return {
      response(response) {
        try {
          const requestIds = Object.fromEntries(
            ['x-request-id', 'request-id', 'x-mistral-request-id']
              .map(name => [name, identifier(response.headers.get(name))])
              .filter(([, value]) => value !== undefined),
          )
          emit('response', { status: response.status, request_ids: requestIds })
        } catch { /* Optional diagnostics. */ }
      },
      frame(chunk) {
        try {
          if (finished) return
          const value = record(chunk)
          const id = identifier(value.id)
          if (id && id !== completionId) {
            completionId = id
            emit('completion', { upstream_completion_id: id })
          }
          if (!own(value, 'usage')) return
          usageFrames++
          const usage = record(value.usage)
          emit('usage', {
            frame: usageFrames,
            usage_present: true,
            usage_type: value.usage === null ? 'null' : typeof value.usage,
            ...numericFields(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']),
            prompt_tokens_details_present: own(usage, 'prompt_tokens_details'),
            cached_tokens: numericField(usage.prompt_tokens_details, 'cached_tokens'),
            cache_write_tokens: numericField(usage.prompt_tokens_details, 'cache_write_tokens'),
            reasoning_tokens: numericField(usage.completion_tokens_details, 'reasoning_tokens'),
          })
        } catch { /* Optional diagnostics. */ }
      },
      finish(outcome, usage) {
        try {
          if (finished) return
          finished = true
          emit('end', {
            outcome,
            upstream_completion_id: completionId,
            usage_frames: usageFrames,
            normalized_usage: numericFields(usage, ['prompt_tokens', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'reasoning_tokens']),
          })
        } catch { /* Optional diagnostics. */ }
      },
    }
  } catch {
    return undefined
  }
}
