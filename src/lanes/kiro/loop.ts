/**
 * Kiro Lane — CodeWhisperer streaming (AWS EventStream binary frames).
 *
 * Wire: POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
 *   Headers:
 *     Content-Type: application/json
 *     Accept: application/vnd.amazon.eventstream
 *     X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
 *     Authorization: Bearer <accessToken>
 *     X-Amz-User-Agent / User-Agent: aws-sdk-js/3.0.0 kiro-ide/1.0.0
 *     Amz-Sdk-Invocation-Id: <uuid>
 *
 * The response body is a sequence of binary EventStream frames; we
 * normalize each frame's JSON payload into Anthropic-IR events so
 * claude.ts renders Kiro turns identically to every other lane.
 *
 * Event type → Anthropic-IR mapping:
 *   assistantResponseEvent  → text_delta
 *   codeEvent               → text_delta (appended as code block)
 *   reasoningContentEvent   → thinking_delta (wrapped)
 *   toolUseEvent            → tool_use block (input_json_delta accumulation)
 *   messageStopEvent        → closes open blocks, emits message_delta
 *   metricsEvent            → folds usage into final message_delta
 *   contextUsageEvent       → estimates input tokens when metrics absent
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneRunContext,
  LaneRunResult,
  LaneProviderCallParams,
  NormalizedUsage,
} from '../types.js'
import { parseFrames, type KiroEvent } from './eventstream.js'
import { buildKiroPayload } from './request.js'
import { KIRO_MODELS, isKiroModel, normalizeKiroModelId } from './catalog.js'
import {
  buildKiroToolNameReverseMap,
  resolvePreferredKiroShellToolName,
  toClaudexToolName,
} from './tool_names.js'
import { randomUUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'

const KIRO_ENDPOINT = 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse'
const KIRO_MODELS_ENDPOINT = 'https://codewhisperer.us-east-1.amazonaws.com'
// Kiro context window used when we have to estimate prompt tokens from
// contextUsagePercentage (no metricsEvent was emitted). Claude/Kiro pairs
// all use a 200k window.
const KIRO_CONTEXT_WINDOW = 200_000
const KIRO_MODELS_CACHE_TTL_MS = 5 * 60_000
const MAX_TURNS = 100
const DSML_TOKEN = '\uFF5CDSML\uFF5C'
const DSML_FUNCTION_CALLS_OPEN = `<${DSML_TOKEN}function_calls>`
const DSML_FUNCTION_CALLS_CLOSE = `</${DSML_TOKEN}function_calls>`

interface ParsedDsmlToolCall {
  name: string
  input: Record<string, unknown>
}

interface DerivedKiroPromptUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  nextContextTokens: number
}

interface KiroAvailableModel {
  modelId?: string
  modelName?: string
  tokenLimits?: {
    maxInputTokens?: number
  }
}

interface StoredKiroOAuthBlob {
  accessToken?: string
  refreshToken?: string
  meta?: {
    profileArn?: string | null
  }
}

function _isLikelyKiroModelId(id: string): boolean {
  const normalized = id.toLowerCase()
  return (
    normalized.startsWith('claude-')
    || normalized.startsWith('deepseek-')
    || normalized.startsWith('qwen')
    || normalized.startsWith('glm-')
    || normalized.startsWith('minimax-')
  )
}

function _dedupeKiroModels(models: readonly ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const model of models) {
    if (!model.id) continue
    const normalizedId = normalizeKiroModelId(model.id)
    const dedupeKey = normalizedId.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({
      ...model,
      id: normalizedId,
      name: model.name || normalizedId,
    })
  }
  return out
}

function _normalizeKiroModelCatalog(models: readonly KiroAvailableModel[]): ModelInfo[] {
  const normalized = models
    .filter((model): model is KiroAvailableModel & { modelId: string } => typeof model.modelId === 'string' && model.modelId.length > 0)
    .filter(model => _isLikelyKiroModelId(model.modelId) || isKiroModel(model.modelId))
    .map(model => ({
      id: normalizeKiroModelId(model.modelId),
      name: model.modelName || normalizeKiroModelId(model.modelId),
      contextWindow: model.tokenLimits?.maxInputTokens,
      supportsToolCalling: true,
    }))

  return _dedupeKiroModels(normalized)
}

export class KiroLane implements Lane {
  readonly name = 'kiro'
  readonly displayName = 'Kiro (AWS CodeWhisperer)'

  private accessToken: string | null = null
  private profileArn: string | null = null
  private discoveredModels = new Map<string, ModelInfo>()
  private modelsCache: { at: number; models: ModelInfo[] } | null = null
  private promptContextTokensByConversation = new Map<string, number>()

  configure(opts: { accessToken?: string; profileArn?: string | null }): void {
    const authChanged =
      (opts.accessToken !== undefined && (opts.accessToken || null) !== this.accessToken)
      || (opts.profileArn !== undefined && (opts.profileArn ?? null) !== this.profileArn)
    if (opts.accessToken !== undefined) this.accessToken = opts.accessToken || null
    if (opts.profileArn !== undefined) this.profileArn = opts.profileArn || null
    this.modelsCache = null
    this.discoveredModels.clear()
    if (authChanged) this.promptContextTokensByConversation.clear()
  }

  supportsModel(model: string): boolean {
    // Kiro catalog uses dot-versioned aliases (`claude-sonnet-4.5`,
    // `deepseek-3.2`…) that DON'T collide with Anthropic-canonical ids
    // like `claude-sonnet-4-20250514`. Route strictly on the static
    // list so the dispatcher doesn't accidentally steal a canonical
    // Claude id away from the Anthropic path.
    const normalized = normalizeKiroModelId(model)
    return isKiroModel(normalized) || this.discoveredModels.has(normalized)
  }

  isHealthy(): boolean {
    return !!this.accessToken
  }

  resolveModel(model: string): string {
    return normalizeKiroModelId(model)
  }

  async listModels(_providerFilter?: string): Promise<ModelInfo[]> {
    const now = Date.now()
    if (this.modelsCache && now - this.modelsCache.at < KIRO_MODELS_CACHE_TTL_MS) {
      return this.modelsCache.models
    }

    const dynamicModels = await this._listAvailableModels().catch(() => [])
    const models = dynamicModels.length > 0 ? dynamicModels : KIRO_MODELS
    const deduped = _dedupeKiroModels(models)
    this.discoveredModels.clear()
    for (const model of deduped) {
      this.discoveredModels.set(model.id, model)
    }
    this.modelsCache = { at: now, models: deduped }
    return deduped
  }

  dispose(): void {}

  private _readStoredAuthBlob(): StoredKiroOAuthBlob | null {
    try {
      const raw = loadProviderKey('kiro_oauth')
      if (!raw) return null
      return JSON.parse(raw) as StoredKiroOAuthBlob
    } catch {
      return null
    }
  }

  private _reloadAuthFromDisk(): boolean {
    const blob = this._readStoredAuthBlob()
    if (!blob?.accessToken) return false

    const nextAccessToken = blob.accessToken
    const nextProfileArn = blob.meta?.profileArn ?? null
    const changed = nextAccessToken !== this.accessToken || nextProfileArn !== this.profileArn
    if (changed) {
      this.configure({ accessToken: nextAccessToken, profileArn: nextProfileArn })
    }
    return changed
  }

  private async _recoverInvalidBearer(): Promise<boolean> {
    // Step 1: Check if a fresh token was already written to disk
    // (e.g. by a concurrent /login kiro or token refresh elsewhere).
    if (this._reloadAuthFromDisk()) return true

    // Step 2: If we have a refresh token, try refreshing via HTTPS.
    // This is fully native — no CLI binary needed.
    const blob = this._readStoredAuthBlob()
    const refreshToken = blob?.refreshToken
    if (refreshToken) {
      try {
        const { refreshKiroOAuth } = await import('../../services/api/auth/oauth_services.js')
        await refreshKiroOAuth(refreshToken)
      } catch {
        // Refresh failed — token may be revoked. User needs to re-login.
      }
    }

    // Step 3: Reload from disk one more time — the refresh above
    // saves the new token to disk before returning.
    return this._reloadAuthFromDisk() || !!this.accessToken
  }

  private async _listAvailableModels(): Promise<ModelInfo[]> {
    if (!this.accessToken) return []

    const response = await fetch(KIRO_MODELS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererService.ListAvailableModels',
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        origin: 'AI_EDITOR',
        ...(this.profileArn ? { profileArn: this.profileArn } : {}),
      }),
    })
    if (!response.ok) return []

    const data = await response.json() as { models?: KiroAvailableModel[] }
    return _normalizeKiroModelCatalog(data.models ?? [])
  }

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    const context = _context
    const { model, messages, systemParts, availableTools, mcpTools, signal, maxTokens } = context

    const systemText = assembleSystemFromParts(systemParts)
    const allTools = [
      ...availableTools.map(tool => tool.anthropicDef),
      ...mcpTools,
    ]

    const totalUsage: NormalizedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    }

    let currentMessages = messages
    let turnCount = 0

    while (turnCount < MAX_TURNS) {
      if (signal.aborted) return { stopReason: 'aborted', usage: totalUsage }
      turnCount++

      const toolUsesByIndex = new Map<number, {
        id: string
        name: string
        inputJson: string
      }>()
      let done = false
      let stopReason: 'end_turn' | 'tool_use' = 'end_turn'

      const gen = this.streamAsProvider({
        model,
        messages: currentMessages,
        system: systemText,
        tools: allTools,
        max_tokens: maxTokens,
        signal,
      })

      while (!done) {
        const next = await gen.next()
        if (next.done) {
          const usage = next.value
          totalUsage.input_tokens += usage.input_tokens
          totalUsage.output_tokens += usage.output_tokens
          totalUsage.cache_read_tokens += usage.cache_read_tokens
          totalUsage.cache_write_tokens += usage.cache_write_tokens
          totalUsage.thinking_tokens += usage.thinking_tokens
          done = true
          break
        }

        const event = next.value
        yield event

        if (
          event.type === 'content_block_start'
          && event.content_block?.type === 'tool_use'
          && typeof event.index === 'number'
          && event.content_block.id
          && event.content_block.name
        ) {
          toolUsesByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          })
        }

        if (
          event.type === 'content_block_delta'
          && event.delta?.type === 'input_json_delta'
          && typeof event.index === 'number'
        ) {
          const toolUse = toolUsesByIndex.get(event.index)
          if (toolUse) {
            toolUse.inputJson += event.delta.partial_json ?? ''
          }
        }

        if (event.type === 'message_delta' && event.delta?.stop_reason === 'tool_use') {
          stopReason = 'tool_use'
        }
      }

      const collectedToolUses = Array.from(toolUsesByIndex.values()).map(toolUse => {
        let input: Record<string, unknown> = {}
        if (toolUse.inputJson) {
          try {
            input = JSON.parse(toolUse.inputJson) as Record<string, unknown>
          } catch {
            input = {}
          }
        }
        return { id: toolUse.id, name: toolUse.name, input }
      })

      if (stopReason !== 'tool_use' || collectedToolUses.length === 0) {
        return { stopReason: 'end_turn', usage: totalUsage }
      }

      const toolResults = await Promise.all(
        collectedToolUses.map(async toolUse => {
          try {
            const result = await context.executeTool(toolUse.name, toolUse.input)
            return {
              type: 'tool_result' as const,
              tool_use_id: toolUse.id,
              content: typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
              is_error: result.isError,
            }
          } catch (error: any) {
            return {
              type: 'tool_result' as const,
              tool_use_id: toolUse.id,
              content: `Error: ${error?.message ?? String(error)}`,
              is_error: true,
            }
          }
        }),
      )

      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: collectedToolUses.map(toolUse => ({
            type: 'tool_use' as const,
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          })),
        },
        {
          role: 'user',
          content: toolResults,
        },
      ]
    }

    return { stopReason: 'max_turns', usage: totalUsage }
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const { model, messages, system, tools, max_tokens, temperature, signal } = params
    const resolvedModel = this.resolveModel(model)
    const conversationId = params.sessionId || getSessionId()

    if (!this.accessToken) {
      throw new Error(
        'Kiro lane: not authenticated. Run `/login kiro` to sign in with AWS Builder ID.',
      )
    }

    const systemText = typeof system === 'string'
      ? system
      : (system ?? []).map(b => b.text).join('\n\n')

    const body = buildKiroPayload({
      model: resolvedModel,
      system: systemText,
      messages,
      tools,
      conversationId,
      // CodeWhisperer caps at 32k output; the caller's max_tokens is
      // usually 8192 already, but clamp for safety.
      maxTokens: Math.min(max_tokens ?? 8192, 32_000),
      temperature,
      profileArn: this.profileArn ?? undefined,
    })

    const messageId = `kiro-${Date.now()}`
    let messageStartEmitted = false
    let outputTokens = 0
    let inputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let reasoningTokens = 0

    // Content-block state. Kiro interleaves text + code + tool_use freely,
    // so we track what's currently open and switch cleanly.
    let currentIndex = 0
    let openBlock: 'text' | 'thinking' | null = null
    // Per-tool accumulation. Kiro's toolUseEvent fires once per tool with
    // the input already resolved (no argument-streaming), but the same
    // toolUseId may repeat if the model extends its input mid-stream, so
    // we reuse the block index and accumulate partial_json into it.
    const toolBlocks = new Map<string, ToolBlockState>()
    let pendingAssistantText = ''
    let sawToolUse = false
    let syntheticToolCounter = 0
    const preferredShellToolName = resolvePreferredKiroShellToolName(
      tools.map(tool => tool.name),
    )
    // Reverse map so tool calls Kiro returns map back to Tau names even when the
    // outgoing name was sanitized to Kiro's allowed shape.
    const toolNameReverseMap = buildKiroToolNameReverseMap(
      tools.map(tool => tool.name),
    )

    // Kiro often emits messageStopEvent before metrics/context bookkeeping.
    // Keep reading until the HTTP stream ends so final usage is not dropped.
    let totalContentChars = 0
    let contextUsagePercentage = 0

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
          model: resolvedModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }
    }

    const handlerState: EventHandlerState = {
      model: resolvedModel,
      messageId,
      toolBlocks,
      getCurrentIndex: () => currentIndex,
      setCurrentIndex: v => { currentIndex = v },
      getOpenBlock: () => openBlock,
      setOpenBlock: v => { openBlock = v },
      getPendingAssistantText: () => pendingAssistantText,
      setPendingAssistantText: v => { pendingAssistantText = v },
      markSawToolUse: () => { sawToolUse = true },
      nextSyntheticToolUseId: () => `toolu_kiro_${++syntheticToolCounter}`,
      preferredShellToolName,
      toolNameReverseMap,
    }

    let response: Response | null = null
    let responseStatus = 0
    let responseErrorText = ''
    try {
      let bearerRecovered = false
      for (let attempt = 0; attempt < KIRO_MAX_REQUEST_ATTEMPTS; attempt++) {
        response = await fetch(KIRO_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.amazon.eventstream',
            'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
            'Authorization': `Bearer ${this.accessToken}`,
            'User-Agent': 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
            'X-Amz-User-Agent': 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
            'Amz-Sdk-Invocation-Id': randomUUID(),
            'Amz-Sdk-Request': 'attempt=1; max=3',
          },
          body: JSON.stringify(body),
          signal,
        })

        if (response.ok) break

        responseStatus = response.status
        responseErrorText = await response.text().catch(() => '')

        // Invalid/expired bearer: re-auth once, then retry immediately.
        if (
          !bearerRecovered
          && _isInvalidBearerResponse(responseStatus, responseErrorText)
          && await this._recoverInvalidBearer()
        ) {
          bearerRecovered = true
          response = null
          responseStatus = 0
          responseErrorText = ''
          continue
        }

        // Transient server-side errors: Kiro explicitly says "please try
        // again", so retry with backoff before failing the lane — a momentary
        // blip should not cost a fallback hop.
        if (
          attempt < KIRO_MAX_REQUEST_ATTEMPTS - 1
          && _isTransientKiroStatus(responseStatus)
        ) {
          await _kiroBackoffDelay(attempt, signal)
          response = null
          responseStatus = 0
          responseErrorText = ''
          continue
        }

        break
      }
    } catch (err: unknown) {
      const mst = emitMessageStart()
      if (mst) yield mst
      const message = err instanceof Error ? err.message : String(err)
      yield* _emitErrorText(`kiro API connection error: ${message}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }
      return _blankUsage()
    }

    if (!response?.ok) {
      const errText = responseErrorText
      const mst = emitMessageStart()
      if (mst) yield mst
      const lowered = errText.toLowerCase()
      const isPromptTooLong =
        lowered.includes('context length')
        || lowered.includes('context window')
        || lowered.includes('too long')
        || lowered.includes('inputtokens')
      const isImproperlyFormed =
        responseStatus === 400 && lowered.includes('improperly formed')
      const headline = isPromptTooLong
        ? `Prompt is too long (kiro ${responseStatus})`
        : `kiro API error ${responseStatus}`
      // "Improperly formed request" is a generic AWS-side 400 with no
      // structured reason. The most useful thing we can do is (a) dump the
      // payload so the user can inspect what Kiro rejected, and (b) hint at
      // the common causes so a fix is one step closer.
      // Server-side 5xx ("please try again") was already retried with backoff
      // above; if it still got here, capturing the body lets us confirm or rule
      // out a payload-shape cause. Both this and the 400 case are gated behind
      // CLAUDEX_KIRO_DEBUG_DUMP, so nothing is written for normal users.
      const isServerError = responseStatus >= 500
      let extra = ''
      if (isImproperlyFormed || isServerError) {
        const dumpPath = _dumpKiroRequestBody(
          body,
          isImproperlyFormed ? 'improperly-formed' : 'server-error',
        )
        const hint = isImproperlyFormed
          ? 'Common causes: an MCP tool name with characters Kiro disallows, '
            + 'a tool input_schema field not handled by sanitizeSchemaForLane, '
            + 'or a history shape that lost role alternation during fallback.'
          : 'Kiro server-side error (already retried with backoff). If it '
            + 'recurs, the dumped request body shows exactly what was sent so a '
            + 'payload-shape cause can be confirmed or ruled out.'
        extra = dumpPath
          ? ` ${hint} Request body dumped to ${dumpPath}.`
          : ` ${hint} Set CLAUDEX_KIRO_DEBUG_DUMP=1 to capture the request body on the next failure.`
      }
      yield* _emitErrorText(`${headline}: ${errText.slice(0, 500)}${extra}`)
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }
      return _blankUsage()
    }

    if (!response.body) throw new Error('Kiro: empty response body')

    const reader = response.body.getReader()
    // Explicit widen from ArrayBuffer → ArrayBufferLike so the remainder
    // returned by parseFrames() (which starts from a fetch() chunk whose
    // underlying buffer is ArrayBufferLike) assigns back without a cast.
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          // Append incoming chunk to the residual buffer from the last
          // parse pass (frames can straddle chunk boundaries).
          const merged = new Uint8Array(buffer.length + value.length)
          merged.set(buffer)
          merged.set(value, buffer.length)
          buffer = merged
        }

        const { events, remainder } = parseFrames(buffer)
        buffer = remainder

        for (const ev of events) {
          // Track how much content the model has produced so we can
          // estimate output_tokens when metricsEvent is absent.
          if (ev.eventType === 'assistantResponseEvent' || ev.eventType === 'codeEvent') {
            const contentPayload = _asRecord(_unwrapKiroEventPayload(ev.eventType, ev.payload))
            const c = typeof contentPayload?.content === 'string' ? contentPayload.content : ''
            totalContentChars += c.length
          }

          const emissions = _handleKiroEvent(ev, handlerState)
          for (const ev2 of emissions) {
            if (!messageStartEmitted && _shouldTriggerMessageStart(ev2)) {
              const mst = emitMessageStart()
              if (mst) yield mst
            }
            yield ev2
          }

          if (ev.eventType === 'metricsEvent') {
            const m = (ev.payload?.metricsEvent as Record<string, unknown> | undefined)
              ?? ev.payload
              ?? {}
            const usage = _extractKiroMetricsUsage(m)
            if (usage.inputTokens > 0) inputTokens = usage.inputTokens
            if (usage.outputTokens > 0) outputTokens = usage.outputTokens
            if (usage.cacheReadTokens > 0) cacheReadTokens = usage.cacheReadTokens
            if (usage.cacheWriteTokens > 0) cacheWriteTokens = usage.cacheWriteTokens
            if (usage.reasoningTokens > 0) reasoningTokens = usage.reasoningTokens
          }

          if (ev.eventType === 'contextUsageEvent') {
            const pct = _extractKiroContextUsagePercentage(ev.payload)
            if (pct > 0) contextUsagePercentage = pct
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Flush any buffered assistant text and close any still-open block.
    // The messageStopEvent path usually does this for clean exits; this
    // also covers mid-stream aborts and DSML marker tails.
    const finalEmissions: AnthropicStreamEvent[] = []
    _flushPendingAssistantText(handlerState, finalEmissions, true)
    _closeOpenContentBlock(handlerState, finalEmissions)
    _closeOpenToolUseBlocks(handlerState, finalEmissions)
    for (const ev2 of finalEmissions) {
      if (!messageStartEmitted && _shouldTriggerMessageStart(ev2)) {
        const mst = emitMessageStart()
        if (mst) yield mst
      }
      yield ev2
    }

    if (!messageStartEmitted) {
      const mst = emitMessageStart()
      if (mst) yield mst
    }

    // Backfill usage from text length when metricsEvent was missing.
    if (outputTokens === 0 && totalContentChars > 0) {
      outputTokens = Math.max(1, Math.floor(totalContentChars / 4))
    }
    const estimatedContextTokens = contextUsagePercentage > 0
      ? Math.floor(contextUsagePercentage * KIRO_CONTEXT_WINDOW / 100)
      : 0
    if (inputTokens === 0 && estimatedContextTokens > 0) inputTokens = estimatedContextTokens

    const promptUsageKey = `${conversationId}:${resolvedModel}`
    const promptUsage = _deriveKiroPromptUsage({
      rawInputTokens: inputTokens,
      contextTokens: estimatedContextTokens,
      cacheReadTokens,
      cacheWriteTokens,
      previousContextTokens: this.promptContextTokensByConversation.get(promptUsageKey) ?? 0,
    })
    inputTokens = promptUsage.inputTokens
    cacheReadTokens = promptUsage.cacheReadTokens
    cacheWriteTokens = promptUsage.cacheWriteTokens
    if (promptUsage.nextContextTokens > 0) {
      this.promptContextTokensByConversation.set(promptUsageKey, promptUsage.nextContextTokens)
    }

    const hadToolUse = sawToolUse
    const stopReason: 'tool_use' | 'end_turn' = hadToolUse ? 'tool_use' : 'end_turn'
    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: {
        output_tokens: outputTokens,
        input_tokens: inputTokens,
        ...(cacheReadTokens > 0 && { cache_read_input_tokens: cacheReadTokens }),
        ...(cacheWriteTokens > 0 && { cache_creation_input_tokens: cacheWriteTokens }),
      },
    }
    yield { type: 'message_stop' }

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      thinking_tokens: reasoningTokens,
    }
  }
}

// ─── Event → IR translation ──────────────────────────────────────

interface EventHandlerState {
  model: string
  messageId: string
  toolBlocks: Map<string, ToolBlockState>
  getCurrentIndex: () => number
  setCurrentIndex: (v: number) => void
  getOpenBlock: () => 'text' | 'thinking' | null
  setOpenBlock: (v: 'text' | 'thinking' | null) => void
  getPendingAssistantText: () => string
  setPendingAssistantText: (v: string) => void
  markSawToolUse: () => void
  nextSyntheticToolUseId: () => string
  preferredShellToolName: string | null
  toolNameReverseMap: Map<string, string>
}

interface ToolBlockState {
  anthropicIndex: number
  emittedStart: boolean
  closed: boolean
}

function _closeOpenContentBlock(
  state: EventHandlerState,
  out: AnthropicStreamEvent[],
): void {
  const openBlock = state.getOpenBlock()
  if (openBlock === null) return
  out.push({ type: 'content_block_stop', index: state.getCurrentIndex() })
  state.setCurrentIndex(state.getCurrentIndex() + 1)
  state.setOpenBlock(null)
}

export function _closeOpenToolUseBlocks(
  state: Pick<EventHandlerState, 'toolBlocks'>,
  out: AnthropicStreamEvent[],
): void {
  for (const [, entry] of state.toolBlocks) {
    if (entry.emittedStart && !entry.closed) {
      out.push({ type: 'content_block_stop', index: entry.anthropicIndex })
      entry.closed = true
    }
  }
  state.toolBlocks.clear()
}

function _asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function _numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return 0
}

function _firstNumber(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = _numberFrom(record[key])
    if (value > 0) return value
  }
  return 0
}

function _unwrapKiroEventPayload(eventType: string, payload: Record<string, unknown> | null): unknown {
  if (!payload) return {}
  const nested = payload[eventType]
  return nested !== undefined ? nested : payload
}

function _extractKiroMetricsUsage(metrics: Record<string, unknown>): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
} {
  return {
    inputTokens: _firstNumber(metrics, [
      'inputTokens',
      'input_tokens',
      'promptTokens',
      'prompt_tokens',
    ]),
    outputTokens: _firstNumber(metrics, [
      'outputTokens',
      'output_tokens',
      'completionTokens',
      'completion_tokens',
    ]),
    cacheReadTokens: _firstNumber(metrics, [
      'cacheReadInputTokens',
      'cache_read_input_tokens',
      'cachedInputTokens',
      'cached_input_tokens',
      'cachedTokens',
      'cached_tokens',
    ]),
    cacheWriteTokens: _firstNumber(metrics, [
      'cacheCreationInputTokens',
      'cache_creation_input_tokens',
      'cacheWriteInputTokens',
      'cache_write_input_tokens',
    ]),
    reasoningTokens: _firstNumber(metrics, [
      'reasoningTokens',
      'reasoning_tokens',
      'thinkingTokens',
      'thinking_tokens',
    ]),
  }
}

function _extractKiroContextUsagePercentage(payload: Record<string, unknown> | null): number {
  const source = _asRecord(_unwrapKiroEventPayload('contextUsageEvent', payload)) ?? payload ?? {}
  return _numberFrom(source.contextUsagePercentage)
}

export function _deriveKiroPromptUsage(args: {
  rawInputTokens: number
  contextTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  previousContextTokens: number
}): DerivedKiroPromptUsage {
  const rawInputTokens = _numberFrom(args.rawInputTokens)
  const contextTokens = _numberFrom(args.contextTokens)
  const explicitCacheReadTokens = _numberFrom(args.cacheReadTokens)
  const explicitCacheWriteTokens = _numberFrom(args.cacheWriteTokens)
  const previousContextTokens = _numberFrom(args.previousContextTokens)
  const explicitCacheTokens = explicitCacheReadTokens + explicitCacheWriteTokens

  if (explicitCacheTokens > 0) {
    const inputTokens = rawInputTokens >= explicitCacheTokens
      ? rawInputTokens - explicitCacheTokens
      : rawInputTokens
    const nextContextTokens = contextTokens > 0
      ? contextTokens
      : inputTokens + explicitCacheTokens
    return {
      inputTokens,
      cacheReadTokens: explicitCacheReadTokens,
      cacheWriteTokens: explicitCacheWriteTokens,
      nextContextTokens,
    }
  }

  const totalContextTokens = contextTokens > 0 ? contextTokens : rawInputTokens
  if (totalContextTokens <= 0) {
    return {
      inputTokens: rawInputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      nextContextTokens: 0,
    }
  }

  if (previousContextTokens <= 0) {
    return {
      inputTokens: rawInputTokens > 0 ? rawInputTokens : totalContextTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      nextContextTokens: totalContextTokens,
    }
  }

  const cacheReadTokens = Math.min(previousContextTokens, totalContextTokens)
  return {
    inputTokens: Math.max(0, totalContextTokens - cacheReadTokens),
    cacheReadTokens,
    cacheWriteTokens: 0,
    nextContextTokens: totalContextTokens,
  }
}

function _emitText(
  state: EventHandlerState,
  out: AnthropicStreamEvent[],
  text: string,
): void {
  if (!text) return
  if (state.getOpenBlock() === 'thinking') {
    _closeOpenContentBlock(state, out)
  }
  if (state.getOpenBlock() !== 'text') {
    out.push({
      type: 'content_block_start',
      index: state.getCurrentIndex(),
      content_block: { type: 'text', text: '' },
    })
    state.setOpenBlock('text')
  }
  out.push({
    type: 'content_block_delta',
    index: state.getCurrentIndex(),
    delta: { type: 'text_delta', text },
  })
}

function _emitThinking(
  state: EventHandlerState,
  out: AnthropicStreamEvent[],
  text: string,
): void {
  if (!text) return
  if (state.getOpenBlock() === 'text') {
    _closeOpenContentBlock(state, out)
  }
  if (state.getOpenBlock() !== 'thinking') {
    out.push({
      type: 'content_block_start',
      index: state.getCurrentIndex(),
      content_block: { type: 'thinking', thinking: '' },
    })
    state.setOpenBlock('thinking')
  }
  out.push({
    type: 'content_block_delta',
    index: state.getCurrentIndex(),
    delta: { type: 'thinking_delta', thinking: text },
  })
}

function _emitToolUse(
  state: EventHandlerState,
  out: AnthropicStreamEvent[],
  toolUse: { toolUseId: string; name: string; input: unknown },
  opts: { closeImmediately?: boolean } = {},
): void {
  let entry = state.toolBlocks.get(toolUse.toolUseId)
  if (!entry) {
    _closeOpenContentBlock(state, out)
    entry = {
      anthropicIndex: state.getCurrentIndex(),
      emittedStart: false,
      closed: false,
    }
    state.toolBlocks.set(toolUse.toolUseId, entry)
    state.setCurrentIndex(state.getCurrentIndex() + 1)
  }

  if (!entry.emittedStart) {
    out.push({
      type: 'content_block_start',
      index: entry.anthropicIndex,
      content_block: {
        type: 'tool_use',
        id: toolUse.toolUseId,
        name: toClaudexToolName(toolUse.name, state.preferredShellToolName, state.toolNameReverseMap),
        input: {},
      },
    })
    entry.emittedStart = true
    state.markSawToolUse()
  }

  if (toolUse.input !== undefined) {
    const json = typeof toolUse.input === 'string'
      ? toolUse.input
      : JSON.stringify(toolUse.input)
    out.push({
      type: 'content_block_delta',
      index: entry.anthropicIndex,
      delta: { type: 'input_json_delta', partial_json: json },
    })
  }

  if (opts.closeImmediately && !entry.closed) {
    out.push({ type: 'content_block_stop', index: entry.anthropicIndex })
    entry.closed = true
  }
}

export function _parseDsmlFunctionCalls(block: string): ParsedDsmlToolCall[] | null {
  if (!block.startsWith(DSML_FUNCTION_CALLS_OPEN) || !block.endsWith(DSML_FUNCTION_CALLS_CLOSE)) {
    return null
  }

  const inner = block.slice(
    DSML_FUNCTION_CALLS_OPEN.length,
    block.length - DSML_FUNCTION_CALLS_CLOSE.length,
  )
  const calls: ParsedDsmlToolCall[] = []
  const invokeRegex = new RegExp(
    `<${DSML_TOKEN}invoke name="([^"]+)">([\\s\\S]*?)</${DSML_TOKEN}invoke>`,
    'g',
  )
  const parameterRegex = new RegExp(
    `<${DSML_TOKEN}parameter name="([^"]+)" string="(true|false)">([\\s\\S]*?)</${DSML_TOKEN}parameter>`,
    'g',
  )

  let lastInvokeEnd = 0
  for (const match of inner.matchAll(invokeRegex)) {
    const full = match[0]
    const name = match[1]
    const argsBlock = match[2]
    if (!(full && name != null && argsBlock != null && match.index != null)) return null
    if (inner.slice(lastInvokeEnd, match.index).trim()) return null

    const input: Record<string, unknown> = {}
    let lastParamEnd = 0
    for (const param of argsBlock.matchAll(parameterRegex)) {
      const [, paramName, isString, rawValue] = param
      if (!(paramName && isString && rawValue != null && param.index != null)) return null
      if (argsBlock.slice(lastParamEnd, param.index).trim()) return null
      if (Object.prototype.hasOwnProperty.call(input, paramName)) return null

      if (isString === 'true') {
        input[paramName] = rawValue
      } else {
        const trimmed = rawValue.trim()
        if (!trimmed) {
          input[paramName] = null
        } else {
          try {
            input[paramName] = JSON.parse(trimmed) as unknown
          } catch {
            return null
          }
        }
      }

      lastParamEnd = param.index + param[0].length
    }

    if (argsBlock.slice(lastParamEnd).trim()) return null

    calls.push({ name, input })
    lastInvokeEnd = match.index + full.length
  }

  if (inner.slice(lastInvokeEnd).trim()) return null

  return calls
}

function _flushPendingAssistantText(
  state: EventHandlerState,
  out: AnthropicStreamEvent[],
  flushAll: boolean,
): void {
  let pending = state.getPendingAssistantText()
  if (!pending) return

  while (pending.length > 0) {
    const openIndex = pending.indexOf(DSML_FUNCTION_CALLS_OPEN)
    if (openIndex === -1) {
      if (!flushAll) {
        const keepTail = Math.min(pending.length, DSML_FUNCTION_CALLS_OPEN.length - 1)
        const emitLength = pending.length - keepTail
        if (emitLength > 0) {
          _emitText(state, out, pending.slice(0, emitLength))
          pending = pending.slice(emitLength)
        }
        break
      }

      const stripped = _stripDanglingDsmlText(pending)
      if (stripped) _emitText(state, out, stripped)
      pending = ''
      break
    }

    if (openIndex > 0) {
      _emitText(state, out, pending.slice(0, openIndex))
      pending = pending.slice(openIndex)
      continue
    }

    const closeIndex = pending.indexOf(
      DSML_FUNCTION_CALLS_CLOSE,
      DSML_FUNCTION_CALLS_OPEN.length,
    )
    if (closeIndex === -1) {
      if (flushAll) {
        const stripped = _stripDanglingDsmlText(pending)
        if (stripped) _emitText(state, out, stripped)
        pending = ''
      }
      break
    }

    const blockEnd = closeIndex + DSML_FUNCTION_CALLS_CLOSE.length
    const block = pending.slice(0, blockEnd)
    const toolCalls = _parseDsmlFunctionCalls(block)
    if (toolCalls === null) {
      _emitText(state, out, block)
    } else {
      for (const toolCall of toolCalls) {
        _emitToolUse(
          state,
          out,
          {
            toolUseId: state.nextSyntheticToolUseId(),
            name: toolCall.name,
            input: toolCall.input,
          },
          { closeImmediately: true },
        )
      }
    }
    pending = pending.slice(blockEnd)
  }

  state.setPendingAssistantText(pending)
}

function _stripDanglingDsmlText(text: string): string {
  const marker = `<${DSML_TOKEN}`
  const markerIndex = text.lastIndexOf(marker)
  if (markerIndex === -1) return text
  return text.slice(0, markerIndex)
}

export function _handleKiroEvent(
  ev: KiroEvent,
  state: EventHandlerState,
): AnthropicStreamEvent[] {
  const out: AnthropicStreamEvent[] = []

  const payload = _unwrapKiroEventPayload(ev.eventType, ev.payload)
  const payloadRecord = _asRecord(payload) ?? {}

  switch (ev.eventType) {
    case 'assistantResponseEvent': {
      const content = typeof payloadRecord.content === 'string' ? payloadRecord.content : ''
      if (content) {
        state.setPendingAssistantText(state.getPendingAssistantText() + content)
        _flushPendingAssistantText(state, out, false)
      }
      break
    }
    case 'codeEvent': {
      const content = typeof payloadRecord.content === 'string' ? payloadRecord.content : ''
      if (content) _emitText(state, out, content)
      break
    }
    case 'reasoningContentEvent': {
      const content = typeof payloadRecord.content === 'string' ? payloadRecord.content : ''
      if (content) _emitThinking(state, out, content)
      break
    }
    case 'toolUseEvent': {
      // Payload can be a single tool or an array — normalize.
      const items: Array<Record<string, unknown>> = Array.isArray(payload)
        ? payload.filter((item): item is Record<string, unknown> => _asRecord(item) !== null)
        : [payloadRecord]
      for (const tu of items) {
        const toolUseId = (typeof tu.toolUseId === 'string' && tu.toolUseId)
          || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const toolName = typeof tu.name === 'string' ? tu.name : ''
        _emitToolUse(state, out, {
          toolUseId,
          name: toolName,
          input: tu.input,
        })
      }
      break
    }
    case 'messageStopEvent': {
      _flushPendingAssistantText(state, out, true)
      _closeOpenContentBlock(state, out)
      // Finalize any in-flight tool_use blocks.
      _closeOpenToolUseBlocks(state, out)
      break
    }
    // meteringEvent / metricsEvent / contextUsageEvent / supplementaryWebLinksEvent:
    // metrics are consumed in the outer loop; other bookkeeping events
    // don't map to Anthropic IR.
  }

  return out
}

function _shouldTriggerMessageStart(ev: AnthropicStreamEvent): boolean {
  return ev.type === 'content_block_start' || ev.type === 'content_block_delta'
}

function assembleSystemFromParts(parts: {
  memory?: string
  environment?: string
  gitStatus?: string
  toolsAddendum?: string
  mcpIntro?: string
  skillsContext?: string
  customInstructions?: string
}): string {
  const sections: string[] = []
  if (parts.customInstructions) sections.push(parts.customInstructions)
  if (parts.toolsAddendum) sections.push(parts.toolsAddendum)
  if (parts.mcpIntro) sections.push(parts.mcpIntro)
  if (parts.skillsContext) sections.push(`Skills:\n${parts.skillsContext}`)
  if (parts.memory) sections.push(`Context:\n${parts.memory}`)
  if (parts.environment) sections.push(parts.environment)
  if (parts.gitStatus) sections.push(`Git status:\n${parts.gitStatus}`)
  return sections.join('\n\n')
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

function _isInvalidBearerResponse(status: number, errText: string): boolean {
  if (status !== 401 && status !== 403) return false
  const lowered = errText.toLowerCase()
  return (
    lowered.includes('bearer token')
    || lowered.includes('invalid token')
    || lowered.includes('token included in the request is invalid')
    || lowered.includes('expired token')
    || lowered.includes('unauthorized')
  )
}

// Total Kiro request attempts (initial + retries) before failing the lane.
const KIRO_MAX_REQUEST_ATTEMPTS = 3

/**
 * Transient server-side statuses where Kiro asks us to "try again". Retrying
 * these before falling back avoids burning a fallback hop on a momentary blip
 * (the 500 "Encountered an unexpected error … please try again" is the common
 * one; 429/502/503/504 are the usual transient companions).
 */
