/**
 * OpenRouter transformer.
 *
 * - Injects OpenRouter app-attribution headers so rankings credit Tau
 *   under the CLI agent category.
 * - cache_control is PASSED THROUGH for Anthropic/Gemini models (they
 *   natively support it); stripped for everything else so OpenRouter
 *   doesn't surface it as an unknown-field warning.
 * - Accepts `reasoning: { effort }` for reasoning-capable upstreams.
 * - Sends OpenRouter session affinity/cache fields when a stable session id is present.
 * - Enables OpenRouter context-compression by default so over-context prompts
 *   use the gateway's middle-out compressor instead of failing.
 * - Honors `function.strict: true` for the underlying model.
 * - `transforms`/`route`/`models` are OpenRouter-specific fields that
 *   pass through as-is.
 */

import type { Transformer, TransformContext, HeaderContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

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
      ...(ctx?.sessionId ? { 'x-session-id': openRouterSessionKey(ctx.sessionId, ctx.model) } : {}),
    }
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    if (ctx.sessionId) {
      const sessionKey = openRouterSessionKey(ctx.sessionId, body.model)
      body.session_id = sessionKey
      const retention = resolveOpenRouterCacheRetention()
      if (retention !== 'none') {
        body.prompt_cache_key = sessionKey
        if (retention === 'long') body.prompt_cache_retention = '24h'
      }
    }

    applyOpenRouterContextCompressionPlugin(body)

    // Only emit the reasoning knob for models that actually support it.
    // Llama-4 / prompt-guard / base-chat Llamas routed via Vertex return
    // "thinking is not supported by this model" when reasoning is set.
    if (ctx.isReasoning && ctx.reasoningEffort && openrouterModelSupportsReasoning(body.model)) {
      body.reasoning = { effort: ctx.reasoningEffort }
    }
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
  sanitizeToolSchemaExtra(schema: Record<string, unknown>, modelId: string): Record<string, unknown> {
    if (!isGeminiOnOR(modelId)) return schema
    return sanitizeGeminiSchema(schema) as Record<string, unknown>
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
    const m = model.toLowerCase()
    // Free-tier parent: reuse the selected model. Routing side queries to a
    // different free model splits cache/session accounting and shows up as a
    // giant cold-context bucket on that helper model.
    if (m.endsWith(':free')) return null
    if (m.startsWith('anthropic/')) return 'anthropic/claude-haiku-4-5'
    if (m.startsWith('openai/')) return 'openai/gpt-4o-mini'
    if (m.startsWith('google/')) return 'google/gemini-2.5-flash-lite'
    if (m.startsWith('meta-llama/') || m.startsWith('meta/')) return 'meta-llama/llama-3.3-8b-instruct'
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    // OpenRouter enforces Anthropic's 4-breakpoint cap by relocating
    // cache_control to the last text block. For other underlying
    // providers the field is silently ignored.
    const m = model.toLowerCase()
    if (m.includes('anthropic/') || m.includes('claude-')) return 'last-only'
    if (m.includes('google/gemini')) return 'last-only'
    return 'none'
  },
}

type OpenRouterCacheRetention = 'none' | 'short' | 'long'
type OpenRouterContextCompressionMode = 'enabled' | 'disabled'

function openRouterSessionKey(sessionId: string, model: string): string {
  return normalizeOpenRouterSessionId(`${sessionId}:${model.toLowerCase()}`)
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

function resolveOpenRouterContextCompressionMode(): OpenRouterContextCompressionMode {
  const raw = (
    process.env.CLAUDEX_OPENROUTER_CONTEXT_COMPRESSION
    ?? process.env.OPENROUTER_CONTEXT_COMPRESSION
    ?? ''
  ).trim().toLowerCase()

  if (raw === 'none' || raw === 'off' || raw === 'false' || raw === '0' || raw === 'disabled') {
    return 'disabled'
  }
  return 'enabled'
}

function applyOpenRouterContextCompressionPlugin(body: OpenAIChatRequest): void {
  const mode = resolveOpenRouterContextCompressionMode()
  const existing = body.plugins?.find(plugin => plugin.id === 'context-compression')
  if (existing) {
    if (mode === 'disabled') existing.enabled = false
    return
  }

  body.plugins = body.plugins ?? []
  body.plugins.push(
    mode === 'disabled'
      ? { id: 'context-compression', enabled: false }
      : { id: 'context-compression' },
  )
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
