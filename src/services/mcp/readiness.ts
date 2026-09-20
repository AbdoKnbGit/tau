/**
 * Authoritative MCP startup readiness.
 *
 * The launch barrier has to answer one question: is startup MCP discovery
 * settled? AppState cannot answer it. A source that is still enumerating has
 * registered no clients yet, so an empty `mcp.clients` is indistinguishable
 * from "no servers configured" — that is exactly the 12:31 case in
 * docs/mcp-tool-loading-investigation.md, where a check for pending clients
 * alone released the wait before the claude.ai connectors were even known.
 *
 * So readiness is tracked here, in a React-independent registry that the hook,
 * print mode and main.tsx all report into, in two parts:
 *
 * - **Sources** (local config, claude.ai connectors, dynamic/SDK config): each
 *   is registered as enumerating *before* its fetch starts and settles when it
 *   has finished handing over the servers it found. Registration of a source's
 *   servers and completion of that source are one transition (`settleSource`).
 * - **Servers**: each eligible server settles when its tool discovery has
 *   finished or it reached a terminal state (failed, needs-auth, disabled).
 *
 * Settled means every registered source has settled and every server they
 * registered has settled. Ineligible sources (bare mode, strict config,
 * enterprise policy, disabled by settings) settle immediately.
 */

import { launchElapsedMs } from '../../utils/launchClock.js'
import { logForDebugging } from '../../utils/debug.js'

export type McpSourceId = string

/**
 * The startup discovery sources. Fixed ids so main.tsx, the connection hook
 * and print mode all report into the same source rather than each inventing
 * its own and leaving the other's unsettled forever.
 */
export const MCP_SOURCE_LOCAL_CONFIG = 'local-config'
export const MCP_SOURCE_CLAUDEAI_CONNECTORS = 'claudeai-connectors'

type ServerState = 'discovering' | 'settled'

type Waiter = {
  resolve: () => void
}

const sources = new Map<McpSourceId, 'enumerating' | 'settled'>()
const servers = new Map<string, ServerState>()
const waiters = new Set<Waiter>()

/** Launch-elapsed ms at which each milestone was first observed, for metrics. */
const milestones = new Map<string, number>()

function markMilestone(name: string): void {
  if (!milestones.has(name)) milestones.set(name, launchElapsedMs())
}

export function getMcpReadinessMilestones(): Record<string, number> {
  return Object.fromEntries(milestones)
}

/**
 * Register a discovery source as enumerating. Must be called synchronously,
 * before the source's asynchronous work starts, so a request that arrives in
 * between cannot conclude an empty registry is settled.
 */
export function beginMcpSource(id: McpSourceId): void {
  if (sources.get(id) === 'settled') return
  sources.set(id, 'enumerating')
}

/**
 * Settle a source and register the servers it found, as one transition.
 *
 * `serverNames` are the servers this source expects to discover tools for.
 * Servers already registered by another source are not re-opened.
 */
export function settleMcpSource(
  id: McpSourceId,
  serverNames: readonly string[] = [],
): void {
  for (const name of serverNames) {
    if (!servers.has(name)) servers.set(name, 'discovering')
  }
  sources.set(id, 'settled')
  notifyIfSettled()
}

/** Mark a source ineligible: it will never enumerate, so it is already settled. */
export function skipMcpSource(id: McpSourceId): void {
  settleMcpSource(id, [])
}

/**
 * Register a server that is being connected outside a source enumeration — a
 * mid-session install, a manual reconnect, an agent's inline server.
 */
export function beginMcpServer(name: string): void {
  if (servers.get(name) === 'settled') return
  servers.set(name, 'discovering')
}

/**
 * Settle a server: its tools are published, or it reached a terminal state.
 * Idempotent — a reconnect that settles the same server again is not an error.
 */
export function settleMcpServer(name: string): void {
  servers.set(name, 'settled')
  notifyIfSettled()
}

/** Forget a server entirely (removed from config, disabled before connecting). */
export function forgetMcpServer(name: string): void {
  servers.delete(name)
  notifyIfSettled()
}

export function isMcpDiscoverySettled(): boolean {
  for (const state of sources.values()) {
    if (state !== 'settled') return false
  }
  for (const state of servers.values()) {
    if (state !== 'settled') return false
  }
  return true
}

/** Counts for the status line: settled servers out of registered servers. */
export function getMcpReadinessCounts(): {
  settledServers: number
  totalServers: number
  enumeratingSources: number
} {
  let settledServers = 0
  for (const state of servers.values()) {
    if (state === 'settled') settledServers++
  }
  let enumeratingSources = 0
  for (const state of sources.values()) {
    if (state !== 'settled') enumeratingSources++
  }
  return { settledServers, totalServers: servers.size, enumeratingSources }
}

function notifyIfSettled(): void {
  if (!isMcpDiscoverySettled()) return
  markMilestone('settled')
  if (waiters.size === 0) return
  // Copy first: a waiter's resolve may synchronously register more work.
  const current = [...waiters]
  waiters.clear()
  for (const waiter of current) waiter.resolve()
}

/**
 * Resolves when discovery is settled, when `signal` aborts, or when the
 * deadline passes — whichever comes first. Never rejects.
 *
 * Subscribe-then-check: the waiter is registered before the settled state is
 * read, so a `settleMcpSource` between the two cannot be lost. Cancelling one
 * waiter leaves background discovery and other waiters untouched.
 */
export function waitForMcpDiscovery(
  remainingMs: number,
  signal?: AbortSignal,
): Promise<'settled' | 'deadline' | 'aborted'> {
  if (remainingMs <= 0) {
    return Promise.resolve(isMcpDiscoverySettled() ? 'settled' : 'deadline')
  }
  if (signal?.aborted) return Promise.resolve('aborted')

  return new Promise(resolve => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (outcome: 'settled' | 'deadline' | 'aborted') => {
      if (done) return
      done = true
      waiters.delete(waiter)
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    const onAbort = () => finish('aborted')
    // Recheck on wake: a waiter may be resolved by a settle that a later
    // registration has already undone.
    const waiter: Waiter = {
      resolve: () => finish(isMcpDiscoverySettled() ? 'settled' : 'deadline'),
    }

    waiters.add(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    // eslint-disable-next-line no-restricted-syntax -- deadline timer, cleared on every outcome
    timer = setTimeout(() => finish('deadline'), remainingMs)
    if (timer.unref) timer.unref()

    // Check after subscribing, so a settle racing this call is not lost.
    if (isMcpDiscoverySettled()) finish('settled')
  })
}

export function logMcpReadinessSnapshot(context: string): void {
  const counts = getMcpReadinessCounts()
  logForDebugging(
    `[MCP readiness] ${context}: settled=${isMcpDiscoverySettled()} ` +
      `servers=${counts.settledServers}/${counts.totalServers} ` +
      `sources_enumerating=${counts.enumeratingSources} ` +
      `launch_elapsed=${launchElapsedMs()}ms`,
  )
}
