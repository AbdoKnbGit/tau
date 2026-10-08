/**
 * Gemini error classifier — port of gemini-cli's googleQuotaErrors.ts.
 *
 * Google's API packs rich error metadata into the response body's
 * `error.details[]` array using gRPC types:
 *
 *   - type.googleapis.com/google.rpc.ErrorInfo      — reason + domain + metadata
 *   - type.googleapis.com/google.rpc.QuotaFailure   — per-quota violation records
 *   - type.googleapis.com/google.rpc.RetryInfo      — retryDelay (seconds string)
 *   - type.googleapis.com/google.rpc.Help           — links + descriptions
 *
 * We read these to tell the difference between:
 *   - transient          — retry with backoff, same credential
 *   - retryable-quota    — rotate credential, then retry
 *   - terminal-quota     — stop trying this credential; surface to user
 *   - auth-stale         — refresh auth / re-onboard; retry once
 *   - prompt-too-long    — do NOT retry; surface to query.ts reactive compact
 *   - validation-required — user must click a link; surface banner
 *   - non-retryable      — real error, surface to user
 *
 * Reference: reference/gemini-cli-main/packages/core/src/utils/googleQuotaErrors.ts
 */

export type GeminiErrorKind =
  | 'transient'
  | 'retryable-quota'
  | 'terminal-quota'
  | 'auth-stale'
  | 'prompt-too-long'
  | 'validation-required'
  | 'non-retryable'

export interface GoogleErrorDetails {
  code?: number
  message?: string
  status?: string
  reason?: string
  domain?: string
  metadata?: Record<string, string>
  quotaFailures?: Array<{
    subject?: string
    description?: string
    quotaMetric?: string
    quotaId?: string
    quotaDimensions?: Record<string, string>
  }>
  retryDelaySeconds?: number
  validationLink?: string
  validationDescription?: string
  learnMoreUrl?: string
  insufficientCredits?: boolean
  terminalQuota?: boolean
}

export interface ClassifiedGeminiError {
  kind: GeminiErrorKind
  retryAfterMs?: number
  details: GoogleErrorDetails
}

// ─── Body parsing ────────────────────────────────────────────────

const TERMINAL_QUOTA_REASONS = new Set([
  'DAILY_LIMIT_EXCEEDED', 'DAILY_QUOTA_EXCEEDED', 'DAILY_QUOTA_EXHAUSTED',
  'WEEKLY_LIMIT_EXCEEDED', 'WEEKLY_QUOTA_EXCEEDED', 'WEEKLY_QUOTA_EXHAUSTED',
  'MONTHLY_LIMIT_EXCEEDED', 'MONTHLY_QUOTA_EXCEEDED', 'MONTHLY_QUOTA_EXHAUSTED',
  'BILLING_LIMIT_EXCEEDED', 'BILLING_QUOTA_EXCEEDED', 'BILLING_HARD_LIMIT_REACHED',
  'BILLING_ACCOUNT_SPEND_LIMIT_EXCEEDED', 'PROJECT_SPEND_LIMIT_EXCEEDED',
  'SPEND_LIMIT_EXCEEDED', 'SPENDING_LIMIT_EXCEEDED', 'SPENDING_LIMIT_REACHED',
  'INSUFFICIENT_G1_CREDITS_BALANCE', 'INSUFFICIENT_CREDITS', 'CREDITS_EXHAUSTED',
])

function quotaIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

function isLongPeriodQuota(value: string): boolean {
  const identifier = quotaIdentifier(value)
  return /(?:^|_)(?:DAILY|WEEKLY|MONTHLY|PER_(?:DAY|WEEK|MONTH))(?:_|$)/.test(identifier)
    || /^(?:DAY|WEEK|MONTH)$/.test(identifier)
    || /^1\/(?:d|day|wk|week|mo|month)(?:\/|$)/i.test(value)
}

function hasExplicitQuotaCap(metadata: Record<string, string>): boolean {
  return Object.entries(metadata).some(([key, value]) => (
    /^(?:QUOTA_(?:LIMIT|LIMIT_NAME|ID|METRIC|PERIOD|UNIT|TYPE)|LIMIT_(?:NAME|TYPE|PERIOD))$/.test(quotaIdentifier(key))
    && (isLongPeriodQuota(value) || TERMINAL_QUOTA_REASONS.has(quotaIdentifier(value)))
  ))
}

function hasExplicitCapMessage(message: string): boolean {
  // A generic "quota exhausted" or "capacity" message is not proof of a
  // terminal cap: the same account may recover on the next short retry.
  return /\b(?:daily|weekly|monthly|billing|spend(?:ing)?)\s+(?:\w+\s+){0,2}(?:quota|limit|cap)\b.{0,40}\b(?:exceeded|exhausted|reached)\b/i.test(message)
    || /\b(?:exceeded|exhausted|reached)\b.{0,40}\b(?:daily|weekly|monthly|billing|spend(?:ing)?)\s+(?:\w+\s+){0,2}(?:quota|limit|cap)\b/i.test(message)
}

