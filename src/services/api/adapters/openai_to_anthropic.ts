/**
 * Inbound adapter: Converts OpenAI Chat Completions responses → Anthropic format.
 *
 * Handles both streaming (SSE chunks) and non-streaming (complete response) conversion.
 * Emits the exact event sequence the existing streaming handler in claude.ts expects:
 *   message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
 */

import type {
  AnthropicMessage,
  AnthropicStreamEvent,
  AnthropicContentBlock,
} from '../providers/base_provider.js'
import { coerceToolCallArgs } from './tool_schema_cache.js'
import {
  InFlightToolCall,
  isOutputCapTruncation,
} from '../../../lanes/shared/truncation.js'

// ─── OpenAI response types (minimal) ───────────────────────────────

export interface OpenAIChatCompletion {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

export interface OpenAIChatCompletionChunk {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
}

// ─── Non-Streaming Conversion ──────────────────────────────────────

export function openAIMessageToAnthropic(
  response: OpenAIChatCompletion,
): AnthropicMessage {
  const choice = response.choices[0]
  if (!choice) {
    return {
      id: response.id ?? `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: response.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
    }
  }

  const content: AnthropicContentBlock[] = []

  // Reasoning content → thinking block (DeepSeek R1, o1-series)
  if (choice.message.reasoning_content) {
    content.push({
      type: 'thinking' as any,
      thinking: choice.message.reasoning_content,
    } as any)
  }

  // Text content
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  // Tool calls → tool_use blocks
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = { _raw: tc.function.arguments }
      }
      const coerced = coerceToolCallArgs(tc.function.name, input)
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: (coerced ?? input) as Record<string, unknown>,
      })
    }
  }

  const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens'
    : 'end_turn'

  const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const promptTokens = response.usage?.prompt_tokens ?? 0
  // OpenAI's prompt_tokens is the TOTAL (cached + fresh). Anthropic's
  // semantic treats input_tokens and cache_read_input_tokens as separate
  // additive buckets. Subtract so downstream cost / context-meter code
  // doesn't double-count the cached portion.
  const freshInputTokens = Math.max(0, promptTokens - cachedTokens)

  return {
    id: response.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: response.model,
    stop_reason: stopReason as AnthropicMessage['stop_reason'],
    stop_sequence: null,
    usage: {
      input_tokens: freshInputTokens,
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(cachedTokens > 0 && {
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: 0,
      }),
    },
  }
}

// ─── Streaming Conversion ──────────────────────────────────────────

/**
 * Converts an async iterable of OpenAI streaming chunks into
 * Anthropic-format stream events.
 *
 * Handles:
 * - Text content streaming
 * - Tool call argument streaming (buffered per tool index)
 * - Parallel tool calls (multiple indices)
 * - Proper event ordering (message_start first, message_stop last)
 */
export async function* openAIStreamToAnthropicEvents(
  openAIStream: AsyncIterable<OpenAIChatCompletionChunk>,
): AsyncGenerator<AnthropicStreamEvent> {
  let messageStarted = false
  let currentModel = ''
  let messageId = ''
  let blockIndex = 0
  let hasThinkingBlock = false
  let hasTextBlock = false

  // Track tool calls by index for argument buffering
  const toolCallState: Map<number, {
    id: string
    name: string
    argBuffer: string
    blockIndex: number
    started: boolean
  }> = new Map()

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCachedTokens = 0
  let finishedCleanly = false
  // Output-cap truncation: see lanes/shared/truncation.ts.
  const inFlightToolCall = new InFlightToolCall<number>()

  for await (const chunk of openAIStream) {
    if (!chunk.choices || chunk.choices.length === 0) {
      // Usage-only chunk (some providers send this at the end)
      if (chunk.usage) {
        totalInputTokens = chunk.usage.prompt_tokens ?? totalInputTokens
        totalOutputTokens = chunk.usage.completion_tokens ?? totalOutputTokens
        totalCachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? totalCachedTokens
      }
      continue
    }

    const choice = chunk.choices[0]!
    if (!messageId) messageId = chunk.id ?? `msg_${Date.now()}`
    if (!currentModel) currentModel = chunk.model ?? ''

    // Emit message_start on first chunk
    if (!messageStarted) {
      messageStarted = true
      yield {
        type: 'message_start',
        message: {
          id: messageId,
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

    // Handle reasoning_content (DeepSeek R1, o1-series) → thinking block
    if (choice.delta.reasoning_content != null && choice.delta.reasoning_content !== '') {
      if (!hasThinkingBlock) {
        hasThinkingBlock = true
        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'thinking', thinking: '' } as any,
        }
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta' as any, thinking: choice.delta.reasoning_content } as any,
      }
    }

    // Handle text content
    if (choice.delta.content != null && choice.delta.content !== '') {
      inFlightToolCall.noteOtherOutput()
      // Close thinking block before text starts
      if (hasThinkingBlock) {
        yield { type: 'content_block_stop', index: blockIndex }
        blockIndex++
        hasThinkingBlock = false
      }
      if (!hasTextBlock) {
        hasTextBlock = true
        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: choice.delta.content },
      }
    }

    // Handle tool calls
    if (choice.delta.tool_calls) {
      // Close text block before tool calls start
      if (hasTextBlock) {
        yield { type: 'content_block_stop', index: blockIndex }
        blockIndex++
        hasTextBlock = false
      }

      for (const tc of choice.delta.tool_calls) {
        const tcIndex = tc.index ?? 0

        if (!toolCallState.has(tcIndex)) {
          // New tool call — emit content_block_start
          const toolId = tc.id ?? `toolu_${Math.random().toString(36).slice(2, 11)}`
          const toolName = tc.function?.name ?? ''
          const currentBlockIndex = blockIndex++

          toolCallState.set(tcIndex, {
            id: toolId,
            name: toolName,
            argBuffer: '',
            blockIndex: currentBlockIndex,
            started: false,
          })
        }

        const state = toolCallState.get(tcIndex)!

        // Update name if provided (sometimes comes in a later chunk)
        if (tc.function?.name) state.name = tc.function.name
        if (tc.id) state.id = tc.id

        // Emit start event once we have the name
        if (!state.started && state.name) {
          state.started = true
          yield {
            type: 'content_block_start',
            index: state.blockIndex,
            content_block: {
              type: 'tool_use',
              id: state.id,
              name: state.name,
              input: {},
            },
          }
        }

        // Stream argument chunks
        if (tc.function?.arguments) {
          state.argBuffer += tc.function.arguments
          inFlightToolCall.noteArgs(tcIndex)
          yield {
            type: 'content_block_delta',
            index: state.blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          }
        }
      }
    }

    // Handle finish
    if (choice.finish_reason) {
      // Close any open thinking block
      if (hasThinkingBlock) {
        yield { type: 'content_block_stop', index: blockIndex }
        hasThinkingBlock = false
      }

      // Close any open text block
      if (hasTextBlock) {
        yield { type: 'content_block_stop', index: blockIndex }
        hasTextBlock = false
      }

      // Close any open tool call blocks. A call still taking argument
      // fragments when the output cap was hit is half-written, so leave it
      // unclosed: claude.ts materializes a tool_use block into a message at
      // content_block_stop and nowhere else, so skipping the stop drops the
      // call before anything can execute it, and no tool_result is owed for
      // a block that never became a message. See lanes/shared/truncation.ts.
      const dropBlock = inFlightToolCall.toDrop(
        isOutputCapTruncation(choice.finish_reason),
      )
      for (const [tcIndex, state] of toolCallState) {
        if (state.started && tcIndex !== dropBlock) {
          yield { type: 'content_block_stop', index: state.blockIndex }
        }
      }

      // Determine stop reason
      const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use'
        : choice.finish_reason === 'length' ? 'max_tokens'
        : 'end_turn'

      // Update usage from final chunk
      if (chunk.usage) {
        totalInputTokens = chunk.usage.prompt_tokens ?? totalInputTokens
        totalOutputTokens = chunk.usage.completion_tokens ?? totalOutputTokens
        totalCachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? totalCachedTokens
      }

      // message_delta with stop reason. Input + cache tokens are piggy-
      // backed so downstream (claude.ts updateUsage, provider-bridge
      // assembler) picks them up — OpenAI only ships usage in the final
      // chunk, so message_start was emitted with zeros. Split OpenAI's
      // total prompt_tokens into fresh vs cached to match Anthropic's
      // additive-bucket semantic.
      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          output_tokens: totalOutputTokens,
          input_tokens: Math.max(0, totalInputTokens - totalCachedTokens),
          ...(totalCachedTokens > 0 && {
            cache_read_input_tokens: totalCachedTokens,
            cache_creation_input_tokens: 0,
          }),
        },
      }

      // message_stop
      yield { type: 'message_stop' }
      finishedCleanly = true
    }
  }

  // Safety: if stream ended without finish_reason, close gracefully
  if (messageStarted && !finishedCleanly) {
    if (hasThinkingBlock) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    if (hasTextBlock) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    for (const [, state] of toolCallState) {
      if (state.started) {
        yield { type: 'content_block_stop', index: state.blockIndex }
      }
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
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
  }
}
