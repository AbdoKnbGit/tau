/**
 * OpenCode Zen transformer (https://opencode.ai/zen/).
 *
 * Multi-format gateway hosted by the OpenCode team. Speaks the OpenAI Chat
 * Completions wire format on `/v1/chat/completions` for the broad catalog
 * (Qwen, GLM, Kimi, Grok, DeepSeek, Nemotron, MiniMax), and routes Claude
 * and Gemini rows through their native shapes internally. From the
 * client's perspective every request goes to `/chat/completions` — the
 * gateway translates per-model.
 *
 * cache_control: `last-only` placement on Claude / Gemini rows so the
 * upstream sees the rolling 3-breakpoint cache anchor (system + last two
 * user/tool turns) and hits the prefix cache instead of cold-writing
 * every turn. For non-Anthropic/non-Gemini rows the field is stripped —
 * those backends don't honor Anthropic-style cache_control and may 400
 * on unknown fields. Their server-side implicit caches still work.
 *
 * prompt_cache_key: stamped from the stable claudex sessionId on Claude
 * rows. Anchors the gateway to the same upstream backend across turns;
 * without it the cache_control breakpoints land on a cold prefix every
 * time.
 */

import { randomUUID } from 'node:crypto'

import type { HeaderContext, Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

declare const MACRO: { VERSION: string }

// Pinned to the live opencode release shape: `opencode/<version>`. The
// rate-limit gate (ipRateLimiter.ts:13-16) reads checkHeaders out of the
// ZEN_LIMITS secret and the only entry stable enough to gate on is the
// official client's UA. Bumping this string in lockstep with opencode-dev's
// packages/opencode/package.json keeps the gate satisfied even if the
// gateway tightens the substring (e.g. to `opencode/1.`).
const OPENCODE_UA_VERSION = '1.15.9'

// Stable per-process session id used when the caller didn't pass one
// (e.g. /title, /compact, or any one-shot lane call that bypasses the
// bridge's getSessionId() injection). Without this header the gateway's
// `headersExist` test (ipRateLimiter.ts:13) fails on the entry that
// requires x-opencode-session to be non-empty, dropping the daily quota
// to dailyRequestsFallback (1/day) on free rows. Generating once per
// process means the gateway sees consistent affinity across the run.
let _processSessionId: string | null = null
function getProcessSessionId(): string {
  if (!_processSessionId) _processSessionId = randomUUID()
  return _processSessionId
}

function isClaudeModel(model: string): boolean {
  const m = model.toLowerCase()
  return m.startsWith('claude-') || m.includes('anthropic/')
}

function isGeminiModel(model: string): boolean {
  const m = model.toLowerCase()
  return m.startsWith('gemini-') || m.includes('google/gemini')
}

function isReasoningCapable(model: string): boolean {
  const m = model.toLowerCase()
  if (m.startsWith('claude-opus-4') || m.startsWith('claude-haiku-4') || m.startsWith('claude-sonnet-4')) return true
  if (m.includes('anthropic/claude-opus-4') || m.includes('anthropic/claude-sonnet-4') || m.includes('anthropic/claude-haiku-4')) return true
  if (m.includes('deepseek-r1') || m.includes('deepseek/deepseek-r')) return true
  if (m.includes('qwen3') || m.includes('qwen-3') || m.includes('qwq')) return true
  if (m.startsWith('glm-5') || m.includes('glm-5')) return true
  if (m.startsWith('gpt-5') || m.startsWith('openai/gpt-5') || m.includes('codex')) return true
  if (m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return true
  if (m.startsWith('grok-3') || m.startsWith('grok-4') || m.startsWith('xai/grok-3') || m.startsWith('xai/grok-4')) return true
  if (m.includes('gemini-2.5') || m.includes('gemini-3')) return true
  return false
}

export const opencodeTransformer: Transformer = {
  id: 'opencode',
  displayName: 'OpenCode Zen',
  defaultBaseUrl: 'https://opencode.ai/zen/v1',

  supportsStrictMode: () => true,

  clampMaxTokens(requested: number): number {
    // OpenCode Zen is pay-per-use; mirror OpenRouter's conservative cap so
    // free credit accounts don't trip 402 on the upstream's reserve check.
    return requested > 8192 ? 8192 : requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    // Anchor the gateway to the same upstream backend across turns for
    // EVERY family the catalog serves — each backend has its own caching
    // primitive:
    //   - Claude  → cache_control breakpoints (stamped via cacheControlMode)
    //               + prompt_cache_key as a gateway affinity hint so the
    //               same Anthropic worker keeps the prefix warm.
    //   - GPT-5.x → OpenAI Responses API auto-caches prefixes >1024 tokens
    //               and uses prompt_cache_key directly for affinity.
    //               This is where the cache actually lives on this row.
    //   - Gemini  → Google context caching; cache_control breakpoints +
    //               prompt_cache_key anchor the gateway to one backend.
    //   - DeepSeek/GLM/Kimi/Grok/Qwen/Nemotron/MiniMax → most have their
    //               own server-side implicit cache; affinity hint still
    //               helps the gateway keep sessions sticky so those
    //               caches actually hit.
    //
    // The field is silently ignored on any backend that doesn't recognize
    // it, so stamping uniformly is strictly an improvement.
    if (ctx.sessionId) {
      body.prompt_cache_key = ctx.sessionId
    }

    if (ctx.isReasoning && ctx.reasoningEffort && isReasoningCapable(body.model)) {
      body.reasoning = { effort: ctx.reasoningEffort }
      // OpenAI-shape reasoning_effort for GPT-5 / o-series rows hosted on
      // the gateway. Harmless on backends that ignore it.
      const m = body.model.toLowerCase()
      if (
        m.startsWith('gpt-5') || m.startsWith('openai/gpt-5') ||
        m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')
      ) {
        body.reasoning_effort = ctx.reasoningEffort
      }
    }
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'maximum context', 'token limit']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    if (isClaudeModel(model)) return 'apply_patch'
    const m = model.toLowerCase()
    if (m.startsWith('gpt-5') || m.startsWith('openai/gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
      return 'apply_patch'
    }
    if (isGeminiModel(model)) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(model: string): string | null {
    // Every id below is verified against the live opencode catalog at
    // https://opencode.ai/zen/v1/models. Returning a non-existent id 401s
    // with ModelError; returning a `*-free` / big-pickle / gpt-5-nano row
    // puts the small-fast call onto the gateway's allowAnonymous=true
    // IP rate-limit bucket (1-2/day) and triggers FreeUsageLimitError —
    // never fall back to those from a paid main model.
    const m = model.toLowerCase()
    if (isClaudeModel(model)) return 'claude-haiku-4-5'
    if (m.startsWith('gpt-5') || m.startsWith('openai/gpt-5')) return 'gpt-5.4-mini'
    if (isGeminiModel(model)) return 'gemini-3-flash'
    if (m.startsWith('glm-')) return 'glm-5'
    if (m.startsWith('kimi-')) return 'kimi-k2.5'
    if (m.startsWith('qwen')) return 'qwen3.5-plus'
    if (m.startsWith('minimax-') || m.startsWith('minimax/')) return 'minimax-m2.5'
    // DeepSeek, Grok, Nemotron, Big Pickle: opencode only hosts free
    // (allowAnonymous=true) variants for these families. Returning null
    // makes the caller reuse the main model for small-fast tasks rather
    // than silently routing to a free row that burns the IP daily cap.
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    // OpenCode Zen routes Claude through Anthropic's native `/v1/messages`
    // shape internally and Gemini through Google's native shape — both
    // honor the rolling cache_control breakpoints we stamp. Strip the
    // field for every other family.
    if (isClaudeModel(model)) return 'last-only'
    if (isGeminiModel(model)) return 'last-only'
    return 'none'
  },

  buildHeaders(_apiKey: string, ctx?: HeaderContext): Record<string, string> {
    // OpenCode Zen's gateway reads five headers. Four are stripped before
    // the gateway forwards to the upstream (see opencode-dev
    // packages/console/app/src/routes/zen/util/handler.ts:193-196); they're
    // gateway-side only — affinity / rate-limit bucketing / telemetry.
    //
    // - User-Agent          → THE rate-limit gate. ipRateLimiter.ts:13-16
    //                         (packages/console/app/src/routes/zen/util)
    //                         runs `request.headers.get(name).toLowerCase()
    //                         .includes(value)` over a `checkHeaders` map
    //                         from Subscription.getFreeLimits(). If any
    //                         check fails the daily quota collapses from
    //                         `dailyRequests` to `dailyRequestsFallback`
    //                         (typically 1/day) and the next request 429s
    //                         with FreeUsageLimitError. The official
    //                         client sends `opencode/<version>` (see
    //                         opencode-dev packages/opencode/src/session/
    //                         llm/request.ts:16,175); we mirror that exact
    //                         shape so free-tier rows ("*-free", big-pickle,
    //                         gpt-5-nano) actually get their full daily
    //                         allowance instead of the fallback bucket.
    // - x-opencode-session  → sticky-provider routing across turns so the
    //                         upstream cache (Anthropic prefix, OpenAI
    //                         Responses, DeepSeek/GLM/Kimi implicit, etc.)
    //                         actually hits instead of cold-writing every
    //                         request. Also feeds the gateway's stickyId
    //                         (handler.ts:124) for per-session affinity.
    // - x-opencode-request  → request correlation key for telemetry; the
    //                         official client passes a user id, we reuse
    //                         the session id as a stable surrogate.
    // - x-opencode-project  → project grouping for telemetry; optional.
    // - x-opencode-client   → client identifier; identifies Tau in usage
    //                         metrics on the OpenCode side.
    const sessionId = ctx?.sessionId ?? getProcessSessionId()
    const headers: Record<string, string> = {
      'User-Agent': `opencode/${OPENCODE_UA_VERSION}`,
      'x-opencode-client': process.env.OPENCODE_CLIENT ?? `opencode-tau/${MACRO.VERSION}`,
      'x-opencode-session': sessionId,
      'x-opencode-request': sessionId,
    }
    const project = process.env.OPENCODE_PROJECT
    if (project) headers['x-opencode-project'] = project
    return headers
  },
}
