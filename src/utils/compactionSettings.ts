/**
 * Pure vocabulary and arithmetic for the automatic-compaction controls.
 *
 * Deliberately dependency-free so the threshold math can be exercised on its
 * own. Reading and writing the values lives in ./compactionConfig.js; applying
 * them to a live model lives in services/compact/autoCompact.js.
 *
 * Two controls, both expressed relative to whatever context window the active
 * model actually reports, so nothing here is tied to a model or provider:
 *
 * - threshold percent — how full the usable window gets before compaction runs
 * - window cap        — an absolute ceiling, applied as min(modelWindow, cap)
 *
 * They answer different questions. The percentage keeps a large window from
 * being wasted; the cap bounds what a single turn can cost in absolute terms.
 * Both default to undefined, meaning "auto" — the behaviour that shipped
 * before these existed.
 */

/**
 * Floor of the threshold range.
 *
 * Below this, compaction fires so often that the summarization requests cost
 * more than the context they reclaim — each one re-reads the whole
 * conversation.
 */
export const COMPACT_THRESHOLD_MIN_PERCENT = 20

/**
 * Ceiling of the threshold range.
 *
 * The engine reserves an absolute headroom for the summary response and clamps
 * the resolved threshold to it, so asking for more than this cannot buy extra
 * room — it only hides that the clamp is doing the work. Keeping the slider
 * below the clamp means the number shown is the number used.
 */
export const COMPACT_THRESHOLD_MAX_PERCENT = 90

/** Slider granularity. */
export const COMPACT_THRESHOLD_STEP_PERCENT = 5

/**
 * Selectable context ceilings, in tokens.
 *
 * Intersected with the live model window via `min()`, so a ceiling larger than
 * the active model is inert rather than wrong. That is what lets one list
 * serve a 200K model and a 1M model.
 */
export const COMPACT_WINDOW_CAP_CHOICES: readonly number[] = [
  100_000, 200_000, 300_000, 500_000, 750_000, 1_000_000,
]

/** Clamp and round an arbitrary number to a valid threshold percentage. */
export function normalizeThresholdPercent(value: number): number {
  if (!Number.isFinite(value)) return COMPACT_THRESHOLD_MAX_PERCENT
  const stepped =
    Math.round(value / COMPACT_THRESHOLD_STEP_PERCENT) *
    COMPACT_THRESHOLD_STEP_PERCENT
  return Math.min(
    COMPACT_THRESHOLD_MAX_PERCENT,
    Math.max(COMPACT_THRESHOLD_MIN_PERCENT, stepped),
  )
}

/**
 * True when a stored value is a usable threshold percentage.
 *
 * Out-of-range values are rejected rather than clamped: a config carrying
 * something nonsensical should fall back to auto, not to the nearest extreme.
 */
export function isValidThresholdPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= COMPACT_THRESHOLD_MIN_PERCENT &&
    value <= COMPACT_THRESHOLD_MAX_PERCENT
  )
}

/** True when a stored value is a usable context ceiling. */
export function isValidWindowCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Resolved effect of a compaction configuration on one context window. */
export type CompactionThresholdResult = {
  /** Window after the ceiling and the summary-output reserve. */
  effectiveWindow: number
  /** Token count at which auto-compaction fires. */
  threshold: number
  /** Threshold as a share of the real window. */
  thresholdShareOfWindow: number
  /** Room left between the threshold and the real window. */
  headroomTokens: number
  /** True when the requested percentage was capped by the reserve. */
  clampedByReserve: boolean
  /** True when the proportional small-window reserve had to be substituted. */
  usedProportionalReserve: boolean
}

/**
 * Share of the window held back when the absolute reserve cannot fit.
 *
 * Only consulted for windows small enough that the fixed reserve would consume
 * them (below roughly 39K with the standard 33K reserve), so every mainstream
 * model keeps the exact behaviour it had before.
 */
const PROPORTIONAL_RESERVE_FRACTION = 0.15

/**
 * The whole threshold calculation, as arithmetic over explicit inputs.
 *
 * `min(requested, autoThreshold)` is what makes one percentage safe on every
 * window size: the reserve is an absolute number, so it is a much larger share
 * of a small window. A high percentage therefore resolves back to the auto
 * threshold on a 200K model instead of eating the headroom compaction itself
 * needs to run, while still moving the trigger meaningfully on a 1M model.
 */
