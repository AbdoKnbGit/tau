/**
 * Adapters for the OpenAI Responses API (POST /v1/responses).
 *
 * GPT-5 Codex models use this API instead of Chat Completions.
 * Handles both directions:
 *   1. Anthropic messages/tools → Responses API input/tools
 *   2. Responses API SSE events → Anthropic stream events
 */

import type {
  AnthropicMessage,
  AnthropicStreamEvent,
  AnthropicContentBlock,
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
  SystemBlock,
} from '../providers/base_provider.js'
import {
  sanitizeResponsesToolParametersForOpenAI,
  toOpenAIStrictToolParameters,
} from './openai_responses_schema.js'
import { coerceToolCallArgs, recordToolSchema } from './tool_schema_cache.js'

// ─── Responses API types ───────────────────────────────────────────

/** Generic SSE event from the Responses API stream. */
export interface ResponsesSSEEvent {
  type: string
  [key: string]: unknown
}

/** Non-streaming Responses API response. */
export interface ResponsesApiResponse {
  id: string
  object?: string
  model: string
  output: ResponsesOutputItem[]
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

interface ResponsesOutputItem {
  type: string
  id?: string
  role?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: Array<{ type: string; text?: string }>
}

/** An input item for the Responses API `input` array. */
export interface ResponsesInputItem {
  type: string
  [key: string]: unknown
}

/** A function tool in Responses API format. */
export interface ResponsesApiTool {
  type: 'function'
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict: boolean
}

function textFromContent(content: ProviderContentBlock['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ProviderContentBlock[]).map(c => c.text ?? '').join('')
}

function imageItemsFromContent(
  content: ProviderContentBlock['content'],
): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return (content as ProviderContentBlock[]).flatMap(c =>
    c.type === 'image' && c.source
      ? [{
          type: 'input_image',
          image_url: `data:${c.source.media_type};base64,${c.source.data}`,
        }]
      : [],
  )
}

// ─── Input conversion (Anthropic → Responses API) ──────────────────

/**
 * Extract the system prompt text for the Responses API `instructions` field.
 */
export function extractInstructions(system?: string | SystemBlock[]): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.map(s => s.text).join('\n\n')
}

/**
 * Convert Anthropic conversation messages to Responses API input items.
 *
 * Mapping:
 *   user text        → { type: "message", role: "user", content: [{ type: "input_text", ... }] }
 *   assistant text   → { type: "message", role: "assistant", content: [{ type: "output_text", ... }] }
 *   tool_use block   → { type: "function_call", call_id, name, arguments }
 *   tool_result      → { type: "function_call_output", call_id, output }
 *   image            → { type: "message", role: "user", content: [{ type: "input_image", ... }] }
 */
export function anthropicToResponsesInput(
  messages: ProviderMessage[],
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      items.push({
        type: 'message',
        role: msg.role,
        content: [{
          type: msg.role === 'assistant' ? 'output_text' : 'input_text',
          text: msg.content,
        }],
      })
      continue
    }

    const blocks = msg.content as ProviderContentBlock[]

    if (msg.role === 'assistant') {
      const textParts: string[] = []

      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          // Flush accumulated text before tool call
          if (textParts.length > 0) {
            items.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: textParts.join('') }],
            })
            textParts.length = 0
          }
          items.push({
            type: 'function_call',
            call_id: block.id ?? `call_${Math.random().toString(36).slice(2, 11)}`,
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
        // Skip thinking/redacted_thinking — reasoning is model-internal
      }

      if (textParts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textParts.join('') }],
        })
      }
    } else {
      // User message — may contain tool_results, text, images
      const toolResults = blocks.filter(b => b.type === 'tool_result')
      const otherBlocks = blocks.filter(b => b.type !== 'tool_result')

      const toolResultImageItems: Array<Record<string, unknown>> = []
      for (const tr of toolResults) {
        const output = textFromContent(tr.content)
        toolResultImageItems.push(...imageItemsFromContent(tr.content))
        items.push({
          type: 'function_call_output',
          call_id: tr.tool_use_id ?? '',
          output,
        })
      }

      if (toolResultImageItems.length > 0) {
        items.push({
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Visual observation from the previous tool result:',
            },
            ...toolResultImageItems,
          ],
        })
      }

      if (otherBlocks.length > 0) {
        const content: Array<Record<string, unknown>> = []
        for (const block of otherBlocks) {
          if (block.type === 'image' && block.source) {
            content.push({
              type: 'input_image',
              image_url: `data:${block.source.media_type};base64,${block.source.data}`,
            })
          } else if (block.type === 'text' && block.text) {
            content.push({ type: 'input_text', text: block.text })
          }
        }
        if (content.length > 0) {
          items.push({ type: 'message', role: 'user', content })
        }
      }
    }
  }

  return items
}

