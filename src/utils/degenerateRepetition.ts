/**
 * Degenerate output-loop detection.
 *
 * A model that loses the thread sometimes stops generating and starts
 * *looping*: the same sentence or paragraph emitted over and over until the
 * output-token ceiling finally stops it. Weak and heavily quantized models on
 * compat lanes do it most, usually after a tool returns nothing useful and
 * they have nothing left to say. Nothing in the streaming protocol catches it
 * — `stop_reason` only arrives at the end, so a stream that has degenerated
 * looks exactly like a stream that is working, and the turn burns output
 * tokens until the ceiling is hit.
 *
 * This module finds the pattern in accumulated text so the caller can cut the
 * stream off. Two deliberate properties:
 *
 *   - Leaf module. No imports, no I/O, no env reads (thresholds are passed
 *     in), so degenerateRepetition.test.ts runs standalone.
 *   - Exact-match only. Detection is exact periodicity at the *tail* of the
 *     text, which is what a decoding loop actually produces. Near-repeats
 *     ("1. foo / 2. foo") are not flagged: a fuzzy matcher would eventually
 *     truncate legitimate structured output, and a false positive here
 *     silently cuts a real answer short.
 */

/** Consecutive copies of the repeating unit before a tail counts as a loop. */
export const DEFAULT_MIN_REPEATS = 6

/** Characters the repeating run must span before it counts as a loop. */
export const DEFAULT_MIN_REPEATED_CHARS = 1500

/**
 * Longest repeating unit considered. Longer units do occur, but the longer
 * the unit the likelier the text is legitimately structured rather than
 * looping, and verification cost grows with it.
 */
const MAX_PERIOD = 2048

/**
 * Tail searched for the previous copy of the anchor. Bounds the cost of
 * finding the unit on a long response; it does not bound the run itself,
 * which is measured over the whole text once the unit is known.
 */
const WINDOW_CHARS = 16_384

/**
 * Suffix used to locate the previous copy. Long enough that an accidental
 * re-occurrence is unlikely; being *longer* than the unit is harmless,
 * because in a looping tail the anchor is itself periodic and its nearest
 * earlier occurrence still sits exactly one unit back.
 */
const ANCHOR_CHARS = 48

/** New characters that must arrive before the tail is re-examined. */
const CHECK_INTERVAL_CHARS = 256

/** Cap on the unit copy carried in the detection, which is for logs only. */
const UNIT_PREVIEW_CHARS = 80

export type RepetitionThresholds = {
  minRepeats?: number
  minRepeatedChars?: number
}

export type RepetitionDetection = {
  /** Length of the repeating unit. */
  period: number
  /** Consecutive copies found at the tail, counted within the window. */
  repeats: number
  /** Characters the run spans: `period * repeats`. */
  repeatedChars: number
  /**
   * Prefix length that keeps everything before the run plus one copy of the
   * unit, so the trimmed text still reads as a finished thought.
   */
  keepChars: number
  /** The unit, truncated. Diagnostics only — never send it to analytics. */
  unit: string
}

/**
 * Report an exactly-repeating run at the tail of `text`.
 *
 * The unit is found rather than guessed: the last {@link ANCHOR_CHARS} of the
 * text are located at their previous occurrence, and the distance between the
 * two is the candidate period. That one `lastIndexOf` replaces trying every
 * period in turn, and it yields the *smallest* period, so "abab…" is reported
 * as a 2-character loop rather than a 4-character one.
 *
 * The tail may (and usually does) end mid-unit. That is fine: a rotation of a
 * periodic string has the same period, so counting copies backward from the
 * very end is phase-independent.
 */