export function computeCompactionThreshold(input: {
  /** The model's real context window. */
  contextWindow: number
  /** Tokens reserved for the summary response. */
  reservedForSummary: number
  /** Additional safety margin below the effective window. */
  bufferTokens: number
  /** Requested threshold percentage, or undefined for auto. */
  thresholdPercent: number | undefined
  /** Requested ceiling in tokens, or undefined for none. */
  windowCap: number | undefined
}): CompactionThresholdResult {
  const { contextWindow, reservedForSummary, bufferTokens } = input
  const capped = Math.max(
    1,
    input.windowCap !== undefined && input.windowCap > 0
      ? Math.min(contextWindow, input.windowCap)
      : contextWindow,
  )

  // The reserve is an absolute token count sized for mainstream windows, so on
  // a small local model (llama3 and codellama are 8K-16K) it exceeds the whole
  // window and the derived threshold goes negative — which reads as "always
  // over", firing compaction every single turn. Substituting a proportional
  // reserve keeps a usable threshold on any window size. The substitution only
  // engages when the absolute reserve genuinely cannot fit, so every model at
  // or above roughly 39K resolves exactly as it did before.
  const absoluteReserve = reservedForSummary + bufferTokens
  const proportionalReserve = Math.max(
    1,
    Math.floor(capped * PROPORTIONAL_RESERVE_FRACTION),
  )
  const usedProportionalReserve =
    absoluteReserve >= capped - proportionalReserve
  const effectiveReserve = usedProportionalReserve
    ? proportionalReserve
    : absoluteReserve

  // Floored at 1: a window smaller than its own proportional reserve (only
  // reachable by hand-editing a nonsensical ceiling into config) would
  // otherwise yield a zero or negative threshold, which reads downstream as
  // "always over" and would compact on every single turn.
  const autoThreshold = Math.max(1, capped - effectiveReserve)
  // Kept as the window the percentage is taken against, so a percentage means
  // "of what is usable" rather than "of what includes the summary's landing
  // space".
  const effectiveWindow = usedProportionalReserve
    ? autoThreshold
    : capped - reservedForSummary

  let threshold = autoThreshold
  let clampedByReserve = false
  if (input.thresholdPercent !== undefined) {
    const requested = Math.floor(
      effectiveWindow * (input.thresholdPercent / 100),
    )
    threshold = Math.min(requested, autoThreshold)
    clampedByReserve = requested > autoThreshold
  }

  return {
    effectiveWindow,
    threshold,
    thresholdShareOfWindow:
      contextWindow > 0 ? (threshold / contextWindow) * 100 : 0,
    headroomTokens: Math.max(0, contextWindow - threshold),
    clampedByReserve,
    usedProportionalReserve,
  }
}

/** Human-readable token count: 1_048_576 -> "1M", 200_000 -> "200K". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions >= 10 || Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

/**
 * What a threshold percentage means in plain terms. Phrased as trade-offs
 * rather than numbers, because the numbers are shown live alongside and depend
 * on the active model.
 */
export function describeThresholdPercent(percent: number | undefined): string {
  if (percent === undefined) {
    return 'Compact as late as safely possible. Most context kept, highest cost per turn.'
  }
  if (percent <= 30) {
    return 'Compact very early. Cheapest turns, but summaries happen often.'
  }
  if (percent <= 50) {
    return 'Compact early. Lower cost per turn, more frequent summaries.'
  }
  if (percent <= 70) {
    return 'Balanced. Noticeably cheaper turns on large windows.'
  }
  if (percent <= 85) {
    return 'Keep most of the window. Close to auto on small models.'
  }
  return 'Compact only near the ceiling. Closest to auto.'
}

/** What a context ceiling means. */
export function describeWindowCap(tokens: number | undefined): string {
  if (tokens === undefined) {
    return "No ceiling. Uses the model's full context window."
  }
  return `Behave as if the window were ${formatTokenCount(tokens)}, even on larger models. Bounds what one turn can cost.`
}
