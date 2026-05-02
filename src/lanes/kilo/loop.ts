/**
 * Kilo Lane
 *
 * Native transport for the Kilo Gateway (https://api.kilo.ai).
 *
 * Wire format — OpenAI chat completions with OpenRouter extensions. Kilo
 * fronts an OpenRouter-compatible aggregator, so Claude/Gemini/OpenAI
 * models keep their native cache semantics (`cache_control: {type:
 * ephemeral}` is passed through untouched).
 *
 *   - chat:     POST  https://api.kilo.ai/api/openrouter/chat/completions
 *   - models:   GET   https://api.kilo.ai/api/openrouter/models                  (personal)
 *               GET   https://api.kilo.ai/api/organizations/<orgId>/models       (org)
 *   - defaults: GET   https://api.kilo.ai/api/defaults | /api/organizations/<orgId>/defaults
 *
 * NB: the kilo-gateway OSS repo (packages/kilo-gateway/src/provider.ts) builds
 * the SDK baseURL as `${KILO_API_BASE}/openrouter/` (no `/api/`), which 404s
 * against the live gateway. 9router's probed config at
 * reference/9router-master/open-sse/config/providers.js:213 has the
 * authoritative URL — `/api/openrouter/chat/completions`.
 *
 * Auth — long-lived bearer (1 year) issued by the device-auth flow in
 * services/api/auth/oauth_services.ts::startKiloCodeOAuth. No refresh
 * endpoint; on 401 we surface a `/login kilocode` prompt.
 *
 * Headers mirror the native Kilo CLI (packages/kilo-gateway/src/headers.ts):
 * editor name, feature tag, organization id. Organization scoping for
 * chat is header-only — the chat URL never changes per org.
 *
 * Subscription-aware visibility — `/api/openrouter/models` returns the
 * catalog the user's plan is entitled to. We additionally filter out
 * image-only models and models that don't advertise `tools` support,
 * matching the native Kilo CLI's kilo-gateway/src/api/models.ts filter.
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
  anthropicToolsToOpenAI,
  type OpenAIMessage,
  type OpenAITool,
} from '../../services/api/adapters/anthropic_to_openai.js'
import {
  openAIStreamToAnthropicEvents,
  type OpenAIChatCompletionChunk,
} from '../../services/api/adapters/openai_to_anthropic.js'
import { loadProviderKey } from '../../services/api/auth/api_key_manager.js'
import {
  OPENAI_COMPAT_TOOL_USAGE_RULES,
  appendStrictParamsHint,
} from '../shared/mcp_bridge.js'
import {
  KILO_FALLBACK_MODELS,
  KILO_FALLBACK_FREE_IDS,
} from './catalog.js'
import { applyKiloCacheBreakpoints } from './cache.js'
import {
  kiloToolCallKey,
  normalizeKiloToolCallArgumentString,
  parseKiloToolCallKey,
  tryNormalizeKiloToolCallArgumentString,
} from './tool_args.js'

const KILO_API_BASE = 'https://api.kilo.ai'
const KILO_MODEL_LIST_LIMIT = 40
const KILO_MODELS_CACHE_TTL_MS = 5 * 60_000
const KILO_CONTEXT_EXCEEDED_MARKERS = [
  'context length',
  'context_length_exceeded',
  'prompt is too long',
  'maximum context',
  'too long',
]

const KILO_TOOL_USAGE_RULES = `${OPENAI_COMPAT_TOOL_USAGE_RULES}
<kilocode_tool_quirks>
KiloCode must call the tools using the schema names shown in this session, not aliases remembered from other coding CLIs:
- AskUserQuestion.questions must be an array of question objects, not a JSON string.
- Edit, Read, and Write use file_path for the file path.
- TaskGet.taskId must come from a current TaskList or TaskCreate result; do not guess stale task IDs.
</kilocode_tool_quirks>
`

/** `X-KILOCODE-EDITORNAME` — matches Kilo CLI's DEFAULT_EDITOR_NAME path. */
const KILO_EDITOR_NAME = 'Tau'
/** `User-Agent` base — kilo-gateway/src/headers.ts::getUserAgent. */
const KILO_USER_AGENT = 'claudex-kilo-provider'

interface StoredKiloOAuthBlob {
  accessToken?: string
  meta?: {
    email?: string
    orgId?: string | null
  }
}

interface KiloAuthSession {
  token: string
  orgId: string | null
}

