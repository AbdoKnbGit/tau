/**
 * Monotonic launch clock.
 *
 * The MCP launch barrier (src/services/mcp/launchBarrier.ts) budgets its wait
 * from application launch, not from Enter or from REPL mount. That needs one
 * origin that is fixed before the expensive asynchronous startup work begins,
 * and that survives the winpty re-exec in src/entrypoints/cli.tsx.
 *
 * Monotonic, not wall-clock: a suspend/resume or an NTP step must not hand the
 * barrier a fresh budget, and must not make an expired budget look unexpired.
 * `performance.timeOrigin + performance.now()` is a wall-clock instant derived
 * from a monotonic reading, which is what the re-exec handoff has to carry;
 * within one process we only ever subtract monotonic readings.
 */

// Monotonic ms since this process started. Read once: later reads of
// performance.now() are compared against it.
const PROCESS_START_EPOCH_MS = Date.now() - Math.round(performance.now())

/**
 * Env var carrying the parent's launch origin across a re-exec, as epoch ms.
 * Set by the launcher immediately before it spawns the child.
 */
export const LAUNCH_ORIGIN_ENV = 'CLAUDE_CODE_LAUNCH_ORIGIN_MS'

function readInheritedOriginEpochMs(): number | undefined {
  const raw = process.env[LAUNCH_ORIGIN_ENV]
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  // A parent origin in the future, or absurdly far in the past, is a stale or
  // corrupt value (an exported variable from an unrelated shell, a clock step
  // between the two processes). Fall back to this process's own start.
  const elapsed = PROCESS_START_EPOCH_MS - parsed
  if (elapsed < 0 || elapsed > 10 * 60_000) return undefined
  return parsed
}

// How much of the budget the parent process already consumed before it handed
// off. Zero when this process is the launcher.
const INHERITED_ELAPSED_MS = (() => {
  const inherited = readInheritedOriginEpochMs()
  return inherited === undefined ? 0 : PROCESS_START_EPOCH_MS - inherited
})()

/**
 * Milliseconds elapsed since application launch, including time consumed by a
 * parent process that re-executed us.
 */
export function launchElapsedMs(): number {
  return INHERITED_ELAPSED_MS + Math.round(performance.now())
}

/**
 * The launch origin as epoch ms, for handing to a child process that will
 * continue this launch. Only the launcher calls this.
 */
export function launchOriginEpochMs(): number {
  return PROCESS_START_EPOCH_MS - INHERITED_ELAPSED_MS
}

/** True when a parent process handed its launch budget to this one. */
export function didInheritLaunchOrigin(): boolean {
  return INHERITED_ELAPSED_MS > 0
}
