/**
 * Google Gemini native REST provider.
 *
 * Uses the Gemini REST API directly (no SDK dependency).
 * Supports both API key auth (x-goog-api-key header) and OAuth Bearer token.
 *
 * Endpoints:
 *   Streaming:     POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   Non-streaming: POST /v1beta/models/{model}:generateContent
 *   Model list:    GET  /v1beta/models
 *
 * Optimizations:
 *   - API key sent via x-goog-api-key header (not URL param) for security
 *   - Connection: keep-alive on all requests for connection reuse
 *   - Sliding-window rate limiter to avoid hitting 429s
 *   - Context caching with proactive background refresh
 */

import {
  BaseProvider,
  buildProviderStreamResult,
  type AnthropicMessage,
  type ModelInfo,
  type ProviderConfig,
  type ProviderRequestParams,
  type ProviderStreamResult,
  type SystemBlock,
} from './base_provider.js'
import { anthropicToGeminiRequest } from '../adapters/anthropic_to_gemini.js'
import {
  geminiStreamToAnthropicEvents,
  geminiMessageToAnthropic,
  parseGeminiSSE,
  type GeminiGenerateContentResponse,
} from '../adapters/gemini_to_anthropic.js'
import {
  ANTIGRAVITY_MODELS,
  GEMINI_TIER_FREE,
  GEMINI_TIER_LEGACY,
  ensureCodeAssistReady,
  executorForModel,
  getGeminiEntitledModelIds,
  getGeminiTier,
  hasPaidEntitlement,
  isPaidGeminiTier,
  parseCodeAssistSSE,
  unwrapCodeAssistResponse,
  wrapForCodeAssist,
  wrapForGeminiCLI,
  geminiCLIApiHeaders,
  antigravityApiHeaders,
  codeAssistGenerationBases,
  clearCodeAssistCache,
} from './gemini_code_assist.js'
import { getOrCreateCache, invalidateCache } from './gemini_cache.js'
import { getProviderModelSet } from '../../../utils/model/configs.js'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'

/**
 * Hardcoded Pro-model id set — anything that is *not* a flash variant
 * routed through the CLI executor. Used by the success-path latch in
 * `stream`/`create` to auto-record paid entitlement. Stays in sync with
 * `GEMINI_CLI_PRO_MODELS` below.
 */
const GEMINI_PRO_MODEL_IDS = new Set([
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
])

function antigravitySessionHeaders(wrappedBody: Record<string, unknown>): Record<string, string> {
  const request = wrappedBody.request as { sessionId?: unknown } | undefined
  return typeof request?.sessionId === 'string'
    ? { 'X-Machine-Session-Id': request.sessionId }
    : {}
}

/**
 * Resolve the persistent "show Pro models" decision.
 *
 * Priority:
 *   1. `GEMINI_SHOW_PRO_MODELS` env var when explicitly set ('true' or
 *      'false'). The decision is also persisted to global config so the
 *      user only configures it once per machine.
 *   2. The persisted `geminiShowProModels` flag in global config.
 *   3. `null` — caller should fall back to live-detection (entitled-id
 *      list / tier id from Code Assist).
 *
 * Persisting on env-var read means a one-shot
 * `GEMINI_SHOW_PRO_MODELS=true claudex` permanently flips the toggle on
 * that machine; subsequent launches don't need the env var. The user can
 * undo this with `GEMINI_SHOW_PRO_MODELS=false`.
 */
export function resolvePersistedShowPro(): boolean | null {
  const env = process.env.GEMINI_SHOW_PRO_MODELS
  if (env === 'true' || env === 'false') {
    const value = env === 'true'
    const persisted = getGlobalConfig().geminiShowProModels
    if (persisted !== value) {
      try {
        saveGlobalConfig(c => ({ ...c, geminiShowProModels: value }))
      } catch {
        // Best-effort persistence; the env var still applies this run.
      }
    }
    return value
  }
  const persisted = getGlobalConfig().geminiShowProModels
  return typeof persisted === 'boolean' ? persisted : null
}

/**
 * Latch the "user has paid Gemini access" flag in global config the first
 * time a Pro Gemini model call succeeds. Idempotent — only writes when
 * the flag isn't already set. This is the auto-discovery path: even
 * users who never set GEMINI_SHOW_PRO_MODELS will get Pro models in the
 * picker on the next session as long as one Pro chat goes through.
 */
function latchProEntitlementOnSuccess(model: string): void {
  if (!GEMINI_PRO_MODEL_IDS.has(model)) return
  if (getGlobalConfig().geminiShowProModels === true) return
  try {
    saveGlobalConfig(c =>
      c.geminiShowProModels === true ? c : { ...c, geminiShowProModels: true },
    )
  } catch {
    // Persistence is best-effort; failure here just means we'll retry
    // on the next successful Pro call.
  }
}

/**
 * Parse a Gemini 429 error body to extract the reset duration in seconds.
 *
 * Gemini exposes reset duration in multiple spots on the 429 payload:
 *   - Free-text: "retry in 12.5s", "reset after 1h2m3s", "reset after 45s"
 *   - Embedded QuotaFailure violation: "retryDelay": "12s"
 *   - ErrorInfo metadata:           "retryDelay": "12s"
 *
 * Returns the duration in seconds, or null if nothing parseable is present.
 * Callers use > 300s (5 min) as the threshold separating a per-minute rate
 * limit from real daily/weekly quota exhaustion.
 */
