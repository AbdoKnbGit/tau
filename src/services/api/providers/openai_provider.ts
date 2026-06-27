/**
 * OpenAI-compatible provider.
 *
 * Base class for all providers that implement the OpenAI Chat Completions API:
 * OpenAI, OpenRouter, Groq, NVIDIA NIM, DeepSeek, Ollama.
 *
 * Uses native fetch (no openai SDK dependency) for maximum portability.
 *
 * Payload optimization (enabled for all 3P providers):
 * Tau sends a massive system prompt (~8K tokens) + 40+ tool definitions
 * (~5K tokens) designed for Claude. Smaller open-source models choke on this,
 * causing 2-3 minute response times for trivial messages.
 *
 * This base class trims the payload:
 *   - Caps system prompt length
 *   - Limits tools to core essentials
 *   - Caps max_tokens to avoid over-reservation
 *
 * Configure via env vars:
 *   PROVIDER_MAX_TOKENS=4096      — max output tokens (default: 4096)
 *   PROVIDER_MAX_SYSTEM_CHARS=6000 — max system prompt chars (default: 6000)
 *   PROVIDER_NO_OPTIMIZE=true      — disable optimization (send full payload)
 */

import {
  BaseProvider,
  buildProviderStreamResult,
  type AnthropicMessage,
  type AnthropicStreamEvent,
  type ModelInfo,
  type ProviderConfig,
  type ProviderRequestParams,
  type ProviderStreamResult,
  type ProviderTool,
  type SystemBlock,
} from './base_provider.js'
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  coalesceConsecutiveMessages,
} from '../adapters/anthropic_to_openai.js'
import {
  openAIStreamToAnthropicEvents,
  openAIMessageToAnthropic,
  type OpenAIChatCompletion,
  type OpenAIChatCompletionChunk,
} from '../adapters/openai_to_anthropic.js'
import {
  anthropicToResponsesInput,
  anthropicToolsToResponsesTools,
  extractInstructions,
  responsesStreamToAnthropicEvents,
  responsesMessageToAnthropic,
  type ResponsesSSEEvent,
  type ResponsesApiResponse,
} from '../adapters/openai_responses.js'
import { getProviderModelSet } from '../../../utils/model/configs.js'
import {
  getOpenAIReasoningLevel,
  isReasoningLevelExplicit,
  modelSupportsReasoning,
  type OpenAIReasoningLevel,
} from '../../../utils/model/openaiReasoning.js'

// ─── Curated Codex model list (fallback) ──────────────────────────
// Used ONLY when the /v1/models fetch fails (e.g. OAuth token can't
// list models). GPT-5 models use the Responses API (/v1/responses).

const OPENAI_FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 272000,
    supportsToolCalling: true,
    tags: ['recommended', 'reasoning'],
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    contextWindow: 1050000,
    supportsToolCalling: true,
    tags: ['reasoning'],
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    contextWindow: 272000,
    supportsToolCalling: true,
    tags: ['fast', 'reasoning'],
  },
]

const OPENAI_SELECTABLE_MODEL_IDS = new Set(
  OPENAI_FALLBACK_MODELS.map(model => model.id),
)

function isSelectableOpenAIModel(modelId: string): boolean {
  return OPENAI_SELECTABLE_MODEL_IDS.has(modelId.toLowerCase())
}

function mergeOpenAIModels(apiModels: readonly ModelInfo[]): ModelInfo[] {
  const merged = new Map<string, ModelInfo>()
  for (const model of OPENAI_FALLBACK_MODELS) {
    merged.set(model.id, model)
  }
  for (const model of apiModels) {
    if (isSelectableOpenAIModel(model.id) && !merged.has(model.id)) {
      merged.set(model.id, model)
    }
  }
  return Array.from(merged.values())
}

// ─── Payload optimization constants ─────────────────────────────

/**
 * Core tools that 3P models actually need for coding assistance.
 * All other tools (Agent, MCP, TaskCreate, NotebookEdit, etc.) add
 * thousands of tokens to the payload without being useful to smaller models.
 */
