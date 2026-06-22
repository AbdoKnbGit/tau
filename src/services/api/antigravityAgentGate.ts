import type { APIProvider } from '../../utils/model/providers.js'
import { isAntigravityGeminiModel } from './providers/gemini_code_assist.js'

/**
 * Concurrency gate for subagents on the Antigravity Gemini path.
 *
 * Antigravity's Gemini implicit cache holds ~one prefix slot per account
 * with a multi-second async write commit. Fully-parallel agent streams land
 * inside each other's commit windows and evict each other (a parallel
 * 3-agent batch measured 0/17 agent cache hits and forced the parent into
 * repeated full-context re-ingests, ~4x session cost). Strict serialization
 * fixed the cache but serialized the wall clock with it.
 *
 * OFF by default: the gate only earns its keep alongside the prefix pad
 * (TAU_ANTIGRAVITY_MAX_CACHE), which makes agents large enough to contend
 * for the one cache slot. With the pad off, small agents don't cache anyway,
 * so serializing them would only cost wall-clock — agents run fully parallel.
 *
 * When MAX_CACHE is on, the gate is a small concurrency window (default 2)
 * rather than strict serialization: most fan-outs are 2-3 wide, so width 2
 * roughly halves wall-clock while still capping cache-slot contention. Tune
 * with TAU_ANTIGRAVITY_AGENT_CONCURRENCY (1 = strict serial / maximal cache
 * hits; higher = faster / more thrash). TAU_ANTIGRAVITY_PARALLEL_AGENTS=1
 * force-removes the gate even under MAX_CACHE.
 *
 * Gemini-only: Claude resold through Antigravity uses a multi-entry,
 * low-minimum content-addressed cache that does not thrash under parallel
 * spawns, so it is never gated. Every other provider is untouched.
 */

const DEFAULT_AGENT_CONCURRENCY = 2

function agentConcurrency(): number {
  const raw = process.env.TAU_ANTIGRAVITY_AGENT_CONCURRENCY
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 1) return n
  }
  return DEFAULT_AGENT_CONCURRENCY
}

export function shouldSerializeAntigravityAgents(
  provider: APIProvider,
  model: string,
): boolean {
  if (process.env.TAU_ANTIGRAVITY_PARALLEL_AGENTS === '1') return false
  // Off unless the cache discipline is opted into — without padding, agents
  // don't fill the cache slot, so gating them just costs wall-clock.
  if (process.env.TAU_ANTIGRAVITY_MAX_CACHE !== '1') return false
  // Only the single-slot Gemini implicit cache thrashes under parallel
  // spawns; Claude on Antigravity uses a multi-entry cache and is exempt.
  return provider === 'antigravity' && isAntigravityGeminiModel(model)
}

// Counting semaphore. `active` is the number of held slots; waiters queue
// FIFO and are woken one per release. A released slot is TRANSFERRED to the
// next waiter (active stays put) rather than freed-then-reacquired, so a
// fast-path acquirer racing the wake microtask can never jump the queue or
// over-grant past the width.
let active = 0
const waiters: Array<() => void> = []

/** True while any agent holds or is queued for the gate — test/diagnostic hook. */
export function antigravityAgentGateBusy(): boolean {
  return active > 0 || waiters.length > 0
}

/**
 * Take a gate slot, waiting if all `agentConcurrency()` slots are held.
 * Returns an idempotent release function — call it in a finally so an agent
 * that throws or aborts never wedges the queue.
 *
 * Abort-aware: if `signal` fires while still waiting, the slot is forfeited
 * (a slot handed over in the same tick is forwarded to the next waiter) and
 * a no-op release is returned — the caller's own abort handling takes over.
 */
export async function acquireAntigravityAgentTurn(
  signal?: AbortSignal,
): Promise<() => void> {
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    const next = waiters.shift()
    // Hand this slot to the next waiter (count unchanged), or free it.
    if (next) next()
    else active--
  }

  // Fast path: a slot is free. Synchronous to here, so no interleaving.
  if (active < agentConcurrency()) {
    active++
    return release
  }

  // Queue for the next transferred slot.
  let onSlot!: () => void
  const slot = new Promise<void>(resolve => {
    onSlot = resolve
  })
  waiters.push(onSlot)

  if (signal) {
    const aborted = new Promise<'aborted'>(resolve => {
      if (signal.aborted) {
        resolve('aborted')
        return
      }
      signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    const outcome = await Promise.race([
      slot.then(() => 'turn' as const),
      aborted,
    ])
    if (outcome === 'aborted') {
      const idx = waiters.indexOf(onSlot)
      if (idx >= 0) {
        // Still queued — never granted a slot; just leave the queue.
        waiters.splice(idx, 1)
      } else {
        // A release() already transferred a slot to us this tick. Pass it on
        // to the next waiter (or free it) instead of stranding it.
        release()
      }
      return () => {}
    }
  } else {
    await slot
  }

  // A slot was transferred to us — we inherit it without bumping `active`.
  return release
}

/** Test helper: reset the queue so test cases don't leak into each other. */
export function _resetAntigravityAgentGateForTest(): void {
  active = 0
  waiters.length = 0
}
