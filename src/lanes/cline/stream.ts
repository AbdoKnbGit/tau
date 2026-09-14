/**
 * Reader for Cline's chat-completions stream.
 *
 * Three things the gateway can send used to vanish. An error payload inside a
 * 200 stream and a plain JSON body where SSE was expected both left a turn
 * with no text and no error at all. Usage that arrives in its own chunk after
 * `finish_reason` was dropped too, so every token read as zero and the cache
 * hit rate as null. This reader keeps all three and hands the lane either the
 * finished events with real usage, or the failure to report.
 */

import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import {
  openAIStreamToAnthropicEvents,
  type OpenAIChatCompletionChunk,
} from '../../services/api/adapters/openai_to_anthropic.js'
import type { NormalizedUsage } from '../types.js'
import { coerceClineToolCallArguments } from './tool_arg_validation.js'

export interface RawClineUsage {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  prompt_tokens_details?: {
    cached_tokens?: number | null
    cache_write_tokens?: number | null
  } | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export interface ClineStreamFailure {
  /** 'stream': the gateway reported an error. 'empty': nothing came back. */
  kind: 'stream' | 'empty'
  /** HTTP-style status, when the payload carried one. */
  status?: number
  message: string
  /** The payload as received, for the error text and the retry controller. */
  raw: string
}

export interface ClineCollectedStream {
  events: AnthropicStreamEvent[]
  usage: NormalizedUsage
  failure: ClineStreamFailure | null
}

interface ClineStreamState {
  dataEvents: number
  failure: ClineStreamFailure | null
  sawCleanFinish: boolean
  usage: RawClineUsage | null
  nonSseText: string
}

const NON_SSE_TEXT_LIMIT = 256 * 1024
const RAW_PAYLOAD_LIMIT = 2_000

export async function collectClineStream(
  body: ReadableStream<Uint8Array>,
): Promise<ClineCollectedStream> {
  const state: ClineStreamState = {
    dataEvents: 0,
    failure: null,
    sawCleanFinish: false,
    usage: null,
    nonSseText: '',
  }
  const events: AnthropicStreamEvent[] = []
  const chunks = normalizeClineChunks(readClineSse(body, state), state)
  for await (const event of openAIStreamToAnthropicEvents(chunks)) {
    events.push(event)
  }

  const usage = clineUsageFromRaw(state.usage)
  // Nothing has been shown yet, so a failed stream drops its partial output
  // instead of leaving half an answer that looks finished.
  if (state.failure && !state.sawCleanFinish) {
    return { events: [], usage, failure: state.failure }
  }
  if (!events.some(event => event.type === 'content_block_start')) {
    return {
      events: [],
      usage,
      failure: {
        kind: 'empty',
        message: 'the response ended without text, a tool call or an error',
        raw: state.nonSseText.trim().slice(0, 500),
      },
    }
  }
  return {
    events: endOnce(state.usage ? withClineUsage(events, usage) : events),
    usage,
    failure: null,
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/**
 * The gateway reports OpenAI-style usage: `prompt_tokens` includes cache
 * reads (`prompt_tokens_details.cached_tokens`) and cache writes
 * (`cache_creation_input_tokens`), which is how Cline's SDK prices it. Tau
 * counts the three separately, Anthropic style.
 */
export function clineUsageFromRaw(raw: RawClineUsage | null): NormalizedUsage {
  const prompt = tokenCount(raw?.prompt_tokens)
  const cacheRead = tokenCount(raw?.prompt_tokens_details?.cached_tokens)
    || tokenCount(raw?.cache_read_input_tokens)
  const cacheWrite = tokenCount(raw?.cache_creation_input_tokens)
    || tokenCount(raw?.prompt_tokens_details?.cache_write_tokens)
  // A route that reports writes outside prompt_tokens would go negative;
  // subtract only the reads there.
  const freshInput = prompt >= cacheRead + cacheWrite
    ? prompt - cacheRead - cacheWrite
    : Math.max(0, prompt - cacheRead)
  return {
    input_tokens: freshInput,
    output_tokens: tokenCount(raw?.completion_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    thinking_tokens: 0,
  }
}

function withClineUsage(
  events: AnthropicStreamEvent[],
  usage: NormalizedUsage,
): AnthropicStreamEvent[] {
  return events.map(event => {
    if (event.type !== 'message_delta') return event
    const previous = (event as { usage?: { output_tokens?: number } }).usage
    return {
      ...event,
      usage: {
        ...previous,
        output_tokens: usage.output_tokens || (previous?.output_tokens ?? 0),
        input_tokens: usage.input_tokens,
        cache_read_input_tokens: usage.cache_read_tokens,
        cache_creation_input_tokens: usage.cache_write_tokens,
      },
    } as AnthropicStreamEvent
  })
}

/**
 * End the response once. Some Cline routes repeat finish_reason on the
 * trailing usage chunk, and the shared adapter then ends the message again: a
 * second message_delta and message_stop, and a second stop for every tool
 * block. claude.ts adds a response's usage to the session once per
 * message_delta, so each such request was counted twice, and each repeated
 * stop re-emits a tool call. The first ending, which already carries the
 * final usage, closes the stream; the repeat is dropped. A stream that ended
 * once comes back untouched.
 */
function endOnce(events: AnthropicStreamEvent[]): AnthropicStreamEvent[] {
  const ending = events.find(event => event.type === 'message_delta')
  const firstStop = events.findIndex(event => event.type === 'message_stop')
  const endings = events.filter(event => event.type === 'message_delta').length
  if (!ending || firstStop < 0 || endings < 2) return events

  // Blocks the first ending closed, or deliberately left open (a tool call
  // cut off by the output cap). The repeat must not stop them again.
  const settled = new Set<number>()
  for (const event of events.slice(0, firstStop)) {
    if (event.type === 'content_block_start' && typeof event.index === 'number') {
      settled.add(event.index)
    }
  }

  const kept: AnthropicStreamEvent[] = []
  events.forEach((event, position) => {
    if (event.type === 'message_delta' || event.type === 'message_stop') return
    if (position > firstStop && typeof event.index === 'number') {
      // A block that starts after the first ending is new output: keep it whole.
      if (event.type === 'content_block_start') settled.delete(event.index)
      else if (event.type === 'content_block_stop' && settled.has(event.index)) return
    }
    kept.push(event)
  })
  return [...kept, ending, events[firstStop]!]
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function httpStatus(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d{3}$/.test(value.trim())
    ? Number(value)
    : value
  return typeof parsed === 'number' && Number.isInteger(parsed)
    && parsed >= 100 && parsed <= 599
    ? parsed
    : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * The error a gateway payload carries, if any. Covers Cline's own envelope
 * (`{"error":{"code":"API_REQUEST_ERROR_CODE","message":"Error 403: ..."}}`),
 * OpenAI/OpenRouter-style `{"error":{"code":429,"message":...}}`, and
 * `{"success":false,...}`.
 */
export function clineFailureFromPayload(
  payload: unknown,
  assumeError = false,
): ClineStreamFailure | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const error = record.error
  const hasError = error !== undefined && error !== null && error !== false
  if (!hasError && record.success !== false && record.type !== 'error' && !assumeError) {
    return null
  }

  const detail = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined
  const message = (typeof error === 'string' ? stringField(error) : undefined)
    ?? stringField(detail?.message)
    ?? stringField(record.message)
    ?? stringField(detail?.error)
    ?? JSON.stringify(error ?? record)
  const status = httpStatus(detail?.code)
    ?? httpStatus(detail?.status)
    ?? httpStatus(record.status)
    ?? httpStatus(message.match(/\b(?:error|status|http)\s*:?\s*([1-5]\d{2})\b/i)?.[1])
  return {
    kind: 'stream',
    ...(status !== undefined ? { status } : {}),
    message,
    raw: JSON.stringify(payload).slice(0, RAW_PAYLOAD_LIMIT),
  }
}

function takeData(
  payload: string,
  eventName: string,
  state: ClineStreamState,
): OpenAIChatCompletionChunk | null {
  if (!payload || payload === '[DONE]') return null
  state.dataEvents++
  const parsed = parseJson(payload)
  if (parsed === undefined) {
    if (eventName === 'error') {
      state.failure ??= {
        kind: 'stream',
        message: payload,
        raw: payload.slice(0, RAW_PAYLOAD_LIMIT),
      }
    }
    return null
  }
  const failure = clineFailureFromPayload(parsed, eventName === 'error')
  if (failure) state.failure ??= failure
  const chunk = parsed as Partial<OpenAIChatCompletionChunk>
  return Array.isArray(chunk.choices) || chunk.usage
    ? parsed as OpenAIChatCompletionChunk
    : null
}

async function* readClineSse(
  body: ReadableStream<Uint8Array>,
  state: ClineStreamState,
): AsyncGenerator<OpenAIChatCompletionChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''

  const takeLine = (rawLine: string): OpenAIChatCompletionChunk | null => {
    const line = rawLine.trim()
    if (!line) {
      eventName = ''
      return null
    }
    if (line.startsWith(':')) return null
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim().toLowerCase()
      return null
    }
    if (line.startsWith('data:')) return takeData(line.slice(5).trim(), eventName, state)
    if (/^(?:id|retry):/.test(line)) return null
    if (state.nonSseText.length < NON_SSE_TEXT_LIMIT) {
      state.nonSseText += `${rawLine}\n`
    }
    return null
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const chunk = takeLine(rawLine)
        if (chunk) yield chunk
      }
    }
    buffer += decoder.decode()
    for (const rawLine of buffer.split('\n')) {
      const chunk = takeLine(rawLine)
      if (chunk) yield chunk
    }
  } finally {
    reader.releaseLock()
  }

  // A body that was never SSE: a JSON error envelope, or a whole completion
  // from a route that ignored `stream: true`.
  if (state.dataEvents === 0 && state.nonSseText.trim()) {
    const payload = parseJson(state.nonSseText.trim())
    if (payload === undefined) return
    const failure = clineFailureFromPayload(payload)
    if (failure) {
      state.failure ??= failure
      return
    }
    const chunk = completionToChunk(payload)
    if (chunk) {
      state.dataEvents++
      yield chunk
    }
  }
}

interface RawCompletionChoice {
  index?: number
  finish_reason?: string | null
  message?: {
    content?: unknown
    reasoning_content?: string | null
    reasoning?: string | null
    tool_calls?: Array<{
      id?: string
      type?: string
      function?: { name?: string; arguments?: string }
    }> | null
  } | null
}

function completionToChunk(payload: unknown): OpenAIChatCompletionChunk | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as {
    id?: string
    model?: string
    choices?: unknown
    usage?: RawClineUsage | null
  }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return null
  const choices = (record.choices as RawCompletionChoice[]).map((choice, index) => {
    const message = choice?.message ?? {}
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    return {
      index: typeof choice?.index === 'number' ? choice.index : index,
      delta: {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        reasoning_content: message.reasoning_content ?? message.reasoning ?? null,
        ...(toolCalls.length > 0 && {
          tool_calls: toolCalls.map((call, callIndex) => ({
            index: callIndex,
            id: call.id,
            type: call.type ?? 'function',
            function: call.function,
          })),
        }),
      },
      finish_reason: choice?.finish_reason ?? 'stop',
    }
  })
  return {
    id: record.id ?? `cline-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: record.model ?? '',
    choices,
    usage: record.usage ?? null,
  } as OpenAIChatCompletionChunk
}

async function* normalizeClineChunks(
  chunks: AsyncIterable<OpenAIChatCompletionChunk>,
  state: ClineStreamState,
): AsyncGenerator<OpenAIChatCompletionChunk> {
  for await (const chunk of chunks) {
    // Every chunk may repeat usage; the last one is the final count.
    if (chunk.usage) state.usage = chunk.usage as RawClineUsage
    const choices = Array.isArray(chunk.choices)
      ? chunk.choices.map((choice) => {
        if (choice.finish_reason && choice.finish_reason !== 'error') {
          state.sawCleanFinish = true
        }
        const delta = { ...(choice.delta ?? {}) } as OpenAIChatCompletionChunk['choices'][number]['delta'] & {
          reasoning?: string
        }
        if (typeof delta.reasoning === 'string' && !delta.reasoning_content) {
          delta.reasoning_content = delta.reasoning
        }
        // Some Cline upstreams return tool-call arguments as a parsed JSON
        // object instead of the OpenAI-spec string. Left as-is, the Anthropic
        // adapter concatenates it into "[object Object]" and every tool call
        // decodes to {}. Coerce object/array arguments to a JSON string.
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls = coerceClineToolCallArguments(
            delta.tool_calls,
          ) as typeof delta.tool_calls
        }
        return { ...choice, delta }
      })
      : chunk.choices

    yield { ...chunk, choices }
  }
}