interface RawKiloModelInfo {
  id?: string
  name?: string
  description?: string
  context_length?: number | null
  max_completion_tokens?: number | null
  top_provider?: {
    max_completion_tokens?: number | null
    context_length?: number | null
  } | null
  supported_parameters?: string[] | null
  architecture?: {
    input_modalities?: string[] | null
    output_modalities?: string[] | null
  } | null
  pricing?: {
    prompt?: string | null
    completion?: string | null
    input_cache_read?: string | null
    input_cache_write?: string | null
  } | null
  isFree?: boolean
  preferredIndex?: number
}

interface KiloModelsResponse {
  data?: RawKiloModelInfo[]
}

interface KiloDefaultsResponse {
  defaultModel?: string
  defaultFreeModel?: string
}

export class KiloLane implements Lane {
  readonly name = 'kilo'
  readonly displayName = 'Kilo Code'

  private tokenHint: string | null = null
  private orgIdHint: string | null = null
  private modelCache: { models: ModelInfo[]; at: number } | null = null
  private defaultModelCache: { id: string; at: number } | null = null

  configure(opts: { accessToken?: string | null; orgId?: string | null }): void {
    if (opts.accessToken !== undefined) this.tokenHint = opts.accessToken || null
    if (opts.orgId !== undefined) this.orgIdHint = opts.orgId || null
  }

  invalidateModelCache(): void {
    this.modelCache = null
    this.defaultModelCache = null
  }

  // Kilo's catalog shares ids with Anthropic/OpenAI/Gemini/OpenRouter (it
  // IS an OpenRouter aggregator). Model-heuristic dispatch would collide;
  // providerShim routes `kilocode` here explicitly instead.
  supportsModel(_model: string): boolean {
    return false
  }

  isHealthy(): boolean {
    return !!this._peekStored()
  }

  resolveModel(model: string): string {
    return model
  }

  dispose(): void {}

  async *run(_context: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    throw new Error(
      'KiloLane.run (lane-owns-loop) is not wired yet — use streamAsProvider via LaneBackedProvider.',
    )
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < KILO_MODELS_CACHE_TTL_MS) {
      return this.modelCache.models
    }

    const auth = this._peekStored()
    // A healthy lane path always has auth (providerShim gates on
    // isHealthy()). We still fall back to the public models URL when
    // auth is absent so /models works during transient credential loss.
    const modelsURL = auth?.orgId
      ? `${KILO_API_BASE}/api/organizations/${auth.orgId}/models`
      : `${KILO_API_BASE}/api/openrouter/models`

    let rawModels: RawKiloModelInfo[] = []
    try {
      const response = await fetch(modelsURL, {
        method: 'GET',
        headers: this._buildDiscoveryHeaders(auth),
        signal: AbortSignal.timeout(10_000),
      })

      if (response.ok) {
        const payload = await response.json() as KiloModelsResponse
        rawModels = Array.isArray(payload.data) ? payload.data : []
      }
    } catch {
      // Fall through to the curated fallback below.
    }

