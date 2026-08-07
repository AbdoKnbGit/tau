/**
 * Groq transformer.
 *
 * - Strips cache_control from messages (Groq validator rejects).
 * - Strips `$schema`/`strict` from tool params.
 * - Strips null `function_call` fields from assistant messages.
 * - Accepts `reasoning_effort` on reasoning-capable models.
 * - Emits `reasoning` on delta — normalize to `reasoning_content`.
 *
 * Strict mode is OFF: Groq's Llama validator enforces the full OpenAI
 * strict contract (additionalProperties:false on every object + every
 * property in required). Our tools declare optional fields, so strict
 * would reject. Without strict the models still call tools correctly —
 * the description hint in tools.ts carries schema constraints in-prompt.
 * Only openai/gpt-oss-20b on Groq tolerates non-strict schemas under
 * strict:true; other models 400 with "additionalProperties:false must
 * be set on every object".
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest, OpenAIChatMessage } from './shared_types.js'
import { RUST_TOOL_NAME } from '../../../tools/RustTool/constants.js'

export const groqTransformer: Transformer = {
  id: 'groq',
  displayName: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    // `reasoning_effort` is only accepted by reasoning-capable Groq
    // models (gpt-oss). Llama-3.x 400s with "reasoning_effort is not
    // supported with this model" when the knob is sent.
    if (ctx.isReasoning && ctx.reasoningEffort && groqModelSupportsReasoning(body.model)) {
      body.reasoning_effort = ctx.reasoningEffort
    }
    // Strip null tool_calls field that Groq's validator rejects.
    body.messages = body.messages.map(m => {
      const tc = (m as { tool_calls?: unknown }).tool_calls
      if (tc === null) {
        const { tool_calls: _tool_calls, ...rest } = m as OpenAIChatMessage & { tool_calls?: unknown }
        return rest as OpenAIChatMessage
      }
      return m
    })
    return body
  },

  normalizeStreamDelta(delta, _finishReason): void {
    // Groq uses `reasoning` where most providers use `reasoning_content`.
    const d = delta as { reasoning?: string; reasoning_content?: string }
    if (typeof d.reasoning === 'string' && !d.reasoning_content) {
      d.reasoning_content = d.reasoning
    }
  },

  schemaDropList(): Set<string> {
    // Keep `additionalProperties` — Groq's Llama validator requires it
    // when strict is on, and ignores it when strict is off. Drop only
    // the JSON-Schema meta fields and legacy `strict` marker.
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict'])
  },

  contextExceededMarkers(): string[] {
    // Groq free-tier / on-demand surfaces two distinct overflow classes:
    //   1. Context-window exceeded (model's native token limit).
    //   2. TPM rate limit ("Request too large for model ... tokens per
    //      minute (TPM): Limit 8000, Requested 53003"). Both are fixed
    //      by reactive-compacting the conversation, so we map both to
    //      PromptTooLongError via these markers.
    return [
      'context_length_exceeded', 'prompt is too long', 'too many tokens',
      'context window',
      // TPM rate-limit phrasings (trigger reactive compact — a smaller
      // turn fits under the per-minute budget).
      'request too large', 'reduce the length of the messages',
      'tokens per minute', 'rate_limit_exceeded',
    ]
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    // Llama-3.3+ and Kimi K2 handle edit_block reasonably.
    if (m.includes('llama') || m.includes('kimi')) return 'edit_block'
    return 'str_replace'
  },

  smallFastModel(_model: string): string | null {
    return 'llama-3.1-8b-instant'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  filterModelCatalog(models: Array<{ id: string; name?: string }>): Array<{ id: string; name?: string }> {
    return models.filter(m => GROQ_PRODUCTION_MODELS.has(m.id))
  },

  filterTools<T extends { name: string }>(model: string, tools: T[]): T[] {
    // Every Groq chat model on the free / on-demand tier has a tight TPM
    // cap — 6k (llama-8b), 12k (llama-70b), 8k (gpt-oss-*). The full
    // claudex tool suite alone is ~45–55k tokens of JSON-Schema, which
    // blows past all four limits on the first turn. Keep a curated set:
    // core FS + shell + web + Agent delegation + any MCP server the
    // user configured. Upgrading to a paid dev tier lifts the cap and
    // the filter can be relaxed per-model if needed.
    if (!isSmallTierGroqModel(model)) return tools
    return tools.filter(t => GROQ_SMALL_TIER_TOOL_ALLOWLIST.has(t.name)
      || t.name.startsWith('mcp__'))
  },

  skipToolUsagePreamble(model: string): boolean {
    // Every token counts under the per-model TPM cap — the preamble is
    // ~250 tokens of JSON-Schema hygiene that Llama-3.x and gpt-oss
    // already ignore (they follow the description hint instead).
    return isSmallTierGroqModel(model)
  },
}

// Production chat models on Groq per console.groq.com/docs/models —
// the /models list uses this so users don't pick preview / audio-only
// (whisper) / retired endpoints or compound systems. Routing (Groq vs
// OpenRouter for the same model ID) is controlled by the provider the
// user selected in /models, not by this set — both providers host
// `openai/gpt-oss-*`. Each listed model has a tight on-demand TPM
// budget; `filterTools` + `skipToolUsagePreamble` trim the request to
// fit that budget.
const GROQ_PRODUCTION_MODELS = new Set<string>([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
])

function groqModelSupportsReasoning(model: string): boolean {
  const m = model.toLowerCase()
  // Only gpt-oss (both sizes) accepts reasoning_effort on Groq.
  // Llama-3.x does not; whisper is not a chat model.
  if (m.includes('gpt-oss')) return true
  return false
}

function isSmallTierGroqModel(model: string): boolean {
  // Every Groq chat model on the free / on-demand tier has a tight
  // per-minute token cap and 413s on the full claudex tool set:
  //   llama-3.1-8b-instant      → 6000 TPM
  //   llama-3.3-70b-versatile   → 12000 TPM
  //   openai/gpt-oss-20b        → 8000 TPM
  //   openai/gpt-oss-120b       → 8000 TPM
  // So the small-tier filter applies to ALL supported models. Users on
  // a paid Dev tier can lift this by setting CLAUDEX_GROQ_FULL_TOOLS=1
  // (not yet wired — relaxation is one env-var check away).
  const m = model.toLowerCase()
  return m.startsWith('llama-') || m.includes('gpt-oss')
}

// Small-tier allowlist: FS + shell + web + delegation. Keeps the
// request inside the 6k-12k TPM budget while preserving the user's
// ability to spawn sub-agents and call MCP tools (which pass through
// via the mcp__ prefix check above).
const GROQ_SMALL_TIER_TOOL_ALLOWLIST = new Set<string>([
  // Shell
  'Bash',
  // Filesystem
  'Read', 'Write', 'Edit',
  // Search
  'Grep', 'Glob',
  // Web
  'WebSearch', 'WebFetch',
  // Delegation / MCP entrypoint
  'Agent', 'Skill',
  RUST_TOOL_NAME,
])
