import type { APIProvider } from '../../utils/model/providers.js'

/**
 * Serialization gate for subagents on the Antigravity path.
 *
 * Antigravity's implicit prompt cache holds per-account context with a
 * multi-second async write commit. Concurrent agent streams land inside
 * each other's commit windows: a parallel 3-agent batch measured 0/17
 * cache hits across the agents and forced the parent thread into
 * repeated full-context re-ingests afterwards (~4x session cost).
 * Per-agent session affinity (cacheAffinity.ts) keys the requests
 * correctly but cannot add server-side capacity, so the fix is to stop
 * interleaving: agents on this path run their query loops one at a time.
 * Each agent's stream then extends its own prefix uninterrupted, and the
 * parent pays a single cold re-ingest per batch instead of one per turn.
 *
 * Covers BOTH Gemini and Claude models on Antigravity — Claude is resold
 * through the same cloudcode-pa Gemini wire protocol and shares the same
 * per-account implicit cache, so it thrashes the same way under parallel
 * spawns. Every other provider is untouched.
 *
 * Escape hatch: TAU_ANTIGRAVITY_PARALLEL_AGENTS=1 restores parallel
 * spawns for users who prefer wall-clock speed over token cost.
 */

export function shouldSerializeAntigravityAgents(
  provider: APIProvider,
  _model: string,
): boolean {
  if (process.env.TAU_ANTIGRAVITY_PARALLEL_AGENTS === '1') return false
  // The whole Antigravity quota pool shares one async-commit cache
  // backend per account, Gemini and Claude alike — serialize all of it.
  return provider === 'antigravity'
}

// FIFO promise-chain mutex. `tail` resolves when every previously queued
// turn has been released, so awaiting the prior tail = waiting your turn.
let tail: Promise<void> = Promise.resolve()
let activeHolders = 0

/** True while some agent holds (or is queued for) the gate — test/diagnostic hook. */
export function antigravityAgentGateBusy(): boolean {
  return activeHolders > 0
}

/**
 * Wait for the previous agent's turn to finish, then take the gate.
 * Returns an idempotent release function — call it in a finally so an
 * agent that throws or aborts never wedges the queue.
 *
 * Abort-aware: if `signal` fires while still waiting, the slot is
 * forfeited immediately (later waiters are not blocked) and a no-op
 * release is returned — the caller's own abort handling takes over.
 */
export async function acquireAntigravityAgentTurn(
  signal?: AbortSignal,
): Promise<() => void> {
  let releaseSlot!: () => void
  const myTurnDone = new Promise<void>(resolve => {
    releaseSlot = resolve
  })
  const prior = tail
  // Chain through myTurnDone unconditionally — an abandoned (aborted)
  // waiter resolves its slot below, so the queue always drains.
  tail = prior.then(() => myTurnDone)
  activeHolders++

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    activeHolders--
    releaseSlot()
  }

  if (signal) {
    const aborted = new Promise<'aborted'>(resolve => {
      if (signal.aborted) {
        resolve('aborted')
        return
      }
      signal.addEventListener('abort', () => resolve('aborted'), {
        once: true,
      })
    })
    const outcome = await Promise.race([
      prior.then(() => 'turn' as const),
      aborted,
    ])
    if (outcome === 'aborted') {
      // Forfeit the slot so agents queued behind this one are not blocked
      // on a waiter that will never run. Hand back a no-op.
      release()
      return () => {}
    }
  } else {
    await prior
  }

  return release
}

/** Test helper: reset the queue so test cases don't leak into each other. */
export function _resetAntigravityAgentGateForTest(): void {
  tail = Promise.resolve()
  activeHolders = 0
}
