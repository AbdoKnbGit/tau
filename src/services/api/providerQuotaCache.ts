/**
 * Account-level quota for the active provider, for the status bar.
 *
 * Header harvesting (providerRateLimits.ts) is free but only covers providers
 * that publish `x-ratelimit-*`. The rest keep their standing behind an account
 * endpoint - OpenRouter credits, a DeepSeek balance, a Kiro utilization - which
 * is what /usage already fetches. This module makes exactly that data available
 * to the bar without adopting the hazards of a background poller:
 *
 *   - No timer. Refresh is driven by the bar rendering, so a session that is
 *     not showing the bar (`tau -p`, a piped run) never issues a request.
 *   - One provider, never all nineteen.
 *   - Never on the render path. Callers read a synchronous snapshot; the fetch
 *     is fire-and-forget and lands on a later frame.
 *
 * The cost that remains, stated plainly: an interactive session on a provider
 * with a reporter makes one account request per TTL while the bar is visible.
 *
 * ── Why outcomes are a union rather than a nullable number ──────────────
 *
 * A lookup can end four ways, and collapsing them is how a status bar starts
 * lying. "The provider has no quota API" and "the request just failed" both
 * produce no number, but only the first is an answer. Caching the second as
 * though it were one turns a momentary outage into a confident "n/a" that
 * outlives it. So a transient failure is never stored as a settled outcome:
 * the previous reading stands, and the next attempt is delayed by backoff
 * rather than repeated on every keystroke.
 */

import { hasProviderUsageReporter } from './providerUsageCoverage.js'
import {
  buildProviderQuotaInput,
  type ProviderQuotaInput,
} from './providerRateLimits.js'
import type { ProviderUsageReport, ProviderUsageId } from './providerUsage.js'

/** Balances move slowly; this is about freshness, not precision. */
const TTL_MS = 5 * 60_000

/**
 * Per-provider overrides. Antigravity's pool moves visibly while you work -
 * it can shift several percent within one session - so it refreshes faster
 * than a credit balance does. That is affordable because its status read
 * remembers a working endpoint and costs one request, not a sweep.
 */
const PROVIDER_TTL_MS: Readonly<Record<string, number>> = {
  antigravity: 3 * 60_000,
}

function ttlFor(provider: string): number {
  return PROVIDER_TTL_MS[provider] ?? TTL_MS
}

/**
 * How long a reading may still be shown once refreshes stop succeeding.
 * Past this the segment goes quiet - never to "n/a", because a failure to
 * refresh says nothing about whether the quota exists.
 */
const MAX_STALE_MS = 30 * 60_000

/** First retry delay after a failure; doubles per consecutive failure. */
const RETRY_BASE_MS = 30_000

export type ProviderQuotaReading = {
  /**
   * Percent of the account's allowance consumed, or null when the provider
   * reports a standing that is not a proportion.
   *
   * A balance has no denominator: DeepSeek returns "$12.34 remaining" and
   * only yields a percentage once a budget env var supplies the total.
   */
  usedPercent: number | null
  /**
   * The standing as text, e.g. `$12.34 remaining`, for providers that report
   * an amount rather than a proportion.
   */
  summary: string | null
  /** Short description of what the reading measures, e.g. `Credits`. */
  label: string | null
}

/** One window as the provider reported it, kept for read-time selection. */
export type ProviderQuotaMetric = {
  label: string
  usedPercent: number | null
  summary: string | null
}

/**
 * A settled answer. Transient failures are deliberately not representable
 * here - they are signalled by a null classification and never stored.
 */
export type ProviderQuotaOutcome =
  | ({ kind: 'reading' } & ProviderQuotaReading & {
      /**
       * Every usable window from the same response. Kept because the right
       * one to show depends on the model in use, which is known at render
       * time and not at fetch time.
       */
      metrics?: ProviderQuotaMetric[]
    })
  /** The provider was reached and publishes no quota at all (MiMo). */
  | { kind: 'absent' }
  /** No credential for the provider's usage API; user-fixable. */
  | { kind: 'unconfigured' }

