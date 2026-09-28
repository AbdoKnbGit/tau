/**
 * OpenCode Zen rows the gateway serves in Google's format: Gemini, at
 * `/models/{id}:streamGenerateContent?alt=sse` with the key in
 * `x-goog-api-key`. The body mirrors @ai-sdk/google 3.0.73 with OpenCode's
 * options (packages/opencode/src/provider/transform.ts):
 *
 *   - `thinkingConfig: { includeThoughts: true }`, at `thinkingLevel: 'high'`
 *     on Gemini 3 unless a level is picked, which then replaces it.
 *   - Function declarations with the SDK's JSON Schema → OpenAPI conversion,
 *     and `toolConfig.functionCallingConfig.mode: 'AUTO'`.
 *   - `maxOutputTokens` at most 32,000 (the client's OUTPUT_TOKEN_MAX).
 *   - Gemini 3 takes images inside `functionResponse.parts`.
 *
 * A function call's `thoughtSignature` rides on the tool_use block as
 * `_gemini_thought_signature`, as in the Gemini lane, and goes back on the
 * same call; Gemini 3 needs it there. Thought text is not replayed.
 */

import { randomUUID } from 'node:crypto'
import type {
  AnthropicStreamEvent,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { isMediaBlock } from '../shared/media_blocks.js'
import { renderMediaForTextLane } from '../shared/media_extract.js'
import type { NormalizedUsage } from '../types.js'
import { OPENCODE_MAX_OUTPUT_TOKENS } from './opencode_responses.js'

/** @ai-sdk/google's convertJSONSchemaToOpenAPISchema. */
export function convertJsonSchemaToGeminiSchema(schema: unknown, isRoot = true): unknown {
  if (schema == null) return undefined
  if (typeof schema === 'boolean') return { type: 'boolean', properties: {} }
  if (typeof schema !== 'object') return undefined
  const source = schema as Record<string, any>
  if (
    source.type === 'object'
    && (source.properties == null || Object.keys(source.properties).length === 0)
    && !source.additionalProperties
  ) {
    if (isRoot) return undefined
    return source.description
      ? { type: 'object', description: source.description }
      : { type: 'object' }
  }

  const result: Record<string, unknown> = {}
  if (source.description) result.description = source.description
  if (source.required) result.required = source.required
  if (source.format) result.format = source.format
  if (source.const !== undefined) result.enum = [source.const]
  if (source.type) {
    if (Array.isArray(source.type)) {
      const nonNull = source.type.filter((type: unknown) => type !== 'null')
      if (nonNull.length === 0) {
        result.type = 'null'
      } else {
        result.anyOf = nonNull.map((type: unknown) => ({ type }))
        if (source.type.includes('null')) result.nullable = true
      }
    } else {
      result.type = source.type
    }
  }
  if (source.enum !== undefined) result.enum = source.enum
  if (source.properties != null) {
    result.properties = Object.fromEntries(
      Object.entries(source.properties).map(([key, value]) => [
        key,
        convertJsonSchemaToGeminiSchema(value, false),
      ]),
    )
  }
  if (source.items) {
    result.items = Array.isArray(source.items)
      ? source.items.map((item: unknown) => convertJsonSchemaToGeminiSchema(item, false))
      : convertJsonSchemaToGeminiSchema(source.items, false)
  }
  if (source.allOf) {
    result.allOf = source.allOf.map((item: unknown) => convertJsonSchemaToGeminiSchema(item, false))
  }
  if (source.anyOf) {
    const isNull = (item: any) => typeof item === 'object' && item?.type === 'null'
    if (source.anyOf.some(isNull)) {
      const nonNull = source.anyOf.filter((item: any) => !isNull(item))
      if (nonNull.length === 1) {
        const converted = convertJsonSchemaToGeminiSchema(nonNull[0], false)
        if (converted && typeof converted === 'object') {
          result.nullable = true
          Object.assign(result, converted)
        }
      } else {
        result.anyOf = nonNull.map((item: unknown) => convertJsonSchemaToGeminiSchema(item, false))
        result.nullable = true
      }
    } else {
      result.anyOf = source.anyOf.map((item: unknown) => convertJsonSchemaToGeminiSchema(item, false))
    }
  }
  if (source.oneOf) {
    result.oneOf = source.oneOf.map((item: unknown) => convertJsonSchemaToGeminiSchema(item, false))
  }
  if (source.minLength !== undefined) result.minLength = source.minLength
  return result
}

export interface OpenCodeGeminiRequest {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ProviderTool[]
  maxTokens: number
  temperature?: number
  stopSequences?: string[]
  /** The level picked (or mapped from the session's thinking), if any. */
  effort?: string
  /** Send image parts; otherwise images become their text rendering. */
  canSeeImages: boolean
}

export function buildOpenCodeGeminiBody(request: OpenCodeGeminiRequest): Record<string, unknown> {
  const id = request.model.trim().toLowerCase()
  const thinkingLevel = request.effort ?? (id.includes('gemini-3') ? 'high' : undefined)
  return {
    generationConfig: {
      maxOutputTokens: Math.min(request.maxTokens, OPENCODE_MAX_OUTPUT_TOKENS),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.stopSequences?.length && { stopSequences: request.stopSequences }),
      thinkingConfig: {
        includeThoughts: true,
        ...(thinkingLevel && { thinkingLevel }),
      },
    },
    contents: convertMessagesToGeminiContents(request.messages, {
      canSeeImages: request.canSeeImages,
      functionResponseParts: id.startsWith('gemini-3'),
    }),
    ...(request.system && { systemInstruction: { parts: [{ text: request.system }] } }),
    ...(request.tools.length > 0 && {
      tools: [{
        functionDeclarations: request.tools.map(tool => ({
          name: tool.name,
          description: tool.description ?? '',
          parameters: convertJsonSchemaToGeminiSchema(tool.input_schema),
        })),
      }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    }),
  }
}

function inlineData(block: unknown): { mimeType: string; data: string } | null {
  const source = (block as { source?: Record<string, unknown> } | null)?.source
  if (source?.type === 'base64' && typeof source.data === 'string') {
    return { mimeType: String(source.media_type ?? 'image/png'), data: source.data }
  }
  return null
}

/** Tau's Anthropic-shaped history as Gemini contents. */
export function convertMessagesToGeminiContents(
  messages: readonly ProviderMessage[],
  options: { canSeeImages: boolean; functionResponseParts: boolean },
): Array<{ role: 'user' | 'model'; parts: unknown[] }> {
  const toolNames = new Map<string, string>()
  const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts: unknown[] = []
    if (typeof message.content === 'string') {
      if (message.content) parts.push({ text: message.content })
    } else if (role === 'model') {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text })
        } else if (block.type === 'tool_use' && block.name) {
          if (block.id) toolNames.set(block.id, block.name)
          parts.push({
            functionCall: { name: block.name, args: block.input ?? {} },
            ...(block._gemini_thought_signature && {
              thoughtSignature: block._gemini_thought_signature,
            }),
          })
        }
      }
    } else {
      for (const block of message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const name = toolNames.get(block.tool_use_id) ?? 'tool'
          const images = options.canSeeImages && Array.isArray(block.content)
            ? block.content
                .map(child => (child?.type === 'image' ? inlineData(child) : null))
                .filter((data): data is { mimeType: string; data: string } => data !== null)
            : []
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter(child => !(images.length > 0 && child?.type === 'image'))
                  .map(child => (child?.type === 'text' && child.text
                    ? child.text
                    : isMediaBlock(child) ? renderMediaForTextLane(child) : JSON.stringify(child)))
                  .join('\n')
              : ''
          if (options.functionResponseParts) {
            parts.push({
              functionResponse: {
                name,
                response: { name, content: text || 'Tool executed successfully.' },
                ...(images.length > 0 && { parts: images.map(data => ({ inlineData: data })) }),
              },
            })
          } else {
            parts.push({ functionResponse: { name, response: { name, content: text } } })
            for (const data of images) parts.push({ inlineData: data })
          }
        } else if (block.type === 'text' && block.text) {
          parts.push({ text: block.text })
        } else if (block.type === 'image') {
          const data = options.canSeeImages ? inlineData(block) : null
          parts.push(data ? { inlineData: data } : { text: renderMediaForTextLane(block) })
        } else if (isMediaBlock(block)) {
          parts.push({ text: renderMediaForTextLane(block) })
        }
      }
    }
    if (parts.length > 0) contents.push({ role, parts })
  }
  return contents
}

