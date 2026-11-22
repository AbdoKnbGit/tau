/**
 * One-time notices about models on this machine, shown in the REPL's
 * notification area (hooks/notifs/useLocalModelNotices.ts). They are never
 * part of the conversation, so no request changes because of them.
 *
 * Only the local model lanes publish here; with any other provider nothing is
 * ever published and the REPL hook stays idle.
 */

export type LocalModelNotice = {
  /** One notice per key per process. */
  key: string
  text: string
}

type Listener = (notice: LocalModelNotice) => void

const listeners = new Set<Listener>()
const published = new Set<string>()
// Notices published before the REPL listens (or in a session without one).
let waiting: LocalModelNotice[] = []

export function publishLocalModelNotice(notice: LocalModelNotice): void {
  if (published.has(notice.key)) return
  published.add(notice.key)
  if (listeners.size === 0) {
    waiting.push(notice)
    return
  }
  for (const listener of listeners) listener(notice)
}

/** Delivers waiting notices at once, then each new one. Returns the unsubscribe. */
export function onLocalModelNotice(listener: Listener): () => void {
  listeners.add(listener)
  const queued = waiting
  waiting = []
  for (const notice of queued) listener(notice)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam. */
export function resetLocalModelNoticesForTests(): void {
  listeners.clear()
  published.clear()
  waiting = []
}
