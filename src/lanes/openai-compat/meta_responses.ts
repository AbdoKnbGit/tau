/**
 * Meta (Muse) on the Responses API — the route the `meta` provider takes
 * inside the OpenAI-compatible lane.
 *
 * Meta recommends Responses for agents and coding tools: it is the API that
 * carries reasoning across turns (dev.meta.ai/docs/protocols). Chat
 * Completions redacts reasoning for external keys. This route sends what Meta
 * documents for a prefix-cache hit (dev.meta.ai/docs/prompt-caching,
 * /docs/protocols/responses):
 *
 *   - Stateless encrypted replay, Meta's recommended mode: `store: false`
 *     with `include: ["reasoning.encrypted_content"]`, each reasoning item
 *     replayed unchanged where it sat on the wire, only to the model that
 *     produced it. Spark re-issues its items in `response.completed` with
 *     fresh encrypted content; the streamed copy is the one replayed.
 *   - Assistant `phase` preserved. A preamble before a tool call is
 *     `commentary`, and replayed as a final answer it is a 400.
 *   - `prompt_cache_key` naming the shared prefix: a hash of the model and the
 *     stable instructions, never the session id (Meta: "unique keys per user
 *     or per session lower hit rates"). `prompt_cache_retention: "24h"` keeps
 *     the prefix warm across an agent session's idle gaps.
 *   - A prefix that only grows: the stable system prompt as `instructions`,
 *     the volatile environment block frozen per session as the first input
 *     item, every tool's full schema up front in a per-conversation order that
 *     only appends, and history replayed byte-for-byte.
 *
 * Never sent, because Meta rejects or advises against them: a `tool_choice`
 * other than "auto", `truncation: "auto"`, `stop`, logprobs,
 * `reasoning.effort: "none"`, and sampling overrides ("the model performs
 * best at the defaults").
 *
 * Tools: every tool Tau offers, built-in and MCP, goes out with its whole
 * contract — the Codex lane's deterministic schema sanitizer, a STRICT
 * PARAMETERS summary in each description, and `strict: false` so optional
 * fields stay optional. Tau validates every call against the full schema
 * before it runs.
 */

import { createHash } from 'node:crypto'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { checkMetaApiKey, META_BILLING_URL } from '../../services/api/metaAccount.js'
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
  ensureMetaCatalogFresh,
  getMetaCatalogPrice,
  getMetaModelMeta,
  isMuseModelId,
  listMetaModelMeta,
  META_DEFAULT_BASE_URL,
  metaMaxOutputTokens,
  normalizeMetaModelId,
  recordMetaLiveModels,
  type MetaModelMeta,
} from '../../utils/model/metaCatalog.js'
import { resolveMetaRequestEffort } from '../../utils/model/metaThinking.js'
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

const PROVIDER = 'meta'
const DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
/** The first volatile section when the prompt carries no boundary marker. */
const VOLATILE_SECTION = /# Session-specific guidance\b|<env>|# Environment\b|# currentDate\n|# gitStatus\b/

/**
 * The reasoning state Tau keeps on a block (the Codex lane's, scoped by model
 * id), plus the phase Meta streamed for a text block's message item.
 */
type MetaBlockState = CodexReasoningState & { phase?: 'commentary' }

