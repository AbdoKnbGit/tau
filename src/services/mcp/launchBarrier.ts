/**
 * The MCP launch barrier.
 *
 * Interactive Tau has never waited for MCP servers before the first request,
 * so late-connecting servers change the tool list mid-session. On lanes with
 * eager tool declarations that voids the implicit prompt cache, and on any
 * lane it means the first turn ran without tools the user has configured.
 *
 * The barrier makes the first MCP-capable request of the process wait for
 * discovery to settle, bounded by a budget measured **from application
 * launch** (src/utils/launchClock.ts), not from Enter. A user who spends the
 * budget on the trust dialog or on typing waits nothing extra; a session where
 * discovery settles at +1 s waits about 1 s.
 *
 * This barrier is a wait, never a gate: at the deadline the request proceeds
 * with whatever is connected and background discovery continues. It arms at
 * launch, and again when the MCP connection manager reloads (a new or cleared
 * session, a plugin reload, a power mode or login change): a request sent
 * while servers reconnect would otherwise go out without their tools, and the
 * next one would carry a different tool list. A re-armed wait has the same
 * budget, measured from the reload instead of from launch.
 */

import { logForDebugging } from '../../utils/debug.js'
import { launchElapsedMs } from '../../utils/launchClock.js'
import {
  isMcpDiscoverySettled,
  logMcpReadinessSnapshot,
  waitForMcpDiscovery,
} from './readiness.js'

export const MCP_LAUNCH_WAIT_ENV = 'TAU_MCP_LAUNCH_WAIT_MS'

const DEFAULT_BUDGET_MS = 10_000
/** Refuse a budget large enough to look like a hang. */
const MAX_BUDGET_MS = 120_000

/**
 * Configured budget in ms. 0 (or any falsy-defined value) disables the wait.
 * An unparseable value falls back to the default rather than to no wait: a
 * typo should not silently remove the behavior the user asked for.
 */
export function getMcpLaunchBudgetMs(): number {
  const raw = process.env[MCP_LAUNCH_WAIT_ENV]
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_BUDGET_MS
  if (parsed <= 0) return 0
  return Math.min(Math.round(parsed), MAX_BUDGET_MS)
}

let armed = true
/** Launch-elapsed ms the current wait is measured from; undefined = launch. */
let windowStart: number | undefined

export function isMcpLaunchBarrierArmed(): boolean {
  return armed
}

/**
 * Arm the wait for an MCP reload. The next MCP-capable request waits for the
 * reloading servers (see `beginMcpReload`), bounded by the configured budget
 * measured from now. Arming again before that request only restarts the window.
 */
export function armMcpReloadWait(): void {
  armed = true
  windowStart = launchElapsedMs()
}

export type McpLaunchWaitOutcome =
  | 'disarmed'
  | 'disabled'
  | 'already-settled'
  | 'expired'
  | 'settled'
  | 'deadline'
  | 'aborted'

export type McpLaunchWaitResult = {
  outcome: McpLaunchWaitOutcome
  /** Extra wait this request actually added, in ms. */
  waitedMs: number
}

/**
 * Wait for startup MCP discovery, bounded by the remaining launch budget.
 *
 * Consumes the barrier: every outcome disarms it, so only the first
 * MCP-capable request of the process can wait. Callers that decide they are
 * not MCP-capable must not call this at all — calling and ignoring the result
 * would spend the barrier on a request that could not have used the tools.
 */
export async function waitForMcpLaunchBarrier(
  signal?: AbortSignal,
): Promise<McpLaunchWaitResult> {
  if (!armed) return { outcome: 'disarmed', waitedMs: 0 }
  armed = false
  const since = windowStart ?? 0
  windowStart = undefined

  const budgetMs = getMcpLaunchBudgetMs()
  if (budgetMs === 0) return { outcome: 'disabled', waitedMs: 0 }

  if (isMcpDiscoverySettled()) {
    return { outcome: 'already-settled', waitedMs: 0 }
  }

  const elapsed = launchElapsedMs() - since
  const remainingMs = budgetMs - elapsed
  if (remainingMs <= 0) {
    logForDebugging(
      `[MCP launch barrier] budget already spent (${elapsed}ms of ${budgetMs}ms ${since ? 'since the reload' : 'at launch'}) — not waiting`,
    )
    return { outcome: 'expired', waitedMs: 0 }
  }

  logMcpReadinessSnapshot('launch barrier waiting')
  const startedAt = launchElapsedMs()
  const outcome = await waitForMcpDiscovery(remainingMs, signal)
  const waitedMs = launchElapsedMs() - startedAt

  logForDebugging(
    `[MCP launch barrier] ${outcome} after ${waitedMs}ms ` +
      `(launch elapsed ${launchElapsedMs()}ms of ${budgetMs}ms budget)`,
  )
  return { outcome, waitedMs }
}

/**
 * Whether a request should acquire the barrier at all.
 *
 * The plan keeps one readiness policy for eager and lazy routes: a lazy route
 * still needs an accurate catalog to search, and a request that starts before
 * the connectors are even known searches a catalog that is missing them. So
 * the only requests that skip the barrier are the ones that have no MCP tool
 * surface to wait for.
 *
 * `hasMcpSurface` is the caller's answer to "could this request use an MCP
 * tool?" — false for a request built with no tools at all.
 */
export function shouldWaitForMcpAtLaunch(hasMcpSurface: boolean): boolean {
  if (!armed) return false
  if (!hasMcpSurface) return false
  return getMcpLaunchBudgetMs() > 0
}
