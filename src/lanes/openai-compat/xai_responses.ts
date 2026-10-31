/**
 * xAI (Grok) on the Responses API — the route the `xai` provider takes inside
 * the OpenAI-compatible lane.
 *
 * xAI lists Chat Completions as deprecated: it returns no reasoning content,
 * and for reasoning models "omitting reasoning content is the top cause of
 * cache misses" (docs.x.ai/developers/advanced-api-usage/prompt-caching/
 * multi-turn). This route sends everything that keeps the prefix cache
 * hitting:
 *
 *   - `prompt_cache_key` and the `x-grok-conv-id` header, both the stable Tau
 *     session id, so every request of a conversation reaches the server that
 *     holds its cache (xAI caches per server).
 *   - Encrypted reasoning requested (`include: ["reasoning.encrypted_content"]`
 *     with `store: false`) and replayed unchanged, in wire order, on every
 *     later request — the stateless form of xAI's documented cache contract.
 *   - A prefix that only grows: the stable system prompt as `instructions`,
 *     the volatile environment block frozen per session as the first input
 *     item, every tool's full schema up front in a per-conversation order that
 *     only ever appends, and history that is replayed byte-for-byte.
 *
 * Tools: every tool Tau offers, built-in and MCP, goes out with its whole
 * contract — the Codex lane's deterministic schema sanitizer (local $refs
 * inlined, the root forced to an object as xAI's tool grammar requires), a
 * STRICT PARAMETERS summary in each description, and `strict: false` so
 * optional fields stay optional. Tau validates every call against the full
 * schema before it runs.
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
  ProviderContentBlock,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { recordProviderRateLimits } from '../../services/api/providerRateLimits.js'
import {
  createRetryableConnectionError,
  isAbortError,
  ProviderHttpError,
  throwRetryableProviderHttpError,
} from '../../services/api/transport_error.js'
import { decodeToolArguments, toolDecodeFields } from '../../services/mcp/decodeStatus.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/constants.js'
import {
  getXaiModelMeta,
  listXaiModelMeta,
  normalizeXaiModelId,
  recordXaiLiveModels,
  XAI_DEFAULT_BASE_URL,
  xaiMaxOutputTokens,
  type XaiApiModel,
  type XaiModelMeta,
} from '../../utils/model/xaiCatalog.js'
import { resolveXaiRequestEffort } from '../../utils/model/xaiThinking.js'
import type { CodexReasoningState } from '../codex/reasoning.js'
import { toCodexToolParameters } from '../codex/tool_schema.js'
import { appendStrictParamsHint, buildOpenAICompatToolUsageRules } from '../shared/mcp_bridge.js'
import { providerFailureEvents } from '../shared/provider_failure.js'
import { isMediaBlock } from '../shared/media_blocks.js'
import { renderMediaForTextLane } from '../shared/media_extract.js'
import { isOutputCapTruncation, laneStopReason } from '../shared/truncation.js'
import { decideImageSupport, recordModelVision } from '../shared/vision_capability.js'
import { freezeSessionVolatileText, volatileFreezeKey } from '../shared/volatile_freeze.js'
import type { LaneProviderCallParams, NormalizedUsage } from '../types.js'
import { readSseDataPayloads } from './sse_payloads.js'

const PROVIDER = 'xai'
const DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
/** The first volatile section when the prompt carries no boundary marker. */
const VOLATILE_SECTION = /# Session-specific guidance\b|<env>|# Environment\b|# currentDate\n|# gitStatus\b/

// ─── System prompt ───────────────────────────────────────────────────

/**
 * The part of the system prompt that stays byte-identical for the session,
 * and the volatile tail (environment, git status, memory, date). The marker
 * is present whenever xAI is the session provider (systemBoundaryProviders);
 * an agent pinned to xAI from another provider's session falls back to the
 * first known volatile heading.
 */
export function splitXaiSystem(system: string): { stable: string; volatile: string } {
  const marker = system.indexOf(DYNAMIC_BOUNDARY)
  if (marker >= 0) {
    return {
      stable: system.slice(0, marker).trimEnd(),
      volatile: system.slice(marker + DYNAMIC_BOUNDARY.length).split(DYNAMIC_BOUNDARY).join('').trimStart(),
    }
  }
  const cut = system.search(VOLATILE_SECTION)
  if (cut < 0) return { stable: system, volatile: '' }
  return { stable: system.slice(0, cut).trimEnd(), volatile: system.slice(cut).trimStart() }
}

