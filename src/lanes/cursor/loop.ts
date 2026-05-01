/**
 * Cursor Lane — ConnectRPC protobuf streaming.
 *
 * Wire: POST https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools
 *   Content-Type: application/connect+proto
 *   Authorization: Bearer <accessToken>
 *   x-cursor-checksum: <jyh(now/1e6) ^ rolling-key(165) base64 || machineId>
 *
 * The response body is a stream of 5-byte-prefixed protobuf frames. Each
 * frame carries text, thinking content, a tool-call delta, a JSON error
 * envelope, or trailer metadata. We normalize each frame's payload into
 * Anthropic-IR events so claude.ts renders a Cursor turn identically to
 * every other lane.
 *
 * Frame → IR mapping:
 *   RESPONSE_TEXT          → text_delta
 *   RESPONSE.THINKING.TEXT → thinking_delta
 *   TOOL_CALL              → tool_use block (input_json_delta accumulation)
 *   JSON {"error": …}      → surfaces as an error text block pre-content;
 *                            dropped silently post-content (9router pattern).
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import { buildCursorBody } from './request.js'
import {
  parseConnectFrame,
  extractFromResponsePayload,
  formatCursorToolName,
  unformatCursorToolName,
} from './protobuf.js'
import { buildCursorHeaders } from './checksum.js'
import {
  CURSOR_MODELS,
  isCursorAutoModelId,
  isCursorModel,
  resolveCursorModelId,
} from './catalog.js'
import {
  getCursorRegistrationByImplId,
  getCursorRegistrationByNativeName,
  resolveCursorToolCall,
} from './tools.js'
import { OPENAI_COMPAT_TOOL_USAGE_RULES } from '../shared/mcp_bridge.js'

const CURSOR_ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.InferenceService/Stream'
const CURSOR_HTTP_TIMEOUT_MS = 60_000
const CURSOR_THINK_CLOSE_MARKER = '</think>'
const CURSOR_PRINTED_TOOL_CALLS_OPEN = '<|tool_calls_begin|>'
const CURSOR_PRINTED_TOOL_CALLS_CLOSE = '<|tool_calls_end|>'
const CURSOR_PRINTED_TOOL_CALL_OPEN = '<|tool_call_begin|>'
const CURSOR_PRINTED_TOOL_CALL_CLOSE = '<|tool_call_end|>'
const CURSOR_PRINTED_TOOL_SEP = '<|tool_sep|>'
const CURSOR_PRINTED_TOOL_MARKERS = [
  CURSOR_PRINTED_TOOL_CALLS_OPEN,
  CURSOR_PRINTED_TOOL_CALLS_CLOSE,
  CURSOR_PRINTED_TOOL_CALL_OPEN,
  CURSOR_PRINTED_TOOL_CALL_CLOSE,
  CURSOR_PRINTED_TOOL_SEP,
] as const

interface CursorHttpStreamResponse {
  status: number
  body: AsyncIterable<Uint8Array>
}

interface CursorAttemptResult {
  usage: NormalizedUsage
  retry: boolean
}

interface CursorThinkingSplitState {
  mode: 'thinking' | 'text'
  carry: string
  trimLeadingText: boolean
}

export interface CursorPrintedToolCall {
  name: string
  input: Record<string, unknown>
}

export interface CursorPrintedToolTextState {
  pending: string
}

export type CursorPrintedToolTextChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: CursorPrintedToolCall[] }

export class CursorLane implements Lane {
  readonly name = 'cursor'
  readonly displayName = 'Cursor (ConnectRPC)'

  private accessToken: string | null = null
  private machineId: string | null = null
  private conversationId = _newCursorConversationId()

  configure(opts: { accessToken?: string | null; machineId?: string | null }): void {
    const accessTokenChanged =
      opts.accessToken !== undefined && (opts.accessToken || null) !== this.accessToken
    const machineIdChanged =
      opts.machineId !== undefined && (opts.machineId || null) !== this.machineId

    if (opts.accessToken !== undefined) this.accessToken = opts.accessToken || null
    if (opts.machineId !== undefined) this.machineId = opts.machineId || null

    if (accessTokenChanged || machineIdChanged) {
      this._resetSessionState()
    }
  }

  supportsModel(model: string): boolean {
    // Catalog membership only. Provider-shim routing is provider-scoped, so
    // same-looking ids such as `gpt-5.3-codex` stay on Cursor when the active
    // provider is Cursor and stay on OpenAI when the active provider is OpenAI.
    return isCursorModel(model)
  }

  isHealthy(): boolean {
    return !!this.accessToken
  }

  resolveModel(model: string): string {
    return resolveCursorModelId(model)
  }

  async listModels(_providerFilter?: string): Promise<ModelInfo[]> {
    // Cursor's GetDefaultModelNudgeData endpoint is noisy + includes
    // retired aliases. The static catalog is what Cursor's own IDE ships.
    return CURSOR_MODELS
  }

  dispose(): void {
    this._resetSessionState()
  }

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    throw new Error(
      'CursorLane.run (lane-owns-loop) is not wired yet — use streamAsProvider via LaneBackedProvider.',
    )
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, signal, thinking } = params

    if (!this.accessToken) {
      throw new Error(
        'Cursor lane: not authenticated. Run `/login cursor` to complete the browser login.',
      )
    }

    const rawSystemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')

    // Prepend OPENAI_COMPAT_TOOL_USAGE_RULES at the top of system text
    // when tools are present. Same pattern as the cline / kilo / openai-
    // compat lanes — Cursor proxies to Anthropic / OpenAI / Gemini upstream
    // and the rule is already in the upstream prompt, but lifting it to
    // the very top is the difference between "buried hint the model
    // ignores" and "first thing it reads", which materially reduces the
    // syntax-flailing retry loops that burn input tokens on non-Claude
    // routes through Cursor.
    const systemText = (tools && tools.length > 0)
      ? (rawSystemText
          ? `${OPENAI_COMPAT_TOOL_USAGE_RULES}\n${rawSystemText}`
          : OPENAI_COMPAT_TOOL_USAGE_RULES)
      : rawSystemText

    // Cursor only exposes UNSPECIFIED / MEDIUM / HIGH, not a continuous
    // thinking budget — bucket the caller's budget_tokens into those.
    const reasoningEffort: 'medium' | 'high' | null =
      thinking?.type === 'enabled'
        ? ((thinking.budget_tokens ?? 0) >= 16_000 ? 'high' : 'medium')
        : null

    const accessToken = this.accessToken
    if (_looksLikeFreshCursorConversation(messages)) {
      this.conversationId = _newCursorConversationId()
    }
    const gen = _streamCursorAttempt({
      displayModel: model,
      cursorModel: this.resolveModel(model),
      accessToken,
      machineId: this.machineId,
      conversationId: this.conversationId,
      systemText,
      messages,
      tools,
      reasoningEffort,
      signal,
    })

    while (true) {
      const next = await gen.next()
      if (next.done) {
        return next.value.usage
      }
      yield next.value
    }

    return _blankUsage()
  }

  private _resetSessionState(): void {
    this.conversationId = _newCursorConversationId()
  }
}

export function createCursorThinkingSplitState(): CursorThinkingSplitState {
  return { mode: 'thinking', carry: '', trimLeadingText: false }
}

export function splitCursorThinkingDelta(
  chunk: string,
  state: CursorThinkingSplitState,
): { thinking: string | null; text: string | null } {
  if (!chunk) return { thinking: null, text: null }
  if (state.mode === 'text') {
    const text = state.trimLeadingText ? _trimLeadingCursorThinkText(chunk) : chunk
    state.trimLeadingText = false
    return { thinking: null, text: text || null }
  }

  let combined = _stripLeadingCursorThinkTag(state.carry + chunk)
  state.carry = ''

  const closeIdx = combined.indexOf(CURSOR_THINK_CLOSE_MARKER)
  if (closeIdx >= 0) {
    const thinking = combined.slice(0, closeIdx) || null
    const text = _trimLeadingCursorThinkText(
      combined.slice(closeIdx + CURSOR_THINK_CLOSE_MARKER.length),
    )
    state.mode = 'text'
    state.trimLeadingText = !text
    return { thinking, text: text || null }
  }

  const suffixLen = _cursorThinkClosePrefixSuffixLen(combined)
  if (suffixLen > 0) {
    state.carry = combined.slice(-suffixLen)
    combined = combined.slice(0, -suffixLen)
  }

  return { thinking: combined || null, text: null }
}

export function flushCursorThinkingSplitState(
  state: CursorThinkingSplitState,
): { thinking: string | null; text: string | null } {
  if (!state.carry) return { thinking: null, text: null }
  const carry = state.carry
  state.carry = ''
  if (state.mode === 'text') {
    const text = state.trimLeadingText ? _trimLeadingCursorThinkText(carry) : carry
    state.trimLeadingText = false
    return { thinking: null, text: text || null }
  }
  return { thinking: carry, text: null }
}

export function createCursorPrintedToolTextState(): CursorPrintedToolTextState {
  return { pending: '' }
}

export function consumeCursorPrintedToolText(
  chunk: string,
  state: CursorPrintedToolTextState,
  flushAll = false,
): CursorPrintedToolTextChunk[] {
  if (chunk) state.pending += chunk

  const out: CursorPrintedToolTextChunk[] = []
  let pending = state.pending

  while (pending.length > 0) {
    const openIndex = _findCursorToolMarker(pending, CURSOR_PRINTED_TOOL_CALLS_OPEN)
    if (openIndex === -1) {
      if (!flushAll) {
        const keepTail = _cursorPrintedToolOpenPrefixSuffixLen(pending)
        const emitLength = pending.length - keepTail
        if (emitLength > 0) {
          out.push({ type: 'text', text: pending.slice(0, emitLength) })
          pending = pending.slice(emitLength)
        }
        break
      }

      const stripped = _stripDanglingCursorPrintedToolText(pending)
      if (stripped) out.push({ type: 'text', text: stripped })
      pending = ''
      break
    }

    if (openIndex > 0) {
      out.push({ type: 'text', text: pending.slice(0, openIndex) })
      pending = pending.slice(openIndex)
      continue
    }

    const closeIndex = _findCursorToolMarker(
      pending,
      CURSOR_PRINTED_TOOL_CALLS_CLOSE,
      CURSOR_PRINTED_TOOL_CALLS_OPEN.length,
    )
    if (closeIndex === -1) {
      if (flushAll) {
        const stripped = _stripDanglingCursorPrintedToolText(pending)
        if (stripped) out.push({ type: 'text', text: stripped })
        pending = ''
      }
      break
    }

    const blockEnd = closeIndex + CURSOR_PRINTED_TOOL_CALLS_CLOSE.length
    const block = pending.slice(0, blockEnd)
    const calls = parseCursorPrintedToolCalls(block)
    if (calls === null) {
      out.push({ type: 'text', text: block })
    } else if (calls.length > 0) {
      out.push({ type: 'tool_calls', calls })
    }
    pending = pending.slice(blockEnd)
  }

  state.pending = pending
  return out
}

export function flushCursorPrintedToolText(
  state: CursorPrintedToolTextState,
): CursorPrintedToolTextChunk[] {
  return consumeCursorPrintedToolText('', state, true)
}

export function parseCursorPrintedToolCalls(
  block: string,
): CursorPrintedToolCall[] | null {
  if (
    !_cursorToolMarkerMatchesAt(block, 0, CURSOR_PRINTED_TOOL_CALLS_OPEN) ||
    !_cursorToolMarkerMatchesAt(
      block,
      block.length - CURSOR_PRINTED_TOOL_CALLS_CLOSE.length,
      CURSOR_PRINTED_TOOL_CALLS_CLOSE,
    )
  ) {
    return null
  }

  const inner = block.slice(
    CURSOR_PRINTED_TOOL_CALLS_OPEN.length,
    block.length - CURSOR_PRINTED_TOOL_CALLS_CLOSE.length,
  )
  const calls: CursorPrintedToolCall[] = []
  let pos = 0

  while (pos < inner.length) {
    const trimmedLeading = inner.slice(pos).match(/^\s*/)
    pos += trimmedLeading?.[0]?.length ?? 0
    if (pos >= inner.length) break

    if (!_cursorToolMarkerMatchesAt(inner, pos, CURSOR_PRINTED_TOOL_CALL_OPEN)) return null
    pos += CURSOR_PRINTED_TOOL_CALL_OPEN.length

    const closeIndex = _findCursorToolMarker(inner, CURSOR_PRINTED_TOOL_CALL_CLOSE, pos)
    if (closeIndex === -1) return null

    const call = _parseCursorPrintedToolCallBody(inner.slice(pos, closeIndex))
    if (!call) return null
    calls.push(call)

    pos = closeIndex + CURSOR_PRINTED_TOOL_CALL_CLOSE.length
  }

  return calls
}

