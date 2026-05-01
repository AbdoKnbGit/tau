/**
 * OpenRouter transformer.
 *
 * - Injects `HTTP-Referer` + `X-Title` headers so OpenRouter's
 *   analytics credit ClaudeX.
 * - cache_control is PASSED THROUGH for Anthropic/Gemini models (they
 *   natively support it); stripped for everything else so OpenRouter
 *   doesn't surface it as an unknown-field warning.
 * - Accepts `reasoning: { effort }` for reasoning-capable upstreams.
 * - Honors `function.strict: true` for the underlying model.
 * - `transforms`/`route`/`models` are OpenRouter-specific fields that
 *   pass through as-is.
 */

import type { Transformer, TransformContext } from './base.js'
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

  buildHeaders(_apiKey: string): Record<string, string> {
    return {
      'HTTP-Referer': 'https://github.com/AbdoKnbGit/claudex',
      'X-Title': 'ClaudeX',
    }
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
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
    // Free-tier parent ⇒ free fast model. Otherwise the title /
    // tool-use-summary side calls would silently leave the free credit
    // pool, surprise-billing the user.
    if (m.endsWith(':free')) return 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
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
