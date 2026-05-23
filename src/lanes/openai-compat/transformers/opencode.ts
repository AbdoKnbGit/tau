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
import { sanitizeDeepSeekToolCallAdjacency } from './deepseek.js'
import {
  getOpencodeEffort,
  isOpencodeThinkingModel,
  type OpencodeEffort,
} from '../../../utils/model/opencodeThinking.js'

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
  // Authoritative list lives in utils/model/opencodeThinking.ts so the picker
  // chip and the transformer agree on which rows expose the toggle.
  return isOpencodeThinkingModel(model)
}

// ── Per-model reasoning-effort budget for Anthropic / Gemini upstreams ──
//
// The gateway forwards Anthropic-shape `thinking.budget_tokens` and
// Google-shape `thinking_config.thinking_budget` literally to the underlying
// provider. Match the budgets opencode-dev's own variants() function uses
// so a Tau "high" feels the same as opencode's "high".
function anthropicBudgetFor(effort: OpencodeEffort): number {
  switch (effort) {
    case 'low': return 4000
    case 'medium': return 8000
    case 'high': return 16000
    default: return 0
  }
}

function gemini25BudgetFor(effort: OpencodeEffort): number {
  switch (effort) {
    case 'low': return 4000
    case 'medium': return 8000
    case 'high': return 16000
    default: return 0
  }
}

function isAnthropicRow(model: string): boolean {
  const m = model.toLowerCase()
  return m.startsWith('claude-') || m.includes('anthropic/claude')
}

function isGptOrOSeries(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('openai/gpt-5') ||
    m.includes('codex') ||
    m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')
  )
}

function isGemini25(model: string): boolean {
  return model.toLowerCase().includes('gemini-2.5')
}

function isGemini3(model: string): boolean {
  return model.toLowerCase().includes('gemini-3')
}

function isGrokMini(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('grok-3-mini') || m.includes('xai/grok-3-mini')
}

// kimi-k2-thinking and glm-4.6 expose reasoning via vLLM/SGLang's
// chat_template_args switch. The gateway forwards this flag verbatim
// to the upstream's chat template. See opencode-dev's ProviderTransform.options:
// (input.model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(...))
function needsChatTemplateArgs(model: string): boolean {
  const m = model.toLowerCase()
  return m === 'kimi-k2-thinking' || m === 'glm-4.6'
}

// DashScope-style (qwen, qwq, deepseek-r1 on alibaba-cn) needs `enable_thinking`
// at the top level. opencode-dev applies this for any reasoning model on the
// alibaba-cn provider with openai-compatible npm. We forward the same flag —
// upstreams that don't recognize it ignore it (oa-compat tolerant), upstreams
// that do recognize it (DashScope) start emitting reasoning_content.
function needsEnableThinking(model: string): boolean {
  const m = model.toLowerCase()
  if (m === 'kimi-k2-thinking') return false  // already covered by chat_template_args
  return (
    m.includes('qwen3') || m.includes('qwen-3') || m.includes('qwq') ||
    m.includes('deepseek-r1') || m.includes('deepseek/deepseek-r')
  )
}

// GLM zai/zhipuai-style switch — opencode-dev injects this for zai/zhipuai
// providers with openai-compatible npm. Match for GLM 5.x rows hosted via
// OpenCode Zen so they actually emit reasoning when the user wants it on.
function needsZaiThinkingSwitch(model: string): boolean {
  const m = model.toLowerCase()
  return m.startsWith('glm-5') || m.includes('glm-5') || m === 'glm-4.7'
}

