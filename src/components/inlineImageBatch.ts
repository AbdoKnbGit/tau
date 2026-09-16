/**
 * Lets inline images that are rendering at the same time land together.
 *
 * An image box goes into the transcript, or changes size, only once its render
 * finishes, and renders finish in any order: a small image read alongside three
 * large ones is ready first, and after a resize every image re-encodes, one
 * after another. Each of those would land in a frame of its own. On the main
 * screen a box appearing or changing size above rows already in terminal
 * history forces a full reset, which writes the whole transcript again along
 * with every image in it — once per image, if they land one at a time. Holding
 * each finished render until the others in flight are done turns the batch
 * into one change, made in transcript order.
 *
 * A straggler holds the rest for at most {@link MAX_BATCH_WAIT_MS}.
 */

import { logForDebugging } from '../utils/debug.js'

/** Longest a finished render waits for others still in flight. */
export const MAX_BATCH_WAIT_MS = 1000

let nextToken = 0
/** Images with a render in flight, finished or not. */
const inFlight = new Set<number>()
/** Finished renders, with what applies each. */
const finished = new Map<number, () => void>()
/** When the longest-waiting finished render finished. */
let waitingSince: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** An identity for one image, kept for the life of its component. */
export function createImageRenderToken(): number {
  return nextToken++
}

/** A render has started for this image, superseding any not yet applied. */
export function beginImageRender(
  token: number,
  now: number = Date.now(),
): void {
  inFlight.add(token)
  finished.delete(token)
  settle(now)
}

/**
 * Apply a finished render once the other renders in flight have finished too.
 * Applied at once when this image has no render in flight.
 */
export function applyWithBatch(
  token: number,
  apply: () => void,
  now: number = Date.now(),
): void {
  if (!inFlight.has(token)) {
    apply()
    return
  }
  finished.set(token, apply)
  if (waitingSince === null) waitingSince = now
  settle(now)
}

/** A render that will not be applied: superseded, unmounted, or failed. */
export function endImageRender(token: number, now: number = Date.now()): void {
  inFlight.delete(token)
  finished.delete(token)
  settle(now)
}

function settle(now: number): void {
  if (finished.size === 0) {
    waitingSince = null
    cancelTimer()
    return
  }
  const waited = now - (waitingSince ?? now)
  if (finished.size === inFlight.size || waited >= MAX_BATCH_WAIT_MS) {
    flush()
    return
  }
  if (timer === null) {
    const handle = setTimeout(
      () => {
        timer = null
        settle(Date.now())
      },
      Math.max(1, MAX_BATCH_WAIT_MS - waited),
    )
    // Never a reason to keep the process alive.
    ;(handle as { unref?: () => void }).unref?.()
    timer = handle
  }
}

/** Every finished render applies, in one synchronous pass so React batches it. */
function flush(): void {
  const applies = [...finished.values()]
  for (const token of finished.keys()) inFlight.delete(token)
  finished.clear()
  waitingSince = null
  cancelTimer()
  for (const apply of applies) {
    try {
      apply()
    } catch (error) {
      // One image failing to apply must not strand the others behind it.
      logForDebugging(
        `inlineImageBatch: apply failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}

function cancelTimer(): void {
  if (timer === null) return
  clearTimeout(timer)
  timer = null
}

/** Test hook: forget every render. */
export function resetImageBatchForTesting(): void {
  inFlight.clear()
  finished.clear()
  waitingSince = null
  cancelTimer()
}
