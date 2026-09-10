/**
 * Size of the context a session already carries before it sends anything.
 *
 * The status line reports the last API call's usage, so until the first
 * response arrives it has nothing to report and shows zero — even though the
 * session is already holding its system prompt and tool definitions. On a real
 * project that is tens of thousands of tokens, so a fresh session reads as
 * `0/200K (0%)` when it is really closer to 30K.
 *
 * The measurement is async while the status line is built synchronously on
 * every render, so it is taken once in the background and read synchronously
 * from here — the same shape as utils/model/modelCapabilities.ts.
 *
 * Nothing here is hardcoded: the number comes from the live session's own
 * prompt and tools, so it tracks the project it is in.
 */

import { logForDebugging } from './debug.js'

type Baseline = {
  /** Tokens the session holds before any conversation. */
  tokens: number
  /** Model this was measured against; a different one invalidates it. */
  model: string
}

let baseline: Baseline | null = null

/** Bumped each time a measurement lands, so a render can depend on it. */
let revision = 0

const listeners = new Set<() => void>()

/**
 * Models a measurement has been started for.
 *
 * Entries are added before the work begins and never removed, including on
 * failure. That is deliberate: the caller is a React effect whose dependencies
 * change whenever session state does, so clearing a failed attempt would let it
 * retry on every subsequent state change. One attempt per model per process is
 * the right trade for a display reading that already degrades safely to the
 * previous behaviour. Switching models and back re-attempts naturally.
 */
const attempted = new Set<string>()

/**
 * Baseline for `model`, or 0 when it has not been measured.
 *
 * Returns 0 rather than a guess, so a status line never shows a number that was
 * invented — before the measurement lands it behaves exactly as it did before
 * this existed.
 *
 * `model` must be the model the session actually runs (the runtime model), which
 * is also what the measurement keys on; the two agreeing is what makes the
 * lookup hit at all.
 */
export function getContextBaselineTokens(model: string): number {
  return baseline?.model === model ? baseline.tokens : 0
}

/** Record a measured baseline. */
export function setContextBaselineTokens(model: string, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  baseline = { model, tokens }
  revision += 1
  logForDebugging(
    `[contextBaseline] ${model}: ~${tokens} tokens of initial context`,
  )
  for (const listener of listeners) listener()
}

/** Whether a measurement for `model` is worth starting. */
export function shouldRefreshContextBaseline(model: string): boolean {
  return !attempted.has(model) && baseline?.model !== model
}

/** Claim the measurement for `model` so concurrent callers do not repeat it. */
export function beginContextBaselineRefresh(model: string): void {
  attempted.add(model)
}

/**
 * Run `listener` whenever a measurement lands; returns the unsubscribe.
 *
 * The measurement finishes after the first render, and both status rows are
 * otherwise redrawn only by conversation events — so without this a fresh
 * session keeps showing no context until its first response, which is the
 * exact stretch the baseline exists to cover. Shaped for
 * useSyncExternalStore, paired with getContextBaselineRevision.
 */
export function subscribeContextBaseline(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes every time a measurement lands. */
export function getContextBaselineRevision(): number {
  return revision
}

/** Token usage in the shape the status line reports. */
export type ContextUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/**
 * Report the session's real initial context while no API usage exists yet.
 *
 * A floor, never a ceiling: it can only raise a number toward the truth, and
 * it steps aside entirely as soon as the provider reports anything, so a
 * measured value never overrides a real one. Returns `usage` unchanged when
 * no baseline has been measured, which keeps the previous behaviour intact.
 *
 * `estimatePendingTokens` sizes what the baseline cannot know about — the
 * messages typed or attached since the session started. It runs only when the
 * floor actually applies.
 */
export function applyInitialContextFloor(
  usage: ContextUsage | null,
  baselineTokens: number,
  estimatePendingTokens: () => number,
): ContextUsage | null {
  if (baselineTokens <= 0) return usage
  const reported = usage
    ? usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens
    : 0
  if (reported > 0) return usage
  return {
    input_tokens: baselineTokens + estimatePendingTokens(),
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}