const CORE_TOOL_NAMES = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoRead',
  'TodoWrite',
  'ToolSearch',
])

const DEFAULT_3P_MAX_TOKENS = 4096
const DEFAULT_3P_MAX_SYSTEM_CHARS = 6000

export class OpenAIProvider extends BaseProvider {
  readonly name: string = 'openai'
  protected apiKey: string
  protected baseUrl: string
  protected extraHeaders: Record<string, string>

  /** Whether to optimize payload for smaller models */
  protected optimizePayload: boolean
  protected maxTokensCap: number
  protected maxSystemChars: number
  /** Session token for ChatGPT backend API (OAuth users, GPT-5 Codex models) */
  protected sessionToken?: string
  /**
   * Preserve cache_control markers when converting to OpenAI format.
   * Providers like OpenRouter pass these through to underlying providers
   * (Anthropic, etc.) enabling prompt caching. Off by default.
   */
  protected preserveCacheControl: boolean = false

  /**
   * Stable cache-routing key for the Responses API. OpenAI routes requests
   * with the same `prompt_cache_key` to the same backend node, which is
   * what makes the server-side prompt cache hit. codex-rs uses a single
   * conversation-id for the lifetime of the session — we mirror that here
   * with a randomly-generated id created on first use. Rotates via
   * clearCacheSession() (called by the lane on /clear or context reset).
   */
  private _cacheSessionId: string | null = null

  constructor(config: ProviderConfig) {
    super()
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'
    this.extraHeaders = config.extraHeaders ?? {}
    this.sessionToken = config.sessionToken

    // Payload optimization — on by default for all 3P providers
    this.optimizePayload = process.env.PROVIDER_NO_OPTIMIZE !== 'true'
    this.maxTokensCap = parseInt(
      process.env.PROVIDER_MAX_TOKENS ?? String(DEFAULT_3P_MAX_TOKENS), 10,
    )
    this.maxSystemChars = parseInt(
      process.env.PROVIDER_MAX_SYSTEM_CHARS ?? String(DEFAULT_3P_MAX_SYSTEM_CHARS), 10,
    )
  }

  /** Override in subclasses to enable message coalescing for strict models */
  protected needsMessageCoalescing(model: string): boolean {
    // o1-series models require strictly alternating roles
    return /^o1(-|$)/.test(model)
  }

  /**
   * Resolve the reasoning_effort to send with the request.
   *
   * Priority: user-selected level from /models picker → Anthropic thinking
   * budget mapping → default 'medium'.
   */
  protected resolveReasoningEffort(
    model: string,
    thinking: ProviderRequestParams['thinking'],
  ): OpenAIReasoningLevel | undefined {
    if (!modelSupportsReasoning(model)) return undefined

    // Only send reasoning_effort when the user explicitly chose a level
    // via ← → in the model picker. Sending it unsolicited to models that
    // don't support it causes 500 errors on OpenAI's API.
    if (isReasoningLevelExplicit()) return getOpenAIReasoningLevel()

    return undefined
  }

  // ─── Payload optimization ───────────────────────────────────────