async function* _streamCursorAttempt(params: {
  displayModel: string
  cursorModel: string
  accessToken: string
  machineId: string | null
  conversationId: string
  systemText: string
  messages: LaneProviderCallParams['messages']
  tools: LaneProviderCallParams['tools']
  reasoningEffort: 'medium' | 'high' | null
  signal: AbortSignal
}): AsyncGenerator<AnthropicStreamEvent, CursorAttemptResult> {
  const body = buildCursorBody({
    model: params.cursorModel,
    system: params.systemText,
    messages: params.messages,
    tools: params.tools,
    reasoningEffort: params.reasoningEffort,
    conversationId: params.conversationId,
  })
  const toolNameMap = _buildCursorToolNameMap(params.tools)
  const toolSchemas = _buildCursorToolSchemaMap(params.tools, toolNameMap)

  const headers = buildCursorHeaders({
    accessToken: params.accessToken,
    machineId: params.machineId,
  })

  const messageId = `cursor-${Date.now()}`
  let messageStartEmitted = false
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let totalContentChars = 0

  // Content-block state.
  let currentIndex = 0
  let openBlock: 'text' | 'thinking' | null = null
  const thinkingSplitState = createCursorThinkingSplitState()
  const printedToolTextState = createCursorPrintedToolTextState()
  let syntheticToolCallCount = 0

  // Per-tool accumulation. Cursor re-emits the same toolCallId across
  // frames and appends raw-args chunks. We buffer arguments so Cursor-native
  // schemas (read_file, replace, run_shell_command, ...) can be adapted back
  // to Claudex executor schemas before the shared tool runner sees them.
  interface ToolEntry {
    anthropicIndex: number
    nativeName: string
    name: string
    rawArgs: string
  }
  const toolBlocks = new Map<string, ToolEntry>()

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
        model: params.displayModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
  }

  const emitTextDelta = function* (text: string): Generator<AnthropicStreamEvent> {
    if (!text) return
    totalContentChars += text.length
    const mst = emitMessageStart()
    if (mst) yield mst
    if (openBlock === 'thinking') {
      yield { type: 'content_block_stop', index: currentIndex }
      currentIndex++
      openBlock = null
    }
    if (openBlock !== 'text') {
      yield {
        type: 'content_block_start',
        index: currentIndex,
        content_block: { type: 'text', text: '' },
      }
      openBlock = 'text'
    }
    yield {
      type: 'content_block_delta',
      index: currentIndex,
      delta: { type: 'text_delta', text },
    }
  }

  const emitThinkingDelta = function* (thinking: string): Generator<AnthropicStreamEvent> {
    if (!thinking) return
    const mst = emitMessageStart()
    if (mst) yield mst
    if (openBlock === 'text') {
      yield { type: 'content_block_stop', index: currentIndex }
      currentIndex++
      openBlock = null
    }
    if (openBlock !== 'thinking') {
      yield {
        type: 'content_block_start',
        index: currentIndex,
        content_block: { type: 'thinking', thinking: '' },
      }
      openBlock = 'thinking'
    }
    yield {
      type: 'content_block_delta',
      index: currentIndex,
      delta: { type: 'thinking_delta', thinking },
    }
  }

  const flushThinkingCarry = function* (): Generator<AnthropicStreamEvent> {
    const flushed = flushCursorThinkingSplitState(thinkingSplitState)
    if (flushed.thinking) yield* emitThinkingDelta(flushed.thinking)
    if (flushed.text) yield* emitCursorVisibleText(flushed.text)
  }

  const queueToolUse = (toolName: string, rawInput: Record<string, unknown>): void => {
    const nativeName = _normalizeCursorToolName(toolName, toolNameMap)
    const resolved = resolveCursorToolCall(nativeName, rawInput, {
      toolSchemas,
    })
    const entryName = resolved?.implId ?? _implNameForCursorToolName(nativeName)
    const entryInput = resolved?.input ?? rawInput
    const id = `cursor-printed-tool-${++syntheticToolCallCount}`
    toolBlocks.set(id, {
      anthropicIndex: currentIndex,
      nativeName,
      name: entryName,
      rawArgs: JSON.stringify(entryInput),
    })
    currentIndex++
  }

  const emitCursorPrintedToolChunks = function* (
    chunks: CursorPrintedToolTextChunk[],
  ): Generator<AnthropicStreamEvent> {
    for (const chunk of chunks) {
      if (chunk.type === 'text') {
        yield* emitTextDelta(chunk.text)
        continue
      }
      if (chunk.type === 'tool_calls') {
        if (openBlock !== null) {
          yield { type: 'content_block_stop', index: currentIndex }
          currentIndex++
          openBlock = null
        }
        for (const call of chunk.calls) {
          queueToolUse(call.name, call.input)
        }
      }
    }
  }

  const emitCursorVisibleText = function* (
    text: string,
  ): Generator<AnthropicStreamEvent> {
    if (!text) return
    const chunks = consumeCursorPrintedToolText(text, printedToolTextState, false)
    yield* emitCursorPrintedToolChunks(chunks)
  }

  const flushPrintedToolText = function* (
    flushAll: boolean,
  ): Generator<AnthropicStreamEvent> {
    const chunks = flushAll
      ? flushCursorPrintedToolText(printedToolTextState)
      : consumeCursorPrintedToolText('', printedToolTextState, false)
    yield* emitCursorPrintedToolChunks(chunks)
  }

  let response: CursorHttpStreamResponse
  try {
    response = await _openCursorHttpStream({
      url: CURSOR_ENDPOINT,
      headers,
      body,
      signal: params.signal,
    })
  } catch (err: unknown) {
    const mst = emitMessageStart()
    if (mst) yield mst
    const message = err instanceof Error ? err.message : String(err)
    yield* _emitErrorText(`cursor API connection error: ${message}`)
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
    yield { type: 'message_stop' }
    return { usage: _blankUsage(), retry: false }
  }

  if (response.status < 200 || response.status >= 300) {
    const errText = await _collectStreamText(response.body).catch(() => '')
    const mst = emitMessageStart()
    if (mst) yield mst
    yield* _emitErrorText(formatCursorApiError(response.status, errText, params.cursorModel))
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
    yield { type: 'message_stop' }
    return { usage: _blankUsage(), retry: false }
  }

  // Residual buffer for partial frames that straddle fetch() chunks.
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let deferredError: string | null = null
  let sawAnyFrame = false

  for await (const value of response.body) {
    if (value && value.length > 0) {
      const merged = new Uint8Array(buffer.length + value.length)
      merged.set(buffer)
      merged.set(value, buffer.length)
      buffer = merged
    }

    // Drain every complete frame from the buffer.
    while (true) {
      const frame = parseConnectFrame(buffer)
      if (!frame) break
      buffer = buffer.slice(frame.consumed)
      sawAnyFrame = true

      const result = extractFromResponsePayload(frame.payload)

      if (result.usage) {
        if (typeof result.usage.promptTokens === 'number') {
          inputTokens = result.usage.promptTokens
        }
        if (typeof result.usage.completionTokens === 'number') {
          outputTokens = result.usage.completionTokens
        }
        if (typeof result.usage.inputTokens === 'number') {
          inputTokens = result.usage.inputTokens
        }
        if (typeof result.usage.outputTokens === 'number') {
          outputTokens = result.usage.outputTokens
        }
        if (typeof result.usage.cacheReadTokens === 'number') {
          cacheReadTokens = result.usage.cacheReadTokens
        }
        if (typeof result.usage.cacheWriteTokens === 'number') {
          cacheWriteTokens = result.usage.cacheWriteTokens
        }
      }

      if (result.error) {
        // 9router's pattern: if the turn already produced content,
        // swallow a trailing error frame (usually a soft rate-limit
        // notice). Otherwise surface it.
        const hadContent = messageStartEmitted && (totalContentChars > 0 || toolBlocks.size > 0)
        if (!hadContent) deferredError = _formatCursorNativeError(result.error, params.cursorModel)
        continue
      }

      if (result.text) {
        yield* flushThinkingCarry()
        yield* emitCursorVisibleText(result.text)
      }

      if (result.thinking) {
        const split = splitCursorThinkingDelta(result.thinking, thinkingSplitState)
        if (split.thinking) {
          yield* flushPrintedToolText(true)
          yield* emitThinkingDelta(split.thinking)
        }
        if (split.text) yield* emitCursorVisibleText(split.text)
      }

      if (result.toolCall) {
        yield* flushPrintedToolText(true)
        yield* flushThinkingCarry()
        const tc = result.toolCall
        const nativeName = _normalizeCursorToolName(tc.name, toolNameMap)
        const toolName = _implNameForCursorToolName(nativeName)
        const mst = emitMessageStart()
        if (mst) yield mst

        let entry = toolBlocks.get(tc.id)
        if (!entry) {
          // First slice of this tool — close any open text/thinking
          // block, claim the next block index.
          if (openBlock !== null) {
            yield { type: 'content_block_stop', index: currentIndex }
            currentIndex++
            openBlock = null
          }
          entry = {
            anthropicIndex: currentIndex,
            nativeName,
            name: toolName,
            rawArgs: '',
          }
          toolBlocks.set(tc.id, entry)
          currentIndex++
        }

        if (tc.argumentsDelta) {
          // Structured protobuf snapshots resend the full args object on
          // each frame. Detect a complete JSON snapshot and replace
          // (overwrite) instead of concatenating — otherwise we get
          // malformed JSON like `{"cmd":"ls"}{"cmd":"ls"}`.
          const delta = tc.argumentsDelta.trim()
          if (
            delta.startsWith('{') &&
            delta.endsWith('}') &&
            entry.rawArgs.trim().startsWith('{')
          ) {
            entry.rawArgs = delta
          } else {
            entry.rawArgs += tc.argumentsDelta
          }
        }
      }
    }
  }

  yield* flushPrintedToolText(true)
  yield* flushThinkingCarry()

  // If a pre-content error was deferred, surface it now.
  if (deferredError !== null && !messageStartEmitted) {
    const mst = emitMessageStart()
    if (mst) yield mst
    yield* _emitErrorText(deferredError)
  }
  if (!sawAnyFrame && deferredError === null) {
    const mst = emitMessageStart()
    if (mst) yield mst
    yield* _emitErrorText('Cursor returned an empty stream.')
  }

  // Close any still-open text/thinking block.
  if (openBlock !== null) {
    yield { type: 'content_block_stop', index: currentIndex }
    openBlock = null
  }

  // Emit complete tool_use blocks after native-to-shared input adaptation.
  for (const [id, entry] of toolBlocks) {
    const nativeInput = _parseCursorToolArgs(entry.rawArgs)
    const resolved = resolveCursorToolCall(entry.nativeName, nativeInput, {
      toolSchemas,
    })
    const name = resolved?.implId ?? entry.name
    const input = resolved?.input ?? nativeInput
    yield {
      type: 'content_block_start',
      index: entry.anthropicIndex,
      content_block: {
        type: 'tool_use',
        id,
        name,
        input: {},
      },
    }
    yield {
      type: 'content_block_delta',
      index: entry.anthropicIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }
    yield { type: 'content_block_stop', index: entry.anthropicIndex }
  }

  if (!messageStartEmitted) {
    const mst = emitMessageStart()
    if (mst) yield mst
  }

  // Cursor doesn't emit token counts — estimate output from char count.
  if (outputTokens === 0 && totalContentChars > 0) {
    outputTokens = Math.max(1, Math.floor(totalContentChars / 4))
  }

  const hadToolUse = toolBlocks.size > 0
  yield {
    type: 'message_delta',
    delta: { stop_reason: hadToolUse ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: outputTokens },
  }
  yield { type: 'message_stop' }

  return {
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      thinking_tokens: 0,
    },
    retry: false,
  }
}

