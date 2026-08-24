/**
 * Xiaomi MiMo transformer (api.xiaomimimo.com, token-plan-*.xiaomimimo.com).
 *
 * MiMo is a first-party vendor API rather than a relay, and it deviates from
 * stock OpenAI Chat Completions in three ways that all matter on the wire:
 *
 *   1. Auth is a bare `api-key: <key>` header, NOT `Authorization: Bearer`.
 *      Hence `ownsAuthHeader()` — the lane skips its default Bearer and this
 *      transformer supplies the credential in the shape MiMo actually reads.
 *   2. The output cap is `max_completion_tokens`; `max_tokens` is ignored.
 *   3. Reasoning rows stream `reasoning_content` and REQUIRE it echoed back on
 *      replayed assistant tool-call messages. That carry-back is wired from
 *      day one (see mimoReasoningContentReplayRequired + the lane's history
 *      dispatch) rather than discovered on the second tool turn.
 *
 * Prompt cache: MiMo publishes no cache-control surface and no affinity knob,
 * so nothing speculative is injected here. Hits ride on prefix stability —
 * identical system + tools + message prefix across turns, which the lane
 * already guarantees — and whatever `prompt_tokens_details.cached_tokens` the
 * server returns is picked up by the lane's generic usage extractor.
 */

import type { Transformer, TransformContext, HeaderContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import {
  mimoMaxOutputTokens,
  mimoStaticCatalog,
  recordMimoCatalog,
  type MimoCatalogRow,
} from '../../../utils/model/mimoCatalog.js'
import {
  hasExplicitMimoEffort,
  resolveMimoRequestEffort,
  supportsMimoEffortSelection,
} from '../../../utils/model/mimoThinking.js'

export const mimoTransformer: Transformer = {
  id: 'mimo',
  displayName: 'Xiaomi MiMo',
  defaultBaseUrl: 'https://api.xiaomimimo.com/v1',

  // MiMo authenticates on a bare vendor header. Claiming auth keeps the key
  // from also going out as a Bearer token the server never reads.
  ownsAuthHeader() {
    return true
  },

  buildHeaders(apiKey: string, _ctx?: HeaderContext): Record<string, string> {
    return apiKey ? { 'api-key': apiKey } : {}
  },

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    // Highest per-model ceiling MiMo publishes; the per-model clamp in
    // transformRequest narrows it further once the model id is known.
    return Math.min(Math.max(1, requested), 128_000)
  },

  staticCatalog() {
    return mimoStaticCatalog()
  },

  filterModelCatalog(models) {
    // `/v1/models` is auth-gated, so this only runs once the user is logged
    // in. Fold the response in so a newly released MiMo model picks up its
    // real context window and output cap without a Tau release.
    recordMimoCatalog(models as unknown as readonly MimoCatalogRow[])
    return models
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    const bag = body as unknown as Record<string, unknown>

    // MiMo reads `max_completion_tokens`; a plain `max_tokens` is ignored,
    // which silently hands back the server default instead of the caller's.
    if (typeof body.max_tokens === 'number') {
      bag.max_completion_tokens = Math.min(
        Math.max(1, body.max_tokens),
        mimoMaxOutputTokens(ctx.model),
      )
      delete bag.max_tokens
    }

    // Uniform low/medium/high ladder on every reasoning row, defaulting to
    // MiMo's own `medium`. The picker's per-model pick wins; the caller's
    // thinking budget is the fallback when it maps onto the same ladder.
    if (supportsMimoEffortSelection(ctx.model)) {
      // Precedence: an explicit pick from the picker wins, then the caller's
      // thinking budget, then MiMo's own default. Without the explicit-pick
      // check the budget silently overwrites the chip on every request.
      const fallback = ctx.isReasoning ? ctx.reasoningEffort : null
      body.reasoning_effort = hasExplicitMimoEffort(ctx.model)
        ? resolveMimoRequestEffort(ctx.model)
        : fallback ?? resolveMimoRequestEffort(ctx.model)
    } else {
      delete bag.reasoning_effort
    }

    // Fields MiMo's endpoint does not accept. `store` and `stream_options`
    // are named explicitly by the vendor integration; the rest are Anthropic
    // and OpenRouter leftovers that have no meaning here.
    delete bag.store
    delete bag.stream_options
    delete bag.thinking
    delete bag.reasoning
    delete bag.prompt_cache_key
    delete bag.prompt_cache_retention
    delete bag.transforms
    delete bag.plugins
    delete bag.route
    delete bag.models
    delete bag.extra_body
    delete bag.providerOptions

    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict'])
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'maximum context',
      'prompt is too long',
      'token limit',
      'too long',
      'tokens exceed',
      'exceed token',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'mimo-v2.5'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    // No Anthropic-style cache_control surface on MiMo; leaving the markers on
    // would ship fields the endpoint does not understand.
    return 'none'
  },
}