/** The model id Meta's API takes: Tau may carry a `meta/` vendor prefix. */
export function metaApiModelId(model: string): string {
  return model.trim().replace(/^meta\//i, '')
}

// ─── System prompt ───────────────────────────────────────────────────

/**
 * The part of the system prompt that stays byte-identical for the session,
 * and the volatile tail (environment, git status, memory, date). The marker
 * is present whenever Meta is the session provider (systemBoundaryProviders);
 * an agent pinned to Meta from another provider's session falls back to the
 * first known volatile heading.
 */
export function splitMetaSystem(system: string): { stable: string; volatile: string } {
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

export interface MetaFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: false
}

/** A tool's declaration as this route sends it. */
export function toMetaFunctionTool(tool: ProviderTool): MetaFunctionTool {
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
const toolOrders = new Map<string, Map<string, MetaFunctionTool>>()

/**
 * Per-conversation tool order. Tau lists tools sorted, so an MCP server that
 * connects mid-conversation would insert its tools in the middle of the block
 * and void the cache behind them ("tool definitions are computed once and
 * reused across turns"). A conversation keeps the order its tools were first
 * sent in: a new tool is appended, and a tool keeps its first declaration
 * until its parameters change. A tool missing from a request is not sent but
 * keeps its slot.
 */
export function freezeMetaToolOrder(key: string, tools: readonly MetaFunctionTool[]): MetaFunctionTool[] {
  const snapshot = toolOrders.get(key) ?? new Map<string, MetaFunctionTool>()
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

/** MCP tool name → declaration Meta refused, left out until its schema changes. */
const quarantined = new Map<string, string>()

function declarationKey(tool: MetaFunctionTool): string {
  return JSON.stringify(tool.parameters)
}

function isQuarantined(tool: MetaFunctionTool): boolean {
  return quarantined.get(tool.name) === declarationKey(tool)
}

/**
 * The MCP tool a 400 points at, by `param` (`tools[3]...`) or by name.
 * Built-in tools are never left out: a rejection there is a Tau bug and must
 * surface.
 */
export function findRejectedMetaTool(body: string, tools: readonly MetaFunctionTool[]): MetaFunctionTool | undefined {
  const { message, param } = parseMetaError(body)
  const indexed = /^tools\[(\d+)\]/.exec(param ?? '')
  const byIndex = indexed ? tools[Number(indexed[1])] : undefined
  const named = /schema|tool|function|parameters/i.test(`${param ?? ''} ${message}`)
    ? tools
        .filter(tool => tool.name.startsWith('mcp__'))
        .sort((a, b) => b.name.length - a.name.length)
        .find(tool => message.includes(tool.name))
    : undefined
  const candidate = byIndex ?? named
  return candidate?.name.startsWith('mcp__') ? candidate : undefined
}

// ─── Tool-call ids ───────────────────────────────────────────────────

const TOOL_USE_PREFIX = 'toolu_meta_'
const ENCODED_PREFIX = 'b64_'
/** Meta: "Every call_id must be 1 to 64 characters." */
const SENDABLE_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/

/** A Tau tool_use id for a Meta call id. Reversible, deterministic. */
export function tauToolUseIdForMetaCall(callId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(callId) && !callId.startsWith(ENCODED_PREFIX)
    ? `${TOOL_USE_PREFIX}${callId}`
    : `${TOOL_USE_PREFIX}${ENCODED_PREFIX}${Buffer.from(callId, 'utf8').toString('base64url')}`
}

/**
 * The call id to send for a Tau tool_use id: the one Meta issued, or — for a
 * call another model made — that id when Meta accepts it, else a stable hash.
 * The call and its output map the same way, so they always match.
 */
export function metaCallIdForToolUse(toolUseId: string): string {
  if (toolUseId.startsWith(TOOL_USE_PREFIX)) {
    const rest = toolUseId.slice(TOOL_USE_PREFIX.length)
    if (!rest.startsWith(ENCODED_PREFIX)) return rest
    try {
      return Buffer.from(rest.slice(ENCODED_PREFIX.length), 'base64url').toString('utf8')
    } catch {
      return rest
    }
  }
  return SENDABLE_CALL_ID.test(toolUseId)
    ? toolUseId
    : `call_${createHash('sha256').update(toolUseId).digest('hex').slice(0, 40)}`
}

// ─── History ─────────────────────────────────────────────────────────

type InputPart = Record<string, unknown>

/** What Meta decodes (dev.meta.ai/docs/image-understanding). */
const SENDABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/x-icon'])
/**
 * "Up to 50 images per request ... more than 50 returns HTTP 400." A PDF's
 * page-images draw on the same budget; Tau cannot see a PDF's page count
 * without parsing it, so each PDF counts once.
 */
const MAX_IMAGES_PER_REQUEST = 50

function canSeeImages(model: string): boolean {
  const meta = getMetaModelMeta(model)
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
    getMetaModelMeta(model)?.fileInput
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
 * A tool result as `function_call_output.output` text, and the media it
 * carried. Meta reads images only in user-role messages ("The model does not
 * process images attached to other roles"), so images and PDFs travel in a
 * user message right after the outputs.
 */
function toolOutput(content: ProviderContentBlock['content'], model: string): { output: string; media: InputPart[] } {
  if (typeof content === 'string') return { output: content, media: [] }
  if (!Array.isArray(content)) return { output: JSON.stringify(content ?? ''), media: [] }
  const lines: string[] = []
  const media: InputPart[] = []
  for (const child of content) {
    if (child && typeof child === 'object' && child.type === 'text' && typeof child.text === 'string') {
      lines.push(child.text)
    } else if (child?.type === 'image') {
      const part = imagePart(child, model)
      if (part.type === 'input_image') media.push(part)
      else lines.push(String(part.text ?? ''))
    } else if (isDocumentBlock(child)) {
      const part = filePart(child, model)
      if (part.type === 'input_file') media.push(part)
      else lines.push(String(part.text ?? ''))
    } else if (isMediaBlock(child)) {
      lines.push(renderMediaForTextLane(child))
    } else {
      lines.push(JSON.stringify(child))
    }
  }
  if (media.length > 0) {
    lines.push(`[${media.length} attachment${media.length === 1 ? '' : 's'} in the next user message]`)
  }
  return { output: lines.join('\n'), media }
}

/** Encrypted reasoning this block carries for `model`, each item once. */
function replayedReasoning(block: ProviderContentBlock, model: string, seen: Set<string>): InputPart[] {
  const state = block._codex_reasoning as MetaBlockState | undefined
  if (!state || normalizeMetaModelId(state.model ?? '') !== model || !Array.isArray(state.items)) return []
  const out: InputPart[] = []
  for (const item of state.items) {
    if (!item?.id || typeof item.encrypted_content !== 'string' || !item.encrypted_content || seen.has(item.id)) continue
    seen.add(item.id)
    out.push({
      type: 'reasoning',
      id: item.id,
      // Required on input; `[]` when the model wrote none.
      summary: Array.isArray(item.summary) ? item.summary : [],
      encrypted_content: item.encrypted_content,
    })
  }
  return out
}

/** Whether Meta streamed this text block's message item as `commentary`. */
function recordedCommentary(block: ProviderContentBlock, model: string): boolean {
  const state = block._codex_reasoning as MetaBlockState | undefined
  return state?.phase === 'commentary' && normalizeMetaModelId(state.model ?? '') === model
}

/**
 * "A reasoning item must be followed by an assistant message or a
 * function_call before any new user, system, or developer message. If a turn
 * has reasoning but no text, insert a minimal assistant message."
 */
function closeReasoningRuns(items: readonly InputPart[]): InputPart[] {
  const out: InputPart[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    out.push(item)
    if (item.type !== 'reasoning') continue
    const next = items[i + 1]
    if (next?.type === 'reasoning') continue
    if (next?.type === 'function_call' || (next?.type === 'message' && next.role === 'assistant')) continue
    out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: NO_CONTENT_MESSAGE }] })
  }
  return out
}

/**
 * "Intermediate text before a function_call must be tagged commentary.
 * Replaying it as a final answer returns HTTP 400." The recorded phase covers
 * Meta's own turns; this covers history another model wrote. A turn is fixed
 * once it is complete, so the tag never moves between requests.
 */
function tagCommentary(items: InputPart[]): void {
  let callAhead = false
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.type === 'function_call') callAhead = true
    else if (item.type === 'function_call_output' || (item.type === 'message' && item.role !== 'assistant')) callAhead = false
    else if (item.type === 'message' && item.role === 'assistant' && callAhead && item.phase !== 'commentary') {
      item.phase = 'commentary'
    }
  }
}

