/**
 * Cline Lane
 *
 * Native transport for Cline's own gateway:
 *   - chat:   POST /api/v1/chat/completions
 *   - models: GET  /api/v1/ai/cline/models
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
import {
  openAIStreamToAnthropicEvents,
  type OpenAIChatCompletionChunk,
} from '../../services/api/adapters/openai_to_anthropic.js'
import { getProviderBaseUrl } from '../../utils/auth.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'
import { refreshClineOAuth } from '../../services/api/auth/oauth_services.js'
import {
  OPENAI_COMPAT_TOOL_USAGE_RULES,
} from '../shared/mcp_bridge.js'
import {
  applyClineReasoningToRequest,
  getClineRequestEffort,
  isClineThinkingModel,
} from '../../utils/model/clineThinking.js'
import { buildClineToolsForRequest } from './tools.js'

interface StoredClineOAuthBlob {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

interface ClineAuthSession {
  token: string
}

interface RawClineModelInfo {
  id?: string
  name?: string
  description?: string | null
  supportsReasoning?: boolean | null
  supportsThinking?: boolean | null
  supports_reasoning?: boolean | null
  supports_thinking?: boolean | null
  capabilities?: string[] | null
  model_info?: {
    supports_reasoning?: boolean | null
    supportsThinking?: boolean | null
    supportsReasoning?: boolean | null
    capabilities?: string[] | null
  } | null
  context_length?: number | null
  top_provider?: {
    context_length?: number | null
    max_completion_tokens?: number | null
  } | null
  architecture?: {
    modality?: string | string[] | null
    input_modalities?: string[] | null
    output_modalities?: string[] | null
  } | null
  supported_parameters?: string[] | null
}

interface RecommendedModelEntry {
  id?: string
  name?: string
  tags?: string[]
  description?: string
}

interface RecommendedModelResponse {
  recommended?: RecommendedModelEntry[]
  free?: RecommendedModelEntry[]
}

interface ClineModelsResponse {
  data?: RawClineModelInfo[]
  models?: RawClineModelInfo[]
}

const CLINE_MODELS_CACHE_TTL_MS = 5 * 60_000
const CLINE_REFRESH_BUFFER_MS = 5 * 60_000
const CLINE_CONTEXT_EXCEEDED_MARKERS = [
  'context length',
  'context_length_exceeded',
  'prompt is too long',
  'maximum context',
]

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

const CLINE_FALLBACK_FREE_MODEL_IDS = new Set([
  'kwaipilot/kat-coder-pro',
  'moonshotai/kimi-k2.6',
  'minimax/minimax-m2.5',
  'arcee-ai/trinity-large-preview:free',
  'z-ai/glm-5',
].map(normalizeClineModelId))

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
  private modelCache: { models: ModelInfo[]; at: number } | null = null
  private reasoningModelIds = new Set<string>()
  private refreshInFlight: Promise<string | null> | null = null

  configure(opts: { oauthToken?: string | null }): void {
    if (opts.oauthToken !== undefined) this.oauthTokenHint = opts.oauthToken || null
  }

  invalidateModelCache(): void {
    this.modelCache = null
  }

  supportsModel(_model: string): boolean {
    // Cline's catalog overlaps other providers' ids. Provider-scoped routing
    // from providerShim is the only authoritative selector for this lane.
    return false
  }

  isHealthy(): boolean {
    return !!this._peekStoredOAuthCredential()
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

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < CLINE_MODELS_CACHE_TTL_MS) {
      return this.modelCache.models
    }

    const apiRoot = this._apiRoot()
    const auth = await this._resolveAuth().catch(() => null)
    const discoveryHeaders = this._buildDiscoveryHeaders(auth)
    const [modelsResult, recommendedResult] = await Promise.allSettled([
      fetch(`${apiRoot}/ai/cline/models`, {
        method: 'GET',
        headers: discoveryHeaders,
      }),
      fetch(`${apiRoot}/ai/cline/recommended-models`, {
        method: 'GET',
        headers: discoveryHeaders,
      }),
    ])

    const recommendedIds = new Set<string>()
    const freeIds = new Set<string>()
    const recommendedModels: ModelInfo[] = []

    if (recommendedResult.status === 'fulfilled' && recommendedResult.value.ok) {
      try {
        const payload = await recommendedResult.value.json() as RecommendedModelResponse
        for (const entry of payload.recommended ?? []) {
          const model = recommendedEntryToModel(entry)
          if (model) {
            recommendedIds.add(model.id)
            recommendedModels.push(model)
          }
        }
        for (const entry of payload.free ?? []) {
          const model = recommendedEntryToModel(entry)
          if (model) {
            freeIds.add(model.id)
            recommendedModels.push(model)
          }
        }
      } catch {
        // Ignore recommended-model parse failures and keep the base catalog.
      }
    }

    let models: ModelInfo[] = []
    if (modelsResult.status === 'fulfilled' && modelsResult.value.ok) {
      try {
        const payload = await modelsResult.value.json() as ClineModelsResponse
        models = extractClineModelData(payload)
          .filter((model): model is RawClineModelInfo & { id: string } =>
            typeof model.id === 'string' && model.id.length > 0,
          )
          .map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            contextWindow: model.context_length ?? model.top_provider?.context_length ?? undefined,
            supportsToolCalling: (
              Array.isArray(model.supported_parameters)
              ? model.supported_parameters.includes('tools') || model.supported_parameters.includes('tool_choice')
              : true
            ),
            tags: rawClineModelSupportsReasoning(model) ? ['thinking'] : undefined,
          }))
      } catch {
        models = []
      }
    }

    models.push(...recommendedModels)

    if (models.length === 0) {
      models = [...CLINE_FALLBACK_MODELS]
    }

    models = this._curateModels(models, recommendedIds, freeIds)
    this.reasoningModelIds = new Set(
      models
        .filter(model => model.tags?.some(tag => tag === 'thinking' || tag === 'reasoning'))
        .map(model => normalizeClineModelId(model.id)),
    )

    this.modelCache = { models, at: Date.now() }
    return models
  }

  private _curateModels(
    models: ModelInfo[],
    recommendedIds: Set<string>,
    freeIds: Set<string>,
  ): ModelInfo[] {
    const normalizedRecommended = new Set(
      [...recommendedIds].map((id) => normalizeClineModelId(id)),
    )
    const normalizedFree = new Set(
      [...freeIds].map((id) => normalizeClineModelId(id)),
    )
    const useFallbackSignals = normalizedRecommended.size === 0 && normalizedFree.size === 0

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
        scoreClineModel(right, normalizedRecommended, normalizedFree, useFallbackSignals)
        - scoreClineModel(left, normalizedRecommended, normalizedFree, useFallbackSignals)
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
          getClineModelTags(model.id, normalizedRecommended, normalizedFree, useFallbackSignals),
          clineModelSupportsReasoning(model.id) ? ['thinking'] : undefined,
        )
        return tags.length > 0 ? { ...model, tags } : model
      })
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const auth = await this._resolveAuth()
    if (!auth) {
      throw new Error('Cline lane: not authenticated. Run `/login cline` to authenticate.')
    }

    const preserveCacheControl = this._supportsPromptCache(params.model)
    const system = this._prependToolUsageRules(params.system, params.tools.length > 0)
    const messages = anthropicMessagesToOpenAI(
      params.messages,
      system,
      { preserveCacheControl },
    )
    const tools = this._buildTools(params.tools)
    const body = this._buildRequestBody({
      model: params.model,
      messages,
      tools,
      maxTokens: params.max_tokens,
      temperature: params.temperature,
      stopSequences: params.stop_sequences,
      thinking: params.thinking,
    })

    let response: Response
    try {
      response = await fetch(`${this._apiRoot()}/chat/completions`, {
        method: 'POST',
        headers: this._buildHeaders(auth),
        body: JSON.stringify(body),
        signal: params.signal,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      yield* emitErrorTurn(`cline API connection error: ${message}`)
      return blankUsage()
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      const lowered = errText.toLowerCase()
      const isPromptTooLong = CLINE_CONTEXT_EXCEEDED_MARKERS.some((marker) => lowered.includes(marker))
      const headline = isPromptTooLong
        ? `Prompt is too long (cline ${response.status})`
        : `cline API error ${response.status}`
      yield* emitErrorTurn(`${headline}: ${errText.slice(0, 500)}`)
      return blankUsage()
    }

    if (!response.body) {
      throw new Error('Cline lane: empty response body')
    }

    let finalUsage = blankUsage()
    const chunkStream = this._normalizeChunkStream(this._parseSSE(response.body))

    for await (const event of openAIStreamToAnthropicEvents(chunkStream)) {
      if (event.type === 'message_delta' && event.usage) {
        finalUsage = {
          input_tokens: event.usage.input_tokens ?? finalUsage.input_tokens,
          output_tokens: event.usage.output_tokens ?? finalUsage.output_tokens,
          cache_read_tokens: event.usage.cache_read_input_tokens ?? finalUsage.cache_read_tokens,
          cache_write_tokens: event.usage.cache_creation_input_tokens ?? finalUsage.cache_write_tokens,
          thinking_tokens: 0,
        }
      }
      yield event
    }

    return finalUsage
  }

  private _buildTools(tools: LaneProviderCallParams['tools']): OpenAITool[] {
    return buildClineToolsForRequest(tools)
  }

  private _buildRequestBody(opts: {
    model: string
    messages: OpenAIMessage[]
    tools: OpenAITool[]
    maxTokens: number
    temperature?: number
    stopSequences?: string[]
    thinking?: LaneProviderCallParams['thinking']
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: opts.maxTokens,
      ...(opts.tools.length > 0 && {
        tools: opts.tools,
        tool_choice: 'auto',
      }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.stopSequences && opts.stopSequences.length > 0 && { stop: opts.stopSequences }),
    }

    if (this._modelSupportsReasoning(opts.model)) {
      applyClineReasoningToRequest(body, getClineRequestEffort(opts.model))
    }

    return body
  }

  private _modelSupportsReasoning(model: string): boolean {
    return (
      this.reasoningModelIds.has(normalizeClineModelId(model))
      || clineModelSupportsReasoning(model)
    )
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

  private _buildHeaders(auth: ClineAuthSession): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'HTTP-Referer': 'https://github.com/AbdoKnbGit/tau',
      'X-Title': 'Tau',
    }

    const workosToken = clineBearerToken(auth.token)
    headers.Authorization = `Bearer ${workosToken}`
    headers.workos = workosToken
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

  private _supportsPromptCache(model: string): boolean {
    const normalized = model.toLowerCase()
    return (
      normalized.startsWith('anthropic/')
      || normalized.startsWith('openai/')
      || normalized.startsWith('google/')
      || normalized.includes('claude-')
      || normalized.includes('gemini-')
      || normalized.includes('gpt-5')
    )
  }

  private _peekStoredOAuthCredential(): StoredClineOAuthBlob | null {
    try {
      const raw = loadProviderKey('cline_oauth')
      if (!raw) {
        if (this.oauthTokenHint) return { accessToken: this.oauthTokenHint }
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
      return this.oauthTokenHint ? { accessToken: this.oauthTokenHint } : null
    }
  }

  private async _resolveAuth(): Promise<ClineAuthSession | null> {
    const oauth = await this._getValidOAuthToken()
    if (!oauth) return null
    return { token: oauth }
  }

  private async _getValidOAuthToken(): Promise<string | null> {
    const stored = this._peekStoredOAuthCredential()
    if (!stored) return null

    const accessToken = typeof stored.accessToken === 'string' ? stored.accessToken : null
    const refreshToken = typeof stored.refreshToken === 'string' ? stored.refreshToken : null
    const expiresAt = typeof stored.expiresAt === 'number' ? stored.expiresAt : null
    const needsRefresh = !accessToken || (expiresAt !== null && Date.now() > expiresAt - CLINE_REFRESH_BUFFER_MS)

    if (!needsRefresh) return accessToken
    if (!refreshToken) return accessToken

    if (!this.refreshInFlight) {
      this.refreshInFlight = refreshClineOAuth(refreshToken)
        .then((token) => {
          this.oauthTokenHint = token
          return token
        })
        .catch(() => null)
        .finally(() => {
          this.refreshInFlight = null
        })
    }

    const refreshed = await this.refreshInFlight
    if (refreshed) return refreshed

    const currentStillValid = accessToken && (
      expiresAt === null || Date.now() <= expiresAt
    )
    return currentStillValid ? accessToken : null
  }

  private _apiRoot(): string {
    return `${this._apiBase()}/api/v1`
  }

  private _apiBase(): string {
    const baseUrl = getProviderBaseUrl('cline').replace(/\/+$/, '')
    return baseUrl
      .replace(/\/api\/v1$/i, '')
      .replace(/\/v1$/i, '')
  }

  private async *_parseSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<OpenAIChatCompletionChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            yield JSON.parse(payload) as OpenAIChatCompletionChunk
          } catch {
            // Ignore malformed chunks and keep draining the stream.
          }
        }
      }

      const trailing = buffer.trim()
      if (trailing.startsWith('data:')) {
        const payload = trailing.slice(5).trim()
        if (payload && payload !== '[DONE]') {
          try {
            yield JSON.parse(payload) as OpenAIChatCompletionChunk
          } catch {
            // Ignore malformed trailing chunks.
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async *_normalizeChunkStream(
    chunks: AsyncIterable<OpenAIChatCompletionChunk>,
  ): AsyncGenerator<OpenAIChatCompletionChunk> {
    for await (const chunk of chunks) {
      const choices = Array.isArray(chunk.choices)
        ? chunk.choices.map((choice) => {
          const delta = { ...(choice.delta ?? {}) } as OpenAIChatCompletionChunk['choices'][number]['delta'] & {
            reasoning?: string
          }
          if (typeof delta.reasoning === 'string' && !delta.reasoning_content) {
            delta.reasoning_content = delta.reasoning
          }
          return { ...choice, delta }
        })
        : chunk.choices

      yield { ...chunk, choices }
    }
  }
}

function normalizeClineModelId(id: string): string {
  return id.toLowerCase().replace(/[._]/g, '-')
}

function extractClineModelData(payload: unknown): RawClineModelInfo[] {
  if (Array.isArray(payload)) return payload as RawClineModelInfo[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as ClineModelsResponse
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  return []
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

function recommendedEntryToModel(entry: RecommendedModelEntry): ModelInfo | null {
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
  freeIds: Set<string>,
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
  if (
    freeIds.has(normalizedId)
    || (useFallbackSignals && CLINE_FALLBACK_FREE_MODEL_IDS.has(normalizedId))
  ) {
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
  freeIds: Set<string>,
  useFallbackSignals: boolean,
): string[] | undefined {
  const normalizedId = normalizeClineModelId(modelId)
  const tags: string[] = []
  if (
    recommendedIds.has(normalizedId)
    || (useFallbackSignals && CLINE_FALLBACK_RECOMMENDED_MODEL_IDS.has(normalizedId))
  ) {
    tags.push('recommended')
  }
  if (
    freeIds.has(normalizedId)
    || (useFallbackSignals && CLINE_FALLBACK_FREE_MODEL_IDS.has(normalizedId))
  ) {
    tags.push('free')
  }

  return tags.length > 0 ? tags : undefined
}

function clineBearerToken(token: string): string {
  return token.toLowerCase().startsWith('workos:') ? token : `workos:${token}`
}

function clineModelSupportsReasoning(model: string): boolean {
  return isClineThinkingModel(model)
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