function _blankUsage(): NormalizedUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    thinking_tokens: 0,
  }
}

function _cursorThinkClosePrefixSuffixLen(text: string): number {
  const maxLen = Math.min(text.length, CURSOR_THINK_CLOSE_MARKER.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (CURSOR_THINK_CLOSE_MARKER.startsWith(text.slice(-len))) {
      return len
    }
  }
  return 0
}

function _stripLeadingCursorThinkTag(text: string): string {
  if (text.startsWith('<think>')) return text.slice('<think>'.length)
  if (text.startsWith('<thinking>')) return text.slice('<thinking>'.length)
  return text
}

function _trimLeadingCursorThinkText(text: string): string {
  return text.replace(/^\r?\n/, '')
}

function _cursorPrintedToolOpenPrefixSuffixLen(text: string): number {
  const maxLen = Math.min(text.length, CURSOR_PRINTED_TOOL_CALLS_OPEN.length - 1)
  for (let len = maxLen; len > 0; len--) {
    if (_cursorToolMarkerPrefixMatches(text, text.length - len, CURSOR_PRINTED_TOOL_CALLS_OPEN)) {
      return len
    }
  }
  return 0
}

function _stripDanglingCursorPrintedToolText(text: string): string {
  const markerIndex = _findLastCursorToolMarkerPrefixIndex(text)
  if (markerIndex === -1) return text
  return text.slice(0, markerIndex)
}