  /**
   * Optimize request params for third-party models:
   * 1. Trim system prompt to essential instructions
   * 2. Filter tools to core set
   * 3. Cap max_tokens
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    if (!this.optimizePayload) return params

    // GPT-5 Codex models have 1M+ context — send full payload with all
    // tools so agents, MCP servers, plan mode etc. work without limits.
    const model = this.resolveModel(params.model)
    if (/^gpt-[5-9]/i.test(model)) return params

    return {
      ...params,
      system: this._trimSystem(params.system),
      tools: this._filterTools(params.tools),
      max_tokens: Math.min(params.max_tokens, this.maxTokensCap),
    }
  }

  private _trimSystem(
    system?: string | SystemBlock[],
  ): string | SystemBlock[] | undefined {
    if (!system) return system

    const fullText = typeof system === 'string'
      ? system
      : system.map(s => s.text).join('\n\n')

    if (fullText.length <= this.maxSystemChars) {
      return typeof system === 'string' ? system : system
    }

    // Find a clean cut point at a paragraph break
    let cutPoint = this.maxSystemChars
    const lastBreak = fullText.lastIndexOf('\n\n', cutPoint)
    if (lastBreak > this.maxSystemChars * 0.7) {
      cutPoint = lastBreak
    }

    const trimmed = fullText.slice(0, cutPoint) +
      '\n\n[System instructions trimmed for performance. Core tools available: Bash, Read, Write, Edit, Glob, Grep.]'

    if (typeof system === 'string') return trimmed
    return [{ type: 'text' as const, text: trimmed }]
  }

  private _filterTools(tools?: ProviderTool[]): ProviderTool[] | undefined {
    if (!tools || tools.length === 0) return tools

    const filtered = tools.filter(t => CORE_TOOL_NAMES.has(t.name))
    return filtered.length > 0 ? filtered : tools
  }

  // ─── API methods ───────────────────────────────────────────────

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    const optimized = this.optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    this._adoptRequestSessionId(optimized.sessionId)

    // GPT-5 Codex models use the Responses API
    if (this._useResponsesAPI(model)) {
      return this._streamResponses(optimized, model)
    }

    let messages = anthropicMessagesToOpenAI(optimized.messages, optimized.system, { preserveCacheControl: this.preserveCacheControl })
    if (this.needsMessageCoalescing(model)) {
      messages = coalesceConsecutiveMessages(messages)
    }
    const tools = optimized.tools ? anthropicToolsToOpenAI(optimized.tools) : undefined

    // GPT-5 and o-series require max_completion_tokens, not max_tokens.
    // Sending max_tokens to these models causes 500 errors.
    const useNewTokenParam = this._usesMaxCompletionTokens(model)
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    // prompt_cache_key is OpenAI-specific. Sending it to Groq / OpenRouter /
    // etc. risks a 400 on strict-JSON providers, so gate on this.name.
    if (this.name === 'openai') {
      body.prompt_cache_key = this.cacheSessionKey
    } else if (this.name === 'openrouter') {
      const sessionKey = this.cacheSessionKeyForModel(model)
      body.session_id = sessionKey
      body.prompt_cache_key = sessionKey
    }
    if (useNewTokenParam) {
      body.max_completion_tokens = optimized.max_tokens
    } else {
      body.max_tokens = optimized.max_tokens
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (optimized.temperature !== undefined) body.temperature = optimized.temperature
    if (optimized.stop_sequences) body.stop = optimized.stop_sequences

    // Send reasoning_effort for Codex / o-series models.
    const effort = this.resolveReasoningEffort(model, optimized.thinking)
    if (effort) body.reasoning_effort = effort

    const ac = new AbortController()
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(model),
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    if (!response.body) {
      throw new Error(`${this.name} returned no response body for streaming request`)
    }

    // Extract rate limit headers from the response
    this._extractRateLimits(response.headers)

    const sseStream = this._parseSSE(response.body)
    const anthropicEvents = openAIStreamToAnthropicEvents(sseStream)
    return buildProviderStreamResult(anthropicEvents, ac)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    const optimized = this.optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    this._adoptRequestSessionId(optimized.sessionId)

    // GPT-5 Codex models use the Responses API
    if (this._useResponsesAPI(model)) {
      return this._createResponses(optimized, model)
    }

    let messages = anthropicMessagesToOpenAI(optimized.messages, optimized.system, { preserveCacheControl: this.preserveCacheControl })
    if (this.needsMessageCoalescing(model)) {
      messages = coalesceConsecutiveMessages(messages)
    }
    const tools = optimized.tools ? anthropicToolsToOpenAI(optimized.tools) : undefined

    const useNewTokenParam = this._usesMaxCompletionTokens(model)
    const body: Record<string, unknown> = {
      model,
      messages,
    }
    if (this.name === 'openai') {
      body.prompt_cache_key = this.cacheSessionKey
    } else if (this.name === 'openrouter') {
      const sessionKey = this.cacheSessionKeyForModel(model)
      body.session_id = sessionKey
      body.prompt_cache_key = sessionKey
    }
    if (useNewTokenParam) {
      body.max_completion_tokens = optimized.max_tokens
    } else {
      body.max_tokens = optimized.max_tokens
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (optimized.temperature !== undefined) body.temperature = optimized.temperature
    if (optimized.stop_sequences) body.stop = optimized.stop_sequences

    // Send reasoning_effort for Codex / o-series models.
    const effort = this.resolveReasoningEffort(model, optimized.thinking)
    if (effort) body.reasoning_effort = effort

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(model),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    this._extractRateLimits(response.headers)

    const data = (await response.json()) as OpenAIChatCompletion
    return openAIMessageToAnthropic(data)
  }

  async listModels(): Promise<ModelInfo[]> {
    // Try the real API first — it returns only models the token can access.
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) {
        const data = (await response.json()) as { data: Array<{ id: string }> }
        const apiModels = (data.data ?? []).map(m => ({ id: m.id, name: m.id }))
        if (apiModels.length > 0) return mergeOpenAIModels(apiModels)
      }
    } catch {
      // API unreachable or token can't list
    }

    // Fallback: curated list so /models always shows something.
    return [...OPENAI_FALLBACK_MODELS]
  }

  resolveModel(claudeModel: string): string {
    // If it doesn't look like a Claude model, pass through as-is
    if (!claudeModel.includes('claude')) return claudeModel

    const models = getProviderModelSet(this.name)
    if (claudeModel.includes('opus'))  return models.opus
    if (claudeModel.includes('haiku')) return models.haiku
    return models.sonnet
  }

  /** Last known rate limit info from provider response headers */
  lastRateLimits: {
    requestsLimit?: number
    requestsRemaining?: number
    requestsReset?: string
    tokensLimit?: number
    tokensRemaining?: number
    tokensReset?: string
  } = {}

