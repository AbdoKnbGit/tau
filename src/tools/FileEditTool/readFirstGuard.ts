/**
 * Counts blind edits for the Read-before-Edit refusal.
 *
 * FileEditTool refuses an edit to a file with no current read, so the model
 * reads first and copies old_string from real content instead of guessing. The
 * refusal is unconditional: a model that ignores it must not be rewarded with
 * an eventual bypass (an earlier version let the third blind attempt through,
 * which broke the rule it enforced). Consecutive refusals are counted per file
 * only so the message can say plainly that repeating the edit will keep
 * failing. Other layers bound a model that still loops: the OpenRouter lane
 * refuses a third identical failing call, and every session has a turn limit.
 *
 * State is module-level (session/process scoped), keyed by absolute file path,
 * with a short TTL so stale counters can't accumulate. A real Read of the file
 * clears the counter via noteFileRead(). Mirrors the module-level + TTL shape
 * of bashRetryGuard.
 */

const REFUSAL_TTL_MS = 5 * 60_000 // 5 minutes

interface RefusalEntry {
  count: number
  lastAt: number
}

const _refusals = new Map<string, RefusalEntry>()

function purgeStale(now: number): void {
  for (const [key, entry] of _refusals) {
    if (now - entry.lastAt > REFUSAL_TTL_MS) _refusals.delete(key)
  }
}

/**
 * Register a refused blind edit of `filePath` and return how many consecutive
 * blind edits of it have been refused, counting this one.
 */
export function recordUnreadEditRefusal(
  filePath: string,
  now: number = Date.now(),
): number {
  purgeStale(now)
  const count = (_refusals.get(filePath)?.count ?? 0) + 1
  _refusals.set(filePath, { count, lastAt: now })
  return count
}

/**
 * Clear the refusal counter for a file. Call when a real read-state exists for
 * it, so a later blind edit of the same file starts counting from zero.
 */
export function noteFileRead(filePath: string): void {
  _refusals.delete(filePath)
}

/** Reset all tracked state. For tests and context clears. */
export function resetReadFirstGuard(): void {
  _refusals.clear()
}