function systemText(system: LaneProviderCallParams['system']): string {
  return typeof system === 'string' ? system : (system ?? []).map(block => block.text).join('\n\n')
}

// ─── Tools ───────────────────────────────────────────────────────────

export interface XaiFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: false
}

/** A tool's declaration as this route sends it. */
export function toXaiFunctionTool(tool: ProviderTool): XaiFunctionTool {
  const parameters = toCodexToolParameters(tool.input_schema ?? { type: 'object', properties: {} })
  return {
    type: 'function',
    name: tool.name,
    description: appendStrictParamsHint(tool.description ?? '', parameters),
    parameters,
    strict: false,
  }
}

const TOOL_ORDER_LIMIT = 256
const toolOrders = new Map<string, Map<string, XaiFunctionTool>>()

/**
 * Per-conversation tool order. Tau lists tools sorted, so an MCP server that
 * connects mid-conversation would insert its tools in the middle of the block
 * and void the cache behind them. A conversation keeps the order its tools
 * were first sent in: a new tool is appended, and a tool keeps its first
 * declaration until its parameters change. A tool missing from a request is
 * not sent but keeps its slot. Same rule as the Codex lane's tool order.
 */
export function freezeXaiToolOrder(key: string, tools: readonly XaiFunctionTool[]): XaiFunctionTool[] {
  const snapshot = toolOrders.get(key) ?? new Map<string, XaiFunctionTool>()
  toolOrders.delete(key)
  toolOrders.set(key, snapshot)
  while (toolOrders.size > TOOL_ORDER_LIMIT) {
    const oldest = toolOrders.keys().next().value
    if (oldest === undefined || oldest === key) break
    toolOrders.delete(oldest)
  }
  const present = new Set<string>()
  for (const tool of tools) {
    present.add(tool.name)
    const saved = snapshot.get(tool.name)
    if (!saved || JSON.stringify(saved.parameters) !== JSON.stringify(tool.parameters)) {
      snapshot.set(tool.name, tool)
    }
  }
  return [...snapshot.values()].filter(tool => present.has(tool.name))
}

/** MCP tool name → declaration xAI refused, left out until its schema changes. */
const quarantined = new Map<string, string>()

function declarationKey(tool: XaiFunctionTool): string {
  return JSON.stringify(tool.parameters)
}

function isQuarantined(tool: XaiFunctionTool): boolean {
  return quarantined.get(tool.name) === declarationKey(tool)
}

/**
 * The MCP tool a 400 names, when xAI could not compile its schema into a tool
 * grammar. Built-in tools are never left out: a rejection there is a Tau bug
 * and must surface.
 */
export function findRejectedXaiTool(errorText: string, tools: readonly XaiFunctionTool[]): XaiFunctionTool | undefined {
  const lowered = errorText.toLowerCase()
  if (!/schema|grammar|parameters|function|tool/.test(lowered)) return undefined
  return tools
    .filter(tool => tool.name.startsWith('mcp__'))
    .sort((a, b) => b.name.length - a.name.length)
    .find(tool => errorText.includes(tool.name))
}

// ─── Tool-call ids ───────────────────────────────────────────────────

const TOOL_USE_PREFIX = 'toolu_xai_'
const ENCODED_PREFIX = 'b64_'

/** A Tau tool_use id for an xAI call id. Reversible, deterministic. */
export function tauToolUseIdForXaiCall(callId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(callId) && !callId.startsWith(ENCODED_PREFIX)
    ? `${TOOL_USE_PREFIX}${callId}`
    : `${TOOL_USE_PREFIX}${ENCODED_PREFIX}${Buffer.from(callId, 'utf8').toString('base64url')}`
}

/** The call id xAI issued for a Tau tool_use id (ids from other routes pass through). */
export function xaiCallIdForToolUse(toolUseId: string): string {
  if (!toolUseId.startsWith(TOOL_USE_PREFIX)) return toolUseId
  const rest = toolUseId.slice(TOOL_USE_PREFIX.length)
  if (!rest.startsWith(ENCODED_PREFIX)) return rest
  try {
    return Buffer.from(rest.slice(ENCODED_PREFIX.length), 'base64url').toString('utf8')
  } catch {
    return rest
  }
}

