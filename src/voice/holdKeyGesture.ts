import type { HoldClock } from './pushToTalkHold.js'

const HOLD_THRESHOLD = 5
const WARMUP_THRESHOLD = 2
const RAPID_REPEAT_GAP_MS = 120
const INITIAL_REPEAT_GAP_MS = 650
const MODIFIER_FIRST_REPEAT_MS = 2000

/** A single bare-key tap remains text. Sustained repeats activate recording.
 * stripTrailing's floor protects spaces that were typed before this gesture. */
export function createHoldKeyGesture({ activate, isHolding, stripTrailing, clock }: {
  activate(firstRepeatAllowanceMs?: number): void
  isHolding(): boolean
  stripTrailing(maxStrip: number, char: string, floor?: number): number
  clock: HoldClock
}) {
  let count = 0
  let leaked = 0
  let floor = 0
  let activated = false
  let timer: unknown

  function reset() {
    if (timer !== undefined) clock.clearTimeout(timer)
    timer = undefined
    count = 0
    leaked = 0
    floor = 0
    activated = false
  }

  return {
    reset,
    press(repeats: number, bareChar: string | null): boolean {
      if (!Number.isInteger(repeats) || repeats < 1) return false
      if (activated && isHolding()) {
        if (bareChar !== null) stripTrailing(repeats, bareChar, floor)
        activate()
        return true
      }
      if (activated) reset()
      if (count === 0 && bareChar !== null) floor = stripTrailing(0, bareChar)
      const before = count
      count += repeats
      if (bareChar === null || count >= HOLD_THRESHOLD) {
        if (timer !== undefined) clock.clearTimeout(timer)
        timer = undefined
        activated = true
        if (bareChar !== null) stripTrailing(leaked + repeats, bareChar, floor)
        leaked = 0
        count = 0
        activate(bareChar === null ? MODIFIER_FIRST_REPEAT_MS : undefined)
        return true
      }
      const swallow = before >= WARMUP_THRESHOLD
      if (bareChar !== null) {
        if (swallow) stripTrailing(repeats, bareChar, floor + leaked)
        else leaked += repeats
      }
      if (timer !== undefined) clock.clearTimeout(timer)
      timer = clock.setTimeout(reset, before === 0 ? INITIAL_REPEAT_GAP_MS : RAPID_REPEAT_GAP_MS)
      return swallow
    },
  }
}