type CacheEntry = {
  settled: ProviderQuotaOutcome | null
  settledAt: number
  consecutiveFailures: number
  lastAttemptAt: number
}

/**
 * Providers whose quota lives on the machine or nowhere, so an account fetch
 * cannot tell us anything a local check has not already established.
 */
const NO_ACCOUNT_QUOTA: ReadonlySet<string> = new Set(['ollama', 'lmstudio'])

const entries = new Map<string, CacheEntry>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()

/**
 * Notified when a reading lands. The fetch completes long after the render
 * that started it, and nothing else would tell the bar to repaint.
 */
export function subscribeProviderQuota(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The settled outcome for a provider, or undefined when there is nothing to
 * act on yet - never fetched, still in flight, or a reading too old to stand
 * behind. Callers render undefined as no segment at all.
 */
export function getProviderQuotaOutcome(
  provider: string,
  activeModel?: string,
): ProviderQuotaOutcome | undefined {
  const entry = entries.get(provider)
  if (!entry?.settled) return undefined
  const settled = entry.settled
  // Only a reading goes stale. "Absent" and "unconfigured" describe a
  // configuration, not a measurement, so they do not decay.
  if (settled.kind === 'reading' && Date.now() - entry.settledAt > MAX_STALE_MS) {
    return undefined
  }

  // Prefer the window belonging to the model actually in use. Antigravity
  // meters Claude and Gemini separately, so the tightest pool is often not
  // the one this session is spending.
  if (settled.kind === 'reading' && activeModel && settled.metrics) {
    const match = settled.metrics.find(
      metric =>
        metric.usedPercent !== null &&
        metricMatchesModel(metric.label, activeModel),
    )
    if (match) {
      return {
        kind: 'reading',
        usedPercent: match.usedPercent,
        summary: match.summary,
        label: match.label,
        metrics: settled.metrics,
      }
    }
  }
  return settled
}

/** Test seam. */
export function resetProviderQuotaCache(): void {
  entries.clear()
  inFlight.clear()
}

/**
 * Whether this provider can ever produce an account reading. Callers use it to
 * tell "nothing available anywhere" apart from "not fetched yet".
 */
export function providerHasAccountQuota(provider: string): boolean {
  if (NO_ACCOUNT_QUOTA.has(provider)) return false
  return hasProviderUsageReporter(provider)
}

/**
 * Start a refresh if one is due. Returns immediately and never throws - the
 * caller renders whatever is settled now, and the next frame picks up the
 * result.
 */
export function ensureProviderQuotaFresh(provider: string): void {
  if (!providerHasAccountQuota(provider)) return
  if (inFlight.has(provider)) return
  if (!shouldFetch(provider, Date.now())) return

  inFlight.add(provider)
  // Imported here rather than at module scope: providerUsage pulls in every
  // provider client, and nothing should pay for that unless a fetch happens.
  void import('./providerUsage.js')
    .then(module =>
      module.fetchProviderUsageFor(provider as ProviderUsageId, {
        // Read-only stand-ins where a /usage reporter would write credentials.
        statusBar: true,
      }),
    )
    .then(report => noteOutcome(provider, classifyReport(report)))
    .catch(() => noteOutcome(provider, null))
    .finally(() => {
      inFlight.delete(provider)
    })
}

/**
 * Whether a fetch is due: nothing settled yet, the settled answer has aged
 * past its TTL, or a failure streak's backoff has elapsed.
 *
 * The backoff is what makes "do not cache failures" safe. Refresh is driven by
 * renders, which happen on every keystroke, so a provider that is failing
 * would otherwise be retried continuously.
 */
function shouldFetch(provider: string, now: number): boolean {
  const entry = entries.get(provider)
  if (!entry) return true

  // A clock that jumps backwards - NTP correction, a resumed VM - makes an
  // age negative. Reading that as "not old enough yet" would freeze refreshes
  // until real time caught up, so an impossible age counts as due.
  const settledAge = now - entry.settledAt
  if (entry.settled && settledAge >= 0 && settledAge < ttlFor(provider)) {
    return false
  }

  const attemptAge = now - entry.lastAttemptAt
  if (
    entry.consecutiveFailures > 0 &&
    attemptAge >= 0 &&
    attemptAge < retryDelay(entry.consecutiveFailures)
  ) {
    return false
  }
  return true
}

/** 30s, 60s, 120s, 240s, then capped at the normal refresh interval. */
function retryDelay(consecutiveFailures: number): number {
  const exponential = RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1)
  return Math.min(TTL_MS, exponential)
}