// ─── History ─────────────────────────────────────────────────────────

type InputPart = Record<string, unknown>

const SENDABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png'])

function canSeeImages(model: string): boolean {
  const meta = getXaiModelMeta(model)
  if (meta) recordModelVision(PROVIDER, model, meta.imageInput)
  return decideImageSupport(PROVIDER, model)
}

function imagePart(block: unknown, model: string): InputPart {
  const source = (block as { source?: Record<string, unknown> } | null)?.source
  if (source && canSeeImages(model)) {
    const mediaType = String(source.media_type ?? '').toLowerCase()
    if (source.type === 'base64' && typeof source.data === 'string' && SENDABLE_IMAGE_TYPES.has(mediaType)) {
      return { type: 'input_image', image_url: `data:${mediaType};base64,${source.data}` }
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      return { type: 'input_image', image_url: source.url }
    }
  }
  return { type: 'input_text', text: renderMediaForTextLane(block) }
}

function filePart(block: unknown, model: string): InputPart {
  const doc = block as { source?: Record<string, unknown>; title?: unknown } | null
  const source = doc?.source
  if (
    getXaiModelMeta(model)?.fileInput
    && source?.type === 'base64'
    && String(source.media_type ?? '').toLowerCase() === 'application/pdf'
    && typeof source.data === 'string'
  ) {
    const title = typeof doc?.title === 'string' && doc.title.trim() ? doc.title.trim() : 'document'
    return {
      type: 'input_file',
      filename: title.toLowerCase().endsWith('.pdf') ? title : `${title}.pdf`,
      file_data: `data:application/pdf;base64,${source.data}`,
    }
  }
  return { type: 'input_text', text: renderMediaForTextLane(block) }
}

function isDocumentBlock(block: unknown): boolean {
  return (block as { type?: unknown } | null)?.type === 'document'
}

/**
 * A tool result as `function_call_output.output`: plain text when it is text
 * only, else the parts list xAI accepts there (text, images, PDFs).
 */
function toolOutput(content: ProviderContentBlock['content'], model: string): string | InputPart[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  const parts: InputPart[] = []
  let media = false
  for (const child of content) {
    if (child && typeof child === 'object' && child.type === 'text' && typeof child.text === 'string') {
      parts.push({ type: 'input_text', text: child.text })
    } else if (child?.type === 'image') {
      const part = imagePart(child, model)
      media ||= part.type === 'input_image'
      parts.push(part)
    } else if (isDocumentBlock(child)) {
      const part = filePart(child, model)
      media ||= part.type === 'input_file'
      parts.push(part)
    } else if (isMediaBlock(child)) {
      parts.push({ type: 'input_text', text: renderMediaForTextLane(child) })
    } else {
      parts.push({ type: 'input_text', text: JSON.stringify(child) })
    }
  }
  if (!media) return parts.map(part => String(part.text ?? '')).join('\n')
  return parts
}

/** Encrypted reasoning this block carries for `model`, each item once. */
function replayedReasoning(block: ProviderContentBlock, model: string, seen: Set<string>): InputPart[] {
  const state = block._codex_reasoning as CodexReasoningState | undefined
  if (!state || normalizeXaiModelId(state.model ?? '') !== model || !Array.isArray(state.items)) return []
  const out: InputPart[] = []
  for (const item of state.items) {
    if (!item?.id || typeof item.encrypted_content !== 'string' || !item.encrypted_content || seen.has(item.id)) continue
    seen.add(item.id)
    out.push({
      type: 'reasoning',
      id: item.id,
      summary: Array.isArray(item.summary) ? item.summary : [],
      encrypted_content: item.encrypted_content,
    })
  }
  return out
}

/**
 * Tau's history as Responses input items. Assistant turns replay their
 * encrypted reasoning where it sat on the wire — before the message or call
 * that followed it — and only for the model that produced it.
 */