function stringFields(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** RetryInfo uses protobuf seconds; Antigravity metadata also uses Go durations. */
function durationSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?(?:ms|us|ns|h|m|s))+$/.test(value)) return undefined
  const scales: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001, ns: 0.000000001 }
  let seconds = 0
  for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/g)) {
    seconds += Number(part[1]) * scales[part[2]!]!
  }
  return Number.isFinite(seconds) ? seconds : undefined
}

/**
 * Best-effort parse of a Google API error body.
 *
 * Accepts:
 *   - JSON `{ error: { code, message, details[] } }` (generativelanguage)
 *   - JSON `{ code, message, details[] }` (Code Assist wrapped)
 *   - Raw text (falls through with just the raw message)
 *
 * Never throws — returns the best-interpreted details we could extract.
 */
export function parseGoogleErrorDetails(body: string): GoogleErrorDetails {
  if (!body) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }

  if (!parsed || typeof parsed !== 'object') return {}

  const root = (parsed as { error?: unknown }).error ?? parsed
  if (!root || typeof root !== 'object') return {}

  const details = (root as { details?: unknown[] }).details ?? []
  const out: GoogleErrorDetails = {}

  const code = (root as { code?: unknown }).code
  if (typeof code === 'number') out.code = code
  const message = (root as { message?: unknown }).message
  if (typeof message === 'string') {
    out.message = message
    if (hasExplicitCapMessage(message)) out.terminalQuota = true
  }
  const status = (root as { status?: unknown }).status
  if (typeof status === 'string') {
    out.status = status
    // Some Code Assist quota responses only set error.status and omit
    // details[].reason; keep a reason-like value so callers can branch
    // without reparsing the raw body.
    out.reason ??= status
  }

  if (!Array.isArray(details)) return out

  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    const type = (d as { '@type'?: unknown })['@type']
    if (typeof type !== 'string') continue

    if (type.endsWith('ErrorInfo')) {
      const info = d as {
        reason?: unknown
        domain?: unknown
        metadata?: unknown
      }
      if (typeof info.reason === 'string') {
        out.reason = info.reason
        if (TERMINAL_QUOTA_REASONS.has(quotaIdentifier(info.reason))) out.terminalQuota = true
      }
      if (typeof info.domain === 'string') out.domain = info.domain
      const metadata = stringFields(info.metadata)
      if (metadata) {
        out.metadata = { ...out.metadata, ...metadata }
        if (hasExplicitQuotaCap(metadata)) out.terminalQuota = true
        const resetDelay = durationSeconds(metadata.quotaResetDelay)
        if (resetDelay !== undefined) out.retryDelaySeconds = Math.max(out.retryDelaySeconds ?? 0, resetDelay)
      }
      if (typeof info.reason === 'string' && quotaIdentifier(info.reason) === 'INSUFFICIENT_G1_CREDITS_BALANCE') {
        out.insufficientCredits = true
      }
    } else if (type.endsWith('QuotaFailure')) {
      const qf = d as {
        violations?: unknown[]
      }
      if (Array.isArray(qf.violations)) {
        for (const value of qf.violations) {
          const violation = stringFields(value)
          if (!violation) continue
          const quotaDimensions = stringFields((value as { quotaDimensions?: unknown }).quotaDimensions)
          ;(out.quotaFailures ??= []).push({
            subject: violation.subject,
            description: violation.description,
            quotaMetric: violation.quotaMetric,
            quotaId: violation.quotaId,
            quotaDimensions,
          })
          if (
            [violation.quotaId, violation.quotaMetric].some(v => v !== undefined && isLongPeriodQuota(v))
            || (violation.description !== undefined && hasExplicitCapMessage(violation.description))
            || (quotaDimensions !== undefined && hasExplicitQuotaCap(quotaDimensions))
          ) out.terminalQuota = true
        }
      }
    } else if (type.endsWith('RetryInfo')) {
      const retryDelay = durationSeconds((d as { retryDelay?: unknown }).retryDelay)
      if (retryDelay !== undefined) out.retryDelaySeconds = Math.max(out.retryDelaySeconds ?? 0, retryDelay)
    } else if (type.endsWith('Help')) {
      const help = d as {
        links?: Array<{ url?: string; description?: string }>
      }
      if (Array.isArray(help.links)) {
        for (const link of help.links) {
          if (!link || typeof link.url !== 'string') continue
          const desc = typeof link.description === 'string' ? link.description.toLowerCase() : ''
          if (desc.includes('validat') || desc.includes('verify')) {
            out.validationLink = link.url
            out.validationDescription = link.description ?? undefined
          } else if (desc.includes('learn more') || !out.learnMoreUrl) {
            out.learnMoreUrl = link.url
          }
        }
      }
    }
  }

  return out
}

