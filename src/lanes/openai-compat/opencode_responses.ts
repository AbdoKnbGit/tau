/**
 * OpenCode Zen / Go rows the gateway serves on its OpenAI Responses route
 * (`/responses`): GPT, Grok and Muse Spark. The body mirrors what the
 * official client sends there — the Responses model of @ai-sdk/openai 3.0.88
 * with OpenCode's own options (packages/opencode/src/provider/transform.ts,
 * `options()` and the effort variants):
 *
 *   - `store: false`, and `prompt_cache_key` set to the session id.
 *   - The system prompt is the first input item, role `developer` on OpenAI
 *     reasoning models (gpt-5 and later, o-series) and `system` elsewhere.
 *   - `reasoning: { effort, summary: 'auto' }` only on OpenAI reasoning
 *     models. The SDK drops reasoning settings for any other id, so Grok and
 *     Muse Spark never carry them. GPT-5.x runs at `medium` when nothing is
 *     picked (OpenCode's default for those rows); GPT-6 then sends none.
 *   - `text: { verbosity: 'low' }` on GPT-5.x, except Codex rows.
 *   - `max_output_tokens` at most 32,000 (the client's OUTPUT_TOKEN_MAX), and
 *     temperature only where the model is not a reasoning model.
 *
 * Tools go out as `strict: false` function tools with schemas cleaned by the
 * Codex lane's sanitizer, the rules measured against the same backend.
 * Reasoning is not replayed: as in the Codex lane, thinking blocks stay in the
 * transcript but are not sent back, which keeps the input prefix stable.
 */

import type {
  AnthropicStreamEvent,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { decodeToolArguments, toolDecodeFields } from '../../services/mcp/decodeStatus.js'
import { toCodexToolParameters } from '../codex/tool_schema.js'
import { isMediaBlock } from '../shared/media_blocks.js'
import { renderMediaForTextLane } from '../shared/media_extract.js'
import type { NormalizedUsage } from '../types.js'
import { isOpenAIReasoningModel } from './opencode_anthropic_route.js'

/** The client's OUTPUT_TOKEN_MAX, which caps max_output_tokens. */
export const OPENCODE_MAX_OUTPUT_TOKENS = 32_000

/** OpenCode's `reasoningEffort: 'medium'` default for GPT-5 rows. */
function defaultEffortFor(id: string): string | undefined {
  return id.includes('gpt-5') && !id.includes('gpt-5-chat') && !id.includes('gpt-5-pro')
    ? 'medium'
    : undefined
}

function lowVerbosityFor(id: string): boolean {
  return id.includes('gpt-5.') && !id.includes('codex') && !id.includes('-chat')
}

export interface OpenCodeResponsesRequest {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ProviderTool[]
  maxTokens: number
  temperature?: number
  sessionId?: string
  /** The effort picked (or mapped from the session's thinking), if any. */
  effort?: string
  /** Send image parts; otherwise images become their text rendering. */
  canSeeImages: boolean
}

export function buildOpenCodeResponsesBody(
  request: OpenCodeResponsesRequest,
): Record<string, unknown> {
  const id = request.model.trim().toLowerCase()
  const reasoningModel = isOpenAIReasoningModel(id)
  const effort = reasoningModel ? request.effort ?? defaultEffortFor(id) : undefined
  const input: unknown[] = []
  if (request.system) {
    input.push({ role: reasoningModel ? 'developer' : 'system', content: request.system })
  }
  input.push(...convertMessagesToResponsesInput(request.messages, request.canSeeImages))

  return {
    model: request.model,
    input,
    max_output_tokens: Math.min(request.maxTokens, OPENCODE_MAX_OUTPUT_TOKENS),
    ...(!reasoningModel && request.temperature !== undefined && { temperature: request.temperature }),
    ...(lowVerbosityFor(id) && { text: { verbosity: 'low' } }),
    store: false,
    ...(request.sessionId && { prompt_cache_key: request.sessionId }),
    ...(effort && { reasoning: { effort, summary: 'auto' } }),
    ...(request.tools.length > 0 && {
      tools: request.tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: toCodexToolParameters(tool.input_schema),
        strict: false,
      })),
      tool_choice: 'auto',
    }),
    stream: true,
  }
}

function imageUrl(block: unknown): string | null {
  const source = (block as { source?: Record<string, unknown> } | null)?.source
  if (!source) return null
  if (source.type === 'base64' && typeof source.data === 'string') {
    return `data:${String(source.media_type ?? 'image/png')};base64,${source.data}`
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url
  return null
}

function toolResultText(content: unknown, imagesSentSeparately: boolean): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content
    .map(block => {
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text
      }
      if (isMediaBlock(block)) {
        return imagesSentSeparately && (block as { type?: string }).type === 'image'
          ? '[image attached below]'
          : renderMediaForTextLane(block)
      }
      return JSON.stringify(block)
    })
    .join('\n')
}