export function convertXaiHistory(messages: readonly ProviderMessage[], model: string): InputPart[] {
  const replayModel = normalizeXaiModelId(model)
  const out: InputPart[] = []
  const seen = new Set<string>()

  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (!message.content) continue
      out.push(message.role === 'assistant'
        ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] }
        : { type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }] })
      continue
    }

    if (message.role === 'assistant') {
      let text: InputPart[] = []
      const flush = (): void => {
        if (text.length === 0) return
        out.push({ type: 'message', role: 'assistant', content: text })
        text = []
      }
      for (const block of message.content) {
        const reasoning = replayedReasoning(block, replayModel, seen)
        if (reasoning.length > 0) {
          flush()
          out.push(...reasoning)
        }
        if (block.type === 'text' && block.text) {
          text.push({ type: 'output_text', text: block.text })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          flush()
          out.push({
            type: 'function_call',
            call_id: xaiCallIdForToolUse(block.id),
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
        // Visible thinking is display-only: the encrypted item above is what
        // the model reads back.
      }
      flush()
      continue
    }

    let parts: InputPart[] = []
    const flush = (): void => {
      if (parts.length === 0) return
      out.push({ type: 'message', role: 'user', content: parts })
      parts = []
    }
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        flush()
        out.push({
          type: 'function_call_output',
          call_id: xaiCallIdForToolUse(block.tool_use_id),
          output: toolOutput(block.content, replayModel),
        })
      } else if (block.type === 'text' && block.text) {
        parts.push({ type: 'input_text', text: block.text })
      } else if (block.type === 'image') {
        parts.push(imagePart(block, replayModel))
      } else if (isDocumentBlock(block)) {
        parts.push(filePart(block, replayModel))
      } else if (isMediaBlock(block)) {
        parts.push({ type: 'input_text', text: renderMediaForTextLane(block) })
      }
    }
    flush()
  }
  return out
}

// ─── Request ─────────────────────────────────────────────────────────

export interface XaiRequestInput {
  model: string
  system: LaneProviderCallParams['system']
  messages: readonly ProviderMessage[]
  tools: readonly ProviderTool[]
  maxTokens: number
  temperature?: number
  sessionId?: string
  /** `reasoning.effort`, already resolved against the model's ladder. */
  effort?: string
}

export interface XaiResponsesRequest {
  body: Record<string, unknown>
  /** The declarations sent, for the rejected-schema backstop. */
  tools: XaiFunctionTool[]
}

export function buildXaiResponsesRequest(input: XaiRequestInput): XaiResponsesRequest {
  const model = input.model
  const messages = [...input.messages]

  const tools = input.tools
    // Every schema is declared up front, so there is nothing to discover.
    .filter(tool => tool.name !== TOOL_SEARCH_TOOL_NAME)
    .map(toXaiFunctionTool)
  const orderKey = `${PROVIDER}:${input.sessionId?.trim() || volatileFreezeKey(PROVIDER, model, undefined, messages)}`
  const declared = freezeXaiToolOrder(orderKey, tools).filter(tool => !isQuarantined(tool))

  const { stable, volatile } = splitXaiSystem(systemText(input.system))
  const rules = declared.length > 0 ? buildOpenAICompatToolUsageRules(false) : ''
  const instructions = [rules.trim(), stable].filter(Boolean).join('\n')
  const frozen = freezeSessionVolatileText(
    volatileFreezeKey(PROVIDER, model, input.sessionId, messages, volatile),
    volatile,
  ).trim()

  const items: InputPart[] = []
  if (frozen) items.push({ type: 'message', role: 'system', content: frozen })
  items.push(...convertXaiHistory(messages, model))

  const cap = xaiMaxOutputTokens(model)
  const maxOutput = Number.isFinite(input.maxTokens) && input.maxTokens > 0
    ? (cap ? Math.min(input.maxTokens, cap) : input.maxTokens)
    : undefined

  const body: Record<string, unknown> = {
    model,
    ...(instructions && { instructions }),
    input: items,
    ...(declared.length > 0 && { tools: declared, tool_choice: 'auto' }),
    ...(maxOutput !== undefined && { max_output_tokens: maxOutput }),
    ...(input.temperature !== undefined && { temperature: input.temperature }),
    ...(input.effort && { reasoning: { effort: input.effort } }),
    include: ['reasoning.encrypted_content'],
    store: false,
    ...(input.sessionId && { prompt_cache_key: input.sessionId }),
    stream: true,
  }
  return { body, tools: declared }
}

