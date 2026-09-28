/**
 * OpenCode Go transformer (https://opencode.ai/zen/go/).
 *
 * Go is the same OpenCode gateway as Zen, sharing the same credential
 * (OPENCODE_API_KEY). The ONLY thing that changes is the base path:
 *   Zen → https://opencode.ai/zen/v1
 *   Go  → https://opencode.ai/zen/go/v1
 *
 * Everything else is identical to Zen — request shaping, reasoning/thinking
 * effort injection, the rate-limit UA gate + session-affinity headers, and
 * cache_control management. So we clone the Zen transformer wholesale and
 * override ONLY the identity, the default base URL, and the places where
 * Go's upstream differs from Zen (see below). Nothing is hardcoded: the model
 * list is live-fetched from `https://opencode.ai/zen/go/v1/models` (no
 * staticCatalog), exactly like Zen live-fetches `/zen/v1/models`.
 *
 * This file does NOT modify the Zen transformer; it spreads it, so any future
 * Zen fix flows to Go automatically.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import { buildOpencodeHeaders, opencodeTransformer } from './opencode.js'
import { openCodeRouteFor } from '../opencode_anthropic_route.js'
import {
  getOpencodeEffort,
  isOpencodeGlm52,
  supportsOpencodeThinkingSelection,
  usesOpencodeCatalogEfforts,
} from '../../../utils/model/opencodeThinking.js'

// Reasoning/thinking controls the Zen transformer may inject. OpenCode Go's
// GLM-5.2 and Qwen3.7-max upstreams validate `thinking` against Anthropic's
// ThinkingConfig and 400 on the zai-style shape Zen sends (`clear_thinking`,
// `type:'enabled'`). Qwen3.7-max has no usable knob, so we strip every
// reasoning/thinking control and let its server-side default decide. GLM-5.2 is
// special-cased in transformRequest: same strip, but its effort is re-expressed
// as `reasoning_effort` (high|max) — the shape that row DOES accept, matching
// opencode-dev's variant() for it.
const GO_UNSUPPORTED_THINKING_FIELDS = [
  'thinking',
  'reasoning',
  'reasoning_effort',
  'enable_thinking',
  'chat_template_args',
] as const

// Specific MiMo rows to hide from the Go catalog (mimo-v2.5-pro stays).
const GO_HIDDEN_MODEL_IDS = new Set([
  'mimo-v2-omni',
  'mimo-v2-pro',
  'mimo-v2.5',
])

// Some Go upstreams 400 on the non-standard detailed-usage flag
// `usage: { include: true }` the base transformer stamps. The standard
// `stream_options: { include_usage: true }` is sent separately and already
// carries usage, so dropping this extension only costs the extra cache fields
// some gateways fold into it — never a hard failure.
//   - Kimi: "Upstream request failed" — verified live 2026-07-11 against
//     kimi-k2.5 / kimi-k2.6 (deterministic 5/5). kimi-k2.7-code tolerates it,
//     but every kimi row volunteers `prompt_tokens_details.cached_tokens`
//     without it, so stripping the whole family loses no cache accounting.
//   - GLM: strict upstream rejects it — "Extra inputs are not permitted,
//     field: 'usage'" (observed 2026-07-13). That flag is exactly what glm-5.2
//     needed to surface `cached_tokens`, so GLM cache-hit stats aren't
//     recoverable on Go — but a 400 that stops the turn is far worse than
//     missing stats, so the flag goes for the GLM family too.
function goRejectsUsageIncludeFlag(model: string): boolean {
  const m = model.trim().toLowerCase()
  return m.startsWith('kimi-') || m.startsWith('glm-')
}

export const opencodeGoTransformer: Transformer = {
  ...opencodeTransformer,
  id: 'opencodego',
  displayName: 'OpenCode Go',
  defaultBaseUrl: 'https://opencode.ai/zen/go/v1',

  // Keep Go's existing headers independent of Zen's free-tier compatibility.
  buildHeaders(apiKey, ctx) {
    return buildOpencodeHeaders(apiKey, ctx, '1.15.9')
  },

  transformRequest(
    body: OpenAIChatRequest,
    ctx: TransformContext,
  ): OpenAIChatRequest {
    // Reuse ALL of Zen's request shaping (session affinity, effort injection,
    // cache_control), then reconcile the thinking controls with what Go's
    // upstreams accept. The base reads Go's own ladders from models.dev.
    const result = opencodeTransformer.transformRequest(body, { ...ctx, provider: 'opencodego' })
    const mutable = result as unknown as Record<string, unknown>
    if (usesOpencodeCatalogEfforts('opencodego', result.model)) {
      // Already shaped from the ladder models.dev publishes for this Go row:
      // `reasoning_effort` with one of its values, or nothing at Default.
    } else if (isOpencodeGlm52(result.model)) {
      // GLM-5.2's Go upstream 400s on the zai-style `thinking` object the base
      // transformer stamps; its reasoning is driven by `reasoning_effort`
      // (high|max) — the exact two variants opencode-dev generates for this row.
      // Strip the thinking controls, then translate the picker's effort into
      // reasoning_effort ('default' leaves the upstream server default).
      for (const field of GO_UNSUPPORTED_THINKING_FIELDS) delete mutable[field]
      const effort = getOpencodeEffort(result.model, 'opencodego')
      if (effort === 'high' || effort === 'max') {
        mutable.reasoning_effort = effort
      }
    } else if (!supportsOpencodeThinkingSelection('opencodego', result.model)) {
      // Other rows with no usable thinking selection (e.g. qwen3.7-max): drop
      // every reasoning/thinking control so the request validates instead of 400.
      for (const field of GO_UNSUPPORTED_THINKING_FIELDS) delete mutable[field]
    }
    if (goRejectsUsageIncludeFlag(result.model)) {
      delete mutable.usage
    }
    return result
  },

  smallFastModel(model: string): string | null {
    // Zen's qwen mapping (qwen3.5-plus) is a bad fit on Go: live-probed
    // 2026-07-11, the row reports zero prompt-cache usage AND burns ~300
    // hidden reasoning tokens per call (server-side thinking default).
    // deepseek-v4-flash is Go's designated cheap tier (configs.ts haiku
    // default) and served ~99% of a repeated prefix from cache in the same
    // probe. Zen returns null for the deepseek family (Zen only hosts free
    // variants); on Go deepseek-v4-flash is a paid row, so map the family
    // there too instead of reusing an expensive main model.
    const m = model.toLowerCase()
    if (m.startsWith('qwen') || m.includes('deepseek')) return 'deepseek-v4-flash'
    return opencodeTransformer.smallFastModel!(model)
  },

  filterModelCatalog(
    models: Array<{ id: string; name?: string }>,
  ): Array<{ id: string; name?: string }> {
    return models.filter(
      model => !GO_HIDDEN_MODEL_IDS.has(model.id.trim().toLowerCase())
        && openCodeRouteFor('opencodego', model.id) !== 'systemone',
    )
  },
}
