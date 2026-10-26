/**
 * Fireworks AI transformer (https://fireworks.ai).
 *
 * OpenAI Chat Completions endpoint at https://api.fireworks.ai/inference/v1,
 * Bearer FIREWORKS_API_KEY. Serves open-weight models (DeepSeek V4, Kimi K3,
 * GLM 5.2, MiniMax M3, Qwen 3.8, …) with ids like
 * `accounts/fireworks/models/<name>` (note Fireworks' `p`-for-decimal ids,
 * e.g. `kimi-k2p6`).
 *
 * Catalog: we DON'T live-fetch `/v1/models`. That endpoint returns the
 * account's entire visible registry (hundreds of rows — every public
 * serverless model plus the account's own fine-tunes/embeddings), which
 * buries the handful of models worth coding with. Instead we surface the
 * curated list in utils/model/fireworksCatalog.ts via `staticCatalog()`. The
 * lane returns it verbatim (no `/models` call) since `preferLiveModelCatalog`
 * is unset. Drift is handled without code edits: set `FIREWORKS_MODELS`
 * (comma-separated ids) to replace the list.
 *
 * Cache management: Fireworks routes requests with the same `prompt_cache_key`
 * to the same backend to maximize KV-cache hit rates (it takes priority over
 * the `user` field per the Fireworks API). We stamp it from the stable claudex
 * sessionId so multi-turn sessions stay pinned to one backend and actually hit
 * the prompt cache instead of cold-prefilling every turn. We also request
 * `perf_metrics_in_response` so the streamed final chunk carries
 * `cached-prompt-tokens` — the only place Fireworks reports cache hits for
 * streaming requests (the standard usage block omits prompt_tokens_details
 * mid-stream, which is why the cache-hit count read as null before).
 *
 * Reasoning: Fireworks accepts an OpenAI-compatible `reasoning_effort`
 * with model-specific tiers. Share the picker's capability guard so fixed
 * and unknown models retain their server defaults.
 */

import type { ModelInfo } from '../../../services/api/providers/base_provider.js'
import { getCompatRequestEffort } from '../../../utils/model/compatEffort.js'
import {
  FIREWORKS_MODELS,
  qualifyFireworksId,
} from '../../../utils/model/fireworksCatalog.js'
import type { HeaderContext, Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

// Markers for non-chat rows we don't want surfaced if a live `/models`
// fetch is ever re-enabled (filterModelCatalog is a no-op while the
// static catalog is in force, but kept as a safety net).
const NON_CHAT_MARKERS = [
  'embedding', 'reranker', 'guard', 'safeguard', 'firesearch', 'ocr', 'voyage',
]

function buildFireworksCatalog(): ModelInfo[] {
  // Env override (no code edit needed if the serverless roster drifts):
  // FIREWORKS_MODELS="qwen3-coder-480b-a35b-instruct,deepseek-v3p1,..."
  const override = process.env.FIREWORKS_MODELS?.trim()
  if (override) {
    return override
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0)
      .map(raw => {
        const id = qualifyFireworksId(raw)
        const short = id.slice(id.lastIndexOf('/') + 1)
        return { id, name: short, supportsToolCalling: true, provider: 'Fireworks AI' }
      })
  }
  return FIREWORKS_MODELS.map(entry => ({
    id: qualifyFireworksId(entry.id),
    name: entry.name,
    ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    provider: 'Fireworks AI',
    tags: entry.tags,
    supportsToolCalling: entry.toolCalling ?? true,
  }))
}

export const fireworksTransformer: Transformer = {
  id: 'fireworks',
  displayName: 'Fireworks AI',
  defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',

  buildHeaders(_apiKey: string, ctx?: HeaderContext): Record<string, string> {
    return ctx?.sessionId ? { 'x-session-affinity': ctx.sessionId } : {}
  },

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    // KV-cache session affinity — pin this session to one backend so the
    // prompt cache actually hits. Fireworks prefers prompt_cache_key over
    // the `user` field for routing.
    if (ctx.sessionId) {
      body.prompt_cache_key = ctx.sessionId
      body.user = ctx.sessionId
    }
    // Ask Fireworks to include perf_metrics in the streamed final chunk.
    // For streaming requests `cached-prompt-tokens` only ships in
    // perf_metrics (the usage block omits prompt_tokens_details mid-stream),
    // so without this the cache-hit count is never populated.
    body.perf_metrics_in_response = true
    const effort = getCompatRequestEffort('fireworks', body.model, ctx.effortValue)
    if (effort) body.reasoning_effort = effort
    else delete body.reasoning_effort
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'maximum context', 'token limit', 'too long']
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    // Reuse the main model — picking a specific id risks 401 on accounts that
    // haven't enabled that serverless row.
    return null
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  // Curated coding-only catalog — returned verbatim by the lane, so the
  // provider's `/v1/models` is never fetched.
  staticCatalog(): ModelInfo[] {
    return buildFireworksCatalog()
  },

  filterModelCatalog(
    models: Array<{ id: string; name?: string }>,
  ): Array<{ id: string; name?: string }> {
    return models.filter(model => {
      const id = model.id.toLowerCase()
      return !NON_CHAT_MARKERS.some(marker => id.includes(marker))
    })
  },
}