// DeepSeek V4 / reasoner — `thinking: { type: "enabled" }` toggles thinking
// mode and the upstream then expects `reasoning_content` echoed back on
// replayed assistant tool-call messages.
function needsAnthropicShapeThinking(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('deepseek-v4') ||
    m.includes('deepseek-reasoner') ||
    m === 'kimi-k2.5' || m === 'kimi-k2p5' || m.includes('kimi-k2.5') ||
    m.includes('kimi-k2-5') || m.includes('kimi-k2p5')
  )
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

    // ── Per-model thinking effort injection ──────────────────────────
    //
    // The picker stores per-model effort in utils/model/opencodeThinking.ts.
    // We read it here and inject the correct payload shape per upstream
    // family so the gateway forwards each provider's native thinking
    // controls without surprise.
    //
    // If the user hasn't picked an effort, we fall through to the gateway's
    // default behavior — opencode-dev itself defaults thinking on for
    // free-tier rows (handled by the store).
    if (isReasoningCapable(body.model)) {
      const effort = getOpencodeEffort(body.model)
      const m = body.model.toLowerCase()
      if (effort !== 'default') {
        // Anthropic upstream — `thinking.budget_tokens`. The gateway converts
        // oa-compat → anthropic for Claude rows, so we ALSO need to set
        // `reasoning_effort` (the field opencode's @ai-sdk/anthropic adapter
        // recognizes) so the gateway sees the effort hint either way.
        if (isAnthropicRow(body.model)) {
          body.thinking = { type: 'enabled' } as { type: 'enabled' }
          ;(body as any).thinking = {
            type: 'enabled',
            budget_tokens: anthropicBudgetFor(effort),
          }
          body.reasoning_effort = effort
        }
        // GPT-5 / o-series — Responses API's `reasoning_effort` directly.
        else if (isGptOrOSeries(body.model)) {
          body.reasoning_effort = effort
          body.reasoning = { effort }
          // Match opencode-dev: GPT-5 rows on opencode also pass these.
          ;(body as any).reasoning_summary = 'auto'
          ;(body as any).include = ['reasoning.encrypted_content']
        }
        // Gemini 2.5 — `thinking_config.thinking_budget`.
        else if (isGemini25(body.model)) {
          ;(body as any).thinking_config = {
            include_thoughts: true,
            thinking_budget: gemini25BudgetFor(effort),
          }
        }
        // Gemini 3+ — `thinking_config.thinking_level`.
        else if (isGemini3(body.model)) {
          ;(body as any).thinking_config = {
            include_thoughts: true,
            thinking_level: effort,
          }
        }
        // Grok 3 mini — `reasoning_effort` (only "low" or "high" supported
        // per xAI docs; medium maps to high). Other grok rows have no
        // effort knob, so skip.
        else if (isGrokMini(body.model)) {
          const grokEffort = effort === 'low' ? 'low' : 'high'
          body.reasoning_effort = grokEffort
          body.reasoning = { effort: grokEffort }
        }
        // Kimi k2-thinking / GLM 4.6 — vLLM chat template switch.
        else if (needsChatTemplateArgs(body.model)) {
          ;(body as any).chat_template_args = { enable_thinking: true }
        }
        // GLM 4.7 / 5.x — zai-style thinking object.
        else if (needsZaiThinkingSwitch(body.model)) {
          ;(body as any).thinking = { type: 'enabled', clear_thinking: false }
        }
        // DashScope qwen / qwq / deepseek-r1 — flat enable_thinking flag.
        else if (needsEnableThinking(body.model)) {
          ;(body as any).enable_thinking = true
          // DeepSeek-R / R1 also honors Anthropic-shape thinking; emit it so
          // either gateway path (DashScope vs DeepSeek native) triggers
          // reasoning emission.
          body.thinking = { type: 'enabled' } as { type: 'enabled' }
          body.reasoning = { effort }
        }
        // DeepSeek V4 / reasoner / Kimi 2.5 — Anthropic-shape thinking.
        else if (needsAnthropicShapeThinking(body.model)) {
          body.thinking = { type: 'enabled' } as { type: 'enabled' }
          body.reasoning = { effort }
        }
        // MiniMax M2 / fallback for other reasoning-capable rows — generic
        // `reasoning.effort` is the most widely understood shape and gets
        // ignored by upstreams that don't read it.
        else {
          body.reasoning = { effort }
          body.reasoning_effort = effort
        }
      } else {
        // effort === 'default' — explicitly mark thinking disabled on the
        // families where the gateway / upstream's default is ON (DeepSeek V4,
        // GLM 4.6, kimi-thinking). Without this they 400 on subsequent tool
        // turns because reasoning_content was emitted on the previous turn
        // but the replayed assistant message doesn't carry it. The fix here
        // is symmetric with the picker chip showing "Default" = off.
        if (
          needsAnthropicShapeThinking(body.model) ||
          needsChatTemplateArgs(body.model) ||
          needsZaiThinkingSwitch(body.model) ||
          needsEnableThinking(body.model)
        ) {
          body.thinking = { type: 'disabled' } as { type: 'disabled' }
        }
      }

      // Compat fallback: if the lane's bridge passed thinking (via the
      // global /effort cycle) but we found no per-model override, honor
      // the bridge's effort hint as well. This preserves existing behavior
      // for users who only ever used the global cycle.
      if (effort === 'default' && ctx.isReasoning && ctx.reasoningEffort) {
        if (isGptOrOSeries(body.model)) {
          body.reasoning_effort = ctx.reasoningEffort
          body.reasoning = { effort: ctx.reasoningEffort }
        } else {
          body.reasoning = { effort: ctx.reasoningEffort }
        }
      }
    }

    body.messages = sanitizeDeepSeekToolCallAdjacency(body.messages)
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
