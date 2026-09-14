/**
 * Cline Lane
 *
 * Native transport for Cline's own gateway:
 *   - chat:    POST /api/v1/chat/completions
 *   - catalog: GET  /api/v1/ai/cline/models
 *   - feed:    GET  /api/v1/ai/cline/recommended-models
 *
 * Auth path:
 *   - Cline OAuth session -> Authorization: Bearer workos:<token>
 *
 * Provider-scoped routing is intentional. Cline exposes upstream model ids
 * like `anthropic/claude-sonnet-4.6` and `openai/gpt-5.4`; selecting this
 * lane by model name alone would collide with other native lanes. The shim
 * routes provider `cline` here explicitly.
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
  SystemBlock,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneProviderCallParams,
  LaneRunContext,
  LaneRunResult,
  NormalizedUsage,
} from '../types.js'
import {
  anthropicMessagesToOpenAI,
  type OpenAIMessage,
  type OpenAITool,
} from '../../services/api/adapters/anthropic_to_openai.js'
import { getProviderBaseUrl } from '../../utils/auth.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'
import { refreshClineOAuth } from '../../services/api/auth/oauth_services.js'
import {
  OPENAI_COMPAT_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'
import {
  createRetryableConnectionError,
  isAbortError,
  throwRetryableProviderHttpError,
} from '../../services/api/transport_error.js'
import {
  applyClineReasoningFields,
  isClineThinkingModel,
  resolveClineReasoningFields,
  stripClineEffortVariant,
} from '../../utils/model/clineThinking.js'
import {
  getClineModelMeta,
  waitForClineModelsDev,
} from '../../utils/model/clineModelsDevCatalog.js'
import {
  CLINE_PASS_LABEL,
  getClinePassModels,
  isClinePassProvider,
  recordClinePassModelNames,
} from '../../utils/model/clinePassCatalog.js'
import { decideImageSupport } from '../shared/vision_capability.js'
import { substituteUnsendableMedia } from '../shared/media_extract.js'
import { buildClineToolsForRequest } from './tools.js'
import {
  buildClineBlockedInvalidToolCallText,
  buildClineRequiredParamMap,
  buildClineToolArgRepairMessage,
  buildClineToolSchemaMap,
  findClineToolCallsMissingRequiredArgs,
  normalizeClineToolCallArgumentEvents,
} from './tool_arg_validation.js'
import {
  buildClineCatalogIndex,
  buildClinePassModels,
  catalogContextWindow,
  catalogIsFreeViaApi,
  catalogSupportsPromptCache,
  catalogSupportsTools,
  findClineCatalogModel,
  isClineCatalogRetryDue,
  parseClineCatalog,
  parseClineRecommendedFeed,
  type ClineCatalogFailure,
  type ClineCatalogIndex,
  type ClineCatalogModel,
  type ClineFeedEntry,
  type ClineRecommendedFeed,
  type RawClineModelInfo,
} from './catalog.js'
import {
  applyClinePromptCache,
  isClinePromptCacheRejected,
  isContentPartCacheFamily,
  resolveClinePromptCacheShape,
  type ClinePromptCacheShape,
} from './prompt_cache.js'
import {
  collectClineStream,
  type ClineCollectedStream,
  type ClineStreamFailure,
} from './stream.js'
import { describeClineError, describeEmptyClineResponse } from './errors.js'

interface StoredClineOAuthBlob {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

interface ClineAuthSession {
  token: string
}

interface ClineCatalogSnapshot {
  models: ClineCatalogModel[] | null
  feed: ClineRecommendedFeed | null
  index: ClineCatalogIndex
  /** Both feeds came back on the fetch that produced this snapshot. */
  complete: boolean
  at: number
}

const CLINE_CATALOG_TTL_MS = 5 * 60_000
// A snapshot that is missing a feed is retried sooner than a complete one:
// after 30 s, then twice as long after each further shortfall, up to the
// complete TTL (see _catalogRetryDue).
const CLINE_PARTIAL_CATALOG_TTL_MS = 30_000
const CLINE_CATALOG_FETCH_TIMEOUT_MS = 15_000
// How long a first request waits for what it has to decide with: the catalog
// that says whether a Qwen or MiniMax model caches, and, on a machine with no
// models.dev copy yet, that copy. Later requests reuse both.
const CLINE_CATALOG_REQUEST_WAIT_MS = 3_000
// How long /models waits for the first models.dev download on a machine that
// has none yet. Once the file is on disk it answers at once.
const CLINE_MODELS_DEV_LIST_WAIT_MS = 8_000
const CLINE_REFRESH_BUFFER_MS = 5 * 60_000
const CLINE_TOOL_ARG_REPAIR_ATTEMPTS = 2
// The first send, plus one retry each after dropping strict tool schemas or
// the prompt-cache markers, whichever the gateway objects to.
const CLINE_SEND_ATTEMPTS = 3

