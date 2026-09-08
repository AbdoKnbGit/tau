/**
 * Contract for the automatic-compaction threshold math.
 * Run: bun run src/utils/compactionSettings.test.ts
 *
 * The load-bearing property is the first block: introducing the settings must
 * not move the trigger for anyone who has not configured them. Everything else
 * checks that one percentage and one ceiling stay meaningful across every
 * window size, which is what lets these controls be model- and
 * provider-agnostic.
 */
import assert from 'node:assert/strict'
import {
  COMPACT_THRESHOLD_MAX_PERCENT,
  COMPACT_THRESHOLD_MIN_PERCENT,
  computeCompactionThreshold,
  formatTokenCount,
  isValidThresholdPercent,
  isValidWindowCap,
  normalizeThresholdPercent,
} from './compactionSettings.js'

/** The engine's real constants. */
const RESERVE = 20_000
const BUFFER = 13_000

function threshold(
  contextWindow: number,
  thresholdPercent?: number,
  windowCap?: number,
) {
  return computeCompactionThreshold({
    contextWindow,
    reservedForSummary: RESERVE,
    bufferTokens: BUFFER,
    thresholdPercent,
    windowCap,
  })
}

// ── Unconfigured behaviour is byte-for-byte what it was ──────────────────
// Anything at or above ~39K must keep resolving to `window - reserve - buffer`,
// the formula that shipped before these settings existed.
for (const window of [128_000, 200_000, 262_144, 272_000, 1_048_576, 2_097_152]) {
  const auto = threshold(window)
  assert.equal(
    auto.threshold,
    window - RESERVE - BUFFER,
    `auto threshold changed for a ${window}-token window`,
  )
  assert.equal(auto.usedProportionalReserve, false)
  assert.equal(auto.clampedByReserve, false)
}

// ── Small windows no longer produce a negative threshold ─────────────────
// The absolute reserve exceeds an 8K window, which used to yield a negative
// number — read downstream as "always over", firing compaction every turn.
for (const window of [8_192, 16_384, 32_768]) {
  const auto = threshold(window)
  assert.ok(
    auto.threshold > 0,
    `threshold must stay positive on a ${window}-token window`,
  )
  assert.ok(
    auto.threshold < window,
    `threshold must leave headroom on a ${window}-token window`,
  )
  assert.equal(auto.usedProportionalReserve, true)
}

// ── A percentage always fires earlier than auto, never later ─────────────
for (const window of [8_192, 128_000, 200_000, 1_048_576]) {
  const auto = threshold(window).threshold
  for (const percent of [20, 50, 70, 90]) {
    const picked = threshold(window, percent).threshold
    assert.ok(
      picked <= auto,
      `${percent}% must not push the trigger past auto on ${window}`,
    )
    assert.ok(picked > 0, `${percent}% must stay positive on ${window}`)
  }
}

// ── Monotonic: a higher percentage never compacts earlier ────────────────
for (const window of [128_000, 200_000, 1_048_576]) {
  let previous = 0
  for (let percent = 20; percent <= 90; percent += 5) {
    const picked = threshold(window, percent).threshold
    assert.ok(picked >= previous, `not monotonic at ${percent}% on ${window}`)
    previous = picked
  }
}

// ── The ceiling is inert below the model's own window ────────────────────
assert.equal(threshold(200_000, undefined, 500_000).threshold, threshold(200_000).threshold)
assert.equal(threshold(200_000, undefined, 200_000).threshold, threshold(200_000).threshold)
// ...and makes a large model behave exactly like the smaller one.
assert.equal(
  threshold(1_048_576, undefined, 200_000).threshold,
  threshold(200_000).threshold,
  'a 200K ceiling on a 1M model must match a native 200K model',
)

// ── Clamping is reported, not hidden ─────────────────────────────────────
// 90% of a 128K window lands past what the reserve allows, so the resolved
// value falls back to auto and says so.
const clamped = threshold(128_000, 90)
assert.equal(clamped.clampedByReserve, true)
assert.equal(clamped.threshold, threshold(128_000).threshold)
// The same request on a 1M window has room and is honoured as asked.
assert.equal(threshold(1_048_576, 90).clampedByReserve, false)

// ── Validation rejects rather than clamps ────────────────────────────────
assert.equal(isValidThresholdPercent(COMPACT_THRESHOLD_MIN_PERCENT), true)
assert.equal(isValidThresholdPercent(COMPACT_THRESHOLD_MAX_PERCENT), true)
assert.equal(isValidThresholdPercent(10), false)
assert.equal(isValidThresholdPercent(95), false)
assert.equal(isValidThresholdPercent('70'), false)
assert.equal(isValidThresholdPercent(Number.NaN), false)
assert.equal(isValidWindowCap(0), false)
assert.equal(isValidWindowCap(-1), false)
assert.equal(isValidWindowCap(1_000_000), true)

// ── Normalization snaps into range and onto the step ─────────────────────
assert.equal(normalizeThresholdPercent(5), COMPACT_THRESHOLD_MIN_PERCENT)
assert.equal(normalizeThresholdPercent(200), COMPACT_THRESHOLD_MAX_PERCENT)
assert.equal(normalizeThresholdPercent(67), 65)
assert.equal(normalizeThresholdPercent(Number.NaN), COMPACT_THRESHOLD_MAX_PERCENT)

// ── Display formatting ───────────────────────────────────────────────────
assert.equal(formatTokenCount(8_192), '8K')
assert.equal(formatTokenCount(200_000), '200K')
assert.equal(formatTokenCount(1_000_000), '1M')
assert.equal(formatTokenCount(1_048_576), '1.0M')

console.log('compactionSettings: all assertions passed')
