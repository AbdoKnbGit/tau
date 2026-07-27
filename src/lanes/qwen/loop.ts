/**
 * Qwen Lane — native agent loop + provider-shim entry.
 *
 * Qwen was post-trained against OpenAI function-calling, so the wire
 * format is Chat Completions. Two auth paths:
 *
 *   1. OAuth (chat.qwen.ai → DashScope or account resource_url)
 *   2. API key (DashScope compatible-mode)
 *
 * Like other lanes: streamAsProvider is the single-API-call entry;
 * tool results flow back via the outer claude.ts loop which calls us
 * again with updated history.
 *
 * Reference: reference/qwen-code-main/packages/core/src/qwen/qwenContentGenerator.ts
 */

import { randomUUID } from 'crypto'
import type {
  AnthropicStreamEvent,
  ModelInfo,
  ProviderMessage,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneProviderCallParams,
  LaneRunContext,
  LaneRunResult,
  NormalizedUsage,
} from '../types.js'
import {
  QWEN_TOOL_REGISTRY,
  getQwenRegistrationByNativeName,
  buildQwenTools,
} from './tools.js'
import { qwenApi, type QwenChatMessage, type QwenStreamChunk, type QwenTool } from './api.js'
import { isMediaBlock } from '../shared/media_blocks.js'
import { renderMediaForTextLane } from '../shared/media_extract.js'
import {
  sanitizeSchemaForLane,
  appendStrictParamsHint,
  QWEN_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'

const MAX_TURNS = 100

// ─── Lane ────────────────────────────────────────────────────────

export class QwenLane implements Lane {
  readonly name = 'qwen'
  readonly displayName = 'Qwen (Native, OAuth + DashScope)'

  private _healthy = true

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('qwen') || m === 'coder-model' || m.includes('qwen3-coder')
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, temperature, stop_sequences, signal } = params
    const systemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')

    const toolUseIdToNative = buildToolUseIdToNativeMap(messages)
    const qwenTools = buildQwenToolsForRequest(tools)

    // Prepend QWEN_TOOL_USAGE_RULES to the system message when tools are
    // present. Qwen3-Coder benefits measurably from the explicit
    // required-field + case-sensitivity reminder even with `strict: true`
    // on each tool — the server-side enforcement is reactive, this
    // pre-empts the call shape.
    const systemWithRules = qwenTools.length > 0
      ? (systemText ? `${QWEN_TOOL_USAGE_RULES}\n${systemText}` : QWEN_TOOL_USAGE_RULES)
      : systemText

    const chatMessages: QwenChatMessage[] = []
    if (systemWithRules) chatMessages.push({ role: 'system', content: systemWithRules })
    chatMessages.push(...convertHistoryToQwen(messages, toolUseIdToNative))

    const request = {
      model,
      messages: chatMessages,
      stream: true,
      stream_options: { include_usage: true },
      tools: qwenTools.length > 0 ? qwenTools : undefined,
      tool_choice: qwenTools.length > 0 ? 'auto' as const : undefined,
      max_tokens,
      temperature,
      stop: stop_sequences,
    }

    // ── Stream state ──
    const messageId = `qwen-${Date.now()}`
    let blockIndex = 0
    let inBlock: 'text' | 'thinking' | null = null
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens = 0
    let messageStartEmitted = false

    interface ToolCallBuf {
      id: string
      nativeName: string
      args: string
      anthropicToolUseId: string
      emitted: boolean
    }
    const toolCallsByIndex = new Map<number, ToolCallBuf>()

    const emitMessageStart = (): AnthropicStreamEvent | undefined => {
      if (messageStartEmitted) return undefined
      messageStartEmitted = true
      return {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            ...(cachedTokens > 0 && {
              cache_read_input_tokens: cachedTokens,
              cache_creation_input_tokens: 0,
            }),
          },
        },
      }
    }

    try {
      for await (const chunk of qwenApi.streamChat(request, signal)) {
        if (signal.aborted) break

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens
          outputTokens = chunk.usage.completion_tokens ?? outputTokens
          cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedTokens
        }
        if (!messageStartEmitted) {
          const ev = emitMessageStart()
          if (ev) yield ev
        }

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {}

          // Reasoning-content delta → thinking block.
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            if (inBlock === 'text') {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              inBlock = null
            }
            if (inBlock !== 'thinking') {
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
              inBlock = 'thinking'
            }
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            }
          }

          // Text content delta.
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (inBlock === 'thinking') {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              inBlock = null
            }
            if (inBlock !== 'text') {
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' },
              }
              inBlock = 'text'
            }
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }
          }

          // Tool-call deltas — buffer by index, emit on finish_reason.
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index
            let buf = toolCallsByIndex.get(idx)
            if (!buf) {
              buf = {
                id: tc.id ?? `toolu_qwen_${randomUUID()}`,
                nativeName: tc.function?.name ?? '',
                args: '',
                anthropicToolUseId: tc.id ?? `toolu_qwen_${randomUUID()}`,
                emitted: false,
              }
              toolCallsByIndex.set(idx, buf)
            }
            if (tc.function?.name) buf.nativeName = tc.function.name
            if (tc.function?.arguments) buf.args += tc.function.arguments
          }

          if (choice.finish_reason) {
            // Close any streaming text/thinking.
            if (inBlock !== null) {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
              inBlock = null
            }
            // Emit atomic tool_use blocks for any buffered calls.
            for (const buf of toolCallsByIndex.values()) {
              if (buf.emitted) continue
              buf.emitted = true
              let parsedArgs: Record<string, unknown> = {}
              try {
                parsedArgs = buf.args ? JSON.parse(buf.args) : {}
              } catch {
                parsedArgs = {}
              }
              const reg = getQwenRegistrationByNativeName(buf.nativeName)
              const implId = reg?.implId ?? buf.nativeName
              const adapted = reg ? reg.adaptInput(parsedArgs) : parsedArgs
              // Three-event sequence: start (empty input) + input_json_delta
              // carrying JSON-stringified args + stop. Required for the
              // claude.ts accumulator to capture the args.
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: buf.anthropicToolUseId,
                  name: implId,
                  input: {},
                },
              }
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(adapted ?? {}),
                },
              }
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
            }
          }
        }
      }
    } catch (err: any) {
      if (!messageStartEmitted) {
        const ev = emitMessageStart()
        if (ev) yield ev
      }
      if (err?.name === 'AbortError' || signal.aborted) {
        if (inBlock !== null) yield { type: 'content_block_stop', index: blockIndex }
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: outputTokens },
        }
        yield { type: 'message_stop' }
        return {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cachedTokens,
          cache_write_tokens: 0,
          thinking_tokens: 0,
        }
      }
      if (inBlock !== null) {
        yield { type: 'content_block_stop', index: blockIndex }
        blockIndex++
      }
      const isPTL = (err as { isPromptTooLong?: boolean })?.isPromptTooLong === true
      const errText = isPTL
        ? (err?.message ?? String(err))
        : `\n\nQwen API error: ${err?.message ?? String(err)}`
      yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: errText },
      }
      yield { type: 'content_block_stop', index: blockIndex }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: outputTokens },
      }
      yield { type: 'message_stop' }
      return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cachedTokens,
        cache_write_tokens: 0,
        thinking_tokens: 0,
      }
    }

    if (!messageStartEmitted) {
      const ev = emitMessageStart()
      if (ev) yield ev
    }
    if (inBlock !== null) yield { type: 'content_block_stop', index: blockIndex }

    const hadToolUse = Array.from(toolCallsByIndex.values()).some(b => b.emitted)
    yield {
      type: 'message_delta',
      delta: { stop_reason: hadToolUse ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: outputTokens },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cachedTokens,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    }
  }

  async *run(_ctx: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    // Not yet wired; the outer shim still owns the loop.
    return {
      stopReason: 'end_turn',
      usage: {
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
      },
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Curated list — matches the Qwen Code reference's defaults.
    // A live /v1/models call is added when the lane moves to Phase-2.
    return [
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
      { id: 'qwen3-coder-flash', name: 'Qwen3 Coder Flash' },
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-turbo', name: 'Qwen Turbo (fast)' },
    ]
  }

  resolveModel(model: string): string {
    return model
  }

  smallFastModel(): string {
    return 'qwen-turbo'
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {
    // no-op
  }
}

// ─── History conversion ──────────────────────────────────────────

function buildToolUseIdToNativeMap(messages: ProviderMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        map.set(block.id, block.name)
      }
    }
  }
  return map
}

