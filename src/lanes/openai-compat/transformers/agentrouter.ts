/**
 * AgentRouter transformer (https://agentrouter.org).
 *
 * Independent OpenRouter-style gateway. Speaks the OpenAI Chat
 * Completions wire format. Curated catalog of 8 models exposed by the
 * upstream:
 *   - claude-haiku-4-5-20251001, claude-opus-4-6      (Anthropic family)
 *   - glm-4.5, glm-4.6, glm-5.1                       (Z.ai GLM family)
 *   - deepseek-r1-0528, deepseek-v3.1, deepseek-v3.2  (DeepSeek family)
 *
 * cache_control: passed through with `last-only` placement for the
 * Claude rows so the upstream Anthropic gateway sees the rolling
 * 3-breakpoint cache anchor (system + last two user/tool turns) and
 * actually hits the prefix cache instead of cold-writing every turn.
 * For GLM and DeepSeek rows the field is stripped — those upstreams
 * don't honor Anthropic-style cache_control and may 400 on unknown
 * fields. Their server-side implicit caches still work without it.
 *
 * prompt_cache_key: stamped from the stable claudex sessionId on Claude
 * rows. Without it the gateway free-routes each turn to a different
 * upstream Anthropic backend, so the cache_control breakpoints land on
 * a cold prefix every time — visible as both ~100% cache-write usage
 * and the ~1-minute prefill latency users see on long sessions. The
 * key alone gives the gateway enough affinity hint to keep a session
 * pinned to the same backend, which is where the markers actually hit.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

const AGENTROUTER_MODELS: Array<{ id: string; name: string }> = [
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (2025-10-01)' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'glm-4.5', name: 'GLM 4.5' },
  { id: 'glm-4.6', name: 'GLM 4.6' },
  { id: 'glm-5.1', name: 'GLM 5.1' },
  { id: 'deepseek-r1-0528', name: 'DeepSeek R1 (2025-05-28)' },
  { id: 'deepseek-v3.1', name: 'DeepSeek V3.1' },
  { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
]

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().startsWith('claude-')
}

function isReasoningCapable(model: string): boolean {
  const m = model.toLowerCase()
  if (m.startsWith('claude-opus-4') || m.startsWith('claude-haiku-4')) return true
  if (m.includes('deepseek-r1')) return true
  if (m.startsWith('glm-5')) return true
  return false
}

export const agentrouterTransformer: Transformer = {
  id: 'agentrouter',
  displayName: 'AgentRouter',
  defaultBaseUrl: 'https://agentrouter.org/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    // Anchor the gateway to the same upstream backend across turns.
    // Only Claude rows benefit (cache_control breakpoints are Claude-only
    // here); the other families either implicit-cache server-side or
    // don't cache at all. Field is silently ignored on backends that
    // don't recognize it, so adding it for non-Claude rows is harmless
    // but unnecessary.
    if (ctx.sessionId && isClaudeModel(body.model)) {
      body.prompt_cache_key = ctx.sessionId
    }
    if (ctx.isReasoning && ctx.reasoningEffort && isReasoningCapable(body.model)) {
      body.reasoning = { effort: ctx.reasoningEffort }
    }
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'maximum context']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    if (isClaudeModel(model)) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(model: string): string | null {
    if (isClaudeModel(model)) return 'claude-haiku-4-5-20251001'
    if (model.toLowerCase().includes('deepseek')) return 'deepseek-v3.2'
    if (model.toLowerCase().startsWith('glm-')) return 'glm-4.6'
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    if (isClaudeModel(model)) return 'last-only'
    return 'none'
  },

  staticCatalog(): Array<{ id: string; name: string }> {
    return AGENTROUTER_MODELS.map(m => ({ ...m }))
  },
}
