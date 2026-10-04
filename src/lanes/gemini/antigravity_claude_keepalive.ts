/**
 * Keeps Claude's prompt cache warm on Antigravity while the user is away.
 *
 * The cache lives 5 minutes from its last read and Antigravity offers no
 * longer TTL (agy's own prompt-cache options carry only a type). A pause
 * longer than that re-writes the whole conversation: live 2026-10-04 a
 * 7-minute pause re-billed 57,907 tokens. Antigravity meters quota by token
 * cost, measured the same day on a 43.8k-token prompt: a cache write took
 * 2.19% of the weekly limit, a cache read 0.18%. So a one-token request that
 * re-reads the last prompt every 4.5 minutes costs about a twelfth of the
 * miss it prevents, and the refreshes stop after a window so a session left
 * open does not spend all day.
 *
 * TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES sets the window (default 30, 0 off).
 * One refresher per process: only the main thread schedules it, its next
 * request replaces it, /clear cancels it, and it stops on its own once
 * `shouldContinue` says the conversation has moved elsewhere (another provider).
 */

/** Under the 5-minute TTL with room for a slow request. */
export const ANTIGRAVITY_CLAUDE_REFRESH_EVERY_MS = 270_000
const DEFAULT_WINDOW_MINUTES = 30

export function antigravityClaudeKeepAliveWindowMs(): number {
  const raw = process.env.TAU_ANTIGRAVITY_CLAUDE_KEEPALIVE_MINUTES?.trim()
  if (raw) {
    const minutes = Number(raw)
    if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60_000
  }
  return DEFAULT_WINDOW_MINUTES * 60_000
}

type Refresher = {
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
}

let current: Refresher | null = null

/** Stop any scheduled refresh, and abort one in flight. */
export function cancelAntigravityClaudeKeepAlive(): void {
  if (!current) return
  if (current.timer) clearTimeout(current.timer)
  current.controller?.abort()
  current = null
}

/**
 * Re-read the cache with `refresh` every interval until the window closes.
 * A failed refresh ends the cycle: the next real request decides what happens.
 */
export function scheduleAntigravityClaudeKeepAlive(
  refresh: (signal: AbortSignal) => Promise<void>,
  options: { windowMs?: number; intervalMs?: number; shouldContinue?: () => boolean } = {},
): void {
  cancelAntigravityClaudeKeepAlive()
  const windowMs = options.windowMs ?? antigravityClaudeKeepAliveWindowMs()
  const intervalMs = options.intervalMs ?? ANTIGRAVITY_CLAUDE_REFRESH_EVERY_MS
  if (windowMs <= 0) return
  const deadline = Date.now() + windowMs
  const self: Refresher = {}
  current = self

  const arm = (): void => {
    if (current !== self) return
    if (Date.now() + intervalMs > deadline) {
      current = null
      return
    }
    self.timer = setTimeout(() => {
      if (options.shouldContinue && !options.shouldContinue()) {
        if (current === self) current = null
        return
      }
      const controller = new AbortController()
      self.controller = controller
      refresh(controller.signal).then(
        () => arm(),
        () => {
          if (current === self) current = null
        },
      )
    }, intervalMs)
    // Never keeps the process alive on its own.
    self.timer.unref?.()
  }
  arm()
}