export function _isTransientKiroStatus(status: number): boolean {
  return (
    status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504
  )
}

/**
 * Exponential backoff (0.5s, 1s, 2s … capped at 4s) with jitter. Resolves early
 * if the request is aborted so the next fetch surfaces the canonical AbortError
 * instead of waiting out the delay.
 */
async function _kiroBackoffDelay(
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  const base = Math.min(500 * 2 ** attempt, 4000)
  const ms = base + Math.floor(Math.random() * 250)
  await new Promise<void>(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function* _emitErrorText(text: string): Generator<AnthropicStreamEvent> {
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
}

/**
 * Persist the rejected Kiro request body to a tmp file for inspection.
 * Gated by CLAUDEX_KIRO_DEBUG_DUMP=1 so it never fires for normal users.
 * Returns the file path on success, null otherwise (env off, write failed).
 * Best-effort: never throws — diagnostic logging must not double-fault a
 * request that already failed.
 */
function _dumpKiroRequestBody(body: unknown, reason = 'improperly-formed'): string | null {
  if (process.env.CLAUDEX_KIRO_DEBUG_DUMP !== '1') return null
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const os = require('node:os') as typeof import('node:os')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const dir = path.join(os.tmpdir(), 'tau-kiro-debug')
    fs.mkdirSync(dir, { recursive: true })
    const fileName = `kiro-${reason}-${Date.now()}.json`
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, JSON.stringify(body, null, 2), 'utf-8')
    return filePath
  } catch {
    return null
  }
}

// ─── Singleton ───────────────────────────────────────────────────

export const kiroLane = new KiroLane()