// ─── Tool conversion ───────────────────────────────────────────────

/**
 * Convert Anthropic tool definitions to Responses API function tools.
 */
export function anthropicToolsToResponsesTools(
  tools: ProviderTool[],
): ResponsesApiTool[] {
  return tools.map(t => {
    const wireParameters = sanitizeResponsesToolParametersForOpenAI(t.input_schema)
    const strictParameters = toOpenAIStrictToolParameters(wireParameters)
    const parameters = strictParameters ?? wireParameters
    recordToolSchema(t.name, parameters)
    return {
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters,
      strict: strictParameters !== null,
    }
  })
}

// ─── Streaming conversion (Responses API SSE → Anthropic events) ───

/**
 * Convert an async stream of Responses API SSE events into Anthropic-format
 * stream events. Produces the exact event sequence the streaming handler
 * expects:
 *   message_start → content_block_start → content_block_delta* →
 *   content_block_stop → message_delta → message_stop
 */
export async function* responsesStreamToAnthropicEvents(
  events: AsyncIterable<ResponsesSSEEvent>,
): AsyncGenerator<AnthropicStreamEvent> {
  let messageStarted = false
  let messageId = ''
  let currentModel = ''
  let blockIndex = 0
  let hasTextBlock = false
  let hadToolCalls = false
  let finishedCleanly = false
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCachedTokens = 0

  // Track active tool calls by output_index
  const activeTools = new Map<number, { blockIndex: number }>()

  function* ensureMessageStart(): Generator<AnthropicStreamEvent> {
    if (!messageStarted) {
      messageStarted = true
      yield {
        type: 'message_start',
        message: {
          id: messageId || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: currentModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }
    }
  }

  function* closeTextBlock(): Generator<AnthropicStreamEvent> {
    if (hasTextBlock) {
      yield { type: 'content_block_stop', index: blockIndex }
      blockIndex++
      hasTextBlock = false
    }
  }

  for await (const event of events) {
    switch (event.type) {
      case 'response.created': {
        const resp = event.response as { id?: string; model?: string } | undefined
        messageId = resp?.id ?? `msg_${Date.now()}`
        currentModel = resp?.model ?? ''
        yield* ensureMessageStart()
        break
      }

      case 'response.output_text.delta': {
        yield* ensureMessageStart()
        if (!hasTextBlock) {
          hasTextBlock = true
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          }
        }
        const delta = (event.delta ?? '') as string
        if (delta) {
          yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: delta },
          }
        }
        break
      }

      case 'response.output_item.added': {
        const item = event.item as { type?: string; call_id?: string; id?: string; name?: string } | undefined
        const outputIndex = (event.output_index ?? 0) as number

        if (item?.type === 'function_call') {
          yield* ensureMessageStart()
          yield* closeTextBlock()

          hadToolCalls = true
          const toolBlockIndex = blockIndex++
          activeTools.set(outputIndex, { blockIndex: toolBlockIndex })

          yield {
            type: 'content_block_start',
            index: toolBlockIndex,
            content_block: {
              type: 'tool_use',
              id: item.call_id ?? item.id ?? `toolu_${Math.random().toString(36).slice(2, 11)}`,
              name: item.name ?? '',
              input: {},
            },
          }
        }
        break
      }

      case 'response.function_call_arguments.delta': {
        const outputIndex = (event.output_index ?? 0) as number
        const tool = activeTools.get(outputIndex)
        const delta = (event.delta ?? '') as string

        if (tool && delta) {
          yield {
            type: 'content_block_delta',
            index: tool.blockIndex,
            delta: { type: 'input_json_delta', partial_json: delta },
          }
        }
        break
      }

      case 'response.output_item.done': {
        const outputIndex = (event.output_index ?? 0) as number
        const item = event.item as { type?: string } | undefined

        if (item?.type === 'function_call') {
          const tool = activeTools.get(outputIndex)
          if (tool) {
            yield { type: 'content_block_stop', index: tool.blockIndex }
            activeTools.delete(outputIndex)
          }
        }
        break
      }

      case 'response.completed': {
        const resp = event.response as {
          usage?: {
            input_tokens?: number
            output_tokens?: number
            input_tokens_details?: { cached_tokens?: number }
          }
          output?: unknown[]
        } | undefined
        totalInputTokens = resp?.usage?.input_tokens ?? 0
        totalOutputTokens = resp?.usage?.output_tokens ?? 0
        totalCachedTokens = resp?.usage?.input_tokens_details?.cached_tokens ?? 0

        // Check output for function_calls (in case we missed output_item.added)
        if (Array.isArray(resp?.output)) {
          for (const item of resp!.output as Array<{ type?: string }>) {
            if (item?.type === 'function_call') hadToolCalls = true
          }
        }

        yield* closeTextBlock()
        for (const [, tool] of activeTools) {
          yield { type: 'content_block_stop', index: tool.blockIndex }
        }
        activeTools.clear()

        // Fold the end-of-stream usage through message_delta (Responses
        // API only reports it on response.completed). Input + cache
        // tokens ride here so claude.ts updateUsage() and the bridge
        // assembler pick them up — message_start was emitted on
        // response.created with zeros.
        // OpenAI reports input_tokens as TOTAL (fresh + cached). Anthropic
        // treats input_tokens and cache_read_input_tokens as additive
        // buckets — sum them for "total input". Subtract so cost tracking /
        // context-meter don't double-count the cached portion.
        yield {
          type: 'message_delta',
          delta: {
            stop_reason: hadToolCalls ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: {
            output_tokens: totalOutputTokens,
            input_tokens: Math.max(0, totalInputTokens - totalCachedTokens),
            ...(totalCachedTokens > 0 && {
              cache_read_input_tokens: totalCachedTokens,
              cache_creation_input_tokens: 0,
            }),
          },
        }
        yield { type: 'message_stop' }
        finishedCleanly = true
        break
      }

      case 'response.incomplete': {
        yield* closeTextBlock()
        for (const [, tool] of activeTools) {
          yield { type: 'content_block_stop', index: tool.blockIndex }
        }
        activeTools.clear()

        const resp2 = event.response as { usage?: { output_tokens?: number } } | undefined
        totalOutputTokens = resp2?.usage?.output_tokens ?? totalOutputTokens

        yield {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens', stop_sequence: null },
          usage: { output_tokens: totalOutputTokens },
        }
        yield { type: 'message_stop' }
        finishedCleanly = true
        break
      }

      case 'response.failed': {
        yield* closeTextBlock()
        for (const [, tool] of activeTools) {
          yield { type: 'content_block_stop', index: tool.blockIndex }
        }
        activeTools.clear()

        if (messageStarted) {
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: totalOutputTokens },
          }
          yield { type: 'message_stop' }
        }
        finishedCleanly = true
        break
      }

      // Ignore: response.content_part.added, response.content_part.done,
      // response.reasoning_text.delta, response.reasoning_summary_text.delta, etc.
    }
  }

  // Safety: if stream ended without a terminal event
  if (messageStarted && !finishedCleanly) {
    if (hasTextBlock) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    for (const [, tool] of activeTools) {
      yield { type: 'content_block_stop', index: tool.blockIndex }
    }
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: hadToolCalls ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: totalOutputTokens },
    }
    yield { type: 'message_stop' }
  }
}