/** Tau's Anthropic-shaped history as Responses input items. */
export function convertMessagesToResponsesInput(
  messages: readonly ProviderMessage[],
  canSeeImages: boolean,
): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (!message.content) continue
      input.push(
        message.role === 'assistant'
          ? { role: 'assistant', content: [{ type: 'output_text', text: message.content }] }
          : { role: 'user', content: [{ type: 'input_text', text: message.content }] },
      )
      continue
    }

    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: block.text }] })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
      continue
    }

    // A tool's output answers its call as its own item; the user's text and
    // images follow as one message, as in the chat route.
    const parts: unknown[] = []
    const toolImages: unknown[] = []
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const images = canSeeImages && Array.isArray(block.content)
          ? block.content
              .map(child => (child?.type === 'image' ? imageUrl(child) : null))
              .filter((url): url is string => url !== null)
          : []
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: toolResultText(block.content, images.length > 0),
        })
        for (const url of images) toolImages.push({ type: 'input_image', image_url: url })
      } else if (block.type === 'text' && block.text) {
        parts.push({ type: 'input_text', text: block.text })
      } else if (block.type === 'image') {
        const url = canSeeImages ? imageUrl(block) : null
        parts.push(url
          ? { type: 'input_image', image_url: url }
          : { type: 'input_text', text: renderMediaForTextLane(block) })
      } else if (isMediaBlock(block)) {
        parts.push({ type: 'input_text', text: renderMediaForTextLane(block) })
      }
    }
    if (toolImages.length > 0) {
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text: 'Images from the tool result above:' }, ...toolImages],
      })
    }
    if (parts.length > 0) input.push({ role: 'user', content: parts })
  }
  return input
}

// ─── Stream ──────────────────────────────────────────────────────────

type OpenTextBlock = { kind: 'text' | 'thinking'; index: number; summaryIndex?: number }
type OpenBlock =
  | OpenTextBlock
  | { kind: 'tool'; callId: string; name: string; args: string }

/**
 * Turns Responses stream events into the Anthropic stream Tau consumes. Feed
 * each parsed `data:` payload to push(); finish() closes the message.
 */
export class OpenCodeResponsesStream {
  private started = false
  private nextIndex = 0
  private readonly open = new Map<number, OpenBlock>()
  private sawToolUse = false
  private truncated = false
  private inputTokens = 0
  private cachedTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  /** Set when the stream reported a failure. */
  failure: string | null = null

  constructor(
    private readonly model: string,
    private readonly messageId: string,
  ) {}