function _parseCursorPrintedToolCallBody(body: string): CursorPrintedToolCall | null {
  const trimmed = body.trim()
  if (!trimmed) return null

  const firstSep = _findCursorToolMarker(trimmed, CURSOR_PRINTED_TOOL_SEP)
  const header = (firstSep === -1 ? trimmed : trimmed.slice(0, firstSep)).trim()
  const name = header
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
  if (!name) return null

  const input: Record<string, unknown> = {}
  if (firstSep === -1) return { name, input }

  let params = trimmed.slice(firstSep)
  while (params.length > 0) {
    if (!_cursorToolMarkerMatchesAt(params, 0, CURSOR_PRINTED_TOOL_SEP)) return null
    params = params.slice(CURSOR_PRINTED_TOOL_SEP.length)
    const nextSep = _findCursorToolMarker(params, CURSOR_PRINTED_TOOL_SEP)
    const segment = nextSep === -1 ? params : params.slice(0, nextSep)
    const parsed = _parseCursorPrintedToolParam(segment)
    if (!parsed) return null
    if (Object.prototype.hasOwnProperty.call(input, parsed.key)) return null
    input[parsed.key] = parsed.value
    params = nextSep === -1 ? '' : params.slice(nextSep)
  }

  return { name, input }
}

function _parseCursorPrintedToolParam(
  segment: string,
): { key: string; value: unknown } | null {
  const trimmed = segment.replace(/^\s+/, '')
  const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)/)
  if (!keyMatch) return null
  const key = keyMatch[1]
  const rawValue = trimmed.slice(key.length).replace(/^\s+/, '').trimEnd()
  return { key, value: _parseCursorPrintedToolValue(rawValue) }
}