    let models = rawModels
      .filter((m): m is RawKiloModelInfo & { id: string } => typeof m.id === 'string' && m.id.length > 0)
      // Kilo CLI's kilo-gateway/src/api/models.ts filter: skip image-only
      // and skip models that don't advertise tool support. Chat work
      // needs tool calling; image-gen models would break the agent loop.
      .filter((m) => !(m.architecture?.output_modalities?.includes('image')))
      .filter((m) => {
        const sp = m.supported_parameters
        if (!Array.isArray(sp)) return true
        return sp.includes('tools') || sp.includes('tool_choice')
      })
      .map<ModelInfo>((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.context_length ?? m.top_provider?.context_length ?? undefined,
        supportsToolCalling: true,
        tags: kiloModelTags(m),
      }))

    if (models.length === 0) {
      models = KILO_FALLBACK_MODELS.map((m) => ({
        ...m,
        supportsToolCalling: true,
        tags: KILO_FALLBACK_FREE_IDS.has(m.id.toLowerCase()) ? ['free'] : undefined,
      }))
    }

    models = this._curateModels(models, rawModels)
    this.modelCache = { models, at: Date.now() }
    return models
  }

  smallFastModel(): string | null {
    // The live /api/defaults endpoint would be preferable but the Lane
    // interface declares this sync. We opportunistically return the
    // cached default when _getDefaultModelId() has run, else fall back
    // to Kilo's kilo-auto/free (if the plan exposes it) or Claude Haiku.
    if (this.defaultModelCache) return this.defaultModelCache.id
    // Kick off a background refresh so subsequent calls get the real value.
    void this._getDefaultModelId().catch(() => undefined)
    return 'anthropic/claude-haiku-4.5'
  }

  async *streamAsProvider(
    params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    const auth = this._peekStored()
    if (!auth) {
      throw new Error('Kilo lane: not authenticated. Run `/login kilocode` to authenticate.')
    }

    const preserveCacheControl = this._supportsPromptCache(params.model)
    const system = this._prependToolUsageRules(params.system, params.tools.length > 0)
    const messages = anthropicMessagesToOpenAI(
      params.messages,
      system,
      { preserveCacheControl },
    )
    // Re-inject Kilo's prompt-cache breakpoints after the shared adapter
    // has flattened plain user text. Keep rolling markers on user messages
    // only; Kilo tool results are OpenAI role:"tool" messages, and markers
    // on that role have proven unstable in tool-heavy loops.
    if (preserveCacheControl) {
      applyKiloCacheBreakpoints(messages)
    }
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
      response = await fetch(`${KILO_API_BASE}/api/openrouter/chat/completions`, {
        method: 'POST',
        headers: this._buildHeaders(auth),
        body: JSON.stringify(body),
        signal: params.signal,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      yield* emitErrorTurn(`kilo API connection error: ${message}`)
      return blankUsage()
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      const lowered = errText.toLowerCase()
      const isPromptTooLong = KILO_CONTEXT_EXCEEDED_MARKERS.some((marker) => lowered.includes(marker))
      const headline = isPromptTooLong
        ? `Prompt is too long (kilo ${response.status})`
        : response.status === 401 || response.status === 403
          ? `kilo auth error ${response.status} — run \`/login kilocode\``
          : `kilo API error ${response.status}`
      yield* emitErrorTurn(`${headline}: ${errText.slice(0, 500)}`)
      return blankUsage()
    }

    if (!response.body) {
      throw new Error('Kilo lane: empty response body')
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
    return anthropicToolsToOpenAI(tools).map((tool) => ({
      ...tool,
      function: {
        ...tool.function,
        description: appendStrictParamsHint(
          tool.function.description ?? '',
          tool.function.parameters,
        ),
      },
    }))
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
    const effort = resolveReasoningEffort(opts.thinking)
    // Kilo proxies OpenRouter, which caps max_tokens per-model. 8192 is a
    // safe upper bound for the chat path (matches the prior openai-compat
    // transformer clamp). Kilo-auto routes internally, no per-model cap.
    const capped = Math.min(opts.maxTokens, 8192)
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true },
      // OpenRouter-native detailed usage block — Kilo CLI sets this via
      // providerOptions.openrouter.usage.include. Surfaces cost plus
      // cache_discount and per-breakpoint hit counts in the final chunk
      // so billing reconciliation matches Kilo CLI's view.
      usage: { include: true },
      max_tokens: capped,
      ...(opts.tools.length > 0 && {
        tools: opts.tools,
        tool_choice: 'auto',
      }),
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.stopSequences && opts.stopSequences.length > 0 && { stop: opts.stopSequences }),
    }

    if (effort && kiloModelSupportsReasoning(opts.model)) {
      body.reasoning = { effort }
    }

    return body
  }

  private _prependToolUsageRules(
    system: string | SystemBlock[],
    hasTools: boolean,
  ): string | SystemBlock[] {
    if (!hasTools) return system
    if (typeof system === 'string') {
      return system
        ? `${KILO_TOOL_USAGE_RULES}\n${system}`
        : KILO_TOOL_USAGE_RULES
    }

    const blocks = [...system]
    if (blocks.length === 0) {
      return [{ type: 'text', text: KILO_TOOL_USAGE_RULES }]
    }

    const first = blocks[0] as SystemBlock & { cache_control?: { type: string } }
    return [
      { ...first, text: `${KILO_TOOL_USAGE_RULES}\n${first.text}` },
      ...blocks.slice(1),
    ]
  }

  private _buildHeaders(auth: KiloAuthSession): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': KILO_USER_AGENT,
      'HTTP-Referer': 'https://github.com/AbdoKnbGit/tau',
      'X-Title': 'Tau',
      // Kilo CLI-parity attribution headers — see kilo-gateway/src/headers.ts.
      'X-KILOCODE-EDITORNAME': KILO_EDITOR_NAME,
      Authorization: `Bearer ${auth.token}`,
    }
    if (auth.orgId) {
      headers['X-KILOCODE-ORGANIZATIONID'] = auth.orgId
    }
    const feature = process.env.KILOCODE_FEATURE
    if (feature) headers['X-KILOCODE-FEATURE'] = feature
    return headers
  }

  private _buildDiscoveryHeaders(auth: KiloAuthSession | null): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': KILO_USER_AGENT,
      'X-KILOCODE-EDITORNAME': KILO_EDITOR_NAME,
    }
    if (auth) {
      headers.Authorization = `Bearer ${auth.token}`
      if (auth.orgId) headers['X-KILOCODE-ORGANIZATIONID'] = auth.orgId
    }
    return headers
  }

  private _supportsPromptCache(model: string): boolean {
    const normalized = model.toLowerCase()
    return (
      normalized.startsWith('anthropic/')
      || normalized.startsWith('openai/')
      || normalized.startsWith('google/')
      // kilo-auto/* routes internally (kilo-auto/balanced → Claude
      // Sonnet, coder → Claude Opus, etc.). Missing this prefix meant
      // the default subscription model got no cache markers — the
      // exact billing-parity gap we care about here.
      || normalized.startsWith('kilo-auto/')
      || normalized.includes('claude-')
      || normalized.includes('gemini-')
      || normalized.includes('gpt-5')
    )
  }

  private _curateModels(models: ModelInfo[], raw: RawKiloModelInfo[]): ModelInfo[] {
    const rawById = new Map<string, RawKiloModelInfo>()
    for (const m of raw) {
      if (typeof m.id === 'string') rawById.set(m.id, m)
    }

    const unique = Array.from(new Map(models.map((m) => [m.id, m])).values())

    unique.sort((left, right) => {
      const scoreDiff = scoreKiloModel(right, rawById) - scoreKiloModel(left, rawById)
      if (scoreDiff !== 0) return scoreDiff

      const leftCtx = left.contextWindow ?? 0
      const rightCtx = right.contextWindow ?? 0
      if (leftCtx !== rightCtx) return rightCtx - leftCtx

      const leftName = (left.name ?? left.id).toLowerCase()
      const rightName = (right.name ?? right.id).toLowerCase()
      if (leftName !== rightName) return leftName.localeCompare(rightName)
      return left.id.localeCompare(right.id)
    })

    return unique.slice(0, KILO_MODEL_LIST_LIMIT)
  }

  private async _getDefaultModelId(): Promise<string | null> {
    if (this.defaultModelCache && Date.now() - this.defaultModelCache.at < KILO_MODELS_CACHE_TTL_MS) {
      return this.defaultModelCache.id
    }
    const auth = this._peekStored()
    const url = auth?.orgId
      ? `${KILO_API_BASE}/api/organizations/${auth.orgId}/defaults`
      : `${KILO_API_BASE}/api/defaults`
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this._buildDiscoveryHeaders(auth),
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return null
      const payload = await response.json() as KiloDefaultsResponse
      const id = auth ? payload.defaultModel : payload.defaultFreeModel
      if (typeof id === 'string' && id.length > 0) {
        this.defaultModelCache = { id, at: Date.now() }
        return id
      }
    } catch {
      // swallow — sensible fallback returned by caller.
    }
    return null
  }

  private _peekStored(): KiloAuthSession | null {
    try {
      const raw = loadProviderKey('kilocode_oauth')
      if (!raw) {
        return this.tokenHint
          ? { token: this.tokenHint, orgId: this.orgIdHint }
          : null
      }
      const parsed = JSON.parse(raw) as StoredKiloOAuthBlob
      const token = typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0
        ? parsed.accessToken
        : this.tokenHint
      if (!token) return null
      const orgId = (typeof parsed.meta?.orgId === 'string' && parsed.meta.orgId.length > 0)
        ? parsed.meta.orgId
        : this.orgIdHint
      return { token, orgId: orgId ?? null }
    } catch {
      return this.tokenHint ? { token: this.tokenHint, orgId: this.orgIdHint } : null
    }
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
    const pendingToolArgs = new Map<string, { name: string; args: string }>()

    for await (const chunk of chunks) {
      const choices = Array.isArray(chunk.choices)
        ? chunk.choices.map((choice) => {
          const delta = { ...(choice.delta ?? {}) } as OpenAIChatCompletionChunk['choices'][number]['delta'] & {
            reasoning?: string
          }
          const choiceIndex = typeof choice.index === 'number' ? choice.index : 0

          // OpenRouter-flavoured `delta.reasoning` → normalize to
          // `reasoning_content` so openAIStreamToAnthropicEvents picks it up.
          if (typeof delta.reasoning === 'string' && !delta.reasoning_content) {
            delta.reasoning_content = delta.reasoning
          }

          if (Array.isArray(delta.tool_calls)) {
            delta.tool_calls = delta.tool_calls.map((toolCall) => {
              const toolIndex = toolCall.index ?? 0
              const key = kiloToolCallKey(choiceIndex, toolIndex)
              const pending = pendingToolArgs.get(key) ?? { name: '', args: '' }
              const fn = toolCall.function ? { ...toolCall.function } : undefined

              if (fn?.name) pending.name = fn.name
              if (typeof fn?.arguments === 'string' && fn.arguments.length > 0) {
                pending.args += fn.arguments
                pendingToolArgs.set(key, pending)

                const normalized = pending.name
                  ? tryNormalizeKiloToolCallArgumentString(
                      pending.name,
                      pending.args,
                    )
                  : null
                if (normalized !== null) {
                  fn.arguments = normalized
                  pendingToolArgs.delete(key)
                } else {
                  delete fn.arguments
                }
              }

              return fn ? { ...toolCall, function: fn } : toolCall
            })
          }

          if (choice.finish_reason) {
            const injected: NonNullable<typeof delta.tool_calls> = []
            for (const [key, pending] of Array.from(pendingToolArgs.entries())) {
              const parsed = parseKiloToolCallKey(key)
              if (!parsed || parsed.choiceIndex !== choiceIndex) continue
              injected.push({
                index: parsed.toolIndex,
                function: {
                  arguments: normalizeKiloToolCallArgumentString(
                    pending.name,
                    pending.args,
                  ),
                },
              })
              pendingToolArgs.delete(key)
            }
            if (injected.length > 0) {
              delta.tool_calls = [...(delta.tool_calls ?? []), ...injected]
            }
          }

          return { ...choice, delta }
        })
        : chunk.choices

      yield { ...chunk, choices }
    }
  }
}