const CLINE_FALLBACK_MODELS: ModelInfo[] = [
  { id: 'kwaipilot/kat-coder-pro', name: 'Kat Coder Pro' },
  { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7' },
  { id: 'minimax/minimax-m2.5', name: 'MiniMax M2.5' },
  { id: 'arcee-ai/trinity-large-preview:free', name: 'Arcee Trinity Large Preview' },
  { id: 'z-ai/glm-5', name: 'GLM-5' },
  { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8' },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' },
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
  { id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'openai/gpt-5-codex', name: 'GPT-5 Codex' },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
  { id: 'google/gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite Preview' },
  { id: 'qwen/qwen3-coder:exacto', name: 'Qwen3 Coder Exacto' },
  { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
  { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/kimi-k2:exacto', name: 'Kimi K2 Exacto' },
  { id: 'moonshotai/kimi-k2', name: 'Kimi K2' },
  { id: 'z-ai/glm-4.6:exacto', name: 'GLM 4.6 Exacto' },
  { id: 'deepseek/deepseek-v3.1-terminus:exacto', name: 'DeepSeek V3.1 Terminus Exacto' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'x-ai/grok-code-fast-1', name: 'Grok Code Fast 1' },
]

const CLINE_FALLBACK_RECOMMENDED_MODEL_IDS = new Set([
  'minimax/minimax-m2.7',
  'google/gemini-3.1-pro-preview',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.5',
  'deepseek/deepseek-v4-pro',
  'anthropic/claude-opus-4.6',
  'openai/gpt-5.3-codex',
  'anthropic/claude-opus-4.7',
  'openai/gpt-5.4',
  'openai/gpt-5-codex',
].map(normalizeClineModelId))

const CLINE_LATEST_MODEL_IDS = new Set([
  'minimax/minimax-m2.7',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash-lite-preview',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.7',
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'openai/gpt-5.3-codex',
  'openai/gpt-5-codex',
  'z-ai/glm-5',
  'moonshotai/kimi-k2.6',
  'deepseek/deepseek-v3.1-terminus:exacto',
].map(normalizeClineModelId))

const CLINE_VALUE_MODEL_IDS = new Set([
  'minimax/minimax-m2.7',
  'qwen/qwen3-coder:exacto',
  'qwen/qwen3-coder',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2:exacto',
  'moonshotai/kimi-k2',
  'z-ai/glm-4.6:exacto',
  'z-ai/glm-4.6',
  'deepseek/deepseek-v3.1-terminus:exacto',
  'deepseek/deepseek-chat',
  'google/gemini-3.1-flash-lite-preview',
  'x-ai/grok-code-fast-1',
  'kwaipilot/kat-coder-pro',
  'minimax/minimax-m2.5',
].map(normalizeClineModelId))

export class ClineLane implements Lane {
  readonly name = 'cline'
  readonly displayName = 'Cline'

  private oauthTokenHint: string | null = null
  private clinePassOAuthTokenHint: string | null = null
  // Catalog snapshots and in-flight loads, keyed by API root.
  private catalogs = new Map<string, ClineCatalogSnapshot>()
  private catalogLoads = new Map<string, Promise<ClineCatalogSnapshot>>()
  // Loads in a row that fell short, keyed by API root. Paces the retries.
  private catalogFailures = new Map<string, ClineCatalogFailure>()
  // Prompt-cache decisions stay fixed for the session, keyed by model id.
  private promptCacheShapes = new Map<string, ClinePromptCacheShape>()
  private promptCacheRefused = new Set<string>()
  private refreshInFlight = new Map<string, Promise<string | null>>()

  configure(opts: { oauthToken?: string | null; clinePassOAuthToken?: string | null }): void {
    if (opts.oauthToken !== undefined) this.oauthTokenHint = opts.oauthToken || null
    if (opts.clinePassOAuthToken !== undefined) {
      this.clinePassOAuthTokenHint = opts.clinePassOAuthToken || null
    }
  }

  invalidateModelCache(): void {
    this.catalogs.clear()
    // A new login retries at once instead of waiting out an earlier failure.
    this.catalogFailures.clear()
  }

  supportsModel(_model: string): boolean {
    // Cline's catalog overlaps other providers' ids. Provider-scoped routing
    // from providerShim is the only authoritative selector for this lane.
    return false
  }

  isHealthy(): boolean {
    return !!(
      this._peekStoredOAuthCredential('cline')
      || this._peekStoredOAuthCredential('clinepass')
    )
  }

  resolveModel(model: string): string {
    return model
  }

  dispose(): void {}

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    throw new Error(
      'ClineLane.run (lane-owns-loop) is not wired yet - use streamAsProvider via LaneBackedProvider.',
    )
  }

  async listModels(providerFilter?: string): Promise<ModelInfo[]> {
    const [snapshot] = await Promise.all([
      this._loadCatalog(providerFilter),
      waitForClineModelsDev(CLINE_MODELS_DEV_LIST_WAIT_MS),
    ])

    if (isClinePassProvider(providerFilter)) {
      const live = buildClinePassModels(
        snapshot.feed,
        snapshot.models ? snapshot.index : null,
        getClineModelMeta,
      )
      const models = live.length > 0
        ? live
        : buildClinePassModels(
          { clinePass: getClinePassModels().map(({ id, name }) => ({ id, name })) },
          null,
          getClineModelMeta,
        )
      recordClinePassModelNames(models)
      return models
    }

    return this._buildClineModels(snapshot)
  }

  private _buildClineModels(snapshot: ClineCatalogSnapshot): ModelInfo[] {
    const catalog = snapshot.models
    const catalogIds = catalog
      ? new Set(catalog.map(model => normalizeClineModelId(model.id)))
      : null

    const recommendedIds = new Set<string>()
    const recommendedModels: ModelInfo[] = []
    for (const entry of snapshot.feed?.recommended ?? []) {
      const model = recommendedEntryToModel(entry)
      // A featured id that the billed catalog does not list cannot be called
      // through the API, so listing it would only offer a failing request.
      if (!model || (catalogIds && !catalogIds.has(normalizeClineModelId(model.id)))) continue
      recommendedIds.add(model.id)
      recommendedModels.push(model)
    }

    let models: ModelInfo[] = (catalog ?? []).map((model) => {
      const tags = mergeClineTags(
        rawClineModelSupportsReasoning(model) ? ['thinking'] : undefined,
        catalogIsFreeViaApi(model) ? ['free'] : undefined,
      )
      return {
        id: model.id,
        name: model.name ?? model.id,
        // models.dev states the prompt this route accepts, input ceiling
        // included (gpt-6-astra: 922,000 of a 1,050,000 window). Cline's own
        // row answers for ids models.dev does not describe.
        contextWindow: getClineModelMeta(model.id)?.contextWindow ?? catalogContextWindow(model),
        supportsToolCalling: catalogSupportsTools(model),
        ...(tags.length > 0 && { tags }),
      }
    })

    models.push(...recommendedModels)

    if (models.length === 0) {
      models = [...CLINE_FALLBACK_MODELS]
    }

    models = models.filter(model => !model.id.toLowerCase().startsWith('cline-pass/'))
    return this._curateModels(models, recommendedIds, snapshot.feed !== null)
  }

  private _curateModels(
    models: ModelInfo[],
    recommendedIds: Set<string>,
    feedLoaded: boolean,
  ): ModelInfo[] {
    const normalizedRecommended = new Set(
      [...recommendedIds].map((id) => normalizeClineModelId(id)),
    )
    const useFallbackSignals = !feedLoaded

    const originalRank = new Map<string, number>()
    const byId = new Map<string, ModelInfo>()
    models.forEach((model, index) => {
      const normalizedId = normalizeClineModelId(model.id)
      if (!originalRank.has(normalizedId)) originalRank.set(normalizedId, index)
      const previous = byId.get(normalizedId)
      byId.set(normalizedId, previous ? mergeClineModelInfo(previous, model) : model)
    })
    const uniqueModels = Array.from(byId.values())

    uniqueModels.sort((left, right) => {
      const scoreDiff =
        scoreClineModel(right, normalizedRecommended, useFallbackSignals)
        - scoreClineModel(left, normalizedRecommended, useFallbackSignals)
      if (scoreDiff !== 0) return scoreDiff

      const leftRank = originalRank.get(normalizeClineModelId(left.id)) ?? Number.MAX_SAFE_INTEGER
      const rightRank = originalRank.get(normalizeClineModelId(right.id)) ?? Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank

      const leftContext = left.contextWindow ?? 0
      const rightContext = right.contextWindow ?? 0
      if (leftContext !== rightContext) return rightContext - leftContext

      const leftName = (left.name ?? left.id).toLowerCase()
      const rightName = (right.name ?? right.id).toLowerCase()
      if (leftName !== rightName) return leftName.localeCompare(rightName)
      return left.id.localeCompare(right.id)
    })

    return uniqueModels
      .map((model) => {
        const tags = mergeClineTags(
          model.tags,
          getClineModelTags(model.id, normalizedRecommended, useFallbackSignals),
          clineModelReasons(model.id) ? ['thinking'] : undefined,
        )
        return tags.length > 0 ? { ...model, tags } : model
      })
  }

  private _loadCatalog(providerHint?: string): Promise<ClineCatalogSnapshot> {
    const root = this._apiRoot(providerHint)
    const cached = this.catalogs.get(root)
    if (cached && Date.now() - cached.at < catalogTtl(cached)) {
      return Promise.resolve(cached)
    }

    let load = this.catalogLoads.get(root)
    if (!load) {
      load = this._fetchCatalog(root, providerHint)
        .then((fresh) => {
          // A partial refresh keeps the last good copy of the missing feed.
          const previous = this.catalogs.get(root)
          const models = fresh.models ?? previous?.models ?? null
          const feed = fresh.feed ?? previous?.feed ?? null
          const snapshot: ClineCatalogSnapshot = {
            models,
            feed,
            index: buildClineCatalogIndex(models ?? []),
            complete: fresh.models !== null && fresh.feed !== null,
            at: Date.now(),
          }
          if (models || feed) this.catalogs.set(root, snapshot)
          this._noteCatalogLoad(root, snapshot.complete)
          return snapshot
        })
        .finally(() => {
          this.catalogLoads.delete(root)
        })
      this.catalogLoads.set(root, load)
    }
    return load
  }

  private async _fetchCatalog(
    root: string,
    providerHint?: string,
  ): Promise<{ models: ClineCatalogModel[] | null; feed: ClineRecommendedFeed | null }> {
    const auth = await this._resolveAuth(providerHint).catch(() => null)
    const headers = this._buildDiscoveryHeaders(auth)
    const [modelsResult, feedResult] = await Promise.allSettled([
      fetchClineJson(`${root}/ai/cline/models`, headers),
      fetchClineJson(`${root}/ai/cline/recommended-models`, headers),
    ])
    const models = modelsResult.status === 'fulfilled'
      ? parseClineCatalog(modelsResult.value)
      : []
    const feed = feedResult.status === 'fulfilled'
      ? parseClineRecommendedFeed(feedResult.value)
      : null
    return { models: models.length > 0 ? models : null, feed }
  }

  /**
   * The catalog for a chat request: whatever is cached (refreshed in the
   * background when stale), else a fresh load that is waited on only
   * briefly, so a slow catalog never holds up a turn. While a failed load's
   * retry is not due, nothing is fetched or waited on.
   */
  private async _catalogForRequest(
    params: LaneProviderCallParams,
  ): Promise<ClineCatalogSnapshot | null> {
    const root = this._apiRoot(params.providerHint)
    const retryDue = this._catalogRetryDue(root)
    const cached = this.catalogs.get(root)
    if (cached) {
      if (retryDue && Date.now() - cached.at >= catalogTtl(cached)) {
        void this._loadCatalog(params.providerHint)
      }
      return cached
    }
    if (!retryDue) return null
    return waitAtMost(
      this._loadCatalog(params.providerHint),
      CLINE_CATALOG_REQUEST_WAIT_MS,
      params.signal,
    )
  }

  /**
   * Whether `root` may be loaded again. After a load that fell short (a feed
   * failed, or both did), the next one waits CLINE_PARTIAL_CATALOG_TTL_MS,
   * doubling with each shortfall in a row up to CLINE_CATALOG_TTL_MS, so a
   * failing catalog is never fetched more often than a healthy one is
   * refreshed. Without this, a load that brought nothing back was retried by
   * the very next request, which waited on it too.
   */
  private _catalogRetryDue(root: string): boolean {
    const failure = this.catalogFailures.get(root)
    return !failure || isClineCatalogRetryDue(
      failure,
      Date.now(),
      CLINE_PARTIAL_CATALOG_TTL_MS,
      CLINE_CATALOG_TTL_MS,
    )
  }

  private _noteCatalogLoad(root: string, complete: boolean): void {
    if (complete) {
      this.catalogFailures.delete(root)
      return
    }
    const count = (this.catalogFailures.get(root)?.count ?? 0) + 1
    this.catalogFailures.set(root, { count, at: Date.now() })
  }

  private async _promptCacheShape(
    params: LaneProviderCallParams,
  ): Promise<ClinePromptCacheShape | null> {
    const model = stripClineEffortVariant(params.model)
    const key = promptCacheKey(model)
    if (this.promptCacheRefused.has(key)) return null
    const known = this.promptCacheShapes.get(key)
    if (known) return known

    let catalogSaysCacheable: boolean | undefined
    if (isContentPartCacheFamily(model)) {
      const snapshot = await this._catalogForRequest(params)
      const entry = snapshot?.models
        ? findClineCatalogModel(model, snapshot.index)
        : undefined
      catalogSaysCacheable = entry ? catalogSupportsPromptCache(entry) : undefined
    }

    const shape = resolveClinePromptCacheShape(model, catalogSaysCacheable)
    // Only a yes is kept. Turning markers on later just starts a cache, while
    // turning them off mid-session would reshape requests under a warm one.
    if (shape) this.promptCacheShapes.set(key, shape)
    return shape
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const auth = await this._resolveAuth(params.providerHint)
    if (!auth) {
      throw new Error(
        `${this._authDisplayName(params.providerHint)} lane: not authenticated. `
        + `Run \`${isClinePassProvider(params.providerHint) ? '/login cline pass' : '/login cline'}\` to authenticate.`,
      )
    }

    const model = stripClineEffortVariant(params.model)
    const system = this._prependToolUsageRules(params.system, params.tools.length > 0)
    // Cline routes to whichever upstream model is selected, so carrying an
    // image over the wire says nothing about the model being able to read it.
    // When it cannot, swap in the OCR/description text rather than shipping
    // pixels that get silently dropped and answered about anyway.
    const outboundMessages = decideImageSupport(params.providerHint, params.model)
      ? params.messages
      : substituteUnsendableMedia(params.messages)
    // Tau's Anthropic-shaped cache markers do not survive this conversion.
    // The lane places Cline's own when sending (see prompt_cache.ts).
    const messages = anthropicMessagesToOpenAI(outboundMessages, system)
    // models.dev supplies the thinking stops and output caps the body is
    // built from. On a machine with no copy yet, the first request gives it
    // the same brief wait as the catalog the prompt-cache decision may need.
    const [promptCache] = await Promise.all([
      this._promptCacheShape(params),
      waitForClineModelsDev(CLINE_CATALOG_REQUEST_WAIT_MS, params.signal),
    ])
    const requiredParams = buildClineRequiredParamMap(params.tools)
    const schemaByTool = buildClineToolSchemaMap(params.tools)
    const knownToolNames = new Set(requiredParams.keys())

    let response = await this._send(
      auth,
      params,
      messages,
      [],
      promptCache,
      'cline API connection error',
    )
    if (!response.ok) {
      yield* emitHttpFailure(response, model)
      return blankUsage()
    }

    let collected = await this._collectResponseEvents(response)
    if (collected.failure) {
      yield* emitStreamFailure(collected.failure, model)
      return collected.usage
    }
    collected.events = normalizeClineToolCallArgumentEvents(collected.events, params.tools)
    let invalidToolCalls = findClineToolCallsMissingRequiredArgs(
      collected.events,
      requiredParams,
      { knownToolNames, schemaByTool },
    )

    for (
      let attempt = 1;
      invalidToolCalls.length > 0 && attempt <= CLINE_TOOL_ARG_REPAIR_ATTEMPTS;
      attempt += 1
    ) {
      const repair = buildClineToolArgRepairMessage(invalidToolCalls, attempt, schemaByTool)
      response = await this._send(
        auth,
        params,
        messages,
        [repair],
        promptCache,
        'cline API connection error after tool-arg repair retry',
      )
      if (!response.ok) {
        yield* emitHttpFailure(response, model)
        return blankUsage()
      }

      collected = await this._collectResponseEvents(response)
      if (collected.failure) {
        yield* emitStreamFailure(collected.failure, model)
        return collected.usage
      }
      collected.events = normalizeClineToolCallArgumentEvents(collected.events, params.tools)
      invalidToolCalls = findClineToolCallsMissingRequiredArgs(
        collected.events,
        requiredParams,
        { knownToolNames, schemaByTool },
      )
    }

    if (invalidToolCalls.length > 0) {
      yield* emitErrorTurn(buildClineBlockedInvalidToolCallText(invalidToolCalls))
      return collected.usage
    }

    for (const event of collected.events) {
      yield event
    }

    return collected.usage
  }

  private _buildTools(
    tools: LaneProviderCallParams['tools'],
    opts: { strict?: boolean } = {},
  ): OpenAITool[] {
    return buildClineToolsForRequest(tools, opts)
  }

  private async _send(
    auth: ClineAuthSession,
    params: LaneProviderCallParams,
    messages: readonly OpenAIMessage[],
    tail: readonly OpenAIMessage[],
    promptCache: ClinePromptCacheShape | null,
    connectionErrorPrefix: string,
  ): Promise<Response> {
    try {
      return await this._sendWithFallbacks(auth, params, messages, tail, promptCache)
    } catch (error: unknown) {
      if (isAbortError(error, params.signal)) throw error
      throw createRetryableConnectionError(connectionErrorPrefix, error)
    }
  }

  private async _sendWithFallbacks(
    auth: ClineAuthSession,
    params: LaneProviderCallParams,
    messages: readonly OpenAIMessage[],
    tail: readonly OpenAIMessage[],
    promptCache: ClinePromptCacheShape | null,
  ): Promise<Response> {
    const modelKey = promptCacheKey(params.model)
    let strict = clineModelHonorsOpenAIStrict(params.model)
    let cacheShape = this.promptCacheRefused.has(modelKey) ? null : promptCache
    let response: Response | undefined

    for (let attempt = 0; attempt < CLINE_SEND_ATTEMPTS; attempt += 1) {
      const tools = this._buildTools(params.tools, { strict })
      const body = this._buildRequestBody({
        model: params.model,
        // The repair tail goes after the marked history, so a retry keeps
        // the exact prefix the first send cached.
        messages: [...applyClinePromptCache(messages, cacheShape), ...tail],
        tools,
        maxTokens: params.max_tokens,
        temperature: params.temperature,
        stopSequences: params.stop_sequences,
        thinking: params.thinking,
        promptCache: cacheShape !== null,
      })

      response = await fetch(`${this._apiRoot(params.providerHint)}/chat/completions`, {
        method: 'POST',
        headers: this._buildHeaders(auth, params.sessionId),
        body: JSON.stringify(body),
        signal: params.signal,
      })
      if (response.ok) return response

      const errText = await response.clone().text().catch(() => '')
      const dropCache = cacheShape !== null
        && isClinePromptCacheRejected(response.status, errText)
      const dropStrict = !dropCache
        && strict
        && hasStrictClineTools(tools)
        && isClineStrictToolSchemaRejected(errText)
      if (!dropCache && !dropStrict) return response

      await response.body?.cancel().catch(() => undefined)
      if (dropCache) {
        // The gateway refused markers for this model: stop sending them for
        // the rest of the session instead of flip-flopping every turn.
        this.promptCacheRefused.add(modelKey)
        this.promptCacheShapes.delete(modelKey)
        cacheShape = null
      } else {
        strict = false
      }
    }

    return response!
  }

  private async _collectResponseEvents(response: Response): Promise<ClineCollectedStream> {
    if (!response.body) {
      return {
        events: [],
        usage: blankUsage(),
        failure: { kind: 'empty', message: 'no response body', raw: '' },
      }
    }
    return collectClineStream(response.body)
  }

  private _buildRequestBody(opts: {
    model: string
    messages: OpenAIMessage[]
    tools: OpenAITool[]
    maxTokens: number
    temperature?: number
    stopSequences?: string[]
    thinking?: LaneProviderCallParams['thinking']
    promptCache?: boolean
  }): Record<string, unknown> {
    // A request for more output than the model can give is refused outright.
    const outputCap = getClineModelMeta(opts.model)?.maxOutputTokens
    const body: Record<string, unknown> = {
      model: stripClineEffortVariant(opts.model),
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: outputCap ? Math.min(opts.maxTokens, outputCap) : opts.maxTokens,
      ...(opts.tools.length > 0 && {
        tools: opts.tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
      }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.stopSequences && opts.stopSequences.length > 0 && { stop: opts.stopSequences }),
      // Request-level marker, as Cline's SDK sends it next to the message one.
      ...(opts.promptCache && { cache_control: { type: 'ephemeral' } }),
    }

    // Thinking fields name only a stop on the model's own ladder.
    applyClineReasoningFields(body, resolveClineReasoningFields(opts.model))
    return body
  }

  private _prependToolUsageRules(
    system: string | SystemBlock[],
    hasTools: boolean,
  ): string | SystemBlock[] {
    if (!hasTools) return system
    if (typeof system === 'string') {
      return system
        ? `${OPENAI_COMPAT_TOOL_USAGE_RULES}\n${system}`
        : OPENAI_COMPAT_TOOL_USAGE_RULES
    }

    const blocks = [...system]
    if (blocks.length === 0) {
      return [{ type: 'text', text: OPENAI_COMPAT_TOOL_USAGE_RULES }]
    }

    const first = blocks[0] as SystemBlock & { cache_control?: { type: string } }
    return [
      { ...first, text: `${OPENAI_COMPAT_TOOL_USAGE_RULES}\n${first.text}` },
      ...blocks.slice(1),
    ]
  }

  private _buildHeaders(auth: ClineAuthSession, sessionId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'HTTP-Referer': 'https://github.com/AbdoKnbGit/tau',
      'X-Title': 'Tau',
    }

    const workosToken = clineBearerToken(auth.token)
    headers.Authorization = `Bearer ${workosToken}`
    headers.workos = workosToken
    // Cline's clients stamp every request of a task with X-Task-ID. Tau sends
    // its stable conversation id (services/api/cacheAffinity.ts) so the
    // gateway keeps one conversation together.
    const taskId = sessionId?.trim()
    if (taskId) headers['X-Task-ID'] = taskId
    return headers
  }

  private _buildDiscoveryHeaders(
    auth: ClineAuthSession | null,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (!auth) return headers

    const workosToken = clineBearerToken(auth.token)
    headers.Authorization = `Bearer ${workosToken}`
    headers.workos = workosToken
    return headers
  }

  private _peekStoredOAuthCredential(providerHint?: string): StoredClineOAuthBlob | null {
    try {
      const raw = loadProviderKey(this._oauthStorageKey(providerHint))
      if (!raw) {
        const tokenHint = this._oauthTokenHint(providerHint)
        if (tokenHint) return { accessToken: tokenHint }
        return null
      }
      const parsed = JSON.parse(raw) as StoredClineOAuthBlob
      if (
        (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0)
        || (typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0)
      ) {
        return parsed
      }
      return null
    } catch {
      const tokenHint = this._oauthTokenHint(providerHint)
      return tokenHint ? { accessToken: tokenHint } : null
    }
  }

  private async _resolveAuth(providerHint?: string): Promise<ClineAuthSession | null> {
    const oauth = await this._getValidOAuthToken(providerHint)
    if (!oauth) return null
    return { token: oauth }
  }

  private async _getValidOAuthToken(providerHint?: string): Promise<string | null> {
    const storageKey = this._oauthStorageKey(providerHint)
    const stored = this._peekStoredOAuthCredential(providerHint)
    if (!stored) return null

    const accessToken = typeof stored.accessToken === 'string' ? stored.accessToken : null
    const refreshToken = typeof stored.refreshToken === 'string' ? stored.refreshToken : null
    const expiresAt = typeof stored.expiresAt === 'number' ? stored.expiresAt : null
    const needsRefresh = !accessToken || (expiresAt !== null && Date.now() > expiresAt - CLINE_REFRESH_BUFFER_MS)

    if (!needsRefresh) return accessToken
    if (!refreshToken) return accessToken

    if (!this.refreshInFlight.has(storageKey)) {
      const refreshPromise = refreshClineOAuth(refreshToken, this._oauthTarget(providerHint))
        .then((token) => {
          if (isClinePassProvider(providerHint)) {
            this.clinePassOAuthTokenHint = token
          } else {
            this.oauthTokenHint = token
          }
          return token
        })
        .catch(() => null)
        .finally(() => {
          this.refreshInFlight.delete(storageKey)
        })
      this.refreshInFlight.set(storageKey, refreshPromise)
    }

    const refreshed = await this.refreshInFlight.get(storageKey)!
    if (refreshed) return refreshed

    const currentStillValid = accessToken && (
      expiresAt === null || Date.now() <= expiresAt
    )
    return currentStillValid ? accessToken : null
  }

  private _oauthStorageKey(providerHint?: string): string {
    return isClinePassProvider(providerHint) ? 'clinepass_oauth' : 'cline_oauth'
  }

  private _oauthTarget(providerHint?: string): 'auth' | 'pass' {
    return isClinePassProvider(providerHint) ? 'pass' : 'auth'
  }

  private _oauthTokenHint(providerHint?: string): string | null {
    return isClinePassProvider(providerHint)
      ? this.clinePassOAuthTokenHint
      : this.oauthTokenHint
  }

  private _authDisplayName(providerHint?: string): string {
    return isClinePassProvider(providerHint) ? CLINE_PASS_LABEL : 'Cline'
  }

  private _apiRoot(providerHint?: string): string {
    return `${this._apiBase(providerHint)}/api/v1`
  }

  private _apiBase(providerHint?: string): string {
    const baseUrl = getProviderBaseUrl(
      isClinePassProvider(providerHint) ? 'clinepass' : 'cline',
    ).replace(/\/+$/, '')
    return baseUrl
      .replace(/\/api\/v1$/i, '')
      .replace(/\/v1$/i, '')
  }
}

function normalizeClineModelId(id: string): string {
  return id.toLowerCase().replace(/[._]/g, '-')
}

function promptCacheKey(model: string): string {
  return stripClineEffortVariant(model).trim().toLowerCase()
}

function catalogTtl(snapshot: ClineCatalogSnapshot): number {
  return snapshot.complete ? CLINE_CATALOG_TTL_MS : CLINE_PARTIAL_CATALOG_TTL_MS
}

async function fetchClineJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(CLINE_CATALOG_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** `promise`'s value, or null once `ms` pass or `signal` aborts. */
async function waitAtMost<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const giveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    if (!signal) return
    if (signal.aborted) {
      resolve(null)
      return
    }
    onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, giveUp])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function rawClineModelSupportsReasoning(model: RawClineModelInfo): boolean {
  if (
    model.supportsReasoning === true
    || model.supportsThinking === true
    || model.supports_reasoning === true
    || model.supports_thinking === true
    || model.model_info?.supportsReasoning === true
    || model.model_info?.supportsThinking === true
    || model.model_info?.supports_reasoning === true
  ) {
    return true
  }

  const capabilities = [
    ...(model.capabilities ?? []),
    ...(model.model_info?.capabilities ?? []),
  ].map(capability => capability.toLowerCase())

  return capabilities.includes('reasoning') || capabilities.includes('thinking')
}