function _parseGeminiResetDuration(body: string): number | null {
  if (!body) return null

  // "retry in 12.5s" / "retry after 12s"
  const retryIn = body.match(/retry (?:in|after) ([\d.]+)\s*s/i)
  if (retryIn) {
    const v = parseFloat(retryIn[1])
    if (!isNaN(v)) return v
  }

  // "retryDelay": "12s" (JSON string form)
  const retryDelayJson = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i)
  if (retryDelayJson) {
    const v = parseFloat(retryDelayJson[1])
    if (!isNaN(v)) return v
  }

  // "reset after 1h2m3s" / "reset after 2h" / "reset after 45s" / "reset after 10m"
  const resetAfter = body.match(/reset after ((?:\d+h)?(?:\d+m)?(?:\d+s)?)/i)
  if (resetAfter && resetAfter[1]) {
    const dur = resetAfter[1]
    const h = dur.match(/(\d+)h/)
    const m = dur.match(/(\d+)m/)
    const s = dur.match(/(\d+)s/)
    let total = 0
    if (h) total += parseInt(h[1], 10) * 3600
    if (m) total += parseInt(m[1], 10) * 60
    if (s) total += parseInt(s[1], 10)
    if (total > 0) return total
  }

  return null
}

// ─── Rate Limiter ───────────────────────────────────────────────────
// Simple sliding-window rate limiter. Tracks request timestamps and
// enforces a maximum RPM (requests per minute). When the limit is
// approached, inserts a short delay to spread requests evenly instead
// of bursting and getting 429'd.

// Free-tier RPM limits per model family (as of 2026-04):
//   flash-lite: 5 RPM, flash: 10 RPM, pro: 5 RPM
// OAuth (Code Assist) tier is higher — 30+ RPM.
// Default to a safe free-tier value. OAuth users get auto-upgraded
// in the constructor when we detect they have a token.
const DEFAULT_RPM_FREE = 5     // Safe for all free-tier models
const DEFAULT_RPM_OAUTH = 30   // Code Assist / Antigravity tier
const _requestTimestamps: number[] = []

/** Sleep for ms. */
function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Wait if needed to stay under the RPM limit. Returns immediately
 * if the window has capacity. Otherwise waits until the oldest
 * request in the window expires.
 */
async function _throttle(rpm: number = DEFAULT_RPM_FREE): Promise<void> {
  const now = Date.now()
  const windowMs = 60_000

  // Prune old entries outside the window.
  while (_requestTimestamps.length > 0 && _requestTimestamps[0]! < now - windowMs) {
    _requestTimestamps.shift()
  }

  if (_requestTimestamps.length >= rpm) {
    // Wait until the oldest request leaves the window.
    const waitMs = _requestTimestamps[0]! + windowMs - now + 50 // +50ms margin
    if (waitMs > 0) {
      await _sleep(waitMs)
    }
  }

  _requestTimestamps.push(Date.now())
}

// Models reachable via the two OAuth executors:
//
// 1. Gemini CLI executor (google_oauth 'cli' token) — free-tier flash/lite
//    models with good rate limits. Needs User-Agent=GeminiCLI/...
//
// 2. Antigravity executor (google_oauth 'antigravity' token) — pro models
//    with Antigravity quota pool. Needs body.userAgent="antigravity".
//
// Both route through the Code Assist proxy at cloudcode-pa.googleapis.com.
// The curated lists below are split by executor so the provider can show
// only the models the user actually has tokens for.

/**
 * Flash/lite models the Gemini CLI OAuth executor exposes to free-tier
 * accounts. Exported so the lane and the legacy provider share the same
 * source of truth — and so the strict tier-filtering logic in
 * `resolveCliModelsForPicker` returns this list for free users instead
 * of mixing flash with Pro.
 */
export const GEMINI_CLI_FLASH_MODELS: ModelInfo[] = [
  { id: 'gemini-3-flash-preview',              name: 'Gemini 3 Flash (preview)' },
  { id: 'gemini-3.1-flash-lite-preview',       name: 'Gemini 3.1 Flash Lite (preview)' },
  { id: 'gemini-2.5-flash',                    name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite',               name: 'Gemini 2.5 Flash Lite' },
]

/**
 * Pro/preview models that paid Google CLI accounts (standard-tier and
 * higher) can call through the Code Assist proxy on top of the flash/
 * lite list above. These IDs are NOT in ANTIGRAVITY_MODEL_IDS, so
 * `executorForModel` keeps them on the CLI executor — no Antigravity
 * token needed. Free-tier accounts never see these because their
 * tier id is `free-tier` (or `legacy-tier`) and the picker filters
 * them out.
 *
 * Exported because the native gemini lane (`src/lanes/gemini/api.ts`)
 * runs its own `listModels` and must surface the same Pro models — the
 * legacy provider path is only used as a fallback when the lane is
 * disabled, so duplicating the catalog there would silently regress
 * the picker for default (lanes-on) users.
 */
export const GEMINI_CLI_PRO_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)', tags: ['pro'] },
  { id: 'gemini-2.5-pro',         name: 'Gemini 2.5 Pro',           tags: ['pro'] },
]

