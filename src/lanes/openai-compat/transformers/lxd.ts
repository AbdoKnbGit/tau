/**
 * LXD API transformer (api.lxds.org).
 *
 * LXD is an OpenAI Chat Completions relay in front of a mixed pool of open
 * models (GPT-OSS, GLM, Llama, Gemma, MiniMax, Nemotron, DeepSeek V4, Qwen)
 * plus a rotating set of free "event" rows. The documented request surface is
 * deliberately small -- model, messages, stream, max_tokens, temperature,
 * top_p -- so this transformer strips everything the relay does not publish
 * rather than hoping unknown fields are ignored.
 *
 * Thinking: LXD publishes a per-model ladder in `/v1/models`
 * (`capabilities.reasoning_efforts`) and normalizes it upstream itself,
 * whatever shape the backing model actually wants -- OpenAI-native
 * `reasoning_effort`, zai-style thinking tags, or Qwen's `enable_thinking`
 * (the dashboard calls these `reasoning_type: native | tags | auto`). So one
 * uniform `reasoning_effort` is the right thing to put on the wire, and the
 * picker's chip is driven by that published ladder. See utils/model/lxdThinking.
 *
 * Prompt cache: the relay does not accept Anthropic `cache_control` markers,
 * so those are stripped (`cacheControlMode: 'none'`) and cache hits ride on
 * prefix stability instead -- identical system + tools + message prefix across
 * turns. `prompt_cache_key`/`user` carry the stable Tau session id so a relay
 * that load-balances across upstream replicas pins this conversation to one
 * of them; without that pin every turn lands on a cold KV cache. LXD is
 * registered in cacheAffinity's STABLE_REQUEST_SESSION_PROVIDERS so the id
 * actually reaches this hook.
 */

import type { Transformer, TransformContext, HeaderContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import {
  filterLxdModelCatalog,
  getLxdModelMeta,
  lxdMaxOutputTokens,
  lxdStaticCatalog,
  recordLxdCatalog,
  LXD_MAX_OUTPUT_TOKENS,
  type LxdCatalogRow,
} from '../../../utils/model/lxdCatalog.js'
import { resolveLxdRequestEffort } from '../../../utils/model/lxdThinking.js'

export const lxdTransformer: Transformer = {
  id: 'lxd',
  displayName: 'LXD API',
  defaultBaseUrl: 'https://api.lxds.org/v1',

  buildHeaders(_apiKey: string, ctx?: HeaderContext): Record<string, string> {
    // Same idea as the Fireworks affinity header: a relay that fans out to
    // several upstream replicas can use this to keep one conversation on one
    // replica, which is what makes the prefix cache hit on turn 2+.
    return ctx?.sessionId ? { 'x-session-affinity': ctx.sessionId } : {}
  },

  // The relay forwards tool schemas to a mixed pool of open models; OpenAI's
  // `strict: true` enforcement is not part of its documented surface.
  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return Math.min(Math.max(1, requested), LXD_MAX_OUTPUT_TOKENS)
  },

  preferLiveModelCatalog() {
    return true
  },

  staticCatalog() {
    return lxdStaticCatalog()
  },

  filterModelCatalog(models) {
    // Fold the live rows into the metadata store first so the picker's effort
    // ladders, context windows, and output clamps track whatever LXD serves
    // today -- then drop the image / speech rows from the chat picker.
    recordLxdCatalog(models as unknown as readonly LxdCatalogRow[])
    return filterLxdModelCatalog(models)
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    const bag = body as unknown as Record<string, unknown>

    // Per-model output ceiling, then LXD's documented 32k per-request cap.
    if (typeof body.max_tokens === 'number') {
      body.max_tokens = Math.min(
        Math.max(1, body.max_tokens),
        lxdMaxOutputTokens(ctx.model),
      )
    }

    // Thinking. The picker's per-model pick wins; ctx.reasoningEffort (derived
    // from the caller's thinking budget) is the fallback so a model whose row
    // is left on "Default" still reasons when the caller asked it to. Only
    // send a level this model actually publishes -- the ladders differ per row
    // and an unsupported value is a 400 waiting to happen.
    const meta = getLxdModelMeta(ctx.model)
    const supported = meta?.reasoningEfforts ?? []
    if (supported.length > 0) {
      const picked = resolveLxdRequestEffort(ctx.model)
      const fallback = ctx.isReasoning ? ctx.reasoningEffort : null
      const effort = picked ?? fallback
      if (effort && supported.includes(effort)) {
        body.reasoning_effort = effort
      } else {
        delete bag.reasoning_effort
      }
    } else {
      delete bag.reasoning_effort
    }

    // Cache affinity: pin the conversation to one upstream replica.
    if (ctx.sessionId) {
      body.prompt_cache_key = ctx.sessionId
      body.user = ctx.sessionId
    } else {
      delete bag.prompt_cache_key
      delete bag.user
    }

    // Everything below is outside LXD's documented request surface. Anthropic
    // and OpenAI-Responses leftovers in particular would either 400 or be
    // forwarded verbatim to an upstream that rejects them.
    delete bag.reasoning
    delete bag.thinking
    delete bag.stream_options
    delete bag.store
    delete bag.prompt_cache_retention
    delete bag.transforms
    delete bag.plugins
    delete bag.route
    delete bag.models
    delete bag.extra_body
    delete bag.providerOptions
    delete bag.perf_metrics_in_response

    // Documented ranges: temperature 0..2, top_p 0..1. Drop rather than clamp
    // at zero so the relay's own default applies.
    if (typeof body.temperature === 'number') {
      if (body.temperature < 0) delete bag.temperature
      else if (body.temperature > 2) body.temperature = 2
    }
    if (typeof body.top_p === 'number') {
      if (body.top_p <= 0) delete bag.top_p
      else if (body.top_p > 1) body.top_p = 1
    }

    return body
  },

  schemaDropList(): Set<string> {
    // Mixed open-model pool behind the relay -- keep the schemas plain.
    return new Set([
      '$schema',
      '$id',
      '$ref',
      '$comment',
      'strict',
      'pattern',
      'format',
      'default',
      'examples',
    ])
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'prompt is too long',
      'token limit',
      'too long',
      'tokens exceed',
      'exceed token',
      'maximum context',
      // The relay localizes some errors to Arabic.
      'السياق',
      'تجاوز',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    // Open-weight pool: SEARCH/REPLACE blocks land far more reliably than
    // unified diffs across GLM / Llama / Gemma / Qwen rows.
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    // Cheapest row on the board at 10 / 54 Xen per 1M.
    return 'gpt-oss-120b'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    // The relay has no Anthropic-style cache_control surface; caching is
    // implicit prefix caching upstream. Leaving the markers on would ship
    // fields no backend here understands.
    return 'none'
  },
}