  private start(out: AnthropicStreamEvent[]): void {
    if (this.started) return
    this.started = true
    out.push({
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  private openText(
    out: AnthropicStreamEvent[],
    outputIndex: number,
    kind: 'text' | 'thinking',
  ): OpenTextBlock {
    const existing = this.open.get(outputIndex)
    if (existing && existing.kind === kind) return existing
    const block: OpenTextBlock = { kind, index: this.nextIndex++ }
    this.open.set(outputIndex, block)
    out.push({
      type: 'content_block_start',
      index: block.index,
      content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
    })
    return block
  }

  private closeBlock(out: AnthropicStreamEvent[], outputIndex: number, finalArgs?: string): void {
    const block = this.open.get(outputIndex)
    if (!block) return
    this.open.delete(outputIndex)
    if (block.kind === 'tool') {
      // One start, one complete argument delta, one stop: an inline `input`
      // on the start would leave the accumulator empty.
      const decoded = decodeToolArguments(finalArgs ?? block.args ?? '{}')
      const index = this.nextIndex++
      out.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.callId,
          name: block.name,
          input: {},
          ...toolDecodeFields(decoded),
        },
      })
      out.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(decoded.input ?? {}) },
      })
      out.push({ type: 'content_block_stop', index })
      this.sawToolUse = true
      return
    }
    out.push({ type: 'content_block_stop', index: block.index })
  }

  push(event: Record<string, unknown>): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    const type = String(event.type ?? '')
    const outputIndex = typeof event.output_index === 'number' ? event.output_index : -1
    const item = event.item as Record<string, unknown> | undefined

    switch (type) {
      case 'response.output_item.added':
        if (item?.type === 'function_call') {
          this.open.set(outputIndex, {
            kind: 'tool',
            callId: String(item.call_id ?? item.id ?? `call_${outputIndex}`),
            name: String(item.name ?? ''),
            args: typeof item.arguments === 'string' ? item.arguments : '',
          })
        }
        break
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) {
          const block = this.openText(out, outputIndex, 'text')
          out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text: event.delta } })
        }
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof event.delta === 'string' && event.delta) {
          const block = this.openText(out, outputIndex, 'thinking')
          const summaryIndex = typeof event.summary_index === 'number' ? event.summary_index : 0
          if (block.summaryIndex !== undefined && summaryIndex !== block.summaryIndex) {
            out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'thinking_delta', thinking: '\n\n' } })
          }
          block.summaryIndex = summaryIndex
          out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'thinking_delta', thinking: event.delta } })
        }
        break
      case 'response.function_call_arguments.delta': {
        const block = this.open.get(outputIndex)
        if (block?.kind === 'tool' && typeof event.delta === 'string') block.args += event.delta
        break
      }
      case 'response.function_call_arguments.done': {
        const block = this.open.get(outputIndex)
        if (block?.kind === 'tool' && typeof event.arguments === 'string') block.args = event.arguments
        break
      }
      case 'response.output_item.done':
        if (item?.type === 'function_call') {
          if (!this.open.has(outputIndex)) {
            this.open.set(outputIndex, {
              kind: 'tool',
              callId: String(item.call_id ?? item.id ?? `call_${outputIndex}`),
              name: String(item.name ?? ''),
              args: '',
            })
          }
          this.closeBlock(out, outputIndex, typeof item.arguments === 'string' && item.arguments ? item.arguments : undefined)
        } else if (item?.type === 'message' && !this.open.has(outputIndex)) {
          // A message that arrived whole, with no deltas.
          const text = Array.isArray(item.content)
            ? item.content
                .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
                .join('')
            : ''
          if (text) {
            const block = this.openText(out, outputIndex, 'text')
            out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text } })
            this.closeBlock(out, outputIndex)
          }
        } else {
          this.closeBlock(out, outputIndex)
        }
        break
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response as Record<string, unknown> | undefined
        this.readUsage(response?.usage)
        const reason = (response?.incomplete_details as { reason?: unknown } | undefined)?.reason
        if (type === 'response.incomplete' && reason === 'max_output_tokens') this.truncated = true
        break
      }
      case 'response.failed': {
        const error = (event.response as { error?: { message?: unknown } } | undefined)?.error
        this.failure = String(error?.message ?? 'response failed')
        break
      }
      case 'error':
        this.failure = String(event.message ?? (event.error as { message?: unknown } | undefined)?.message ?? 'stream error')
        break
    }
    return out
  }

  private readUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const usage = raw as Record<string, any>
    this.inputTokens = Number(usage.input_tokens ?? this.inputTokens) || 0
    this.cachedTokens = Number(usage.input_tokens_details?.cached_tokens ?? this.cachedTokens) || 0
    this.outputTokens = Number(usage.output_tokens ?? this.outputTokens) || 0
    this.reasoningTokens = Number(usage.output_tokens_details?.reasoning_tokens ?? this.reasoningTokens) || 0
  }

  /**
   * Close what is open and add the failure as text. A tool call still
   * streaming its arguments is dropped rather than sent half-written.
   */
  fail(text: string): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    for (const [outputIndex, block] of [...this.open.entries()]) {
      if (block.kind === 'tool') this.open.delete(outputIndex)
      else this.closeBlock(out, outputIndex)
    }
    const index = this.nextIndex++
    out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    out.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    out.push({ type: 'content_block_stop', index })
    return out
  }

  finish(): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    for (const outputIndex of [...this.open.keys()]) this.closeBlock(out, outputIndex)
    // Responses reports the whole prompt; Tau's buckets are additive.
    const fresh = Math.max(0, this.inputTokens - this.cachedTokens)
    out.push({
      type: 'message_delta',
      delta: { stop_reason: this.truncated ? 'max_tokens' : this.sawToolUse ? 'tool_use' : 'end_turn' },
      usage: {
        output_tokens: this.outputTokens,
        input_tokens: fresh,
        ...(this.cachedTokens > 0 && { cache_read_input_tokens: this.cachedTokens }),
      },
    })
    out.push({ type: 'message_stop' })
    return out
  }

  get usage(): NormalizedUsage {
    return {
      input_tokens: Math.max(0, this.inputTokens - this.cachedTokens),
      output_tokens: this.outputTokens,
      cache_read_tokens: this.cachedTokens,
      cache_write_tokens: 0,
      thinking_tokens: this.reasoningTokens,
    }
  }
}