function _parseCursorPrintedToolValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return trimmed
    }
  }
  return trimmed
}

function _findCursorToolMarker(
  text: string,
  marker: string,
  fromIndex = 0,
): number {
  const start = Math.max(0, fromIndex)
  const lastStart = text.length - marker.length
  for (let i = start; i <= lastStart; i++) {
    if (_cursorToolMarkerMatchesAt(text, i, marker)) return i
  }
  return -1
}

function _findLastCursorToolMarkerPrefixIndex(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '<') continue
    for (const marker of CURSOR_PRINTED_TOOL_MARKERS) {
      if (_cursorToolMarkerPrefixMatches(text, i, marker)) return i
    }
  }
  return -1
}

function _cursorToolMarkerMatchesAt(
  text: string,
  start: number,
  marker: string,
): boolean {
  if (start < 0 || start + marker.length > text.length) return false
  for (let i = 0; i < marker.length; i++) {
    if (!_cursorToolMarkerCharMatches(text[start + i]!, marker[i]!)) return false
  }
  return true
}

function _cursorToolMarkerPrefixMatches(
  text: string,
  start: number,
  marker: string,
): boolean {
  const len = text.length - start
  if (len <= 0 || len > marker.length) return false
  for (let i = 0; i < len; i++) {
    if (!_cursorToolMarkerCharMatches(text[start + i]!, marker[i]!)) return false
  }
  return true
}