export function xaiRequestHeaders(apiKey: string, sessionId?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': `Bearer ${apiKey}`,
    // Sticky routing to the server holding this conversation's cache. The
    // body's prompt_cache_key carries the same id.
    ...(sessionId && { 'x-grok-conv-id': sessionId }),
  }
}

// ─── Spend xAI reports ───────────────────────────────────────────────

/** 1 USD = 10^10 ticks (docs.x.ai/developers/cost-tracking). */
const TICKS_PER_USD = 10_000_000_000

const spend = { requests: 0, ticks: 0 }

/** What xAI billed this process, summed from `usage.cost_in_usd_ticks`. */
export function getXaiSessionSpend(): { requests: number; usd: number } {
  return { requests: spend.requests, usd: spend.ticks / TICKS_PER_USD }
}

export function _resetXaiSessionSpendForTests(): void {
  spend.requests = 0
  spend.ticks = 0
}

// ─── Stream ──────────────────────────────────────────────────────────

type OpenBlock =
  | { kind: 'text'; index: number }
  | { kind: 'thinking'; index: number; state: CodexReasoningState; summaryIndex?: number }

interface PendingCall {
  callId: string
  name: string
  args: string
}

/**
 * Responses stream events → the Anthropic IR Tau consumes. Encrypted
 * reasoning rides on the blocks as `_codex_reasoning` (the Codex lane's
 * state, scoped by model id): on the thinking block that showed it, and on
 * the next text or tool block, so it survives a transcript that drops
 * thinking blocks. Replay dedups by item id.
 */
export class XaiResponsesStream {
  private started = false
  private nextIndex = 0
  private readonly open = new Map<number, OpenBlock>()
  private readonly calls = new Map<number, PendingCall>()
  private pendingReasoning: CodexReasoningState['items'] = []
  private sawToolUse = false
  private truncated = false
  private inputTokens = 0
  private cachedTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  /** `usage.cost_in_usd_ticks` of the finished response, when reported. */
  costTicks: number | undefined
  /** Set when the stream reported a failure. */
  failure: { message: string; code?: string } | null = null

  constructor(
    private readonly model: string,
    private readonly messageId: string,
  ) {}

  /** Whether any event has been emitted yet. */
  get emitted(): boolean {
    return this.started
  }

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

  private takeReasoning(): { _codex_reasoning?: CodexReasoningState } {
    if (this.pendingReasoning.length === 0) return {}
    const state = { model: this.model, items: this.pendingReasoning }
    this.pendingReasoning = []
    return { _codex_reasoning: state }
  }

  private openText(out: AnthropicStreamEvent[], outputIndex: number): OpenBlock {
    const existing = this.open.get(outputIndex)
    if (existing?.kind === 'text') return existing
    this.start(out)
    const block: OpenBlock = { kind: 'text', index: this.nextIndex++ }
    this.open.set(outputIndex, block)
    out.push({
      type: 'content_block_start',
      index: block.index,
      content_block: { type: 'text', text: '', ...this.takeReasoning() },
    })
    return block
  }

  private openThinking(out: AnthropicStreamEvent[], outputIndex: number): OpenBlock & { kind: 'thinking' } {
    const existing = this.open.get(outputIndex)
    if (existing?.kind === 'thinking') return existing
    this.start(out)
    const block = { kind: 'thinking' as const, index: this.nextIndex++, state: { model: this.model, items: [] } }
    this.open.set(outputIndex, block)
    out.push({
      type: 'content_block_start',
      index: block.index,
      content_block: { type: 'thinking', thinking: '', _codex_reasoning: block.state },
    })
    return block
  }

  private close(out: AnthropicStreamEvent[], outputIndex: number): void {
    const block = this.open.get(outputIndex)
    if (!block) return
    this.open.delete(outputIndex)
    out.push({ type: 'content_block_stop', index: block.index })
  }