// ─── Classification ──────────────────────────────────────────────

/**
 * Classify a Gemini API error by HTTP status + body text.
 *
 * Caller holds the HTTP status separately because the body sometimes
 * lies about `code` (e.g. 200 body with `error.code: 500` envelope).
 * The status wins unless the body's `code` disagrees and claims a
 * quota/validation case we'd otherwise miss.
 */
export function classifyGeminiError(
  status: number,
  body: string,
): ClassifiedGeminiError {
  const details = parseGoogleErrorDetails(body)
  const lowered = body.toLowerCase()
  const retryAfterMs = details.retryDelaySeconds != null
    ? Math.max(0, Math.round(details.retryDelaySeconds * 1000))
    : undefined

  // Prompt-too-long wins regardless of status (some upstreams return 400,
  // some return 200 with an inline error envelope).
  if (
    lowered.includes('prompt is too long')
    || (lowered.includes('token limit') && status !== 429 && !details.terminalQuota)
    || lowered.includes('context window')
    || lowered.includes('context length')
    || details.reason === 'PROMPT_TOO_LONG'
  ) {
    return { kind: 'prompt-too-long', details }
  }

  // Validation-required: Google wants the user to click a link before
  // quota flows. Can come on 403 or 400.
  if (details.validationLink) {
    return { kind: 'validation-required', details }
  }

  if (status === 401) {
    return { kind: 'auth-stale', details }
  }

  if (status === 403) {
    // Stale-project 403 is the cloudaicompanion re-onboard case.
    if (
      /cloudaicompanion|does not have permission|project might not exist/i.test(body)
    ) {
      return { kind: 'auth-stale', details }
    }
    // Antigravity surfaces "restricted_client" when the token scopes are
    // wrong — that's terminal, user must re-auth.
    if (lowered.includes('restricted_client')) {
      return { kind: 'non-retryable', details }
    }
    // Insufficient credits = terminal quota on this credential.
    if (details.insufficientCredits) {
      return { kind: 'terminal-quota', details, retryAfterMs }
    }
    return { kind: 'terminal-quota', details, retryAfterMs }
  }

  if (status === 429) {
    // Split: if ErrorInfo says it's a terminal quota (daily cap, billing
    // exhausted) we don't retry this credential. Otherwise transient.
    if (details.insufficientCredits || details.terminalQuota) {
      return { kind: 'terminal-quota', details, retryAfterMs }
    }
    return { kind: 'retryable-quota', details, retryAfterMs }
  }

  if (status === 400) {
    // Bad request — not retryable unless it's prompt-too-long (handled above).
    return { kind: 'non-retryable', details }
  }

  if (status === 499) {
    // Client closed — treat as transient, the caller already aborted or
    // the connection flapped.
    return { kind: 'transient', details, retryAfterMs }
  }

  if (status === 503) {
    // Google returns 503 UNAVAILABLE when a specific model is out of
    // capacity ("No capacity available for model X"). That's a per-account
    // quota signal: rotating to a different Antigravity account on retry
    // usually succeeds. Classify as retryable-quota so recordRateLimit
    // fires in api.ts and _tokenForModel hops accounts on the next attempt.
    // Single-account users still get backoff retry (isBackoffRetryCase
    // covers retryable-quota) — no regression for them.
    const isCapacityOrUnavailable =
      lowered.includes('no capacity')
      || lowered.includes('"status":"unavailable"')
      || lowered.includes('"status": "unavailable"')
      || details.reason === 'RESOURCE_EXHAUSTED'
    if (isCapacityOrUnavailable) {
      return { kind: 'retryable-quota', details, retryAfterMs }
    }
    return { kind: 'transient', details, retryAfterMs }
  }

  if (status >= 500 && status < 600) {
    return { kind: 'transient', details, retryAfterMs }
  }

  return { kind: 'non-retryable', details }
}

// ─── Retry-policy helpers ────────────────────────────────────────

/** Does the classified error warrant an immediate re-onboard + retry? */
export function isReonboardCase(cls: ClassifiedGeminiError): boolean {
  return cls.kind === 'auth-stale'
}

/** Does the classified error warrant a credential rotation before retry? */
export function isRotationCase(cls: ClassifiedGeminiError): boolean {
  return cls.kind === 'retryable-quota' || cls.kind === 'terminal-quota'
}

/** Should the outer retryWithBackoff loop retry without intervention? */
export function isBackoffRetryCase(cls: ClassifiedGeminiError): boolean {
  return cls.kind === 'transient' || cls.kind === 'retryable-quota'
}