function _cursorToolMarkerCharMatches(actual: string, expected: string): boolean {
  if (expected === '|') return actual === '|' || actual === '\uFF5C'
  if (expected === '_') return actual === '_' || actual === '\u2581' || actual === '?'
  return actual === expected
}

function _buildCursorToolNameMap(
  tools: LaneProviderCallParams['tools'],
): Map<string, string> {
  const map = new Map<string, string>()
  const selectedMcpNames = new Map<string, string | null>()

  for (const tool of tools) {
    const original = tool.name
    if (!original) continue

    const formatted = formatCursorToolName(original)
    map.set(original, original)
    map.set(formatted, original)
    if (original.startsWith('mcp__')) {
      map.set(formatted.replace(/-/g, '_'), original)
    }

    const reg =
      getCursorRegistrationByImplId(original) ??
      getCursorRegistrationByNativeName(original)
    if (reg) {
      map.set(reg.nativeName, reg.nativeName)
      map.set(formatCursorToolName(reg.nativeName), reg.nativeName)
    }

    if (original.startsWith('mcp__')) {
      const selected = _extractMcpSelectedToolName(original)
      if (selected) {
        for (const variant of _mcpSelectedToolNameVariants(selected)) {
          selectedMcpNames.set(
            variant,
            selectedMcpNames.has(variant) ? null : original,
          )
        }
      }
      continue
    }

    const unformatted = unformatCursorToolName(formatted)
    if (unformatted && !map.has(unformatted)) {
      map.set(unformatted, original)
    }
  }

  for (const [selected, original] of selectedMcpNames) {
    if (original && !map.has(selected)) {
      map.set(selected, original)
    }
  }

  return map
}