/**
 * Decide which Pro models to show for the Gemini CLI executor based on
 * the user's current entitlement. Single source of truth for both the
 * legacy provider's `listModels` and the native gemini lane's
 * `listModels` so the picker stays consistent regardless of whether
 * `CLAUDEX_NATIVE_LANES` is on.
 *
 * Detection priority — LIVE DATA WINS over the persisted flag:
 *   1. Persisted/env flag = false → explicit opt-out, hide Pro.
 *   2. `retrieveUserQuota.buckets[].modelId` from the cache populated
 *      by `ensureCodeAssistReady`:
 *        - Match against our Pro catalog → show those.
 *        - Generic entitlement check → show all Pro.
 *        - Buckets present but contain only flash → free user, hide
 *          Pro (this overrides any stale persisted "true" flag from a
 *          previous Pro-tier session — the bug that this priority
 *          ordering fixes).
 *   3. Cached tier id → paid tier shows Pro, explicit free/legacy
 *      hides Pro (again, overriding stale persisted "true").
 *   4. No live data at all (ghost-project 403) → fall back to
 *      persisted/env flag = true as the manual escape hatch.
 *   5. Default → hide Pro.
 *
 * Callers MUST trigger `ensureCodeAssistReady('cli')` before calling
 * this on a freshly-logged-in session — onboarding is what populates
 * the entitled-ids and tier caches this function reads from.
 */
export function resolveCliProModelsToShow(): ModelInfo[] {
  const persisted = resolvePersistedShowPro()

  // Explicit opt-out always wins, even when the user is paid.
  if (persisted === false) return []

  // Live entitlement (most reliable signal — gemini-cli's source of truth).
  const entitledIds = getGeminiEntitledModelIds('cli')
  if (entitledIds && entitledIds.length > 0) {
    const entitledSet = new Set(entitledIds)
    const matches = GEMINI_CLI_PRO_MODELS.filter(m => entitledSet.has(m.id))
    if (matches.length > 0) return matches
    if (hasPaidEntitlement(entitledIds)) return [...GEMINI_CLI_PRO_MODELS]
    // Buckets exist but contain no Pro/preview ids → free account.
    // Ignore any stale persisted "true" flag; live data is authoritative.
    return []
  }

  // Live tier id — also authoritative when set.
  const tier = getGeminiTier('cli')
  if (tier === GEMINI_TIER_FREE || tier === GEMINI_TIER_LEGACY) return []
  if (isPaidGeminiTier(tier)) return [...GEMINI_CLI_PRO_MODELS]

  // No live data (ghost-project bug) — persisted "true" is the escape hatch.
  if (persisted === true) return [...GEMINI_CLI_PRO_MODELS]
  return []
}

/**
 * Pick the catalog the picker should show for the Gemini CLI executor.
 *
 *   - Free-tier accounts see flash/lite only.
 *   - Paid accounts see flash/lite **plus** the entitled Pro models on
 *     top — Pro users still want flash for cheap/fast tasks.
 *
 * Callers MUST trigger `ensureCodeAssistReady('cli')` first when they
 * have an OAuth token; entitlement detection reads the cache that call
 * populates.
 */
export function resolveCliModelsForPicker(): ModelInfo[] {
  return [...GEMINI_CLI_FLASH_MODELS, ...resolveCliProModelsToShow()]
}

/**
 * Generative models that live on v1beta/models but are NOT chat-completion
 * capable — image/audio/TTS/video/embedding. The API-key path will surface
 * them with a descriptive suffix so users can tell at a glance they are not
 * candidates for general chat turns. OAuth users never see them because
 * Code Assist does not proxy these endpoints.
 */
/** Check if a Gemini model is a text/chat model (not image gen, TTS, etc.). */
function _isGeminiChatModel(id: string): boolean {
  const lower = id.toLowerCase()
  if (lower.includes('-tts')) return false
  if (lower.includes('-image')) return false
  if (lower.includes('-live') || lower.includes('-native-audio')) return false
  if (lower.startsWith('veo-')) return false
  if (lower.startsWith('lyria-')) return false
  if (lower.includes('embedding')) return false
  if (lower.includes('robotics')) return false
  return true
}

function _enrichGeminiModelName(id: string, displayName: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('-tts')) return `${displayName} · TTS`
  if (lower.includes('-image')) return `${displayName} · image gen`
  if (lower.includes('-live') || lower.includes('-native-audio')) return `${displayName} · realtime audio`
  if (lower.startsWith('veo-')) return `${displayName} · video gen`
  if (lower.startsWith('lyria-')) return `${displayName} · music gen`
  if (lower.includes('embedding')) return `${displayName} · embeddings`
  if (lower.includes('robotics')) return `${displayName} · robotics`
  return displayName
}

// ─── Gemini Payload Optimization ─────────────────────────────────
//
// Token usage is the #1 cost driver. The full Tau payload
// (system prompt + 40 tools + growing history) can hit 100K+ input
// tokens per request — burning free-tier quotas in minutes.
//
// Optimization tiers:
//   Pro:        No modification. Full payload, all tools. 1M context.
//   Flash:      Trimmed system prompt, all tools, capped output.
//   Flash-Lite: Aggressive — short prompt, core tools ONLY, truncated
//               history, capped tool results. Every token counts.

