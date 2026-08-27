/**
 * Third-party provider rate limits, harvested from response headers.
 *
 * This mirrors claudeAiLimits.ts. The Anthropic 5h/7d windows ride in on
 * `anthropic-ratelimit-unified-*` headers of requests the session was making
 * anyway, and getRawUtilization() hands the statusline a synchronous
 * snapshot. Third-party providers already return the standard `x-ratelimit-*`
 * family, and OpenAIProvider._extractRateLimits already parsed them on every
 * response - the numbers were simply discarded.
 *
 * Harvesting rather than polling is what keeps this free: no extra requests,
 * no timers, no credential refresh, and nothing to invalidate. A snapshot
 * exists only because a real call to that provider produced it, so it is
 * always attributable to the provider that issued it, and it is exactly as
 * old as that call.
 */

/** One `x-ratelimit-*` family (requests or tokens) from a single response. */
export type ProviderRateLimitWindow = {
  limit?: number
  remaining?: number
  /** Seconds until the window refills, when the provider's value parsed. */
  resetsInSeconds?: number
}

export type ProviderRateLimitSnapshot = {
  /** Provider that served the response, matching BaseProvider.name. */
  provider: string
  /** Epoch ms the headers were read. */
  capturedAt: number
  requests?: ProviderRateLimitWindow
  tokens?: ProviderRateLimitWindow
}

export type ProviderQuotaWindowInput = {
  limit?: number
  remaining?: number
  used_percentage?: number
  resets_in_seconds?: number
  resets_at?: number
}

/** The `provider_quota` object handed to statusLine commands. */
export type ProviderQuotaInput = {
  provider: string
  /**
   * 'available' carries captured_at and at least one window. 'unavailable'
   * means the session called this provider and it answered with no rate limit
   * headers - a statement, not a gap, so a script can choose to say so. The
   * field is absent entirely while nothing is known yet.
   */
  status: 'available' | 'unavailable'
  /** Which source produced used_percentage. */
  source?: 'headers' | 'account'
  /** Headline number: the one the built-in bar shows. */
  used_percentage?: number
  /**
   * The standing as text, e.g. `$12.34 remaining`, for providers reporting an
   * amount rather than a proportion. Present instead of used_percentage.
   */
  summary?: string
  /** What an account reading measures, e.g. `Credits`. */
  label?: string
  captured_at?: number
  requests?: ProviderQuotaWindowInput
  tokens?: ProviderQuotaWindowInput
}

/**
 * Only the most recent response is kept, rather than a per-provider map.
 * A map would let a snapshot from a provider the session has since left
 * resurface when the user switches back, presenting pre-switch numbers as
 * current. One slot means the first call after any switch repopulates it.
 */
let snapshot: ProviderRateLimitSnapshot | null = null

/**
 * Providers this session has called which answered without any
 * `x-ratelimit-*` header. That is the difference between "no reading yet"
 * and "this provider does not publish one", and only the second can honestly
 * be shown to the user as unavailable.
 */
const providersWithoutQuota = new Set<string>()

export function getProviderRateLimits(): ProviderRateLimitSnapshot | null {
  return snapshot
}

/** Test seam - production code only ever writes via recordProviderRateLimits. */
export function resetProviderRateLimits(): void {
  snapshot = null
  providersWithoutQuota.clear()
}

/**
 * Parse the `x-ratelimit-*` family and, when anything was found, store it as
 * the session's current snapshot. Returns what was parsed so the caller can
 * reuse it, or null when the response carried no rate limit headers.
 *
 * A response without these headers must not overwrite a good snapshot with an
 * empty one - providers that never send them would otherwise erase the
 * numbers on every turn. The render-time provider guard covers the case where
 * the silent provider is a *different* one.
 */
export function recordProviderRateLimits(
  provider: string,
  headers: Headers,
): ProviderRateLimitSnapshot | null {
  const requests = readWindow(headers, 'requests')
  const tokens = readWindow(headers, 'tokens')
  if (!requests && !tokens) {
    providersWithoutQuota.add(provider)
    return null
  }
  providersWithoutQuota.delete(provider)

  snapshot = {
    provider,
    capturedAt: Date.now(),
    ...(requests && { requests }),
    ...(tokens && { tokens }),
  }
  return snapshot
}