  // ─── Error Handling ─────────────────────────────────────────────

  /**
   * Format API errors with user-friendly messages for common billing/quota issues.
   * Detects 402 (payment required), 429 (quota exceeded), and other billing errors.
   */
  protected formatAPIError(status: number, body: string): Error {
    // Try to extract the error message from JSON response
    let errorDetail = ''
    try {
      const parsed = JSON.parse(body)
      errorDetail = parsed?.error?.message ?? parsed?.error?.type ?? ''
    } catch {
      errorDetail = body
    }

    // 402 — Insufficient balance (DeepSeek, etc.)
    if (status === 402 || errorDetail.toLowerCase().includes('insufficient balance')) {
      return new Error(
        `${this.name} API error: Insufficient account balance.\n` +
        `Your ${this.name} account has no remaining credits.\n` +
        `Please add funds at your provider's billing page and try again.`,
      )
    }

    // 429 — Quota exceeded / rate limit
    if (status === 429) {
      if (errorDetail.toLowerCase().includes('insufficient_quota') ||
          errorDetail.toLowerCase().includes('exceeded your current quota')) {
        return new Error(
          `${this.name} API error: Quota exceeded.\n` +
          `Your ${this.name} API key has exceeded its usage quota.\n` +
          `Check your plan and billing details at your provider's dashboard.`,
        )
      }
      // Rate limit (TPM/RPM) — include the original message for limit details
      return new Error(
        `${this.name} API error: Rate limit exceeded.\n` +
        `${errorDetail}\n` +
        `Tip: Wait a moment and retry, or use a model with higher rate limits.`,
      )
    }

    // 401 — Invalid auth
    if (status === 401) {
      return new Error(
        `${this.name} API error: Authentication failed.\n` +
        `${errorDetail ? errorDetail + '\n' : ''}` +
        `Your API key may be invalid or expired. Run /login to reconfigure.`,
      )
    }

    // 413 — Request too large (Groq TPM, etc.)
    if (status === 413) {
      return new Error(
        `${this.name} API error: Request too large.\n` +
        `${errorDetail}\n` +
        `The message + tools exceeded the model's token limit.\n` +
        `Try a shorter message or switch to a model with a higher token limit.`,
      )
    }

    // 500 — Server error (often means model ID doesn't exist)
    if (status === 500) {
      return new Error(
        `${this.name} API error ${status}: Server error.\n` +
        `${errorDetail || 'The model may not exist or is unavailable.'}\n` +
        `Try a different model with /model or /models.`,
      )
    }

    // Default — include status and body
    return new Error(`${this.name} API error ${status}: ${body}`)
  }