function recommendedEntryToModel(entry: ClineFeedEntry): ModelInfo | null {
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter(tag => tag === 'thinking' || tag === 'reasoning')
    : []
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
    ...(tags.length > 0 && { tags }),
  }
}

function mergeClineTags(
  ...tagGroups: Array<readonly string[] | undefined>
): string[] {
  const merged = new Set<string>()
  for (const group of tagGroups) {
    if (!group) continue
    for (const tag of group) {
      merged.add(tag)
    }
  }
  return Array.from(merged)
}

function mergeClineModelInfo(left: ModelInfo, right: ModelInfo): ModelInfo {
  const tags = new Set<string>([
    ...(left.tags ?? []),
    ...(right.tags ?? []),
  ])
  return {
    ...left,
    ...right,
    name: right.name && right.name !== right.id ? right.name : left.name,
    contextWindow: right.contextWindow ?? left.contextWindow,
    supportsToolCalling: right.supportsToolCalling ?? left.supportsToolCalling,
    tags: tags.size > 0 ? [...tags] : undefined,
  }
}

function isLikelyLatestClineModel(normalizedId: string): boolean {
  return (
    normalizedId.includes('gpt-5-4')
    || normalizedId.includes('gpt-5-5')
    || normalizedId.includes('gpt-5-3')
    || normalizedId.includes('gpt-5-codex')
    || normalizedId.includes('claude-opus-4-8')
    || normalizedId.includes('claude-sonnet-4-6')
    || normalizedId.includes('claude-opus-4-7')
    || normalizedId.includes('claude-opus-4-6')
    || normalizedId.includes('gemini-3-1')
    || normalizedId.includes('glm-5')
    || normalizedId.includes('deepseek-v3-1')
    || normalizedId.includes('minimax-m2-7')
    || normalizedId.includes('kimi-k2-6')
    || normalizedId.includes('kimi-k2-5')
    || normalizedId.includes('0905')
  )
}