// ─── Stream ──────────────────────────────────────────────────────────

/**
 * Turns Gemini stream chunks into the Anthropic stream Tau consumes. Feed
 * each parsed `data:` payload to push(); finish() closes the message.
 */
export class OpenCodeGeminiStream {
  private started = false
  private nextIndex = 0
  private open: { kind: 'text' | 'thinking'; index: number } | null = null
  private sawToolUse = false
  private truncated = false
  private promptTokens = 0
  private cachedTokens = 0
  private candidateTokens = 0
  private thoughtTokens = 0
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

  private closeOpen(out: AnthropicStreamEvent[]): void {
    if (!this.open) return
    out.push({ type: 'content_block_stop', index: this.open.index })
    this.open = null
  }

  private delta(out: AnthropicStreamEvent[], kind: 'text' | 'thinking', text: string): void {
    if (this.open?.kind !== kind) {
      this.closeOpen(out)
      this.open = { kind, index: this.nextIndex++ }
      out.push({
        type: 'content_block_start',
        index: this.open.index,
        content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      })
    }
    out.push({
      type: 'content_block_delta',
      index: this.open.index,
      delta: kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text },
    })
  }

  push(chunk: Record<string, any>): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    if (chunk.error) {
      this.failure = String(chunk.error.message ?? JSON.stringify(chunk.error))
      return out
    }
    const blockReason = chunk.promptFeedback?.blockReason
    if (blockReason) this.failure = `prompt blocked (${blockReason})`

    const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part?.text === 'string' && part.text) {
        this.delta(out, part.thought === true ? 'thinking' : 'text', part.text)
      } else if (part?.functionCall?.name) {
        this.closeOpen(out)
        const index = this.nextIndex++
        out.push({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: typeof part.functionCall.id === 'string' && part.functionCall.id
              ? part.functionCall.id
              : `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name: String(part.functionCall.name),
            input: {},
            ...(typeof part.thoughtSignature === 'string' && part.thoughtSignature && {
              _gemini_thought_signature: part.thoughtSignature,
            }),
          },
        })
        out.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args ?? {}) },
        })
        out.push({ type: 'content_block_stop', index })
        this.sawToolUse = true
      }
    }
    if (candidate?.finishReason === 'MAX_TOKENS') this.truncated = true

    const usage = chunk.usageMetadata
    if (usage) {
      this.promptTokens = Number(usage.promptTokenCount ?? this.promptTokens) || 0
      this.cachedTokens = Number(usage.cachedContentTokenCount ?? this.cachedTokens) || 0
      this.candidateTokens = Number(usage.candidatesTokenCount ?? this.candidateTokens) || 0
      this.thoughtTokens = Number(usage.thoughtsTokenCount ?? this.thoughtTokens) || 0
    }
    return out
  }

  /** Close what is open and add the failure as text. */
  fail(text: string): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    this.closeOpen(out)
    const index = this.nextIndex++
    out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    out.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    out.push({ type: 'content_block_stop', index })
    return out
  }

  finish(): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    this.closeOpen(out)
    // promptTokenCount includes the cached part; Tau's buckets are additive.
    const fresh = Math.max(0, this.promptTokens - this.cachedTokens)
    out.push({
      type: 'message_delta',
      delta: { stop_reason: this.truncated ? 'max_tokens' : this.sawToolUse ? 'tool_use' : 'end_turn' },
      usage: {
        output_tokens: this.candidateTokens + this.thoughtTokens,
        input_tokens: fresh,
        ...(this.cachedTokens > 0 && { cache_read_input_tokens: this.cachedTokens }),
      },
    })
    out.push({ type: 'message_stop' })
    return out
  }

  get usage(): NormalizedUsage {
    return {
      input_tokens: Math.max(0, this.promptTokens - this.cachedTokens),
      output_tokens: this.candidateTokens + this.thoughtTokens,
      cache_read_tokens: this.cachedTokens,
      cache_write_tokens: 0,
      thinking_tokens: this.thoughtTokens,
    }
  }
}