  private emitCall(out: AnthropicStreamEvent[], call: PendingCall): void {
    this.start(out)
    const decoded = decodeToolArguments(call.args || '{}')
    const index = this.nextIndex++
    // One start, one complete argument delta, one stop: input inline on the
    // start would leave Tau's accumulator empty.
    out.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: tauToolUseIdForXaiCall(call.callId),
        name: call.name,
        input: {},
        ...toolDecodeFields(decoded),
        ...this.takeReasoning(),
      },
    })
    out.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(decoded.input ?? {}) },
    })
    out.push({ type: 'content_block_stop', index })
    this.sawToolUse = true
  }

  push(event: Record<string, unknown>): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    const type = String(event.type ?? '')
    const outputIndex = typeof event.output_index === 'number' ? event.output_index : -1
    const item = event.item as Record<string, unknown> | undefined

    switch (type) {
      case 'response.output_item.added':
        if (item?.type === 'message') this.openText(out, outputIndex)
        else if (item?.type === 'reasoning') this.openThinking(out, outputIndex)
        else if (item?.type === 'function_call') {
          this.calls.set(outputIndex, {
            callId: String(item.call_id ?? item.id ?? `call_${outputIndex}`),
            name: String(item.name ?? ''),
            args: typeof item.arguments === 'string' ? item.arguments : '',
          })
        }
        break
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) {
          const block = this.openText(out, outputIndex)
          out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text: event.delta } })
        }
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof event.delta === 'string' && event.delta) {
          const block = this.openThinking(out, outputIndex)
          const summaryIndex = typeof event.summary_index === 'number' ? event.summary_index : 0
          if (block.summaryIndex !== undefined && summaryIndex !== block.summaryIndex) {
            out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'thinking_delta', thinking: '\n\n' } })
          }
          block.summaryIndex = summaryIndex
          out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'thinking_delta', thinking: event.delta } })
        }
        break
      case 'response.function_call_arguments.delta': {
        const call = this.calls.get(outputIndex)
        if (call && typeof event.delta === 'string') call.args += event.delta
        break
      }
      case 'response.function_call_arguments.done': {
        const call = this.calls.get(outputIndex)
        if (call && typeof event.arguments === 'string') call.args = event.arguments
        break
      }
      case 'response.output_item.done':
        this.itemDone(out, outputIndex, item)
        break
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response as Record<string, unknown> | undefined
        this.readUsage(response?.usage)
        const reason = (response?.incomplete_details as { reason?: unknown } | undefined)?.reason
        if (type === 'response.incomplete' && isOutputCapTruncation(reason ?? 'max_output_tokens')) this.truncated = true
        break
      }
      case 'response.failed': {
        const error = (event.response as { error?: Record<string, unknown> } | undefined)?.error
        this.failure = {
          message: String(error?.message ?? 'response failed'),
          ...(typeof error?.code === 'string' && { code: error.code }),
        }
        break
      }
      case 'error': {
        const nested = event.error as Record<string, unknown> | undefined
        this.failure = {
          message: String(event.message ?? nested?.message ?? 'stream error'),
          ...(typeof (event.code ?? nested?.code) === 'string' && { code: String(event.code ?? nested?.code) }),
        }
        break
      }
    }
    return out
  }

  private itemDone(out: AnthropicStreamEvent[], outputIndex: number, item: Record<string, unknown> | undefined): void {
    if (item?.type === 'reasoning') {
      if (typeof item.id === 'string' && item.id && typeof item.encrypted_content === 'string' && item.encrypted_content) {
        const saved = {
          id: item.id,
          encrypted_content: item.encrypted_content,
          summary: Array.isArray(item.summary)
            ? structuredClone(item.summary) as Array<{ type: 'summary_text'; text: string }>
            : [],
        }
        const block = this.open.get(outputIndex)
        if (block?.kind === 'thinking') block.state.items.push(saved)
        this.pendingReasoning.push(saved)
      }
      this.close(out, outputIndex)
      return
    }

    if (item?.type === 'function_call') {
      const pending = this.calls.get(outputIndex)
      this.calls.delete(outputIndex)
      // xAI sends a call whole: the done item is authoritative.
      this.emitCall(out, {
        callId: String(item.call_id ?? pending?.callId ?? item.id ?? `call_${outputIndex}`),
        name: String(item.name ?? pending?.name ?? ''),
        args: typeof item.arguments === 'string' && item.arguments ? item.arguments : pending?.args ?? '',
      })
      return
    }

    if (item?.type === 'message' && !this.open.has(outputIndex)) {
      // A message that arrived whole, with no deltas.
      const text = Array.isArray(item.content)
        ? item.content
            .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
              ? (part as { text: string }).text
              : ''))
            .join('')
        : ''
      if (!text) return
      const block = this.openText(out, outputIndex)
      out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text } })
    }
    this.close(out, outputIndex)
  }

  private readUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const usage = raw as Record<string, any>
    const number = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    const input = number(usage.input_tokens) ?? number(usage.prompt_tokens)
    const cached = number(usage.input_tokens_details?.cached_tokens) ?? number(usage.prompt_tokens_details?.cached_tokens)
    const output = number(usage.output_tokens) ?? number(usage.completion_tokens)
    const reasoning = number(usage.output_tokens_details?.reasoning_tokens)
      ?? number(usage.completion_tokens_details?.reasoning_tokens)
    const total = number(usage.total_tokens)
    if (input !== undefined) this.inputTokens = input
    if (cached !== undefined) this.cachedTokens = Math.min(cached, this.inputTokens || cached)
    if (reasoning !== undefined) this.reasoningTokens = reasoning
    if (output !== undefined) {
      // Responses streams count reasoning inside output_tokens. Should a
      // response state them apart (total = input + output + reasoning), the
      // reasoning is billed as output all the same.
      this.outputTokens = total !== undefined && reasoning && total === (input ?? 0) + output + reasoning
        ? output + reasoning
        : output
    }
    const ticks = number(usage.cost_in_usd_ticks)
    if (ticks !== undefined) this.costTicks = ticks
  }

  /** Close what is open and add `text` as the turn's last text block. */
  fail(text: string): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    for (const outputIndex of [...this.open.keys()]) this.close(out, outputIndex)
    // A call still streaming its arguments is dropped, never sent half-written.
    this.calls.clear()
    const index = this.nextIndex++
    out.push(...providerFailureEvents(index, text))
    return out
  }

  finish(): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    this.start(out)
    for (const outputIndex of [...this.open.keys()]) this.close(out, outputIndex)
    // Responses reports the whole prompt; Tau's buckets are additive.
    const fresh = Math.max(0, this.inputTokens - this.cachedTokens)
    out.push({
      type: 'message_delta',
      delta: { stop_reason: laneStopReason({ truncated: this.truncated, hadToolUse: this.sawToolUse }) },
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

// ─── Errors ──────────────────────────────────────────────────────────

const CONTEXT_EXCEEDED_MARKERS = [
  'maximum prompt length',
  'maximum context length',
  'context length',
  'context_length_exceeded',
  'context window',
  'prompt is too long',
  'too many tokens',
  'token limit',
]

/** The message inside an xAI error body (`{"code","error"}` or OpenAI-style). */
export function xaiErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string' && error.trim()) return error.trim()
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return String((error as { message: string }).message).trim()
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
  } catch {
    // Not JSON: the raw text is the message.
  }
  return body.trim().slice(0, 500)
}