function isLikelyValueClineModel(normalizedId: string): boolean {
  return (
    normalizedId.includes(':exacto')
    || normalizedId.includes('qwen3-coder')
    || normalizedId.includes('minimax-m2-7')
    || normalizedId.includes('kimi-k2-6')
    || normalizedId.includes('kimi-k2')
    || normalizedId.includes('glm-4-6')
    || normalizedId.includes('deepseek-chat')
    || normalizedId.includes('deepseek-v3-1')
    || normalizedId.includes('flash-lite')
    || normalizedId.includes('flash')
    || normalizedId.includes('mini')
    || normalizedId.includes('haiku')
    || normalizedId.includes('kat-coder')
    || normalizedId.includes('grok-code-fast')
  )
}

function scoreClineModel(
  model: ModelInfo,
  recommendedIds: Set<string>,
  useFallbackSignals: boolean,
): number {
  const normalizedId = normalizeClineModelId(model.id)
  let score = 0

  if (
    recommendedIds.has(normalizedId)
    || (useFallbackSignals && CLINE_FALLBACK_RECOMMENDED_MODEL_IDS.has(normalizedId))
  ) {
    score += 20_000
  }
  // Free through the API itself: zero price in the billed catalog.
  if (model.tags?.includes('free')) {
    score += 10_000
  }
  if (CLINE_LATEST_MODEL_IDS.has(normalizedId) || isLikelyLatestClineModel(normalizedId)) {
    score += 4_000
  }
  if (CLINE_VALUE_MODEL_IDS.has(normalizedId) || isLikelyValueClineModel(normalizedId)) {
    score += 3_000
  }
  if (model.supportsToolCalling) {
    score += 200
  }

  const contextWindow = model.contextWindow ?? 0
  if (contextWindow >= 1_000_000) score += 80
  else if (contextWindow >= 200_000) score += 40

  return score
}