// ─── Non-streaming conversion ──────────────────────────────────────

/**
 * Convert a non-streaming Responses API response to an Anthropic message.
 */
export function responsesMessageToAnthropic(
  response: ResponsesApiResponse,
): AnthropicMessage {
  const content: AnthropicContentBlock[] = []
  let hasToolCalls = false

  for (const item of response.output ?? []) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          content.push({ type: 'text', text: part.text })
        }
      }
    } else if (item.type === 'function_call') {
      hasToolCalls = true
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(item.arguments ?? '{}')
      } catch {
        input = { _raw: item.arguments }
      }
      const name = item.name ?? ''
      input = (coerceToolCallArgs(name, input) ?? input) as Record<string, unknown>
      content.push({
        type: 'tool_use',
        id: item.call_id ?? item.id ?? `toolu_${Math.random().toString(36).slice(2, 11)}`,
        name,
        input,
      })
    }
  }

  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0
  const totalInputTokens = response.usage?.input_tokens ?? 0
  // Split OpenAI's total input into Anthropic's fresh + cached buckets.
  const freshInputTokens = Math.max(0, totalInputTokens - cachedTokens)

  return {
    id: response.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: response.model,
    stop_reason: (hasToolCalls ? 'tool_use' : 'end_turn') as AnthropicMessage['stop_reason'],
    stop_sequence: null,
    usage: {
      input_tokens: freshInputTokens,
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(cachedTokens > 0 && {
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: 0,
      }),
    },
  }
}
