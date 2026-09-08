/**
 * Live progress of the running compaction summary, for the spinner.
 *
 * A module-level store rather than app state or a prop chain: the value
 * originates deep in the compaction stream loop and is consumed by one leaf
 * component, so threading it through the tree would touch a dozen files that
 * have no interest in it. Nothing here persists — the value exists only while
 * a summary is streaming.
 */

let fraction: number | null = null
const listeners = new Set<() => void>()

/**
 * Publish progress in the range 0-1, or `null` to clear it.
 *
 * Ignores no-op updates so a burst of identical values cannot wake the
 * renderer; the caller already throttles to whole-percent buckets.
 */
export function setCompactProgress(next: number | null): void {
  const clamped =
    next === null || !Number.isFinite(next)
      ? null
      : Math.min(1, Math.max(0, next))
  if (clamped === fraction) return
  fraction = clamped
  for (const listener of listeners) {
    // A subscriber must never be able to break the run it is reporting on:
    // this is called from inside the compaction stream loop, so a throwing
    // listener would abort the summary itself.
    try {
      listener()
    } catch {
      // A progress indicator that cannot repaint is not worth a failed
      // compaction.
    }
  }
}

/** Current progress, or null when no summary is streaming. */
export function getCompactProgress(): number | null {
  return fraction
}

export function subscribeCompactProgress(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}
