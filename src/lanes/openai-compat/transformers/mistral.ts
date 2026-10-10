/**
 * Mistral transformer.
 *
 * - Rejects `function.strict: true` + extra top-level fields
 *   (`extra_forbidden` error) — strict mode is OFF.
 * - `tool_choice: "required"` → `"any"` (Mistral's name for the same).
 * - Strips `$id`/`$schema`/`additionalProperties`/`strict`/`format`/
 *   `examples`/`default` from tool parameter schemas.
 * - Strips `name` from non-tool messages (Mistral rejects it on
 *   system/user/assistant).
 * - Enforces Mistral's strict assistant-tool-call -> tool-result ordering
 *   on replayed history.
 * - Prompt caching uses top-level `prompt_cache_key`; Anthropic
 *   `cache_control` markers stay stripped by the shared compat loop.
 * - Reasoning is model-specific; Mistral replays it as ThinkChunk content.
 */

import type { Transformer, TransformContext } from './base.js'
import type { ModelInfo } from '../../../services/api/providers/base_provider.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'
import { filterMistralCatalog, getMistralModelMeta, mistralStaticCatalog } from '../../../utils/model/mistralCatalog.js'
import { getDirectEffort } from '../../../utils/model/directProviderThinking.js'
import { MISTRAL_AGENT_MODEL } from '../../../utils/model/mistralAgentModel.js'

export const mistralTransformer: Transformer = {
  id: 'mistral',
  displayName: 'Mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (body.tool_choice === 'required') body.tool_choice = 'any'
    const bag = body as unknown as Record<string, unknown>
    if (ctx.sessionId) body.prompt_cache_key = ctx.sessionId
    else delete bag.prompt_cache_key

    body.messages = sanitizeMistralToolCallAdjacency(body.messages).map(m => {
      if (m.role === 'tool') return m
      const { name: _name, ...rest } = m as OpenAIChatMessage & { name?: string }
      return rest as OpenAIChatMessage
    })

    const meta = getMistralModelMeta(body.model)
    delete body.thinking
    delete body.reasoning
    delete body.reasoning_effort
    if (meta?.reasoning) {
      body.reasoning_effort = getDirectEffort('mistral', body.model) as OpenAIChatRequest['reasoning_effort']
    }
    if (meta && typeof body.max_tokens === 'number') {
      body.max_tokens = Math.min(body.max_tokens, meta.maxOutputTokens)
    }
    // The shared history converter reassembles complete assistant turns.
    // Mistral accepts thinking inside content, not reasoning_content.
    body.messages = body.messages.map(message => {
      const { reasoning_content, reasoning, reasoning_details: _details, ...rest } = message
      const trace = reasoning_content ?? reasoning
      if (rest.role === 'assistant' && trace) {
        const content = typeof rest.content === 'string'
          ? (rest.content ? [{ type: 'text', text: rest.content }] : []) : rest.content ?? []
        rest.content = [{ type: 'thinking', thinking: [{ type: 'text', text: trace }] }, ...content]
      }
      return rest
    })
    return body
  },

  normalizeStreamDelta(delta): void {
    if (!Array.isArray(delta.content)) return
    const text: string[] = []
    const thinking: string[] = []
    for (const chunk of delta.content) {
      if (chunk.type === 'text' && typeof chunk.text === 'string') text.push(chunk.text)
      if (chunk.type === 'thinking' && Array.isArray(chunk.thinking)) {
        for (const inner of chunk.thinking) {
          if (inner.type === 'text' && typeof inner.text === 'string') thinking.push(inner.text)
        }
      }
    }
    delta.content = text.join('')
    if (thinking.length) delta.reasoning_content = thinking.join('')
  },

  schemaDropList(): Set<string> {
    return new Set([
      '$schema', '$id', '$ref', '$comment',
      'strict', 'additionalProperties',
      'format', 'examples', 'default',
    ])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'prompt too long', 'tokens exceeds', 'context_window']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    if (
      m.includes('codestral')
      || m.includes('devstral')
      || m.includes('magistral')
      || getMistralModelMeta(m)?.id === 'mistral-medium-3-5'
    ) return 'edit_block'
    return 'str_replace'
  },

  smallFastModel(_model: string): string | null {
    return MISTRAL_AGENT_MODEL
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  staticCatalog(): ModelInfo[] {
    return mistralStaticCatalog()
  },

  filterModelCatalog(models: Array<{ id: string; name?: string }>): Array<{ id: string; name?: string }> {
    return filterMistralCatalog(models)
  },

  preferLiveModelCatalog(): boolean {
    return true
  },
}

type PendingToolCalls = {
  assistantIndex: number
  pendingIds: Set<string>
  answeredIds: Set<string>
  namesById: Map<string, string>
}

function finalizePendingToolCalls(messages: OpenAIChatMessage[], pending: PendingToolCalls): void {
  const assistant = messages[pending.assistantIndex]
  if (!assistant?.tool_calls?.length) return

  const seen = new Set<string>()
  const keptToolCalls = assistant.tool_calls.filter(call => {
    if (!isValidMistralToolCall(call) || !pending.answeredIds.has(call.id) || seen.has(call.id)) return false
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
    if (!isValidMistralToolCall(call) || seen.has(call.id)) return false
    seen.add(call.id)
    return true
  })

  if (toolCalls.length > 0) return { ...message, tool_calls: toolCalls }

  const next = { ...message }
  delete next.tool_calls
  if (next.content == null) next.content = ''
  return next
}

function isValidMistralToolCall(call: NonNullable<OpenAIChatMessage['tool_calls']>[number] | undefined): boolean {
  return !!(
    call?.id
    && call.function
    && typeof call.function.name === 'string'
    && call.function.name.length > 0
  )
}

function hasMistralRenderableAssistantContent(message: OpenAIChatMessage): boolean {
  if (message.role !== 'assistant') return true
  if (message.reasoning_content || message.reasoning) return true
  if (message.tool_calls?.some(isValidMistralToolCall)) return true
  if (typeof message.content === 'string') return message.content.trim().length > 0
  if (Array.isArray(message.content)) {
    return message.content.some(part =>
      part
      && typeof part === 'object'
      && (part.type !== 'text' || (typeof part.text === 'string' && part.text.trim().length > 0)),
    )
  }
  return false
}

function sanitizeMistralToolCallAdjacency(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  let pending: PendingToolCalls | null = null

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id
      if (pending && toolCallId && pending.pendingIds.has(toolCallId)) {
        out.push({
          ...message,
          content: message.content == null ? '' : message.content,
          name: message.name ?? pending.namesById.get(toolCallId),
        })
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
          namesById: new Map(assistant.tool_calls.map(call => [call.id, call.function.name])),
        }
      }
      continue
    }

    out.push(message)
  }

  if (pending) finalizePendingToolCalls(out, pending)
  return out.filter(hasMistralRenderableAssistantContent)
}