function _mcpSelectedToolNameVariants(name: string): string[] {
  return [...new Set([
    name,
    name.replace(/-/g, '_'),
    name.replace(/_/g, '-'),
  ])]
}

function _buildCursorToolSchemaMap(
  tools: ProviderTool[],
  toolNameMap: Map<string, string>,
): Map<string, Record<string, unknown>> {
  const schemas = new Map<string, Record<string, unknown>>()
  for (const tool of tools) {
    if (!tool.name) continue
    const schema = tool.input_schema ?? {}
    const names = new Set<string>([
      tool.name,
      formatCursorToolName(tool.name),
      unformatCursorToolName(formatCursorToolName(tool.name)),
    ])
    if (tool.name.startsWith('mcp__')) {
      names.add(formatCursorToolName(tool.name).replace(/-/g, '_'))
    }

    const reg =
      getCursorRegistrationByImplId(tool.name) ??
      getCursorRegistrationByNativeName(tool.name)
    if (reg) {
      names.add(reg.nativeName)
      names.add(formatCursorToolName(reg.nativeName))
    }

    const selected = _extractMcpSelectedToolName(tool.name)
    if (selected && toolNameMap.get(selected) === tool.name) {
      for (const variant of _mcpSelectedToolNameVariants(selected)) {
        names.add(variant)
      }
    }

    for (const name of names) {
      schemas.set(name, schema)
    }
  }
  return schemas
}

function _extractMcpSelectedToolName(name: string): string | null {
  const rest = name.startsWith('mcp__') ? name.slice('mcp__'.length) : ''
  const idx = rest.indexOf('__')
  if (idx < 0) return null
  return rest.slice(idx + 2) || null
}

function _normalizeCursorToolName(
  name: string,
  toolNameMap: Map<string, string>,
): string {
  return (
    toolNameMap.get(name) ??
    toolNameMap.get(formatCursorToolName(name)) ??
    unformatCursorToolName(name)
  )
}

function _implNameForCursorToolName(name: string): string {
  return getCursorRegistrationByNativeName(name)?.implId ?? name
}

function _parseCursorToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    if (process.env.CLAUDE_CODE_DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[cursor] _parseCursorToolArgs: empty raw args')
    }
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    if (process.env.CLAUDE_CODE_DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[cursor] _parseCursorToolArgs: parsed to non-object:', typeof parsed)
    }
    return {}
  } catch (err) {
    if (process.env.CLAUDE_CODE_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(
        '[cursor] _parseCursorToolArgs: JSON parse failed:',
        err instanceof Error ? err.message : String(err),
        '| raw (first 200 chars):',
        raw.slice(0, 200),
      )
    }
    return {}
  }
}

function* _emitErrorText(text: string): Generator<AnthropicStreamEvent> {
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
}

