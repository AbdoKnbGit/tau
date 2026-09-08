/**
 * OpenRouter transformer.
 *
 * - Injects OpenRouter app-attribution headers so rankings credit Tau
 *   under the CLI agent category.
 * - cache_control is PASSED THROUGH on OpenRouter broadly. OpenRouter's chat
 *   schema accepts cache_control on content parts and function tools, and
 *   drops/normalizes it for upstreams that do not use explicit breakpoints.
 * - Accepts `reasoning: { effort }` for reasoning-capable upstreams.
 * - Sends OpenRouter session affinity/cache fields when a stable session id is present.
 * - OPENROUTER_PROVIDER_ORDER can pin upstream provider routing. OpenRouter's
 *   session-id sticky routing is BEST-EFFORT: multi-provider pools (e.g.
 *   deepseek/*) re-route under load, and every re-route is a full prompt-cache
 *   cold start on the new provider even when the prefix is byte-stable. A
 *   pinned order makes the cache chain deterministic.
 * - Can enable OpenRouter context-compression by env so over-context prompts
 *   may use the gateway's middle-out compressor instead of failing.
 * - Honors `function.strict: true` for the underlying model.
 * - `transforms`/`route`/`models` are OpenRouter-specific fields that
 *   pass through as-is.
 */

import type { Transformer, TransformContext, HeaderContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import {
  isStrictToolSchemaOnOpenRouter,
  normalizeOpenAIStrictToolSchema,
} from '../../../utils/model/openrouterStrictSchema.js'
import { resolveOpenRouterReasoningField } from '../../../utils/model/openrouterThinking.js'
import { getOpenRouterReasoningMeta } from '../../../utils/model/openrouterReasoningCatalog.js'

export const openrouterTransformer: Transformer = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    // OpenRouter reserves credit = max_tokens * price upfront. The upstream
    // 32k default from context.ts triggers 402 "requires more credits, or
    // fewer max_tokens" on free/low-credit accounts. 8192 fits typical
    // free credit allowances and still leaves room for long tool arguments
    // and multi-line code emissions.
    return requested > 8192 ? 8192 : requested
  },

  buildHeaders(_apiKey: string, ctx?: HeaderContext): Record<string, string> {
    const referer = process.env.OPENROUTER_REFERER ?? 'https://github.com/AbdoKnbGit/tau'
    const title = process.env.OPENROUTER_TITLE ?? 'Tau'
    const categories = process.env.OPENROUTER_CATEGORIES ?? 'cli-agent'

    return {
      'HTTP-Referer': referer,
      'X-OpenRouter-Title': title,
      'X-OpenRouter-Categories': categories,
      'X-Title': title,
      ...(ctx?.sessionId ? { 'x-session-id': normalizeOpenRouterSessionId(ctx.sessionId) } : {}),
    }
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (ctx.sessionId) {
      const sessionKey = normalizeOpenRouterSessionId(ctx.sessionId)
      body.session_id = sessionKey
      const retention = resolveOpenRouterCacheRetention()
      if (retention !== 'none') {
        body.prompt_cache_key = sessionKey
        if (retention === 'long') body.prompt_cache_retention = '24h'
      }
    }

    applyOpenRouterToolCacheBreakpoint(body)
    applyOpenRouterContextCompressionPlugin(body)
    applyOpenRouterProviderRouting(body, ctx.sessionId)

    applyOpenRouterReasoning(body, ctx)
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  // Gemini routed via OpenRouter passes through the Gemini schema
  // validator on the upstream side, which has stricter rules than the
  // base OpenAI Chat shape:
  //   - integer/number enum values must be STRINGS.
  //   - `array` nodes must have an `items` schema.
  //   - non-object types must not have `properties` / `required`.
  //   - `required` must only list fields that exist in `properties`.
  // Mirrors opencode's `sanitizeGemini` in provider/transform.ts:1329.
  // Other upstreams on OR (Anthropic, OpenAI, Llama, …) accept the
  // base shape, so the sanitizer is gated on the model id.
  //
  // Separately, some upstreams (OpenAI's own rows, and — as of Muse Spark —
  // Meta's) run OpenAI's strict function-schema validator, which demands
  // `required` name every key in `properties`. That set is learned from the
  // upstream's own 400 rather than listed here; see openrouterStrictSchema.ts.
  sanitizeToolSchemaExtra(schema: Record<string, unknown>, modelId: string): Record<string, unknown> {
    if (isGeminiOnOR(modelId)) return sanitizeGeminiSchema(schema) as Record<string, unknown>
    if (isStrictToolSchemaOnOpenRouter(modelId)) return normalizeOpenAIStrictToolSchema(schema)
    return schema
  },

  // Per-model default generation params. OpenRouter hosts many
  // upstreams; defaults follow opencode's model-id matrix:
  //   - Gemini family → temperature 1.0, top_p 0.95, top_k 64.
  //   - Qwen family → temperature 0.55, top_p 1.0.
  //   - MiniMax-M2 → temperature 1.0, top_p 0.95, top_k 20–40.
  //   - Kimi K2 family → 0.6 / 1.0 depending on variant.
  defaultGenerationParams(model: string) {
    const id = model.toLowerCase()
    if (id.includes('google/gemini') || id.includes('gemini')) {
      return { temperature: 1.0, top_p: 0.95, top_k: 64 }
    }
    if (id.includes('qwen')) {
      return { temperature: 0.55, top_p: 1.0 }
    }
    if (id.includes('minimax-m2') || id.includes('minimax/m2')) {
      const k = ['m2.', 'm25', 'm21'].some(s => id.includes(s)) ? 40 : 20
      return { temperature: 1.0, top_p: 0.95, top_k: k }
    }
    if (id.includes('kimi-k2') || id.includes('moonshot/kimi-k2')) {
      const isThinking = ['thinking', 'k2.', 'k2p', 'k2-5'].some(s => id.includes(s))
      return isThinking
        ? { temperature: 1.0, top_p: 0.95 }
        : { temperature: 0.6 }
    }
    return undefined
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'maximum context']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    // Frontier models routed via OpenRouter: keep apply_patch.
    if (m.includes('anthropic/') || m.includes('claude-')) return 'apply_patch'
    if (m.includes('openai/gpt-5') || m.includes('openai/o1') || m.includes('openai/o3')) return 'apply_patch'
    if (m.includes('google/gemini-3') || m.includes('google/gemini-2.5')) return 'apply_patch'
    // Everything else on OpenRouter → SEARCH/REPLACE (safer for non-frontier).
    return 'edit_block'
  },

  smallFastModel(model: string): string | null {
    // OpenRouter sticky/cache routing is per account + model + session. Do
    // not substitute helper/side-query traffic onto a different OpenRouter
    // model: that splits cache stats and warms a separate provider cache.
    void model
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    // Keep this provider-scoped, not model-scoped: opencode applies
    // OpenRouter cache-control provider options broadly, and OpenRouter's
    // current schema accepts cache_control content parts generally. The lane
    // still keeps volatile env/date/git context out of stamped messages.
    // Within last-only the lane branches per family: Anthropic-style rolling
    // trailing stamps for most models, a single quantized anchor for
    // google/gemini-* (see or_gemini_cache.ts).
    void model
    return 'last-only'
  },
}