/**
 * Record the result of an attempt. A null outcome is a transient failure: it
 * records the attempt for backoff purposes and leaves any previous settled
 * answer exactly where it was.
 */
function noteOutcome(
  provider: string,
  outcome: ProviderQuotaOutcome | null,
  at: number = Date.now(),
): void {
  const previous = entries.get(provider)
  if (outcome === null) {
    entries.set(provider, {
      settled: previous?.settled ?? null,
      settledAt: previous?.settledAt ?? 0,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      lastAttemptAt: at,
    })
    // Nothing the bar renders has changed, so no repaint is needed.
    return
  }

  entries.set(provider, {
    settled: outcome,
    settledAt: at,
    consecutiveFailures: 0,
    lastAttemptAt: at,
  })
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A subscriber that throws must not skip the remaining listeners, and
      // must not propagate: the caller would treat a stored reading as a
      // failed lookup and delay the next refresh for no reason.
    }
  }
}

/**
 * Map a usage report onto a settled outcome, or null for a transient failure.
 *
 * ProviderUsageStatus already draws these distinctions; the job here is to
 * stop discarding them. Note that a report can be status 'ok' or 'connected'
 * and still carry nothing usable - MiMo reports 'connected' with no metrics
 * because it has no quota API - and that is a genuine absence, not a failure.
 */
function classifyReport(
  report: ProviderUsageReport | null,
): ProviderQuotaOutcome | null {
  // No reporter covers this provider. Guarded against upstream, but a missing
  // source is an absence rather than something to retry.
  if (!report) return { kind: 'absent' }

  switch (report.status) {
    case 'error':
      return null
    case 'not_configured':
      return { kind: 'unconfigured' }
    case 'unsupported':
      return { kind: 'absent' }
    default: {
      const reading = readHeadlineMetric(report)
      if (reading.usedPercent !== null || reading.summary !== null) {
        return { kind: 'reading', ...reading, metrics: collectMetrics(report) }
      }
      return { kind: 'absent' }
    }
  }
}

/** Reporters label the rolling session window this way (see reportAnthropic). */
const SESSION_METRIC = /current session/i

/** Strip case, spaces and punctuation so `Gemini 3 Flash` meets `gemini-3-flash`. */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Whether a metric describes the model the session is actually running.
 *
 * Antigravity reports a separate pool per model family - a spent Gemini pool
 * next to an untouched Claude one - so the worst-window rule would report 71%
 * to someone running Claude at 0%. The row must follow the model in use.
 */
function metricMatchesModel(label: string, model: string): boolean {
  const a = normalizeForMatch(label)
  const b = normalizeForMatch(model)
  if (a === '' || b === '') return false
  return a.includes(b) || b.includes(a)
}

/**
 * The one number worth putting on a single-line bar.
 *
 * A session window wins outright where one exists: Anthropic reports a 5-hour
 * session alongside several weekly windows, and the weekly figure is usually
 * the larger one - taking the maximum would quietly replace "what stops me
 * today" with "what stops me this week".
 *
 * Otherwise the metric nearest its ceiling wins, since that is the one that
 * will stop work first. Failing both, an amount with no denominator still
 * answers the question, which is what a prepaid balance looks like.
 */