/** Over the per-request image budget, the oldest attachments give way. */
function capImages(items: readonly InputPart[]): void {
  const slots: Array<{ content: InputPart[]; index: number }> = []
  for (const item of items) {
    if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content)) continue
    const content = item.content as InputPart[]
    content.forEach((part, index) => {
      if (part.type === 'input_image' || part.type === 'input_file') slots.push({ content, index })
    })
  }
  for (const slot of slots.slice(0, Math.max(0, slots.length - MAX_IMAGES_PER_REQUEST))) {
    const kind = slot.content[slot.index]!.type === 'input_file' ? 'document' : 'image'
    slot.content[slot.index] = {
      type: 'input_text',
      text: `[${kind} omitted: Meta reads at most ${MAX_IMAGES_PER_REQUEST} images per request]`,
    }
  }
}

/**
 * Tau's history as Responses input items. Assistant turns replay their
 * encrypted reasoning where it sat on the wire — before the message or call
 * that followed it — and only for the model that produced it. Each text block
 * is one message item, as Meta streamed it, with its phase.
 */
export function convertMetaHistory(messages: readonly ProviderMessage[], model: string): InputPart[] {
  const replayModel = normalizeMetaModelId(model)
  const items: InputPart[] = []
  const seen = new Set<string>()

  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (!message.content) continue
      items.push(message.role === 'assistant'
        ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] }
        : { type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }] })
      continue
    }

    if (message.role === 'assistant') {
      for (const block of message.content) {
        items.push(...replayedReasoning(block, replayModel, seen))
        if (block.type === 'text' && block.text) {
          items.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text }],
            ...(recordedCommentary(block, replayModel) && { phase: 'commentary' }),
          })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          items.push({
            type: 'function_call',
            call_id: metaCallIdForToolUse(block.id),
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
        // Visible thinking is display-only: the encrypted item above is what
        // the model reads back.
      }
      continue
    }

    // Outputs first, in call order ("keep results in the same order as their
    // calls"), then one user message with their media and the user's own parts.
    const outputs: InputPart[] = []
    const attachments: InputPart[] = []
    const parts: InputPart[] = []
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const callId = metaCallIdForToolUse(block.tool_use_id)
        const { output, media } = toolOutput(block.content, replayModel)
        outputs.push({ type: 'function_call_output', call_id: callId, output })
        if (media.length > 0) attachments.push({ type: 'input_text', text: `Attachments from tool call ${callId}:` }, ...media)
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
    items.push(...outputs)
    if (attachments.length + parts.length > 0) {
      items.push({ type: 'message', role: 'user', content: [...attachments, ...parts] })
    }
  }

  const out = closeReasoningRuns(items)
  tagCommentary(out)
  capImages(out)
  return out
}

