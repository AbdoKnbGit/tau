/**
 * OpenRouter provider — extends OpenAIProvider with OpenRouter-specific headers.
 *
 * OpenRouter is an API aggregator that routes to multiple model providers.
 * It uses the OpenAI-compatible API with extra headers for ranking/attribution.
 *
 * Base URL: https://openrouter.ai/api/v1
 * Auth: Bearer token (sk-or-...)
 * Extra headers: HTTP-Referer, X-OpenRouter-Title,
 * X-OpenRouter-Categories (for app rankings)
 */

import { OpenAIProvider } from './openai_provider.js'
import type { ModelInfo, ProviderConfig, ProviderRequestParams } from './base_provider.js'
import {
  toOpenRouterModelInfo,
  OPENROUTER_ALLOWLIST,
  type OpenRouterCatalogModel,
} from '../../../utils/model/openrouterCatalog.js'

export class OpenRouterProvider extends OpenAIProvider {
  readonly name = 'openrouter'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: 'https://openrouter.ai/api/v1',
      extraHeaders: {
        // OpenRouter uses these for app rankings and attribution.
        'HTTP-Referer': process.env.OPENROUTER_REFERER ?? 'https://github.com/AbdoKnbGit/tau',
        'X-OpenRouter-Title': process.env.OPENROUTER_TITLE ?? 'Tau',
        'X-OpenRouter-Categories': process.env.OPENROUTER_CATEGORIES ?? 'cli-agent',
        'X-Title': process.env.OPENROUTER_TITLE ?? 'Tau',
        ...(config.extraHeaders ?? {}),
      },
    })
    // OpenRouter passes cache_control through to underlying providers
    // (Anthropic, Google, etc.) enabling prompt caching.
    this.preserveCacheControl = true
  }

  protected override _headers(model?: string): Record<string, string> {
    const headers = super._headers(model)
    if (model) headers['x-session-id'] = this.cacheSessionKeyForModel(model)
    return headers
  }

  protected override cacheSessionKeyForModel(model: string): string {
    return normalizeOpenRouterSessionId(`${this.cacheSessionKey}:${model.toLowerCase()}`)
  }

  /**
   * OpenRouter routes to frontier models (Claude, GPT-4, Gemini, etc.)
   * that fully support tool calling, agents, MCP servers, and plugins.
   * Skip the payload optimization that strips tools down to core-only —
   * send the full tool set so all claudex features work.
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    return params
  }

  /**
   * OpenRouter exposes a unified `reasoning` field that every upstream
   * provider (Anthropic, OpenAI, Google, DeepSeek, etc.) respects via
   * their native reasoning surface. We always map the /thinking toggle
   * through this, rather than overriding reasoning_effort, so every
   * thinking-capable model routed via OpenRouter behaves consistently.
   */
  protected modelSupportsReasoningEffort(_model: string): boolean {
    // We return true so the base OpenAIProvider branch runs and
    // `reasoning_effort` is set. OpenRouter accepts both
    // `reasoning_effort` and `reasoning: { effort }`; models that don't
    // reason quietly ignore the flag.
    return true
  }

  /**
   * OpenRouter has its own model list endpoint with richer metadata
   * including pricing, context length, and provider info.
   */
  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    })

    if (!response.ok) return []

    const data = (await response.json()) as {
      data: OpenRouterCatalogModel[]
    }

    return (data.data ?? [])
      .filter(m => {
        if (typeof m.id !== 'string') return false
        // Strip :free suffix for allowlist lookup
        const baseId = m.id.replace(/:free$/, '')
        return OPENROUTER_ALLOWLIST.has(baseId) || OPENROUTER_ALLOWLIST.has(m.id)
      })
      .map(toOpenRouterModelInfo)
      .filter((model): model is ModelInfo => model !== null)
  }
}

function normalizeOpenRouterSessionId(sessionId: string): string {
  if (sessionId.length <= 256) return sessionId
  const hash = shortStableHash(sessionId)
  return `${sessionId.slice(0, 247)}:${hash}`
}

function shortStableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