export function isXaiContextExceeded(status: number, body: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) return false
  const lowered = body.toLowerCase()
  return CONTEXT_EXCEEDED_MARKERS.some(marker => lowered.includes(marker))
}

/**
 * A rejection as an error, never as assistant text: text would be saved as
 * the model's own words and replayed on every later turn. "Prompt is too
 * long" starts the message so reactive compaction recognizes it.
 */
function xaiHttpError(status: number, body: string, headers: Headers): ProviderHttpError {
  const detail = xaiErrorDetail(body)
  const message = isXaiContextExceeded(status, body)
    ? `Prompt is too long (xai ${status}): ${detail}`
    : status === 401 || status === 403
      ? `xai API error ${status}: ${detail} — run /login xai to replace the API key`
      : `xai API error ${status}: ${detail}`
  return new ProviderHttpError(PROVIDER, status, body, headers, message)
}

// ─── Models ──────────────────────────────────────────────────────────

function toModelInfo(meta: XaiModelMeta, recommended: string | undefined): ModelInfo {
  const tags: string[] = []
  if (meta.reasoning) tags.push('reasoning')
  if (meta.toolCalling) tags.push('tools')
  if (meta.id === recommended) tags.push('recommended')
  return {
    id: meta.id,
    name: meta.name,
    ...(meta.contextWindow !== undefined && { contextWindow: meta.contextWindow }),
    supportsToolCalling: meta.toolCalling,
    tags,
  }
}

/**
 * The /models rows for the logged-in key, newest first. xAI's own
 * `GET /v1/models` is recorded first (ladders, windows, prices); offline, the
 * last recorded listing or the snapshot answers.
 */
