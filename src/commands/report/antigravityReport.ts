/**
 * Antigravity-specialized `/report` generation.
 *
 * Antigravity meters quota SEPARATELY PER GENERATION HOST. Measured live
 * 2026-09-04 against a free-tier account with plenty of account quota left:
 * `cloudcode-pa` (prod) answered 429 RESOURCE_EXHAUSTED for every request
 * shape while `daily-cloudcode-pa` and the sandbox host served byte-identical
 * bodies with HTTP 200. The default host order is prod-first.
 *
 * Chat survives that and `/report` did not, for one reason: patience.
 *
 *   - A chat session issues many requests. The lane caps Antigravity Gemini at
 *     2 attempts with a 2s backoff ceiling (`antigravityGeminiRetryOptions`)
 *     precisely so interactive turns stay fast — but across a whole session
 *     one request eventually lands on a healthy host, and the process-wide pin
 *     then carries every later request there.
 *   - `/report` is a single request. Two inner attempts across at most two
 *     hosts, wrapped in an outer controller that caps third-party 429s at two
 *     attempts, gives it roughly six seconds before it gives up. If the first
 *     host is exhausted, that budget is spent re-probing it.
 *
 * So this path changes NOTHING about the request — same bounded payload, same
 * live provider account, same model, same session — and changes only how long
 * it is willing to keep looking for a host that will serve it. A report is
 * user-invoked and one-shot: spending half a minute is fine where a chat turn
 * could not.
 *
 * Sweeping works because each refusal is recorded against the host that made
 * it (`recordAntigravityGeminiHostExhausted`), so the next attempt reorders
 * the host list and starts somewhere new. Nothing here duplicates transport,
 * auth, or model routing.
 *
 * Applies to every Antigravity model — the Gemini family and the Claude models
 * resold through the same proxy — because the per-host quota is a property of
 * the proxy, not of the model. Every other provider keeps the original path.
 */

import {
  antigravityGenerationHostCount,
  isAntigravityModelId,
} from '../../services/api/providers/gemini_code_assist.js'
import { sleep } from '../../utils/sleep.js'

/**
 * Does this request go through the Antigravity proxy?
 *
 * Takes the live provider selection and model rather than reading them, so the
 * decision is a pure function of the request — no account, machine, or
 * install-specific state, and no hidden global to stub in tests. The model id
 * is checked even when the selected provider is something else, because a
 * Gemini 3.x id picked on the legacy openai/gemini rows is auto-routed to
 * Antigravity and hits the same per-host quota.
 */
export function usesAntigravityReportPath(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  if (provider === 'antigravity') return true
  return model ? isAntigravityModelId(model) : false
}

/** Pause between full host sweeps. Short: host quota recovers on its own. */
const SWEEP_BACKOFF_MS = [0, 2_000, 6_000] as const

/**
 * How many report attempts to allow before giving up.
 *
 * One per generation host per sweep, so a single exhausted host never costs
 * more than one attempt of the budget. Derived from the real host list rather
 * than a fixed number, so adding or removing a host stays correct.
 */
export function antigravityReportAttemptBudget(model?: string): number {
  return antigravityGenerationHostCount(model) * SWEEP_BACKOFF_MS.length
}

/**
 * Delay before the attempt at `index` (0-based). Attempts inside one sweep run
 * back-to-back — a refused host is not worth waiting on when a sibling host may
 * answer immediately — and only a completed sweep earns a pause.
 */
export function antigravityReportAttemptDelayMs(
  index: number,
  hostCount: number,
): number {
  if (index <= 0) return 0
  if (index % hostCount !== 0) return 0
  const sweep = Math.min(index / hostCount, SWEEP_BACKOFF_MS.length - 1)
  return SWEEP_BACKOFF_MS[sweep] ?? 0
}

/**
 * Run `attempt` until it produces a report, sweeping Antigravity hosts.
 *
 * `attempt` must resolve with the report markdown or reject. A rejection that
 * `isRetryable` classifies as a host/quota refusal is retried on the next host;
 * anything else (auth, a malformed response, an aborted request) is surfaced
 * immediately, because sweeping cannot fix it and would only burn quota.
 */
export async function runAntigravityReportWithHostSweep({
  attempt,
  isRetryable,
  model,
  signal,
}: {
  attempt: (attemptIndex: number) => Promise<string>
  isRetryable: (error: unknown) => boolean
  /** Gemini and Claude on Antigravity have different host lists. */
  model?: string
  signal?: AbortSignal
}): Promise<string> {
  const hostCount = antigravityGenerationHostCount(model)
  const budget = antigravityReportAttemptBudget(model)
  let lastError: unknown

  for (let index = 0; index < budget; index++) {
    if (signal?.aborted) break
    const delayMs = antigravityReportAttemptDelayMs(index, hostCount)
    if (delayMs > 0) await sleep(delayMs, signal)
    if (signal?.aborted) break

    try {
      return await attempt(index)
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) throw error
    }
  }

  throw lastError ?? new Error('Antigravity report generation produced no result.')
}