function readWindow(
  headers: Headers,
  kind: 'requests' | 'tokens',
): ProviderRateLimitWindow | undefined {
  const limit = readCount(headers.get(`x-ratelimit-limit-${kind}`))
  const remaining = readCount(headers.get(`x-ratelimit-remaining-${kind}`))
  const resetsInSeconds = parseResetDuration(
    headers.get(`x-ratelimit-reset-${kind}`),
  )
  if (
    limit === undefined &&
    remaining === undefined &&
    resetsInSeconds === undefined
  ) {
    return undefined
  }
  return {
    ...(limit !== undefined && { limit }),
    ...(remaining !== undefined && { remaining }),
    ...(resetsInSeconds !== undefined && { resetsInSeconds }),
  }
}

function readCount(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
}

/**
 * These reset headers carry a duration, not a timestamp: OpenAI sends
 * Go-style strings such as `6m0s` or `1.5s`, and some gateways send bare
 * seconds. Anthropic's `rate_limits.resets_at` is epoch seconds, so the two
 * cannot be treated alike - a script doing date math on `6m0s` would silently
 * produce nonsense. Parse to seconds here and let the caller derive an epoch.
 */
export function parseResetDuration(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '') return undefined

  // A bare number is seconds - the form used by gateways that do not copy
  // OpenAI's duration syntax.
  if (/^\d+(\.\d+)?$/.test(value)) {
    return clampSeconds(Number.parseFloat(value))
  }

  const parts = value.match(/\d+(?:\.\d+)?(?:ms|s|m|h|d)/g)
  if (!parts) return undefined
  // Reject trailing junk so a malformed header is dropped rather than
  // half-read: `6m0s` is valid, `6m junk` is not.
  if (parts.join('') !== value) return undefined

  let seconds = 0
  for (const part of parts) {
    const match = part.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/)
    if (!match) return undefined
    seconds += Number.parseFloat(match[1]!) * DURATION_UNIT_SECONDS[match[2]!]!
  }
  return clampSeconds(seconds)
}

function clampSeconds(seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.round(seconds)
}

/**
 * Whether the active provider is known not to publish a quota.
 *
 * True only once the session has actually called it and seen a response with
 * no `x-ratelimit-*` header - never merely because nothing has been read yet.
 * Callers use this to say "unavailable" rather than leaving a silent gap the
 * user cannot tell apart from a bug.
 */
export function providerReportsNoQuota(activeProvider: string): boolean {
  return providersWithoutQuota.has(activeProvider)
}

/**
 * The header-sourced part of `provider_quota`, or undefined when nothing has
 * been read. buildStatusLineProviderQuota merges this with the account reading.
 *
 * The active provider is passed in and checked against the snapshot rather
 * than resolved here. getAPIProvider() is not stable within a session - team
 * mode forces a provider per agent and /provider rewrites the session
 * snapshot - so a number captured under one provider must never be rendered
 * under another.
 */
export function buildProviderQuotaInput(
  activeProvider: string,
): ProviderQuotaInput | undefined {
  const current = snapshot
  const unavailable = providersWithoutQuota.has(activeProvider)
    ? ({ provider: activeProvider, status: 'unavailable' } as const)
    : undefined
  if (!current || current.provider !== activeProvider) return unavailable

  const capturedAt = Math.floor(current.capturedAt / 1000)
  const requests = toWindowInput(current.requests, capturedAt)
  const tokens = toWindowInput(current.tokens, capturedAt)
  if (!requests && !tokens) return unavailable

  return {
    provider: current.provider,
    status: 'available',
    captured_at: capturedAt,
    ...(requests && { requests }),
    ...(tokens && { tokens }),
  }
}

function toWindowInput(
  window: ProviderRateLimitWindow | undefined,
  capturedAt: number,
): ProviderQuotaWindowInput | undefined {
  if (!window) return undefined
  const { limit, remaining, resetsInSeconds } = window
  // Match the polarity of rate_limits.used_percentage rather than reporting a
  // remaining fraction, so every percentage in the payload reads the same way.
  //
  // Whole percent, like every other percentage in the statusline payload.
  // Sub-1% resolution is meaningless for a quota readout, and an unrounded
  // ratio such as 1/3 would reach scripts as 66.66666666666667.
  const usedPercentage =
    limit !== undefined && remaining !== undefined && limit > 0
      ? Math.round(Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100)))
      : undefined

  return {
    ...(limit !== undefined && { limit }),
    ...(remaining !== undefined && { remaining }),
    ...(usedPercentage !== undefined && { used_percentage: usedPercentage }),
    ...(resetsInSeconds !== undefined && {
      resets_in_seconds: resetsInSeconds,
      // Epoch seconds, so scripts can treat this exactly like
      // rate_limits.*.resets_at.
      resets_at: capturedAt + resetsInSeconds,
    }),
  }
}