async function _openCursorHttpStream(opts: {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
}): Promise<CursorHttpStreamResponse> {
  const controller = new AbortController()
  const cleanup = (): void => {
    if (abortHandler && opts.signal) {
      opts.signal.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  let abortHandler: (() => void) | null = null
  let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new Error('Cursor HTTP request timed out'))
  }, CURSOR_HTTP_TIMEOUT_MS)

  abortHandler = () => {
    controller.abort(opts.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  if (opts.signal?.aborted) {
    abortHandler()
  } else {
    opts.signal?.addEventListener('abort', abortHandler, { once: true })
  }

  try {
    const response = await fetch(opts.url, {
      method: 'POST',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    })

    return {
      status: response.status,
      body: _iterateFetchBody(response.body, cleanup),
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

async function* _iterateFetchBody(
  body: ReadableStream<Uint8Array> | null,
  cleanup: () => void,
): AsyncGenerator<Uint8Array> {
  try {
    if (!body) return
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer>) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    }
  } finally {
    cleanup()
  }
}

async function _collectStreamText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body) {
    chunks.push(chunk)
    total += chunk.length
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
}

export function formatCursorApiError(status: number, body: string, model: string): string {
  const detail = _extractCursorErrorDetail(body)
  if (detail) return _formatCursorNativeError(detail, model)
  if (status === 464 && !isCursorAutoModelId(model)) {
    return _namedModelUnavailableMessage()
  }
  return `Cursor request failed (${status}).`
}

function _extractCursorErrorDetail(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''

  try {
    const parsed = JSON.parse(trimmed) as unknown
    const detail = _extractCursorJsonErrorDetail(parsed)
    return detail ? detail.slice(0, 500) : ''
  } catch {
    return trimmed.slice(0, 500)
  }
}

function _formatCursorNativeError(detail: string, model: string): string {
  const normalized = detail.trim()
  if (!normalized) {
    return !isCursorAutoModelId(model)
      ? _namedModelUnavailableMessage()
      : 'Cursor request failed.'
  }

  if (
    !isCursorAutoModelId(model)
    && (
      /named models unavailable/i.test(normalized)
      || /free plans can only use auto/i.test(normalized)
    )
  ) {
    return _namedModelUnavailableMessage()
  }

  return normalized
}

function _extractCursorJsonErrorDetail(parsed: unknown): string | null {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null
  }

  const record = parsed as Record<string, unknown>
  const topLevelDetails =
    record.details != null
    && typeof record.details === 'object'
    && !Array.isArray(record.details)
      ? record.details as Record<string, unknown>
      : null
  const topLevelTitle =
    topLevelDetails && typeof topLevelDetails.title === 'string'
      ? topLevelDetails.title.trim()
      : ''
  const topLevelDetail =
    topLevelDetails && typeof topLevelDetails.detail === 'string'
      ? topLevelDetails.detail.trim()
      : ''
  if (topLevelTitle || topLevelDetail) {
    return [topLevelTitle, topLevelDetail].filter(Boolean).join('\n')
  }

  const errorValue = record.error
  const nestedError =
    errorValue != null
    && typeof errorValue === 'object'
    && !Array.isArray(errorValue)
      ? errorValue as Record<string, unknown>
      : null
  const detailFromDebug =
    nestedError && Array.isArray(nestedError.details)
      ? nestedError.details
          .map(detail => {
            if (!detail || typeof detail !== 'object') return ''
            const debug = 'debug' in detail ? detail.debug : null
            if (!debug || typeof debug !== 'object') return ''
            const debugRecord = debug as Record<string, unknown>
            const debugDetails =
              debugRecord.details != null
              && typeof debugRecord.details === 'object'
              && !Array.isArray(debugRecord.details)
                ? debugRecord.details as Record<string, unknown>
                : null
            const title =
              debugDetails && typeof debugDetails.title === 'string'
                ? debugDetails.title.trim()
                : ''
            const body =
              debugDetails && typeof debugDetails.detail === 'string'
                ? debugDetails.detail.trim()
                : ''
            if (title || body) return [title, body].filter(Boolean).join('\n')
            return typeof debugRecord.error === 'string' ? debugRecord.error.trim() : ''
          })
          .find(Boolean) ?? null
      : null
  if (detailFromDebug) return detailFromDebug

  const nestedMessage =
    nestedError && typeof nestedError.message === 'string'
      ? nestedError.message.trim()
      : ''
  if (nestedMessage) return nestedMessage

  const topLevelMessage =
    typeof record.message === 'string'
      ? record.message.trim()
      : ''
  if (topLevelMessage) return topLevelMessage

  const stringError =
    typeof errorValue === 'string'
      ? errorValue.trim()
      : ''
  return stringError || null
}

function _namedModelUnavailableMessage(): string {
  return [
    'Error: Named models unavailable',
    'Free plans can only use Auto. Switch to Auto or upgrade plans to continue.',
    'hideIcon: true',
    'hideKeybindings: true',
  ].join('\n')
}

export const cursorLane = new CursorLane()

function _looksLikeFreshCursorConversation(
  messages: LaneProviderCallParams['messages'],
): boolean {
  return messages.length <= 1 && messages.every(message => message.role === 'user')
}

function _newCursorConversationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `cursor-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