export function detectDegenerateRepetition(
  text: string,
  options?: RepetitionThresholds,
): RepetitionDetection | null {
  const minRepeats = options?.minRepeats ?? DEFAULT_MIN_REPEATS
  const minRepeatedChars = options?.minRepeatedChars ?? DEFAULT_MIN_REPEATED_CHARS
  // A threshold of 1 repeat would match every string against itself.
  if (minRepeats < 2 || minRepeatedChars < 1) return null

  const length = text.length
  if (length < minRepeatedChars) return null

  const offset = Math.max(0, length - WINDOW_CHARS)
  const window = offset === 0 ? text : text.slice(offset)
  const windowLength = window.length

  const anchorStart = windowLength - Math.min(ANCHOR_CHARS, windowLength)
  if (anchorStart < 1) return null
  const previous = window.lastIndexOf(window.slice(anchorStart), anchorStart - 1)
  if (previous < 0) return null

  const period = anchorStart - previous
  if (period < 1 || period > MAX_PERIOD) return null

  // Counted over the whole text, not just the window: a loop left running
  // produces a run far longer than any window worth searching, and stopping
  // the count at the window edge would report a run that starts where the
  // window happens to start — trimming to there would keep every earlier copy.
  // The walk only covers ground the run actually occupies, so it costs what
  // the loop cost to produce and nothing on text that is not repeating.
  const unit = text.slice(length - period)
  let runStart = length - period
  let repeats = 1
  while (runStart >= period && text.startsWith(unit, runStart - period)) {
    runStart -= period
    repeats++
  }

  const repeatedChars = repeats * period
  if (repeats < minRepeats || repeatedChars < minRepeatedChars) return null

  return {
    period,
    repeats,
    repeatedChars,
    keepChars: runStart + period,
    unit:
      unit.length > UNIT_PREVIEW_CHARS
        ? `${unit.slice(0, UNIT_PREVIEW_CHARS)}…`
        : unit,
  }
}

/**
 * Drop the repeated run, keeping one copy of the unit. What remains is the
 * text the model produced before it started looping, plus one pass of
 * whatever it got stuck on so the notice that follows makes sense.
 *
 * The kept copy runs one unit-length from where the run began, which lands
 * mid-sentence whenever the stream was cut mid-unit. That is left alone: the
 * text is explicitly a truncation, and snapping to a prettier boundary would
 * mean guessing at where the model "meant" the unit to start.
 */
export function trimRepeatedTail(
  text: string,
  detection: RepetitionDetection,
): string {
  return detection.keepChars < text.length
    ? text.slice(0, detection.keepChars)
    : text
}

/**
 * The line appended in place of the removed run. It stays in the assistant
 * message, so it is written for two readers: the user, who needs to know the
 * answer was cut rather than finished, and the model on the next turn, which
 * needs to know it was looping.
 */
export function formatRepetitionNotice(detection: RepetitionDetection): string {
  return `\n\n[stopped: output began repeating — the same ${detection.period}-character passage ${detection.repeats} times in a row — and was truncated here]`
}

export type RepetitionGuard = {
  /**
   * Feed the full accumulated text of a content block after each delta.
   * Returns a detection the first time the block trips the thresholds.
   */
  check(blockIndex: number, accumulated: string): RepetitionDetection | null
}

/**
 * Throttled per-block wrapper over {@link detectDegenerateRepetition}.
 *
 * Streaming deltas are small and frequent, so re-scanning on every one would
 * pay the window cost hundreds of times per response for an answer that
 * cannot change that fast. Re-scanning every {@link CHECK_INTERVAL_CHARS}
 * bounds detection lateness to well under one interval's worth of tokens
 * while making short responses — which cannot trip the thresholds at all —
 * completely free.
 */
export function createRepetitionGuard(
  options?: RepetitionThresholds,
): RepetitionGuard {
  const minRepeatedChars =
    options?.minRepeatedChars ?? DEFAULT_MIN_REPEATED_CHARS
  const checkedAt = new Map<number, number>()
  return {
    check(blockIndex, accumulated) {
      if (accumulated.length < minRepeatedChars) return null
      const checked = checkedAt.get(blockIndex) ?? 0
      // Only "grew, but not by enough" is skipped. A shorter string than last
      // time means the block was replaced rather than appended to, and must be
      // examined rather than silently skipped forever.
      const grew = accumulated.length - checked
      if (grew >= 0 && grew < CHECK_INTERVAL_CHARS) return null
      checkedAt.set(blockIndex, accumulated.length)
      return detectDegenerateRepetition(accumulated, options)
    },
  }
}