export async function listXaiModels(cfg: { apiKey: string; baseUrl: string }): Promise<ModelInfo[]> {
  const baseUrl = (cfg.baseUrl || XAI_DEFAULT_BASE_URL).replace(/\/+$/, '')
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) {
      const data = await response.json() as { data?: XaiApiModel[] }
      if (Array.isArray(data?.data)) recordXaiLiveModels(data.data)
    }
  } catch {
    // Offline or refused: the recorded or snapshot catalog answers.
  }
  const models = listXaiModelMeta()
  // xAI names Grok 4.7 the model for code; otherwise the newest main-line row.
  const recommended = models.find(meta => meta.id === 'grok-4.7')?.id
    ?? models.find(meta => /^grok-\d/.test(meta.id))?.id
  for (const meta of models) recordModelVision(PROVIDER, meta.id, meta.imageInput)
  return models.map(meta => toModelInfo(meta, recommended))
}

// ─── Request lifecycle ───────────────────────────────────────────────

export async function* streamXaiResponses(
  cfg: { apiKey: string; baseUrl: string },
  params: LaneProviderCallParams,
  sessionId: string | undefined,
): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
  const request = buildXaiResponsesRequest({
    model: params.model,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    sessionId,
    effort: resolveXaiRequestEffort(params.model, params.effortValue),
  })
  const baseUrl = (cfg.baseUrl || XAI_DEFAULT_BASE_URL).replace(/\/+$/, '')

  let response: Response
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: xaiRequestHeaders(cfg.apiKey, sessionId),
      body: JSON.stringify(request.body),
      signal: params.signal,
    })
  } catch (error) {
    // Nothing reached the model: the shared controller retries, and no
    // assistant turn is written that would shift the cached prefix.
    if (isAbortError(error, params.signal)) throw error
    throw createRetryableConnectionError('xai API connection error', error)
  }
  recordProviderRateLimits(PROVIDER, response.headers)

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throwRetryableProviderHttpError(PROVIDER, response, body)
    const rejected = response.status === 400 ? findRejectedXaiTool(body, request.tools) : undefined
    if (rejected) {
      // xAI could not compile one MCP tool's schema. Leave that declaration
      // out and let the shared controller retry the turn without it.
      quarantined.set(rejected.name, declarationKey(rejected))
      throw createRetryableConnectionError(
        `xAI rejected the tool schema of ${rejected.name}; retrying without that tool`,
        new Error(xaiErrorDetail(body)),
      )
    }
    throw xaiHttpError(response.status, body, response.headers)
  }
  if (!response.body) {
    throw new ProviderHttpError(PROVIDER, response.status, '', response.headers, 'xai API error: empty response body')
  }

  const stream = new XaiResponsesStream(params.model, `xai-${Date.now()}`)
  const responseBody = response.body
  try {
    for await (const payload of readSseDataPayloads(responseBody)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      for (const event of stream.push(parsed as Record<string, unknown>)) yield event
      if (stream.failure) break
    }
  } catch (error) {
    if (isAbortError(error, params.signal)) throw error
    if (!stream.emitted) throw createRetryableConnectionError('xai API connection error', error)
    for (const event of stream.fail(`xai stream interrupted: ${error instanceof Error ? error.message : String(error)}`)) yield event
    for (const event of stream.finish()) yield event
    return stream.usage
  }

  if (stream.failure) {
    await responseBody.cancel().catch(() => {})
    if (!stream.emitted) {
      // Failed before any output: surface it as an error (retried when the
      // code says the server was at fault), never as model text.
      const status = /rate|capacity|overload|unavailable|internal|server/i.test(stream.failure.code ?? stream.failure.message)
        ? 503
        : 400
      const body = JSON.stringify({ error: stream.failure })
      throwRetryableProviderHttpError(PROVIDER, { status, headers: response.headers }, body)
      throw xaiHttpError(status, body, response.headers)
    }
    for (const event of stream.fail(`xai API stream error: ${stream.failure.message}`)) yield event
  }

  for (const event of stream.finish()) yield event
  if (stream.costTicks !== undefined) {
    spend.requests += 1
    spend.ticks += stream.costTicks
  }
  return stream.usage
}
