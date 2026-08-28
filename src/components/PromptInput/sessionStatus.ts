import { homedir } from 'os'
import path from 'path'
import { stringWidth } from '../../ink/stringWidth.js'
import { truncateStartToWidth, truncateToWidth } from '../../utils/truncate.js'

const STATUS_HORIZONTAL_PADDING = 4
const SEPARATOR = ' · '
const FULL_BAR_WIDTH = 10
const COMPACT_BAR_WIDTH = 6
/** Below this width the cwd and provider/model columns stop being readable. */
const MIN_FLEXIBLE_WIDTH = 16

export type SessionStatusInfo = {
  cwd: string
  provider: string
  model: string
  usedContextTokens: number | null
  contextWindowTokens: number | null
  consumedContextPercentage: number | null
  /**
   * Quota standing for the active provider, or null while it is still being
   * determined - no turn taken yet, or an account lookup still in flight.
   *
   * Null renders as no segment. 'unavailable' renders as `Quota n/a`, and is
   * a conclusion rather than a gap: both the response headers and the
   * provider's own account endpoint were consulted and neither publishes a
   * number (MiMo is one such provider; see reportMimo in providerUsage.ts).
   */
  quota: SessionQuotaStatus | null
}

/**
 * Percent used rather than remaining, so this reads the same direction as the
 * context bar beside it - two gauges on one row pointing opposite ways is a
 * misreading waiting to happen.
 */
export type SessionQuotaStatus =
  /**
   * A window's consumption. `window` names it when the reading is the rolling
   * session limit, so a bare "12%" cannot be read as a weekly cap or a balance.
   */
  | { state: 'used'; percentage: number; window?: string }
  /**
   * A standing with no denominator, e.g. `$12.34 remaining`. A prepaid
   * balance has no total to measure against unless a budget is configured,
   * and the amount still answers the question the row is asking.
   */
  | { state: 'text'; text: string }
  /**
   * What the session has spent, for providers that publish no quota at all.
   * `estimated` marks a flat-fee provider, where the figure is what the same
   * usage would cost on an API rather than an amount actually billed.
   */
  | { state: 'spend'; usd: number; estimated: boolean }
  | { state: 'unavailable' }

function normalizePercentage(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * Percentage of the full context window consumed by conversation content.
 * The caller supplies conversation-only tokens so fixed system, tool-schema,
 * and skill-frontmatter overhead never inflates the displayed usage.
 */
export function calculateConsumedContextPercentage(
  conversationTokens: number,
  contextWindow: number,
): number | null {
  if (
    !Number.isFinite(conversationTokens) ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return null
  }

  return Math.min(100, Math.max(0, (conversationTokens / contextWindow) * 100))
}

/**
 * Compact token count for the status row: `840`, `16K`, `1M`, `1.5M`.
 * Counts round rather than truncate so an in-progress conversation never
 * reads as `0K` while tokens are already being consumed.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'

  const rounded = Math.round(tokens)
  if (rounded < 1_000) return String(rounded)
  // Below the rounding boundary of `1000K`, which reads worse than `1M`.
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}K`

  const millions = tokens / 1_000_000
  if (millions >= 10) return `${Math.round(millions)}M`
  return `${millions.toFixed(1).replace(/\.0$/, '')}M`
}

/** `16K/1M`, or null when the window or usage has not been measured yet. */
function formatUsageRatio(info: SessionStatusInfo): string | null {
  const { usedContextTokens: used, contextWindowTokens: window } = info
  if (used === null || window === null) return null
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) {
    return null
  }

  return `${formatTokenCount(used)}/${formatTokenCount(window)}`
}

/**
 * The value shown beside the bar: `16K/1M (2%)` when the row has space for
 * the token counts, otherwise the percentage alone.
 */
function contextValueLabel(
  info: SessionStatusInfo,
  withTokenCounts: boolean,
): string {
  const consumed = normalizePercentage(info.consumedContextPercentage)
  const percentage = consumed === null ? '--' : `${consumed}%`
  const ratio = withTokenCounts ? formatUsageRatio(info) : null
  return ratio === null ? percentage : `${ratio} (${percentage})`
}

/**
 * `Quota 80%`, or null when there is no reading to show.
 *
 * The provider is deliberately not repeated here - the row already names it
 * two columns to the left, and this segment only ever renders on the widest
 * layout where that column is present in full.
 */
function quotaSegment(info: SessionStatusInfo): string | null {
  if (info.quota === null) return null
  if (info.quota.state === 'unavailable') return 'Quota n/a'
  if (info.quota.state === 'spend') {
    const amount = formatUsd(info.quota.usd)
    return amount === null
      ? null
      : `${info.quota.estimated ? 'Est' : 'Spend'} ${amount}`
  }
  if (info.quota.state === 'text') {
    const text = info.quota.text.trim()
    return text === '' ? null : `Quota ${text}`
  }
  const used = normalizePercentage(info.quota.percentage)
  if (used === null) return null
  return info.quota.window
    ? `Quota ${info.quota.window} ${used}%`
    : `Quota ${used}%`
}

