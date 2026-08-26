/**
 * DeepSeek transformer.
 *
 * - Caps `max_tokens` at DeepSeek's published 384K V4 ceiling.
 * - Supports `function.strict: true` for reasoner-compatible tool calls.
 * - Emits `reasoning_content` on stream deltas — pass through as-is;
 *   loop.ts surfaces it as a thinking_delta.
 * - V4 thinking is a four-stop effort chip in the model picker (see
 *   `utils/model/deepseekThinking.ts`): None sends `thinking: disabled`,
 *   Low/High/Max send `thinking: enabled` plus `reasoning_effort`. The
 *   picker is authoritative — the hidden `/thinking` command does not drive
 *   V4. DeepSeek defaults thinking on, so the None stop must send an explicit
 *   disabled toggle or later tool turns 400 on missing `reasoning_content`.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'
import {
  isDeepSeekV4ThinkingModel,
  resolveDeepSeekRequestEffort,
} from '../../../utils/model/deepseekThinking.js'

/**
 * Per-request output ceiling published for every live V4 row
 * (flash / pro / flash-vision-exp): "MAX OUTPUT -- MAXIMUM: 384K".
 * The old 8192 cap was the V3 chat/reasoner limit and throttled V4 to
 * ~2% of what it can emit.
 */
const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000

export const deepseekTransformer: Transformer = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested > DEEPSEEK_MAX_OUTPUT_TOKENS ? DEEPSEEK_MAX_OUTPUT_TOKENS : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    // V4 rows are driven by the picker's effort chip. Any other id behind
    // DEEPSEEK_BASE_URL is a custom/proxied model: it keeps the caller's
    // thinking budget and never gets an effort field it may not understand.
    const isV4 = isDeepSeekV4ThinkingModel(ctx.model)
    const effort = isV4 ? resolveDeepSeekRequestEffort(ctx.model) : null
    const thinkingEnabled = isV4 ? effort !== null : ctx.isReasoning

    if (thinkingEnabled) {
      body.thinking = { type: 'enabled' }
      if (effort) body.reasoning_effort = effort
      body.messages = sanitizeDeepSeekToolCallAdjacency(body.messages)
      return body
    }

    body.thinking = { type: 'disabled' }
    delete body.reasoning_effort
    body.messages = sanitizeDeepSeekToolCallAdjacency(
      body.messages.map(stripDeepSeekReasoningContent),
    )
    return body
  },

  normalizeStreamDelta(_delta, _finishReason): void {
    // DeepSeek already emits reasoning_content; nothing to rename.
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'too long']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    // DeepSeek-Coder was trained heavily on Aider-style SEARCH/REPLACE.
    const m = model.toLowerCase()
    if (m.includes('coder')) return 'edit_block'
    return 'str_replace'
  },

  smallFastModel(_model: string): string | null {
    // Flash is the cheap row of the live V4 family; the bare alias resolves
    // to the newest checkpoint (-0731 today) without pinning a dead id.
    return 'deepseek-v4-flash'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    // DeepSeek's OpenAI-compat endpoint doesn't honor Anthropic-style
    // cache_control; strip rather than let it 400 on unknown fields.
    return 'none'
  },
}

function stripDeepSeekReasoningContent(message: OpenAIChatMessage): OpenAIChatMessage {
  if (message.reasoning_content === undefined) return message
  const { reasoning_content: _reasoningContent, ...rest } = message
  return rest
}

type PendingToolCalls = {
  assistantIndex: number
  pendingIds: Set<string>
  answeredIds: Set<string>
}

function finalizePendingToolCalls(messages: OpenAIChatMessage[], pending: PendingToolCalls): void {
  const assistant = messages[pending.assistantIndex]
  if (!assistant?.tool_calls?.length) return

  const seen = new Set<string>()
  const keptToolCalls = assistant.tool_calls.filter(call => {
    if (!pending.answeredIds.has(call.id) || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (keptToolCalls.length > 0) {
    assistant.tool_calls = keptToolCalls
  } else {
    delete assistant.tool_calls
    if (assistant.content == null) assistant.content = ''
  }
}

function dedupeToolCalls(message: OpenAIChatMessage): OpenAIChatMessage {
  if (!message.tool_calls?.length) return message

  const seen = new Set<string>()
  const toolCalls = message.tool_calls.filter(call => {
    if (!call.id || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (toolCalls.length > 0) {
    return { ...message, tool_calls: toolCalls }
  }

  const next = { ...message }
  delete next.tool_calls
  if (next.content == null) next.content = ''
  return next
}

export function sanitizeDeepSeekToolCallAdjacency(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  let pending: PendingToolCalls | null = null

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id
      if (pending && toolCallId && pending.pendingIds.has(toolCallId)) {
        out.push(message.content == null ? { ...message, content: '' } : message)
        pending.pendingIds.delete(toolCallId)
        pending.answeredIds.add(toolCallId)
        if (pending.pendingIds.size === 0) pending = null
      }
      continue
    }

    if (pending) {
      finalizePendingToolCalls(out, pending)
      pending = null
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const assistant = dedupeToolCalls(message)
      out.push(assistant)

      if (assistant.tool_calls?.length) {
        pending = {
          assistantIndex: out.length - 1,
          pendingIds: new Set(assistant.tool_calls.map(call => call.id)),
          answeredIds: new Set<string>(),
        }
      }
      continue
    }

    out.push(message)
  }

  if (pending) finalizePendingToolCalls(out, pending)
  return out
}

// Re-export types for the registry consumer.
export type { OpenAIChatRequest, OpenAIChatMessage }