function getClineModelTags(
  modelId: string,
  recommendedIds: Set<string>,
  useFallbackSignals: boolean,
): string[] | undefined {
  const normalizedId = normalizeClineModelId(modelId)
  if (
    recommendedIds.has(normalizedId)
    || (useFallbackSignals && CLINE_FALLBACK_RECOMMENDED_MODEL_IDS.has(normalizedId))
  ) {
    return ['recommended']
  }
  return undefined
}

function clineBearerToken(token: string): string {
  return token.toLowerCase().startsWith('workos:') ? token : `workos:${token}`
}

/** models.dev's answer where it describes the model; the id check otherwise. */
function clineModelReasons(model: string): boolean {
  return getClineModelMeta(model)?.reasoning ?? isClineThinkingModel(model)
}

/**
 * Only genuine OpenAI models enforce OpenAI strict-mode constrained decoding
 * server-side. The Cline gateway proxies `openai/*` straight through to
 * OpenAI, so the all-required + nullable strict shaping is both honest and
 * enforced there. Every other upstream on Cline (Claude, Gemini, MiniMax,
 * GLM, Kimi, Qwen, DeepSeek, Grok, Kwaipilot, …) ignores `strict`; shaping
 * their tool schemas for strict just promotes optional fields to "required"
 * with nothing enforcing it, which drives weak models toward empty/garbage
 * tool calls. Gate strict to the OpenAI family; everyone else gets the
 * truthful wire schema. Mirrors codex (always real OpenAI → always strict)
 * and the compat lane's per-provider `supportsStrictMode()`.
 */