export function convertHistoryToQwen(
  messages: ProviderMessage[],
  toolUseIdToNative: Map<string, string>,
): QwenChatMessage[] {
  const out: QwenChatMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      // tool_result blocks become role:'tool' messages; plain text stays user.
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content })
        continue
      }
      const textParts: string[] = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const content = stringifyToolResult(block.content)
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? '',
            content,
          })
          continue
        }
        if (block.type === 'text' && block.text) textParts.push(block.text)
        // Pasted screenshots arrive as image blocks on the user message.
        // Qwen's chat shape here is text-only, so emit a marker rather than
        // dropping them and leaving `[Image #N]` pointing at nothing.
        else if (isMediaBlock(block)) textParts.push(renderMediaForTextLane(block))
      }
      if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('\n') })
      continue
    }
    // assistant
    if (typeof msg.content === 'string') {
      out.push({ role: 'assistant', content: msg.content })
      continue
    }
    const texts: string[] = []
    const toolCalls: Array<{
      id: string; type: 'function'; function: { name: string; arguments: string }
    }> = []
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
      if (block.type === 'tool_use' && block.id && block.name) {
        // Prefer the native tool name if we know it; otherwise shared impl id.
        const nativeName = toolUseIdToNative.get(block.id) ?? block.name
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: nativeName,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
    }
    const assistant: QwenChatMessage = {
      role: 'assistant',
      content: texts.length > 0 ? texts.join('\n') : null,
    }
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls
    out.push(assistant)
  }
  return out
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const b of content as any[]) {
      if (!b || typeof b !== 'object') continue
      if (typeof b.text === 'string') texts.push(b.text)
      // An image block here (Read on a .png) would otherwise be
      // JSON.stringify-ed, putting its whole base64 payload in the prompt
      // as text. See shared/media_blocks.ts.
      else if (isMediaBlock(b)) texts.push(renderMediaForTextLane(b))
      else texts.push(JSON.stringify(b))
    }
    return texts.join('\n')
  }
  return JSON.stringify(content ?? '')
}