type OpenRouterCacheRetention = 'none' | 'short' | 'long'
type OpenRouterContextCompressionMode = 'enabled' | 'disabled'

function applyOpenRouterToolCacheBreakpoint(body: OpenAIChatRequest): void {
  if (!body.tools?.length) return

  // A single marker on the final tool definition covers the stable tool
  // schema prefix without spending one breakpoint per tool. Together with
  // system + two rolling message markers this stays within Anthropic's
  // four-breakpoint budget while helping OpenRouter tool-heavy turns.
  // For Gemini upstreams this stamp is inert on its own (live-measured: no
  // reads, no writes, never billed), but combined with the lane's single
  // message anchor (or_gemini_cache.ts) it is the recipe that reliably
  // triggers Gemini's synchronous explicit cache from turn 1 — so it stays
  // applied for every OpenRouter model family.
  const lastTool = body.tools[body.tools.length - 1]
  if (lastTool && !lastTool.cache_control) {
    lastTool.cache_control = { type: 'ephemeral' }
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

function resolveOpenRouterCacheRetention(): OpenRouterCacheRetention {
  const raw = (
    process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION
    ?? process.env.OPENROUTER_CACHE_RETENTION
    ?? ''
  ).trim().toLowerCase()

  if (raw === 'none' || raw === 'off' || raw === 'false' || raw === '0' || raw === 'disabled') {
    return 'none'
  }
  if (raw === 'long' || raw === '24h') {
    return 'long'
  }
  return 'short'
}

// ── Session→served-provider auto-pin ─────────────────────────────
//
// OpenRouter's session_id stickiness is BEST-EFFORT: multi-provider pools
// (deepseek/*, qwen/*, …) silently re-route under load, and every re-route is
// a full upstream prompt-cache cold start (measured: 8 resets in a 31-request
// session with session_id + prompt_cache_key on every call). Response chunks
// name the provider that actually served each request, so the lane records it
// and PINS the next request via provider.order. allow_fallbacks stays ON so
// availability is never sacrificed — if OR falls back anyway, the fallback
// provider is recorded and becomes the new pin. Explicit
// OPENROUTER_PROVIDER_ORDER always wins; disable with TAU_OPENROUTER_AUTO_PIN=0.
const _servedProviderBySession = new Map<string, string>()

export function recordOpenRouterServedProvider(
  sessionId: string | undefined,
  model: string,
  servedProvider: string,
): void {
  if (!sessionId) return
  const slug = normalizeOpenRouterProviderSlug(servedProvider)
  if (!slug) return
  const key = `${sessionId}:${model.toLowerCase()}`
  const prev = _servedProviderBySession.get(key)
  if (prev !== slug && process.env.TAU_CACHE_DEBUG) {
    // A provider switch means this request ran against a cold upstream
    // cache. Surfacing it separates routing misses from prefix churn.
    console.error(
      `[tau-or] ${model} served by "${slug}"${prev ? ` (was "${prev}")` : ''}`,
    )
  }
  _servedProviderBySession.set(key, slug)
  if (_servedProviderBySession.size > 512) {
    const oldest = _servedProviderBySession.keys().next().value
    if (oldest !== undefined) _servedProviderBySession.delete(oldest)
  }
}

/**
 * The response `provider` field is a display name ("DeepSeek",
 * "Amazon Bedrock"); `provider.order` wants slugs ("deepseek",
 * "amazon-bedrock").
 */
function normalizeOpenRouterProviderSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

export function _resetOpenRouterAutoPinForTest(): void {
  _servedProviderBySession.clear()
}

/**
 * Provider routing, two layers:
 *  1. Explicit env pin: OPENROUTER_PROVIDER_ORDER="deepseek,fireworks" (or
 *     CLAUDEX_-prefixed) becomes `provider: { order: [...] }`, plus
 *     OPENROUTER_ALLOW_FALLBACKS=false → `allow_fallbacks: false`.
 *  2. Auto-pin (default on): re-use the provider that served this
 *     session+model last, keeping the upstream prompt cache warm.
 */
function applyOpenRouterProviderRouting(
  body: OpenAIChatRequest,
  sessionId?: string,
): void {
  const bag = body as unknown as Record<string, unknown>
  const raw = (
    process.env.CLAUDEX_OPENROUTER_PROVIDER_ORDER
    ?? process.env.OPENROUTER_PROVIDER_ORDER
    ?? ''
  ).trim()
  const explicitOrder = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []

  if (explicitOrder.length > 0) {
    const provider = (
      bag.provider && typeof bag.provider === 'object' ? bag.provider : {}
    ) as Record<string, unknown>
    if (provider.order === undefined) provider.order = explicitOrder

    const fallbacks = (
      process.env.CLAUDEX_OPENROUTER_ALLOW_FALLBACKS
      ?? process.env.OPENROUTER_ALLOW_FALLBACKS
      ?? ''
    ).trim().toLowerCase()
    if (['false', '0', 'off', 'no'].includes(fallbacks)) {
      provider.allow_fallbacks = false
    }
    bag.provider = provider
    return
  }

  if (process.env.TAU_OPENROUTER_AUTO_PIN === '0') return
  if (!sessionId) return
  const pinned = _servedProviderBySession.get(`${sessionId}:${body.model.toLowerCase()}`)
  if (!pinned) return

  const provider = (
    bag.provider && typeof bag.provider === 'object' ? bag.provider : {}
  ) as Record<string, unknown>
  // allow_fallbacks stays default (true): availability first — a fallback
  // response gets recorded and becomes the new pin.
  if (provider.order === undefined) provider.order = [pinned]
  bag.provider = provider
}

function resolveOpenRouterContextCompressionMode(): OpenRouterContextCompressionMode {
  const raw = (
    process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION
    ?? process.env.OPENROUTER_CONTEXT_COMPRESSION
    ?? ''
  ).trim().toLowerCase()

  if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'enabled') {
    return 'enabled'
  }
  return 'disabled'
}

function applyOpenRouterContextCompressionPlugin(body: OpenAIChatRequest): void {
  const mode = resolveOpenRouterContextCompressionMode()
  const existing = body.plugins?.find(plugin => plugin.id === 'context-compression')
  if (mode === 'disabled') {
    if (existing) existing.enabled = false
    return
  }

  body.plugins = body.plugins ?? []
  if (existing) {
    delete existing.enabled
    return
  }
  body.plugins.push({ id: 'context-compression' })
}

function isGeminiOnOR(model: string): boolean {
  const m = model.toLowerCase()
  return m.startsWith('google/gemini') || m.includes('gemini-')
}

/**
 * Gemini upstream sanitizer. Mirrors opencode's `sanitizeGemini` in
 * provider/transform.ts. Returns a fresh object — never mutates input.
 */
function sanitizeGeminiSchema(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(sanitizeGeminiSchema)

  const obj = node as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'enum' && Array.isArray(v)) {
      result[k] = v.map(item => String(item))
      // Integer/number enums become string enums; the type field must
      // follow suit or Gemini 400s with "type mismatch in enum".
      if (result.type === 'integer' || result.type === 'number') {
        result.type = 'string'
      }
    } else if (v !== null && typeof v === 'object') {
      result[k] = sanitizeGeminiSchema(v)
    } else {
      result[k] = v
    }
  }

  // `required` must only list fields that exist in `properties`. MCP
  // tools occasionally list required fields that aren't declared
  // (validator quirk) — Gemini rejects those.
  if (result.type === 'object' && result.properties && Array.isArray(result.required)) {
    const props = result.properties as Record<string, unknown>
    result.required = (result.required as unknown[]).filter(
      (f): f is string => typeof f === 'string' && f in props,
    )
  }

  // Array nodes must carry an `items` schema. Default to `string`
  // when the original schema was loose (e.g. JSON `{ type: "array" }`).
  if (result.type === 'array' && !hasCombiner(result)) {
    if (result.items == null) result.items = { type: 'string' }
    else if (
      typeof result.items === 'object' &&
      !Array.isArray(result.items) &&
      !hasSchemaIntent(result.items as Record<string, unknown>)
    ) {
      ;(result.items as Record<string, unknown>).type = 'string'
    }
  }

  // Non-object nodes must not declare `properties` / `required`.
  if (result.type && result.type !== 'object' && !hasCombiner(result)) {
    delete result.properties
    delete result.required
  }
  return result
}