function resolveReasoningEffort(
  thinking: LaneProviderCallParams['thinking'] | undefined,
): 'low' | 'medium' | 'high' | undefined {
  if (!thinking || thinking.type === 'disabled') return undefined
  if (thinking.type === 'adaptive') return 'medium'
  const budget = (thinking as { budget_tokens?: number }).budget_tokens
  if (budget == null) return 'medium'
  if (budget < 2_000) return 'low'
  if (budget < 8_000) return 'medium'
  return 'high'
}

function kiloModelSupportsReasoning(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    normalized.includes('claude-sonnet-4')
    || normalized.includes('claude-opus-4')
    || normalized.includes('gemini-2.5')
    || normalized.includes('gemini-3')
    || normalized.startsWith('gpt-5')
    || normalized.includes('/gpt-5')
    || normalized.includes('/o1')
    || normalized.includes('/o3')
    || normalized.includes('/o4')
    || normalized.includes('deepseek-reasoner')
    || normalized.includes('deepseek-r1')
    || normalized.includes('thinking')
  )
}

function kiloModelTags(raw: RawKiloModelInfo): string[] | undefined {
  const tags: string[] = []
  const promptPrice = parsePrice(raw.pricing?.prompt)
  const completionPrice = parsePrice(raw.pricing?.completion)
  const isZero = (promptPrice === 0 || promptPrice === undefined)
    && (completionPrice === 0 || completionPrice === undefined)
  if (raw.isFree === true || isZero) tags.push('free')
  if (typeof raw.preferredIndex === 'number') tags.push('recommended')
  return tags.length > 0 ? tags : undefined
}

function parsePrice(price: string | null | undefined): number | undefined {
  if (price == null) return undefined
  const n = parseFloat(price)
  return Number.isFinite(n) ? n : undefined
}

function scoreKiloModel(
  model: ModelInfo,
  rawById: Map<string, RawKiloModelInfo>,
): number {
  let score = 0
  const raw = rawById.get(model.id)
  if (raw?.preferredIndex != null) {
    // Lower preferredIndex = higher priority; large base so it dominates.
    score += 10_000 - raw.preferredIndex
  }
  if (model.tags?.includes('free')) score += 5_000
  if (model.tags?.includes('recommended')) score += 2_000
  if (model.id.startsWith('kilo-auto/')) score += 1_500

  const ctx = model.contextWindow ?? 0
  if (ctx >= 1_000_000) score += 80
  else if (ctx >= 200_000) score += 40

  return score
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
      id: `kilo-error-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'kilo',
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

export const kiloLane = new KiloLane()