function buildQwenToolsForRequest(
  tools: import('../../services/api/providers/base_provider.js').ProviderTool[],
): QwenTool[] {
  const out: QwenTool[] = []
  for (const tool of tools) {
    // Match by impl id first, then native name, then pass-through.
    // Every tool gets:
    //   - strict: true (server-side schema enforcement, the OpenAI
    //     Chat Completions equivalent of Gemini VALIDATED mode)
    //   - STRICT PARAMETERS description hint (belt-and-suspenders
    //     in-context summary so Flash-like models that ignore `strict`
    //     still see the required-field list in plain text)
    const byImpl = QWEN_TOOL_REGISTRY.find(r => r.implId === tool.name)
    if (byImpl) {
      out.push({
        type: 'function',
        function: {
          name: byImpl.nativeName,
          description: appendStrictParamsHint(byImpl.nativeDescription, byImpl.nativeSchema),
          parameters: byImpl.nativeSchema,
          strict: true,
        },
      })
      continue
    }
    const byNative = getQwenRegistrationByNativeName(tool.name)
    if (byNative) {
      out.push({
        type: 'function',
        function: {
          name: byNative.nativeName,
          description: appendStrictParamsHint(byNative.nativeDescription, byNative.nativeSchema),
          parameters: byNative.nativeSchema,
          strict: true,
        },
      })
      continue
    }
    const parameters = sanitizeSchemaForLane(
      tool.input_schema ?? { type: 'object', properties: {} },
      'qwen',
    )
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: appendStrictParamsHint(tool.description ?? '', parameters),
        parameters,
        strict: true,
      },
    })
  }
  return out
}

// ─── Singleton ───────────────────────────────────────────────────

export const qwenLane = new QwenLane()