function hasCombiner(node: Record<string, unknown>): boolean {
  return Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)
}

function hasSchemaIntent(node: Record<string, unknown>): boolean {
  if (hasCombiner(node)) return true
  return [
    'type', 'properties', 'items', 'prefixItems', 'enum', 'const', '$ref',
    'additionalProperties', 'patternProperties', 'required', 'not', 'if',
    'then', 'else',
  ].some(k => k in node)
}

/**
 * Put the `reasoning` knob on the body — or deliberately nothing.
 *
 * OpenRouter publishes, per model, whether the row reasons at all, whether
 * reasoning can be switched off, and which effort values it accepts. That
 * catalogue is the authority here (openrouterThinking.ts turns it into the
 * picker's ladder and the field below), because the ladders genuinely differ:
 * `meta/muse-spark-1.3` takes minimal…max, `x-ai/grok-4.20` takes only
 * low/high/max, and sending a value a row did not publish is a 400.
 *
 * The family list below is the fallback for a model the catalogue has not
 * described yet — a cold cache, or a refresh that could not reach the network.
 * Llama-4 / prompt-guard / base-chat Llamas routed via Vertex answer "thinking
 * is not supported by this model" when reasoning is set, so an unknown row
 * still gets silence rather than a guess.
 */
function applyOpenRouterReasoning(
  body: OpenAIChatRequest,
  ctx: TransformContext,
): void {
  if (getOpenRouterReasoningMeta(body.model)) {
    const reasoning = resolveOpenRouterReasoningField(body.model, {
      enabled: ctx.isReasoning,
      effort: ctx.reasoningEffort,
    })
    if (reasoning) body.reasoning = reasoning
    // Saying nothing is a deliberate answer here — it leaves OpenRouter's own
    // default_effort in charge — so any value a caller pre-set is cleared
    // rather than shipped past the ladder that just rejected it.
    else delete body.reasoning
    return
  }

  if (ctx.isReasoning && ctx.reasoningEffort && openrouterModelSupportsReasoning(body.model)) {
    body.reasoning = { effort: ctx.reasoningEffort }
  }
}

function openrouterModelSupportsReasoning(model: string): boolean {
  const m = model.toLowerCase()
  // Known reasoning-capable families on OpenRouter:
  if (m.includes('deepseek-r1') || m.includes('deepseek/deepseek-r')) return true
  if (m.includes('qwen/qwq') || m.includes('qwen3')) return true
  if (m.includes('openai/o1') || m.includes('openai/o3') || m.includes('openai/o4')) return true
  if (m.includes('openai/gpt-5')) return true
  if (m.includes('anthropic/claude-3-7') || m.includes('anthropic/claude-sonnet-4') || m.includes('anthropic/claude-opus-4')) return true
  if (m.includes('google/gemini-2.5') || m.includes('google/gemini-3')) return true
  if (m.includes('xai/grok-3') || m.includes('xai/grok-4')) return true
  // Everything else (including base Llama, Llama-4, prompt-guard,
  // orpheus, gemma, mistral-small, etc.) — no reasoning knob.
  return false
}