/**
 * Every window worth keeping, rounded the same way the headline is, so a
 * read-time reselection cannot disagree with the number chosen at fetch time.
 */
function collectMetrics(report: ProviderUsageReport): ProviderQuotaMetric[] {
  return (report.metrics ?? []).map(metric => ({
    label: metric.label,
    usedPercent:
      typeof metric.usedPercent === 'number' &&
      Number.isFinite(metric.usedPercent)
        ? Math.round(Math.min(100, Math.max(0, metric.usedPercent)))
        : null,
    summary: metric.summary ?? null,
  }))
}

function readHeadlineMetric(report: ProviderUsageReport): ProviderQuotaReading {
  const nothing = { usedPercent: null, summary: null, label: null }
  const metrics = report.metrics ?? []

  const scored = metrics.filter(
    (metric): metric is typeof metric & { usedPercent: number } =>
      typeof metric.usedPercent === 'number' &&
      Number.isFinite(metric.usedPercent),
  )
  if (scored.length > 0) {
    const chosen =
      scored.find(metric => SESSION_METRIC.test(metric.label)) ??
      scored.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
    return {
      // Whole percent, like every other percentage in the statusline payload.
      // Antigravity's remainingFraction arithmetic lands on values such as
      // 61.775999999999996, and scripts print what they are given.
      usedPercent: Math.round(Math.min(100, Math.max(0, chosen.usedPercent))),
      summary: chosen.summary ?? null,
      label: chosen.label,
    }
  }

  const described = metrics.find(
    metric => typeof metric.summary === 'string' && metric.summary.trim() !== '',
  )
  if (!described) return nothing
  return {
    usedPercent: null,
    summary: described.summary!.trim(),
    label: described.label,
  }
}

/**
 * The `provider_quota` field for statusLine commands, merging both sources so
 * a custom row and the built-in bar cannot disagree.
 *
 * `used_percentage` is the headline number the bar shows, whatever produced
 * it. `source` says which: 'headers' is per-call rate limiting, 'account' is
 * the provider's own balance or utilization endpoint.
 */
export function buildStatusLineProviderQuota(
  provider: string,
): ProviderQuotaInput | undefined {
  const harvested = buildProviderQuotaInput(provider)
  const windows = [harvested?.requests, harvested?.tokens]
    .map(window => window?.used_percentage)
    .filter((value): value is number => value !== undefined)
  if (windows.length > 0 && harvested) {
    return {
      ...harvested,
      source: 'headers',
      used_percentage: Math.max(...windows),
    }
  }

  const outcome = getProviderQuotaOutcome(provider)
  if (outcome?.kind === 'reading') {
    const entry = entries.get(provider)
    return {
      provider,
      status: 'available',
      source: 'account',
      ...(outcome.usedPercent !== null && {
        used_percentage: outcome.usedPercent,
      }),
      ...(outcome.summary && { summary: outcome.summary }),
      ...(entry && { captured_at: Math.floor(entry.settledAt / 1000) }),
      ...(outcome.label && { label: outcome.label }),
    }
  }
  if (outcome) return { provider, status: 'unavailable', source: 'account' }

  // A header-only absence is conclusive only where no account source exists;
  // otherwise the account lookup may simply not have settled yet.
  if (
    !providerHasAccountQuota(provider) &&
    harvested?.status === 'unavailable'
  ) {
    return { provider, status: 'unavailable', source: 'headers' }
  }
  return undefined
}

// ─── Test seams ──────────────────────────────────────────────────────
// The policy above is the part worth testing, and it is unreachable through
// the public API without a network.

export const _classifyReport = classifyReport
export const _retryDelay = retryDelay
export const _shouldFetch = shouldFetch
export const _noteOutcome = noteOutcome
