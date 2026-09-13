/**
 * Moonshot AI / Kimi transformer.
 *
 * Moonshot is OpenAI-compatible but rejects several OpenAI/Responses-only
 * extensions. Kimi K2 thinking models emit reasoning_content directly on
 * stream deltas, which the shared compat loop renders as thinking blocks.
 */

import { getDirectModelMeta } from '../../../utils/model/directProviderCatalog.js'
import { directThinkingFields } from '../../../utils/model/directProviderThinking.js'
import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatMessage, OpenAIChatRequest } from './shared_types.js'
import {
  filterMoonshotModelCatalog,
  isMoonshotThinkingModel,
  normalizeMoonshotModelId,
} from '../../../utils/model/moonshotCatalog.js'

export const moonshotTransformer: Transformer = {
  id: 'moonshot',
  displayName: 'Moonshot AI',
  defaultBaseUrl: 'https://api.moonshot.ai/v1',

  supportsStrictMode: () => false,

  preferLiveModelCatalog() {
    return true
  },

  filterModelCatalog(models) {
    return filterMoonshotModelCatalog(models)
  },

  clampMaxTokens(requested: number): number {
    return requested > 262_144 ? 262_144 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    body.model = normalizeMoonshotModelId(body.model)
    const bag = body as unknown as Record<string, unknown>
    delete bag.reasoning_effort
    delete bag.reasoning
    delete bag.store
    delete bag.prompt_cache_retention
    if (ctx.sessionId) body.prompt_cache_key = ctx.sessionId
    else delete bag.prompt_cache_key

    const meta = getDirectModelMeta('moonshot', body.model)
    delete body.thinking
    if (meta) {
      const fields = directThinkingFields('moonshot', body.model)
      Object.assign(body, fields)
      if (body.max_tokens) body.max_tokens = Math.min(body.max_tokens, meta.maxOutputTokens)
      if (fields.thinking?.type === 'disabled') body.messages = body.messages.map(stripMoonshotReasoningContent)
    } else if (supportsMoonshotThinkingToggle(body.model)) {
      body.thinking = { type: ctx.isReasoning ? 'enabled' : 'disabled' }
      if (!ctx.isReasoning) body.messages = body.messages.map(stripMoonshotReasoningContent)
    } else if (!isMoonshotThinkingModel(body.model)) {
      body.messages = body.messages.map(stripMoonshotReasoningContent)
    }

    return body
  },

  normalizeStreamDelta(): void {
    // Kimi reasoning models already emit reasoning_content.
  },

  schemaDropList(): Set<string> {
    // NB: we DELIBERATELY keep `$ref` in the schema — it's needed for
    // some MCP tools and Moonshot accepts it as long as the $ref node
    // has no sibling keys. sanitizeToolSchemaExtra() enforces that
    // constraint downstream.
    return new Set(['$schema', '$id', '$comment', 'strict', 'format', 'default'])
  },

  // Moonshot's MFJS validator expands `$ref` before checking sibling
  // keywords and rejects any sibling (e.g. `{ $ref: "#/...", description: "..." }`)
  // with a hard 400. MFJS also requires array `items` to be a single
  // schema, not a tuple — `items: [a, b]` 400s. Both are quirks the
  // flat schemaDropList() can't express because they're structural,
  // not key-based. Mirrors opencode's sanitizeMoonshot() in
  // provider/transform.ts:1285.
  sanitizeToolSchemaExtra(schema: Record<string, unknown>): Record<string, unknown> {
    return sanitizeMoonshotSchema(schema) as Record<string, unknown>
  },

  // Per-model default generation params. Mirrors opencode's
  // temperature() / topP() in provider/transform.ts:481+. Kimi
  // documents 0.6 for non-thinking K2 and 1.0/0.95 for the thinking
  // variants. Frontier overrides from claude.ts still win — these
  // only fill in `undefined`.
  defaultGenerationParams(model: string) {
    const id = model.toLowerCase()
    if (!id.includes('kimi') && !id.includes('moonshot')) return undefined
    const isThinking = isMoonshotThinkingModel(id)
    if (isThinking) return { temperature: 1.0, top_p: 0.95 }
    return { temperature: 0.6 }
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'prompt is too long',
      'token limit',
      'too long',
      'tokens exceed',
      'exceeded model token limit',
      'request exceeded model token limit',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'kimi-k2.7-code-highspeed'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },
}

function supportsMoonshotThinkingToggle(model: string): boolean {
  const normalized = normalizeMoonshotModelId(model)
  return normalized === 'kimi-k2.5' || normalized === 'kimi-k2.6'
}

function stripMoonshotReasoningContent(message: OpenAIChatMessage): OpenAIChatMessage {
  if (message.reasoning_content === undefined) return message
  const { reasoning_content: _reasoningContent, ...rest } = message
  return rest
}

// Recursive sanitizer for Moonshot-specific JSON-Schema quirks:
//   1. `$ref` nodes must have NO siblings — drop everything else on
//      that node when `$ref` is present.
//   2. `items: [schema, …]` (tuple form) → `items: schema` (single).
//      Drops every entry after the first, then drills in.
function sanitizeMoonshotSchema(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(sanitizeMoonshotSchema)

  const obj = node as Record<string, unknown>
  if (typeof obj.$ref === 'string') {
    return { $ref: obj.$ref }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeMoonshotSchema(v)
  }
  if (Array.isArray(out.items)) {
    out.items = out.items[0] ?? {}
  }
  return out
}