// ─── Request ─────────────────────────────────────────────────────────

export interface MetaRequestInput {
  model: string
  system: LaneProviderCallParams['system']
  messages: readonly ProviderMessage[]
  tools: readonly ProviderTool[]
  maxTokens: number
  sessionId?: string
  /** `reasoning.effort`, already resolved against the model's ladder. */
  effort?: string
}

export interface MetaResponsesRequest {
  body: Record<string, unknown>
  /** The declarations sent, for the rejected-schema backstop. */
  tools: MetaFunctionTool[]
}

/**
 * Optional fields this route adds on its own (cache routing, retention,
 * reasoning summaries). Each is documented; should Meta ever refuse one with
 * a 400 naming it, it is dropped for the process and the turn retried, rather
 * than failing every request.
 */
const OPTIONAL_PARAMS = new Set(['prompt_cache_key', 'prompt_cache_retention', 'reasoning.summary'])
const droppedParams = new Set<string>()

/**
 * "A stable string that identifies the shared prefix." The model and the
 * stable instructions are that prefix's identity: requests that share them
 * share a key, so the main thread, each agent type and every session that
 * runs them route together, and a tool appended mid-session keeps the key.
 */
export function metaPromptCacheKey(model: string, instructions: string): string {
  const digest = createHash('sha256').update(`${normalizeMetaModelId(model)}\n${instructions}`).digest('hex')
  return `tau-${digest.slice(0, 32)}`
}

