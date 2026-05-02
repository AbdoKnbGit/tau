/**
 * DeepSeek transformer.
 *
 * - Hard-caps `max_tokens` at 8192 (upstream 400s past that).
 * - Supports `function.strict: true` for reasoner-compatible tool calls.
 * - Emits `reasoning_content` on stream deltas — pass through as-is;
 *   loop.ts surfaces it as a thinking_delta.
 * - `thinking: { type: 'enabled' }` only when user/model requested reasoning.
 *   DeepSeek V4 defaults thinking on, so non-reasoning turns must send an
 *   explicit disabled toggle or later tool turns can 400 on missing
 *   `reasoning_content`. The V4 toggle lives in the model picker (see
 *   `utils/model/deepseekThinking.ts`); the hidden `/thinking` command
 *   does not drive V4 — picker is authoritative.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'
import {
  getDeepSeekV4Thinking,
  isDeepSeekV4ThinkingModel,
} from '../../../utils/model/deepseekThinking.js'

export const deepseekTransformer: Transformer = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    const thinkingEnabled = resolveDeepSeekThinking(ctx.model, ctx.isReasoning)

    if (thinkingEnabled) {
      body.thinking = { type: 'enabled' }
      body.messages = sanitizeDeepSeekToolCallAdjacency(body.messages)
      return body
    }

    body.thinking = { type: 'disabled' }
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
    return 'deepseek-chat'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    // DeepSeek's OpenAI-compat endpoint doesn't honor Anthropic-style
    // cache_control; strip rather than let it 400 on unknown fields.
    return 'none'
  },
}

function isDeepSeekReasoningModel(model: string): boolean {
  return /\bdeepseek-reasoner\b/i.test(model)
}

function resolveDeepSeekThinking(model: string, isReasoning: boolean): boolean {
  // V4 picker toggle is authoritative — the hidden /thinking command and
  // the global thinkingConfig do not drive deepseek-v4-flash / -pro.
  if (isDeepSeekV4ThinkingModel(model)) return getDeepSeekV4Thinking()
  return isReasoning || isDeepSeekReasoningModel(model)
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

function sanitizeDeepSeekToolCallAdjacency(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
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