  // ─── Internal helpers ──────────────────────────────────────────

  /**
   * Extract rate limit information from provider response headers.
   * Supports standard X-RateLimit-* headers used by OpenAI, Groq, etc.
   */
  protected _extractRateLimits(headers: Headers): void {
    const rl = this.lastRateLimits
    const reqLimit = headers.get('x-ratelimit-limit-requests')
    const reqRemaining = headers.get('x-ratelimit-remaining-requests')
    const reqReset = headers.get('x-ratelimit-reset-requests')
    const tokLimit = headers.get('x-ratelimit-limit-tokens')
    const tokRemaining = headers.get('x-ratelimit-remaining-tokens')
    const tokReset = headers.get('x-ratelimit-reset-tokens')
    if (reqLimit) rl.requestsLimit = parseInt(reqLimit, 10)
    if (reqRemaining) rl.requestsRemaining = parseInt(reqRemaining, 10)
    if (reqReset) rl.requestsReset = reqReset
    if (tokLimit) rl.tokensLimit = parseInt(tokLimit, 10)
    if (tokRemaining) rl.tokensRemaining = parseInt(tokRemaining, 10)
    if (tokReset) rl.tokensReset = tokReset
  }

  protected _headers(_model?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    }
  }

  private _adoptRequestSessionId(sessionId: string | undefined): void {
    const trimmed = sessionId?.trim()
    if ((this.name !== 'openai' && this.name !== 'openrouter') || !trimmed) return
    this._cacheSessionId = trimmed
  }

  /**
   * Returns the URL and headers for Responses API calls.
   * OAuth users → chatgpt.com/backend-api/codex (session token auth)
   * API key users → standard api.openai.com/v1/responses
   */
  private _responsesEndpoint(): { url: string; headers: Record<string, string> } {
    if (this.sessionToken) {
      return {
        url: 'https://chatgpt.com/backend-api/codex/responses',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.sessionToken}`,
          'OpenAI-Beta': 'responses_websockets=2026-02-06',
          ...this.extraHeaders,
        },
      }
    }
    return {
      url: `${this.baseUrl}/responses`,
      headers: this._headers(),
    }
  }

  /**
   * Stable per-session cache key used with the Responses API. Generated on
   * first read and kept until clearCacheSession() rotates it.
   */
  protected get cacheSessionKey(): string {
    if (!this._cacheSessionId) {
      const crypto = require('crypto') as typeof import('crypto')
      this._cacheSessionId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `oai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }
    return this._cacheSessionId
  }

  protected cacheSessionKeyForModel(_model: string): string {
    return this.cacheSessionKey
  }

  /** Force a new cache-session id — call on conversation reset / compact. */
  clearCacheSession(): void {
    this._cacheSessionId = null
  }

  // ─── Responses API (GPT-5 Codex models) ─────────────────────────

  /**
   * True when the model should use the Responses API via the ChatGPT backend.
   * GPT-5 Codex models only work through chatgpt.com/backend-api/codex which
   * requires the OAuth session token (first-exchange access_token).
   * The standard api.openai.com endpoint rejects these models (missing scopes).
   */
  private _useResponsesAPI(model: string): boolean {
    return /^gpt-[5-9]/i.test(model) && !!this.sessionToken
  }

  /** True for models that require max_completion_tokens instead of max_tokens. */
  private _usesMaxCompletionTokens(model: string): boolean {
    return /^(gpt-[5-9]|o[1-9])/i.test(model)
  }

  private async _streamResponses(
    params: ProviderRequestParams,
    model: string,
  ): Promise<ProviderStreamResult> {
    const input = anthropicToResponsesInput(params.messages)
    const tools = params.tools
      ? anthropicToolsToResponsesTools(params.tools)
      : undefined
    const instructions = extractInstructions(params.system)

    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
      // The ChatGPT backend (OAuth / Codex endpoint) rejects store:true with
      // "Store must be set to false". Keep store:false for both OAuth and
      // API-key paths — prompt_cache_key alone is enough to make the server
      // route the request to the same cache-warm backend node (this is what
      // codex-rs does).
      store: false,
      prompt_cache_key: this.cacheSessionKey,
    }

    if (instructions) body.instructions = instructions
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    // Nested reasoning.effort for Responses API
    const effort = this.resolveReasoningEffort(model, params.thinking)
    if (effort) body.reasoning = { effort }

    const { url, headers } = this._responsesEndpoint()

    const ac = new AbortController()
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    if (!response.body) {
      throw new Error(`${this.name} returned no response body for streaming request`)
    }

    this._extractRateLimits(response.headers)

    const sseStream = this._parseResponsesSSE(response.body)
    const anthropicEvents = responsesStreamToAnthropicEvents(sseStream)
    return buildProviderStreamResult(anthropicEvents, ac)
  }

  private async _createResponses(
    params: ProviderRequestParams,
    model: string,
  ): Promise<AnthropicMessage> {
    const input = anthropicToResponsesInput(params.messages)
    const tools = params.tools
      ? anthropicToolsToResponsesTools(params.tools)
      : undefined
    const instructions = extractInstructions(params.system)

    const body: Record<string, unknown> = {
      model,
      input,
      store: false,
      prompt_cache_key: this.cacheSessionKey,
    }

    if (instructions) body.instructions = instructions
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const effort = this.resolveReasoningEffort(model, params.thinking)
    if (effort) body.reasoning = { effort }

    const { url, headers } = this._responsesEndpoint()

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw this.formatAPIError(response.status, errText)
    }

    this._extractRateLimits(response.headers)

    const data = (await response.json()) as ResponsesApiResponse
    return responsesMessageToAnthropic(data)
  }

  /**
   * Parse SSE events from the Responses API stream.
   * The Responses API uses `event:` + `data:` lines with a JSON payload
   * that includes the event `type` field.
   */
  protected async *_parseResponsesSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<ResponsesSSEEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          let dataStr = ''
          for (const line of event.split('\n')) {
            if (line.startsWith('data: ')) {
              dataStr += line.slice(6)
            }
          }

          if (!dataStr || dataStr === '[DONE]') continue

          try {
            yield JSON.parse(dataStr) as ResponsesSSEEvent
          } catch {
            // Skip malformed JSON
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        let dataStr = ''
        for (const line of buffer.split('\n')) {
          if (line.startsWith('data: ')) {
            dataStr += line.slice(6)
          }
        }
        if (dataStr && dataStr !== '[DONE]') {
          try {
            yield JSON.parse(dataStr) as ResponsesSSEEvent
          } catch {
            // Skip
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ─── Chat Completions SSE parser ──────────────────────────────────

  protected async *_parseSSE(
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

        // Split on double newline (SSE event boundary)
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)

          for (const line of event.split('\n')) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim()
              if (jsonStr === '[DONE]') return
              if (!jsonStr) continue
              try {
                yield JSON.parse(jsonStr) as OpenAIChatCompletionChunk
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim()
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                yield JSON.parse(jsonStr) as OpenAIChatCompletionChunk
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
