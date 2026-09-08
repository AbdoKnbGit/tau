/**
 * Size of the context a session already carries before it sends anything.
 *
 * The status line reports the last API call's usage, so until the first
 * response arrives it has nothing to report and shows zero — even though the
 * session is already holding the system prompt, tool definitions, MCP tools,
 * custom agents, skills and memory files. On a typical project that is tens of
 * thousands of tokens, so a fresh session reads as `0/200K (0%)` when it is
 * really closer to 30K.
 *
 * That total is expensive to compute (it tokenizes the whole system prompt and
 * every tool definition) and the producing function is async, while the status
 * line is built synchronously on every render. So it is computed once in the
 * background and read synchronously from here — the same shape as
 * utils/model/modelCapabilities.ts.
 *
 * Nothing here is hardcoded: every number comes from the live session's own
 * prompt, tools, servers and memory, so it tracks the project it is in.
 */

import { logForDebugging } from './debug.js'

type Baseline = {
  /** Tokens the session holds before any conversation. */
  tokens: number
  /** Model this was measured against; a different one invalidates it. */
  model: string
}

let baseline: Baseline | null = null
let inFlightModel: string | null = null

/**
 * Baseline for `model`, or 0 when it has not been measured yet.
 *
 * Returns 0 rather than a guess so a status line never shows a number that was
 * invented — before the first measurement lands it simply behaves as it did
 * before this existed.
 */
export function getContextBaselineTokens(model: string): number {
  return baseline?.model === model ? baseline.tokens : 0
}

/**
 * Record a measured baseline. Called by the background refresh; separate from
 * the compute so the caller owns which inputs the measurement was taken with.
 */
export function setContextBaselineTokens(model: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  baseline = { model, tokens }
  logForDebugging(
    `[contextBaseline] ${model}: ${tokens} tokens of initial context`,
  )
}

/**
 * Whether a measurement for `model` is worth starting.
 *
 * Guards against both a duplicate in-flight run and re-measuring something
 * already known, so a component that calls this on every render costs nothing
 * after the first pass.
 */
export function shouldRefreshContextBaseline(model: string): boolean {
  if (inFlightModel === model) return false
  return baseline?.model !== model
}

/** Mark a measurement as started, so concurrent callers do not duplicate it. */
export function beginContextBaselineRefresh(model: string): void {
  inFlightModel = model
}

/** Mark a measurement as finished, successfully or not. */
export function endContextBaselineRefresh(model: string): void {
  if (inFlightModel === model) inFlightModel = null
}