const GEMINI_MAX_SYSTEM_CHARS_FLASH = 6000
const GEMINI_MAX_SYSTEM_CHARS_LITE = 3000
const GEMINI_MAX_OUTPUT_TOKENS_FLASH = 8192
const GEMINI_MAX_OUTPUT_TOKENS_LITE = 4096
const GEMINI_MAX_HISTORY_MESSAGES_LITE = 10  // Keep only last N messages for lite
const GEMINI_MAX_TOOL_RESULT_CHARS = 4000    // Cap individual tool results in history

// Core tools that lite models get — everything else is stripped.
// These are enough for basic coding tasks without burning tokens.
const CORE_TOOL_NAMES = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
])

// ─── System Instruction Splitter ─────────────────────────────────
// The system prompt contains a boundary marker that separates static
// content (instructions, tool descriptions, CLAUDE.md) from volatile
// per-turn content (git status, current date, working dir, env info).
//
// For caching to work, we MUST hash only the stable part. Otherwise
// the SHA-256 key changes every turn and the cache never hits.

const DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// Fallback patterns for volatile content when the boundary marker
// is absent (e.g. older system prompt versions, custom prompts).
const VOLATILE_PATTERNS = [
  /# currentDate\n[^\n]+/,          // Today's date is 2026-04-13
  /gitStatus:.*?(?=\n\n|\n#|$)/s,   // Git status block
  /<env>[\s\S]*?<\/env>/,           // Environment block
  /Current branch:.*(?:\n.*){0,10}/, // Branch + recent commits
]

/**
 * Split system instruction text into stable (cacheable) and volatile
 * (per-turn) portions. Uses the SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker
 * when present, falls back to pattern matching.
 */
function splitSystemInstruction(text: string): {
  stable: string
  volatile: string
} {
  // Primary: split at the explicit boundary marker
  const idx = text.indexOf(DYNAMIC_BOUNDARY)
  if (idx !== -1) {
    const stable = text.slice(0, idx).trimEnd()
    const volatile = text.slice(idx + DYNAMIC_BOUNDARY.length).trimStart()
    return { stable, volatile }
  }

  // Fallback: extract known volatile patterns from the end of the prompt
  let volatile = ''
  let remaining = text
  for (const pattern of VOLATILE_PATTERNS) {
    const match = remaining.match(pattern)
    if (match && match.index !== undefined) {
      // Only extract if it's in the last 30% of the text (volatile content
      // is always near the end — don't strip tool descriptions mid-prompt)
      if (match.index > remaining.length * 0.7) {
        volatile += (volatile ? '\n\n' : '') + match[0]
        remaining = remaining.slice(0, match.index) + remaining.slice(match.index + match[0].length)
      }
    }
  }

  return {
    stable: remaining.trimEnd(),
    volatile: volatile.trim(),
  }
}

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini'
  private apiKey: string
  private baseUrl: string
  /** OAuth token from the Gemini CLI client (flash/lite models). */
  private cliOAuthToken?: string
  /** OAuth token from the Antigravity client (pro models). */
  private antigravityOAuthToken?: string
  /** RPM limit — auto-detected from rate limit headers or env override. */
  private rpm: number

  constructor(config: ProviderConfig & {
    cliOAuthToken?: string
    antigravityOAuthToken?: string
    /** @deprecated Use cliOAuthToken / antigravityOAuthToken */
    oauthToken?: string
  }) {
    super()
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    this.cliOAuthToken = config.cliOAuthToken
    this.antigravityOAuthToken = config.antigravityOAuthToken
    // Backwards compat: old single oauthToken → treat as antigravity
    if (config.oauthToken && !config.antigravityOAuthToken) {
      this.antigravityOAuthToken = config.oauthToken
    }
    // Rate limit: env override > auto-detect from auth tier > safe default.
    // OAuth users (Code Assist / Antigravity) get higher RPM than API key free tier.
    const defaultRpm = this.hasOAuth ? DEFAULT_RPM_OAUTH : DEFAULT_RPM_FREE
    this.rpm = parseInt(process.env.GEMINI_RPM ?? '', 10) || defaultRpm
  }

  /**
   * Optimize request params to control token usage.
   *
   * Antigravity (pro, flash, etc.): No modification. Full payload.
   *   These have good quota through Antigravity — don't trim.
   * Free-tier Flash:  Trimmed system prompt, capped output.
   * Free-tier Lite:   Aggressive — short prompt, core tools only,
   *                   truncated history, capped tool results.
   */
  private _optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    if (process.env.PROVIDER_NO_OPTIMIZE === 'true') return params
    const model = this.resolveModel(params.model)
    const lower = model.toLowerCase()

    // Antigravity models: full payload, no modification.
    // These go through the Antigravity quota pool with high rate limits.
    // Includes pro, flash, and image models on Antigravity.
    if (lower.includes('pro')) return params
    if (executorForModel(model) === 'antigravity') return params

    const isLite = lower.includes('lite')
    const maxSystemChars = isLite ? GEMINI_MAX_SYSTEM_CHARS_LITE : GEMINI_MAX_SYSTEM_CHARS_FLASH
    const maxOutputTokens = isLite ? GEMINI_MAX_OUTPUT_TOKENS_LITE : GEMINI_MAX_OUTPUT_TOKENS_FLASH

    let result: ProviderRequestParams = {
      ...params,
      system: this._trimSystem(params.system, maxSystemChars),
      max_tokens: Math.min(params.max_tokens, maxOutputTokens),
    }

    // Lite models: filter to core tools only (saves ~20K tokens)
    if (isLite && result.tools) {
      result = {
        ...result,
        tools: result.tools.filter(t => CORE_TOOL_NAMES.has(t.name)),
      }
    }

    // Lite models: truncate conversation history (saves 10-80K tokens)
    if (isLite && result.messages.length > GEMINI_MAX_HISTORY_MESSAGES_LITE) {
      result = {
        ...result,
        messages: result.messages.slice(-GEMINI_MAX_HISTORY_MESSAGES_LITE),
      }
    }

    // All flash/lite: cap tool result sizes in history
    result = {
      ...result,
      messages: this._truncateToolResults(result.messages),
    }

    return result
  }

  /** Trim system prompt to maxChars, breaking at paragraph boundaries. */
  private _trimSystem(
    system: string | SystemBlock[] | undefined,
    maxChars: number,
  ): string | SystemBlock[] | undefined {
    if (!system) return system
    const fullText = typeof system === 'string'
      ? system
      : system.map(s => s.text).join('\n\n')
    if (fullText.length <= maxChars) return system
    let cutPoint = maxChars
    const lastBreak = fullText.lastIndexOf('\n\n', cutPoint)
    if (lastBreak > maxChars * 0.7) cutPoint = lastBreak
    const trimmed = fullText.slice(0, cutPoint)
    if (typeof system === 'string') return trimmed
    return [{ type: 'text' as const, text: trimmed }]
  }

  /**
   * Truncate large tool results in conversation history.
   * A single `cat` of a big file can add 20K+ tokens to every
   * subsequent request. Cap each result to keep history lean.
   */
  private _truncateToolResults(
    messages: ProviderRequestParams['messages'],
  ): ProviderRequestParams['messages'] {
    return messages.map(msg => {
      if (typeof msg.content === 'string') return msg
      const newContent = msg.content.map(block => {
        if (block.type !== 'tool_result') return block
        const text = typeof block.content === 'string' ? block.content : ''
        if (text.length <= GEMINI_MAX_TOOL_RESULT_CHARS) return block
        return {
          ...block,
          content: text.slice(0, GEMINI_MAX_TOOL_RESULT_CHARS) +
            `\n\n[... truncated ${text.length - GEMINI_MAX_TOOL_RESULT_CHARS} chars to save tokens]`,
        }
      })
      return { ...msg, content: newContent }
    })
  }

  /** True if any OAuth token is available. */
  private get hasOAuth(): boolean {
    return !!(this.cliOAuthToken || this.antigravityOAuthToken)
  }

  /**
   * Build headers for API-key-path requests. Uses x-goog-api-key header
   * instead of URL query param — avoids key appearing in server access
   * logs, proxy caches, and browser history.
   */
  private _apiKeyHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
      'Connection': 'keep-alive',
    }
  }

  /**
   * Pick the right OAuth token for a model. Falls back to the other
   * token if the preferred one is missing (the API will reject if the
   * model isn't available on that executor — better than a client error).
   * Returns null if no OAuth tokens are stored at all.
   */
  private _tokenForModel(model: string): string | null {
    const executor = executorForModel(model)
    if (executor === 'antigravity') {
      return this.antigravityOAuthToken ?? null
    }
    return this.cliOAuthToken ?? null
  }

  async stream(params: ProviderRequestParams): Promise<ProviderStreamResult> {
    // Fresh user turn → reset transient retry counters. Without this, a
    // session that hits a 403 on turn 1 has an exhausted budget on turn 2
    // and self-recovery silently stops working.
    this._staleRetryCount = 0

    const optimized = this._optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    this._lastModelUsed = model
    const body = anthropicToGeminiRequest({ ...optimized, model })

    // OAuth path → route through Code Assist with the right executor.
    const oauthToken = this._tokenForModel(model)
    if (this.hasOAuth && oauthToken) {
      await _throttle(this.rpm)
      const executor = executorForModel(model)
      const projectId = await ensureCodeAssistReady(oauthToken, executor)

      const wrapped = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body as unknown as Record<string, unknown>)
        : wrapForGeminiCLI(model, projectId, body as unknown as Record<string, unknown>)

      const headers = executor === 'antigravity'
        ? {
          ...antigravityApiHeaders(oauthToken),
          ...antigravitySessionHeaders(wrapped as unknown as Record<string, unknown>),
          'Accept': 'text/event-stream',
          'Connection': 'keep-alive',
        }
        : { ...geminiCLIApiHeaders(oauthToken, model), 'Connection': 'keep-alive' }

      const ac = new AbortController()
      let response: Response | null = null
      let errText = ''
      const urls = codeAssistGenerationBases(executor).map(base => `${base}:streamGenerateContent?alt=sse`)
      for (let i = 0; i < urls.length; i++) {
        response = await fetch(urls[i]!, {
          method: 'POST',
          headers,
          body: JSON.stringify(wrapped),
          signal: ac.signal,
        })
        if (response.ok) break
        errText = await response.text().catch(() => '')
        if (!(executor === 'antigravity' && response.status === 404 && i < urls.length - 1)) break
      }
      if (!response) {
        throw new Error('Gemini Code Assist error: no endpoint attempted')
      }

      if (!response.ok) {
        this._adjustRpmFromError(response.status, response.headers)

        // Auto-recover from stale project ID: if Code Assist returns 403
        // with a permission error, the cached project is invalid. Clear it
        // and retry once — the retry will re-onboard and get a fresh project.
        if (response.status === 403 && this._isStaleProjectError(errText) && this._staleRetryCount < this._maxStaleRetries) {
          this._staleRetryCount++
          clearCodeAssistCache(executor)
          return this.stream(params)
        }

        throw this._formatGeminiError(response.status, errText)
      }

      if (!response.body) {
        throw new Error('Gemini Code Assist returned no response body for streaming request')
      }

      // Pro model on the CLI executor returned 200 → the user has paid
      // entitlement, even when Code Assist's loadCodeAssist/quota
      // endpoints fail to advertise it. Latch the flag so future
      // /models invocations surface Pro models without the env var.
      if (executor === 'cli') latchProEntitlementOnSuccess(model)

      const geminiChunks = parseCodeAssistSSE(response.body)
      const anthropicEvents = geminiStreamToAnthropicEvents(geminiChunks, model)
      return buildProviderStreamResult(anthropicEvents, ac)
    }

    // API key path → rate-limit, then try context caching, then call v1beta.
    if (!this.apiKey) {
      throw new Error(
        'Gemini API error 401: No credentials available.\n' +
        'Your OAuth session may have expired and no API key is configured.\n' +
        'Run /login to sign in again.',
      )
    }
    await _throttle(this.rpm)
    const cacheName = await this._applyContextCache(model, body)
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`
    const ac = new AbortController()
    const response = await fetch(url, {
      method: 'POST',
      headers: this._apiKeyHeaders(),
      body: JSON.stringify(body),
      signal: ac.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      this._adjustRpmFromError(response.status, response.headers)
      if (cacheName && this._isCacheExpiredError(response.status, errText)) {
        invalidateCache(cacheName)
        return this.stream(params)
      }
      // Let withRetry (outer layer) handle 429s. It caps third-party 429s at
      // 2 attempts with exponential backoff — stacking another retry loop
      // here caused 3m+ hangs when per-minute buckets cascaded.
      throw this._formatGeminiError(response.status, errText)
    }

    const geminiChunks = parseGeminiSSE(response.body!)
    const anthropicEvents = geminiStreamToAnthropicEvents(geminiChunks, model)
    return buildProviderStreamResult(anthropicEvents, ac)
  }

  async create(params: ProviderRequestParams): Promise<AnthropicMessage> {
    const optimized = this._optimizeParams(params)
    const model = this.resolveModel(optimized.model)
    const body = anthropicToGeminiRequest({ ...optimized, model })

    // OAuth path → route through Code Assist with the right executor.
    const oauthToken = this._tokenForModel(model)
    if (this.hasOAuth && oauthToken) {
      await _throttle(this.rpm)
      const executor = executorForModel(model)
      const projectId = await ensureCodeAssistReady(oauthToken, executor)

      const wrapped = executor === 'antigravity'
        ? wrapForCodeAssist(model, projectId, body as unknown as Record<string, unknown>)
        : wrapForGeminiCLI(model, projectId, body as unknown as Record<string, unknown>)

      const headers = executor === 'antigravity'
        ? {
          ...antigravityApiHeaders(oauthToken),
          ...antigravitySessionHeaders(wrapped as unknown as Record<string, unknown>),
          'Accept': 'application/json',
          'Connection': 'keep-alive',
        }
        : { ...geminiCLIApiHeaders(oauthToken, model), 'Connection': 'keep-alive' }

      let response: Response | null = null
      let errText = ''
      const urls = codeAssistGenerationBases(executor).map(base => `${base}:generateContent`)
      for (let i = 0; i < urls.length; i++) {
        response = await fetch(urls[i]!, {
          method: 'POST',
          headers,
          body: JSON.stringify(wrapped),
        })
        if (response.ok) break
        errText = await response.text().catch(() => '')
        if (!(executor === 'antigravity' && response.status === 404 && i < urls.length - 1)) break
      }
      if (!response) {
        throw new Error('Gemini Code Assist error: no endpoint attempted')
      }

      if (!response.ok) {
        this._adjustRpmFromError(response.status, response.headers)

        // Auto-recover from stale project ID (same as streaming path).
        if (response.status === 403 && this._isStaleProjectError(errText) && this._staleRetryCount < this._maxStaleRetries) {
          this._staleRetryCount++
          clearCodeAssistCache(executor)
          return this.create(params)
        }

        throw this._formatGeminiError(response.status, errText)
      }

      // Pro model on the CLI executor returned 200 → record paid
      // entitlement so /models picks it up without the env var.
      if (executor === 'cli') latchProEntitlementOnSuccess(model)

      const caData = await response.json()
      const data = unwrapCodeAssistResponse(caData)
      return geminiMessageToAnthropic(data, model)
    }

    // API key path → rate-limit, then try context caching, then call v1beta.
    if (!this.apiKey) {
      throw new Error(
        'Gemini API error 401: No credentials available.\n' +
        'Your OAuth session may have expired and no API key is configured.\n' +
        'Run /login to sign in again.',
      )
    }
    await _throttle(this.rpm)
    const cacheName = await this._applyContextCache(model, body)
    const url = `${this.baseUrl}/models/${model}:generateContent`
    const response = await fetch(url, {
      method: 'POST',
      headers: this._apiKeyHeaders(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      this._adjustRpmFromError(response.status, response.headers)
      if (cacheName && this._isCacheExpiredError(response.status, errText)) {
        invalidateCache(cacheName)
        return this.create(params)
      }
      throw this._formatGeminiError(response.status, errText)
    }

    const data = (await response.json()) as GeminiGenerateContentResponse
    return geminiMessageToAnthropic(data, model)
  }

  /**
   * Attempt to attach a `cachedContents/...` reference to the outgoing
   * request body. Mutates `body` in place: on a cache hit, clears
   * `systemInstruction` and `tools` and sets `cachedContent`. Returns
   * the cache name so the caller can invalidate it on 404/expired.
   *
   * CRITICAL FIX: The system prompt contains volatile per-turn data
   * (git status, current date, working dir). If we hash the full
   * systemInstruction, the key changes every turn → cache NEVER hits.
   *
   * Solution: split systemInstruction at the SYSTEM_PROMPT_DYNAMIC_BOUNDARY
   * marker. Cache only the stable prefix (instructions + tool schemas).
   * Inject the volatile suffix as a user message in contents[].
   *
   * API-key path only. OAuth (Code Assist) is skipped because the
   * proxy's cachedContents endpoint is not verified.
   */
  private async _applyContextCache(
    model: string,
    body: ReturnType<typeof anthropicToGeminiRequest>,
  ): Promise<string | null> {
    if (!this.apiKey) return null
    if (!body.systemInstruction) return null

    // Split system instruction into stable (cacheable) and volatile (per-turn).
    const fullText = body.systemInstruction.parts.map(p => p.text).join('\n\n')
    const { stable, volatile } = splitSystemInstruction(fullText)

    // Only cache the stable portion — its hash is consistent across turns.
    const stableInstruction = stable
      ? { parts: [{ text: stable }] }
      : null

    const cacheName = await getOrCreateCache({
      model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      systemInstruction: stableInstruction,
      tools: body.tools,
    })
    if (!cacheName) return null

    // Cache hit: replace systemInstruction + tools with cache reference.
    delete body.systemInstruction
    delete body.tools
    body.cachedContent = cacheName

    // Inject volatile context (git status, date, env) as a leading user
    // message. Gemini doesn't allow systemInstruction + cachedContent
    // together, but leading user parts work fine for context injection.
    if (volatile) {
      body.contents.unshift({
        role: 'user',
        parts: [{ text: volatile }],
      })
    }

    return cacheName
  }

  private _isCacheExpiredError(status: number, body: string): boolean {
    if (status === 404) return true
    if (status === 400 && /cached.?content/i.test(body)) return true
    return false
  }

  async listModels(): Promise<ModelInfo[]> {
    // OAuth path: return only the models the user has tokens for.
    // Code Assist doesn't expose a listModels endpoint and v1beta/models
    // rejects cloud-platform tokens (403 restricted_client).
    if (this.hasOAuth) {
      const models: ModelInfo[] = []
      if (this.cliOAuthToken) {
        // The picker is often the FIRST thing the user opens after
        // /login, before any chat request has triggered onboarding —
        // force the round-trip here so the entitled-ids / tier caches
        // that resolveCliModelsForPicker reads are populated.
        try {
          await ensureCodeAssistReady(this.cliOAuthToken, 'cli')
        } catch {
          // Onboarding failed — fall back to the flash list. The user
          // will hit a clearer error next time they actually try to chat.
        }
        models.push(...resolveCliModelsForPicker())
      }
      if (this.antigravityOAuthToken) models.push(...ANTIGRAVITY_MODELS)
      return models
    }

    // API key path — hidden from the picker by default. Listing
    // /v1beta/models is slow (100+ entries, no useful filtering) and
    // most users never need it. Set GEMINI_SHOW_API_KEY_MODELS=true to
    // opt back in. The chat path itself is unaffected: stream/create
    // continue to honor the configured api key when no OAuth is set.
    if (process.env.GEMINI_SHOW_API_KEY_MODELS !== 'true') {
      return []
    }

    const url = `${this.baseUrl}/models`
    const response = await fetch(url, {
      headers: this._apiKeyHeaders(),
    })

    if (!response.ok) return []
    const data = (await response.json()) as {
      models?: Array<{ name: string; displayName: string; supportedGenerationMethods?: string[] }>
    }
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .filter(m => _isGeminiChatModel(m.name.replace('models/', '')))
      .map(m => {
        const id = m.name.replace('models/', '')
        return {
          id,
          name: _enrichGeminiModelName(id, m.displayName || id),
        }
      })
  }

  resolveModel(claudeModel: string): string {
    if (!claudeModel.includes('claude')) return claudeModel

    const models = getProviderModelSet(this.name)
    if (claudeModel.includes('opus'))  return models.opus
    if (claudeModel.includes('haiku')) return models.haiku
    return models.sonnet
  }

  /**
   * Detect stale Code Assist project errors. These happen when the cached
   * project ID has lost permissions or was deleted server-side. The fix is
   * to clear the cache and re-onboard.
   */
  private _isStaleProjectError(errText: string): boolean {
    return errText.includes('cloudaicompanion') ||
      errText.includes('does not have permission') ||
      errText.includes('project might not exist')
  }

  /**
   * Guard against infinite retry loops on stale project recovery.
   *
   * Bumped from 1 → 3: when the user re-logs into a different Google
   * account, the locally cached projectId belongs to the previous
   * account and the new tokens 403 against it. The first retry clears
   * the local cache, but `loadCodeAssist` may still echo the stale
   * project back from Google's side — we then need to fall through to
   * `onboardUser` to bind a fresh project, which can take another
   * round-trip. Three retries leaves enough budget for the full path
   * (clear-cache → loadCodeAssist → onboardUser → request).
   */
  private _staleRetryCount = 0
  private _maxStaleRetries = 3

  /** Last model used — for error messages. */
  private _lastModelUsed: string | null = null

  /**
   * Format Gemini API errors. All error messages include the numeric status
   * code in the format "Gemini API error NNN: ..." so the app's withRetry
   * logic (which matches /API error (\d{3})/) can detect retryable errors.
   */
  private _formatGeminiError(status: number, body: string): Error {
    let errorDetail = ''
    try {
      const parsed = JSON.parse(body)
      errorDetail = parsed?.error?.message ?? ''
    } catch {
      errorDetail = body
    }

    if (status === 400 && errorDetail.includes('Unknown name')) {
      return new Error(
        `Gemini API error ${status}: Invalid tool schema fields.\n` +
        `The tool parameter schemas contain fields not supported by Gemini.\n` +
        `This is a bug — please report it. Details: ${errorDetail.slice(0, 300)}`,
      )
    }

    if (status === 401 || status === 403) {
      return new Error(
        `Gemini API error ${status}: Authentication failed.\n` +
        `${errorDetail || 'Your API key or OAuth token may be invalid.'}\n` +
        `Run /login to reconfigure.`,
      )
    }

    if (status === 429) {
      // Distinguish quota exhaustion (hours/days) from per-minute rate limit.
      // Google says "exhausted your capacity" on EVERY 429 — even 2-second
      // cooldowns — so we can't use that word. Only the RESET DURATION matters:
      //   - seconds/minutes → normal rate limit, retryable
      //   - hours           → real quota exhaustion, don't retry
      const resetSeconds = _parseGeminiResetDuration(body)
      const isRealExhaustion = resetSeconds !== null && resetSeconds > 300 // >5 min = real exhaustion
      if (isRealExhaustion) {
        const resetMatch = body.match(/reset after (\d+h\d+m\d+s|\d+h\d+m|\d+h)/i)
        const resetHint = resetMatch ? ` Resets in ${resetMatch[1]}.` : ''
        // Include the "quota exhausted" signal the withRetry filter uses to
        // skip retries (`/quota exhausted|exhausted your capacity|quota will reset after \d+h/i`).
        return new Error(
          `Gemini API error 429: quota exhausted for ${this._lastModelUsed ?? 'this model'}.${resetHint}\n` +
          `${errorDetail}\n` +
          `This is a Google-side daily/weekly limit. Options:\n` +
          `  - Switch to a different model via /models\n` +
          `  - Wait for quota to reset\n` +
          `  - Use a different provider via /provider`,
        )
      }
      // Per-minute rate limit — retryable. Include "API error 429" in the
      // message so withRetry's isThirdPartyRetryableError matches. Attach a
      // Headers-shaped retry-after so withRetry honors Gemini's actual
      // reset hint instead of falling back to blind exponential backoff.
      const retryMatch = body.match(/retry in ([\d.]+)s/i) || body.match(/reset after (\d+)s/i)
      const retryHint = retryMatch ? `\nRetry in ~${Math.ceil(parseFloat(retryMatch[1]))}s.` : ''
      const tierHint = this.hasOAuth
        ? ''
        : '\nTip: Use /login to authenticate with Google for higher rate limits (free).'
      const err = new Error(
        `Gemini API error 429: Rate limit hit (${this.rpm} RPM).${retryHint}${tierHint}\n` +
        `${errorDetail}`,
      )
      // Expose the reset duration on `.headers.get('retry-after')` so the
      // outer withRetry wrapper sleeps for the real delay instead of 0.5s.
      if (retryMatch) {
        const retryAfterSec = Math.ceil(parseFloat(retryMatch[1]))
        ;(err as Error & { headers: { get(k: string): string | null } }).headers = {
          get(k: string) { return k.toLowerCase() === 'retry-after' ? String(retryAfterSec) : null },
        }
      }
      return err
    }

    return new Error(`Gemini API error ${status}: ${body}`)
  }

  /**
   * Dynamically lower the RPM when we hit 429 errors. This prevents
   * hammering the API and wasting requests on retries. The RPM recovers
   * on the next provider construction (each turn creates a fresh provider).
   */
  private _adjustRpmFromError(status: number, headers: Headers): void {
    if (status === 429) {
      // Halve RPM (floor at 5) to back off aggressively.
      this.rpm = Math.max(5, Math.floor(this.rpm / 2))
    }
    // Try to learn the actual limit from response headers.
    const limitHeader = headers.get('x-ratelimit-limit-requests')
      ?? headers.get('x-ratelimit-limit')
    if (limitHeader) {
      const parsed = parseInt(limitHeader, 10)
      if (!isNaN(parsed) && parsed > 0) {
        // Use 80% of the advertised limit as our ceiling.
        this.rpm = Math.max(5, Math.floor(parsed * 0.8))
      }
    }
  }

}