export function buildMetaResponsesRequest(input: MetaRequestInput): MetaResponsesRequest {
  const model = metaApiModelId(input.model)
  const messages = [...input.messages]

  const tools = input.tools
    // Every schema is declared up front, so there is nothing to discover.
    .filter(tool => tool.name !== TOOL_SEARCH_TOOL_NAME)
    .map(toMetaFunctionTool)
  const orderKey = `${PROVIDER}:${input.sessionId?.trim() || volatileFreezeKey(PROVIDER, model, undefined, messages)}`
  const declared = freezeMetaToolOrder(orderKey, tools).filter(tool => !isQuarantined(tool))

  const { stable, volatile } = splitMetaSystem(systemText(input.system))
  const rules = declared.length > 0 ? buildOpenAICompatToolUsageRules(false) : ''
  const instructions = [rules.trim(), stable].filter(Boolean).join('\n')
  const frozen = freezeSessionVolatileText(
    volatileFreezeKey(PROVIDER, model, input.sessionId, messages, volatile),
    volatile,
  ).trim()

  const items: InputPart[] = []
  if (frozen) items.push({ type: 'message', role: 'system', content: frozen })
  items.push(...convertMetaHistory(messages, input.model))

  const cap = metaMaxOutputTokens(model)
  const maxOutput = Number.isFinite(input.maxTokens) && input.maxTokens > 0
    ? (cap ? Math.min(input.maxTokens, cap) : input.maxTokens)
    : undefined
  const reasons = getMetaModelMeta(model)?.reasoning ?? isMuseModelId(model)
  const reasoning: Record<string, unknown> = {
    ...(input.effort && { effort: input.effort }),
    // Meta's own coding-agent setups run with summaries on (/docs/coding-agents).
    ...(reasons && !droppedParams.has('reasoning.summary') && { summary: 'auto' }),
  }

  const body: Record<string, unknown> = {
    model,
    ...(instructions && { instructions }),
    input: items,
    ...(declared.length > 0 && { tools: declared, tool_choice: 'auto' }),
    ...(maxOutput !== undefined && { max_output_tokens: maxOutput }),
    ...(Object.keys(reasoning).length > 0 && { reasoning }),
    include: ['reasoning.encrypted_content'],
    store: false,
    ...(!droppedParams.has('prompt_cache_key') && { prompt_cache_key: metaPromptCacheKey(model, instructions) }),
    ...(!droppedParams.has('prompt_cache_retention') && { prompt_cache_retention: '24h' }),
    stream: true,
  }
  return { body, tools: declared }
}

export function metaRequestHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': `Bearer ${apiKey}`,
  }
}

// ─── Spend ───────────────────────────────────────────────────────────

const spend = { requests: 0, usd: 0, unpriced: 0 }

/**
 * One request's cost from Meta's published rates, or undefined for an
 * unpriced model. Meta reports tokens only; cached tokens bill at the cached
 * rate and nothing is charged to write the cache.
 */
export function metaRequestCostUsd(model: string, usage: NormalizedUsage): number | undefined {
  const price = getMetaCatalogPrice(model)
  if (!price) return undefined
  return (
    usage.input_tokens * price.input
    + usage.cache_read_tokens * price.cachedInput
    + usage.output_tokens * price.output
  ) / 1_000_000
}