function clineModelHonorsOpenAIStrict(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    normalized.startsWith('openai/')
    || normalized.includes('gpt-4')
    || normalized.includes('gpt-5')
  )
}

function hasStrictClineTools(tools: OpenAITool[]): boolean {
  return tools.some(tool => tool.function.strict === true)
}

function isClineStrictToolSchemaRejected(errText: string): boolean {
  const lowered = errText.toLowerCase()
  return (
    lowered.includes('strict')
    || lowered.includes('additionalproperties')
    || lowered.includes('additional properties')
    || lowered.includes('nullable')
    || lowered.includes('schema')
  )
}

function blankUsage(): NormalizedUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    thinking_tokens: 0,
  }
}

async function* emitHttpFailure(
  response: Response,
  model: string,
): AsyncGenerator<AnthropicStreamEvent, void> {
  const errText = await response.text().catch(() => '')
  throwRetryableProviderHttpError('cline', response, errText)
  yield* emitErrorTurn(describeClineError({ status: response.status, body: errText, model }))
}

function* emitStreamFailure(
  failure: ClineStreamFailure,
  model: string,
): Generator<AnthropicStreamEvent, void> {
  if (failure.kind === 'empty') {
    yield* emitErrorTurn(describeEmptyClineResponse(model, failure.raw))
    return
  }
  if (failure.status !== undefined) {
    // Nothing from this response has been yielded, so the shared retry loop
    // can resend a retryable failure without duplicating output.
    throwRetryableProviderHttpError(
      'cline',
      { status: failure.status, headers: new Headers() },
      failure.raw,
    )
  }
  yield* emitErrorTurn(describeClineError({
    status: failure.status,
    body: failure.raw || failure.message,
    model,
  }))
}

function* emitErrorTurn(text: string): Generator<AnthropicStreamEvent, void> {
  yield {
    type: 'message_start',
    message: {
      id: `cline-error-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'cline',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  yield { type: 'content_block_stop', index: 0 }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
  yield { type: 'message_stop' }
}

export const clineLane = new ClineLane()