/**
 * Money for a one-line row. Sub-cent amounts collapse to `<$0.01` rather than
 * rounding to `$0.00`, which would read as "free" for work that was not.
 */
function formatUsd(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function contextBar(percentage: number | null, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width))
  if (safeWidth === 0) return ''

  const filled =
    percentage === null
      ? 0
      : Math.round((normalizePercentage(percentage)! / 100) * safeWidth)
  return '█'.repeat(filled) + '░'.repeat(safeWidth - filled)
}

/**
 * Collapse a working directory under the user's home directory to `~`.
 * `path.relative` keeps the containment check segment-aware, so sibling paths
 * which merely share the home directory's prefix are left untouched.
 */
export function shortenSessionCwd(
  cwd: string,
  home: string = homedir(),
  pathApi: Pick<
    typeof import('path'),
    'isAbsolute' | 'join' | 'relative' | 'sep'
  > = path,
): string {
  if (!home) return cwd

  const relativePath = pathApi.relative(home, cwd)
  if (relativePath === '') return '~'
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  ) {
    return cwd
  }

  return pathApi.join('~', relativePath)
}

/**
 * Format the persistent session row to exactly one terminal line. The context
 * readout stays visible at every supported width; cwd and provider/model share
 * the remaining space and truncate independently so one cannot starve the
 * other. The token counts are the first thing dropped when the row runs out of
 * room, since the percentage alone still answers "how full is the window?".
 */
export function formatSessionStatus(
  info: SessionStatusInfo,
  terminalColumns: number,
): string {
  const safeColumns = Number.isFinite(terminalColumns)
    ? Math.max(0, Math.floor(terminalColumns))
    : 0
  const availableWidth = Math.max(0, safeColumns - STATUS_HORIZONTAL_PADDING)
  if (availableWidth === 0) return ''

  const cwd = info.cwd || '?'
  const provider = info.provider || '?'
  const model = info.model || '?'
  const consumed = normalizePercentage(info.consumedContextPercentage)
  const detailedLabel = contextValueLabel(info, true)
  const briefLabel = contextValueLabel(info, false)

  const fullContext = `Context ${contextBar(consumed, FULL_BAR_WIDTH)} ${detailedLabel}`
  const full = `${cwd}${SEPARATOR}${provider} / ${model}${SEPARATOR}${fullContext}`

  // Quota rides along only when the row is already showing everything else,
  // and is the first thing dropped. Context changes with every keystroke and
  // has to stay legible at any width; a quota moves on a scale of minutes, so
  // losing it to a narrow terminal costs the reader nothing.
  const quota = quotaSegment(info)
  if (quota !== null) {
    const withQuota = `${full}${SEPARATOR}${quota}`
    if (stringWidth(withQuota) <= availableWidth) return withQuota
  }
  if (stringWidth(full) <= availableWidth) return full

  const providerModel = `${provider}/${model}`
  const separatorWidth = stringWidth(SEPARATOR) * 2
  const compactBar = contextBar(consumed, COMPACT_BAR_WIDTH)

  for (const [segment, minimumFlexibleWidth] of [
    [`${compactBar} ${detailedLabel}`, MIN_FLEXIBLE_WIDTH],
    [`${compactBar} ${briefLabel}`, 2],
  ] as const) {
    const flexibleWidth =
      availableWidth - stringWidth(segment) - separatorWidth
    if (flexibleWidth < minimumFlexibleWidth) continue

    let cwdWidth = Math.floor(flexibleWidth * 0.4)
    if (flexibleWidth >= MIN_FLEXIBLE_WIDTH) {
      cwdWidth = Math.max(6, Math.min(flexibleWidth - 8, cwdWidth))
    } else {
      cwdWidth = Math.max(1, Math.min(flexibleWidth - 1, cwdWidth))
    }

    return [
      truncateStartToWidth(cwd, cwdWidth),
      truncateToWidth(providerModel, flexibleWidth - cwdWidth),
      segment,
    ].join(SEPARATOR)
  }

  // Pathological terminal widths cannot show three independently useful
  // fields. Keep as much of the context readout as the row can hold.
  for (const label of [detailedLabel, briefLabel]) {
    const segment = `${compactBar} ${label}`
    if (stringWidth(segment) <= availableWidth) return segment
  }
  if (availableWidth < stringWidth(briefLabel) + 2) {
    return contextBar(consumed, availableWidth)
  }
  const barWidth = availableWidth - stringWidth(briefLabel) - 1
  return `${contextBar(consumed, barWidth)} ${briefLabel}`
}