/** What this process spent with Meta, priced from the published rates. */
export function getMetaSessionSpend(): { requests: number; usd: number; unpricedRequests: number } {
  return { requests: spend.requests, usd: spend.usd, unpricedRequests: spend.unpriced }
}

export function _resetMetaSessionSpendForTests(): void {
  spend.requests = 0
  spend.usd = 0
  spend.unpriced = 0
}

/** Test seam: forget dropped fields, quarantined tools, tool orders and spend. */
export function _resetMetaRouteForTests(): void {
  droppedParams.clear()
  quarantined.clear()
  toolOrders.clear()
  _resetMetaSessionSpendForTests()
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
 * reasoning rides on the blocks as `_codex_reasoning`: on the thinking block
 * that showed it, and on the next text or tool block, so it survives a
 * transcript that drops thinking blocks. A commentary message's text block
 * carries `phase` in the same state. Replay dedups by item id.
 */
export class MetaResponsesStream {
  private started = false
  private nextIndex = 0
  private readonly open = new Map<number, OpenBlock>()
  private readonly calls = new Map<number, PendingCall>()
  private readonly phases = new Map<number, string>()
  /** Output indices the stream delivered item by item. */
  private readonly streamed = new Set<number>()
  private pendingReasoning: CodexReasoningState['items'] = []
  private sawToolUse = false
  private truncated = false
  private inputTokens = 0
  private cachedTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
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

  private takeState(phase?: string): { _codex_reasoning?: MetaBlockState } {
    const commentary = phase === 'commentary'
    if (this.pendingReasoning.length === 0 && !commentary) return {}
    const state: MetaBlockState = {
      model: this.model,
      items: this.pendingReasoning,
      ...(commentary && { phase: 'commentary' as const }),
    }
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
      content_block: { type: 'text', text: '', ...this.takeState(this.phases.get(outputIndex)) },
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
        id: tauToolUseIdForMetaCall(call.callId),
        name: call.name,
        input: {},
        ...toolDecodeFields(decoded),
        ...this.takeState(),
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
    if (outputIndex >= 0) this.streamed.add(outputIndex)

    switch (type) {
      case 'response.output_item.added':
        if (item?.type === 'message') {
          if (typeof item.phase === 'string') this.phases.set(outputIndex, item.phase)
          this.openText(out, outputIndex)
        } else if (item?.type === 'reasoning') this.openThinking(out, outputIndex)
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
        this.recoverTerminalItems(out, response?.output)
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

  /**
   * Items only the terminal snapshot carries. Spark streams every item and
   * re-issues them in `response.completed` (reasoning with fresh encrypted
   * content), so a streamed index is never taken twice; output indices
   * identify the items across both.
   */
  private recoverTerminalItems(out: AnthropicStreamEvent[], output: unknown): void {
    if (!Array.isArray(output)) return
    output.forEach((raw, outputIndex) => {
      if (this.streamed.has(outputIndex) || !raw || typeof raw !== 'object') return
      const item = raw as Record<string, unknown>
      this.streamed.add(outputIndex)
      if (item.type === 'message' && typeof item.phase === 'string') this.phases.set(outputIndex, item.phase)
      if (item.type === 'reasoning') this.openThinking(out, outputIndex)
      this.itemDone(out, outputIndex, item)
    })
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
      // The done item is authoritative for a call.
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
      // Responses counts reasoning inside output_tokens. Should a response
      // state them apart (total = input + output + reasoning), the reasoning
      // is billed as output all the same.
      this.outputTokens = total !== undefined && reasoning && total === (input ?? 0) + output + reasoning
        ? output + reasoning
        : output
    }
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

/** Meta's envelope: `{"error":{"message","type","param","code"}}`. */
export function parseMetaError(body: string): { message: string; type?: string; code?: string; param?: string } {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    const error = parsed?.error
    if (error && typeof error === 'object') {
      const fields = error as Record<string, unknown>
      const type = text(fields.type)
      const code = text(fields.code)
      const param = text(fields.param)
      return {
        message: text(fields.message) ?? code ?? type ?? 'request failed',
        ...(type && { type }),
        ...(code && { code }),
        ...(param && { param }),
      }
    }
    const flat = text(error) ?? text(parsed?.message)
    if (flat) return { message: flat }
  } catch {
    // Not JSON: the raw text is the message.
  }
  return { message: body.trim().slice(0, 500) || 'empty error body' }
}

/** The message inside a Meta error body, with its code when that adds anything. */
export function metaErrorDetail(body: string): string {
  const { message, code } = parseMetaError(body)
  return code && !message.includes(code) ? `${message} (${code})` : message
}

/**
 * Meta answers an over-long request with a 400 whose message starts "You
 * passed {N} input tokens and requested {M} output tokens" and ends "Please
 * reduce the length of the input prompt" (dev.meta.ai/docs/error-handling).
 */
const CONTEXT_EXCEEDED = /you passed \d+ input tokens and requested \d+ output tokens|reduce the length of the input prompt|maximum context length|context_length_exceeded|context window/i

export function isMetaContextExceeded(status: number, body: string): boolean {
  return status === 400 && CONTEXT_EXCEEDED.test(parseMetaError(body).message)
}

/** An optional field this route added that a 400 names, if any. */
export function rejectedOptionalMetaParam(status: number, body: string): string | undefined {
  if (status !== 400) return undefined
  const { param } = parseMetaError(body)
  return param && OPTIONAL_PARAMS.has(param) ? param : undefined
}

/**
 * A rejection as an error, never as assistant text: text would be saved as
 * the model's own words and replayed on every later turn. "Prompt is too
 * long" starts the message so reactive compaction recognizes it.
 */
function metaHttpError(status: number, body: string, headers: Headers): ProviderHttpError {
  const detail = metaErrorDetail(body)
  const message = isMetaContextExceeded(status, body)
    ? `Prompt is too long (meta ${status}): ${detail}`
    : status === 401
      ? `meta API error 401: ${detail} — run /login meta to replace the API key`
      : status === 402
        ? `meta API error 402: ${detail} — add a payment method or top up at ${META_BILLING_URL}`
        : status === 403 || status === 404
          ? `meta API error ${status}: ${detail} — check that this key's team can use the model`
          : `meta API error ${status}: ${detail}`
  return new ProviderHttpError(PROVIDER, status, body, headers, message)
}

// ─── Models ──────────────────────────────────────────────────────────

function toModelInfo(meta: MetaModelMeta, recommended: string | undefined): ModelInfo {
  const tags: string[] = []
  if (meta.reasoning) tags.push('reasoning')
  if (meta.toolCalling) tags.push('tools')
  if (meta.id === recommended) tags.push('recommended')
  return {
    id: meta.id,
    // Contributor rows are cheaper because Meta may train on what is sent.
    name: meta.contributor ? `${meta.name} — Meta may train on your content` : meta.name,
    ...(meta.contextWindow !== undefined && { contextWindow: meta.contextWindow }),
    supportsToolCalling: meta.toolCalling,
    tags,
  }
}

/**
 * The /models rows for the logged-in key, newest first: the ids Meta's
 * `GET /v1/models` lists, described by the catalog (models.dev, then the
 * snapshot). Offline, the catalog alone answers.
 */
export async function listMetaModels(cfg: { apiKey: string; baseUrl: string }): Promise<ModelInfo[]> {
  ensureMetaCatalogFresh()
  const check = await checkMetaApiKey(cfg.apiKey, cfg.baseUrl || META_DEFAULT_BASE_URL)
  if (check.ok) recordMetaLiveModels(check.modelIds)
  const models = listMetaModelMeta()
  // Meta: Spark 1.3 is "recommended for new work"; Wonder is in preview.
  const recommended = models.find(meta => meta.id === 'muse-spark-1.3')?.id
  for (const meta of models) recordModelVision(PROVIDER, meta.id, meta.imageInput)
  return models.map(meta => toModelInfo(meta, recommended))
}

// ─── Request lifecycle ───────────────────────────────────────────────

export async function* streamMetaResponses(
  cfg: { apiKey: string; baseUrl: string },
  params: LaneProviderCallParams,
  sessionId: string | undefined,
): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
  ensureMetaCatalogFresh()
  const request = buildMetaResponsesRequest({
    model: params.model,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    maxTokens: params.max_tokens,
    sessionId,
    effort: resolveMetaRequestEffort(params.model, params.effortValue),
  })
  const baseUrl = (cfg.baseUrl || META_DEFAULT_BASE_URL).replace(/\/+$/, '')

  let response: Response
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: metaRequestHeaders(cfg.apiKey),
      body: JSON.stringify(request.body),
      signal: params.signal,
    })
  } catch (error) {
    // Nothing reached the model: the shared controller retries, and no
    // assistant turn is written that would shift the cached prefix.
    if (isAbortError(error, params.signal)) throw error
    throw createRetryableConnectionError('meta API connection error', error)
  }
  recordProviderRateLimits(PROVIDER, response.headers)

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throwRetryableProviderHttpError(PROVIDER, response, body)
    const optional = rejectedOptionalMetaParam(response.status, body)
    if (optional) {
      droppedParams.add(optional)
      throw createRetryableConnectionError(
        `Meta refused the optional ${optional} field; retrying without it`,
        new Error(metaErrorDetail(body)),
      )
    }
    const rejected = response.status === 400 ? findRejectedMetaTool(body, request.tools) : undefined
    if (rejected) {
      // Meta could not take one MCP tool's schema. Leave that declaration
      // out and let the shared controller retry the turn without it.
      quarantined.set(rejected.name, declarationKey(rejected))
      throw createRetryableConnectionError(
        `Meta rejected the tool schema of ${rejected.name}; retrying without that tool`,
        new Error(metaErrorDetail(body)),
      )
    }
    throw metaHttpError(response.status, body, response.headers)
  }
  if (!response.body) {
    throw new ProviderHttpError(PROVIDER, response.status, '', response.headers, 'meta API error: empty response body')
  }

  const stream = new MetaResponsesStream(params.model, `meta-${Date.now()}`)
  const responseBody = response.body
  try {
    for await (const payload of readSseDataPayloads(responseBody)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        // `data: [DONE]` closes Meta's stream; nothing else is non-JSON.
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      for (const event of stream.push(parsed as Record<string, unknown>)) yield event
      if (stream.failure) break
    }
  } catch (error) {
    if (isAbortError(error, params.signal)) throw error
    if (!stream.emitted) throw createRetryableConnectionError('meta API connection error', error)
    for (const event of stream.fail(`meta stream interrupted: ${error instanceof Error ? error.message : String(error)}`)) yield event
    for (const event of stream.finish()) yield event
    return stream.usage
  }

  if (stream.failure) {
    await responseBody.cancel().catch(() => {})
    if (!stream.emitted) {
      // Failed before any output: surface it as an error (retried when the
      // code says the server was at fault: server_shutting_down,
      // service_overloaded, backend_unavailable, rate limits), never as text.
      const status = /rate|capacity|overload|unavailable|shutting|internal|server/i.test(stream.failure.code ?? stream.failure.message)
        ? 503
        : 400
      const body = JSON.stringify({ error: stream.failure })
      throwRetryableProviderHttpError(PROVIDER, { status, headers: response.headers }, body)
      throw metaHttpError(status, body, response.headers)
    }
    for (const event of stream.fail(`meta API stream error: ${stream.failure.message}`)) yield event
  }

  for (const event of stream.finish()) yield event
  const usage = stream.usage
  const cost = metaRequestCostUsd(params.model, usage)
  spend.requests += 1
  if (cost === undefined) spend.unpriced += 1
  else spend.usd += cost
  return usage
}
