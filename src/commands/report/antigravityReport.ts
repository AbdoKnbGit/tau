/**
 * Antigravity-specialized /report generation uses the normal provider route,
 * credentials, model and session. Generation and its bounded recovery stay on
 * daily; reports never sweep production or sandbox as fallback endpoints.
 * The provider retry controller owns transport recovery before output starts.
 */

import { isAntigravityModelId } from '../../services/api/providers/gemini_code_assist.js'

/**
 * Does this request go through the Antigravity proxy?
 *
 * Takes the live provider selection and model rather than reading them, so the
 * decision is a pure function of the request — no account, machine, or
 * install-specific state, and no hidden global to stub in tests. The model id
 * is checked even when the selected provider is something else, because a
 * Gemini 3.x id picked on the legacy openai/gemini rows is auto-routed to
 * Antigravity and uses the same retry policy.
 */
export function usesAntigravityReportPath(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  if (provider === 'antigravity') return true
  return model ? isAntigravityModelId(model) : false
}

/** Transport recovery already provides one initial attempt plus three retries. */
export function antigravityReportAttemptBudget(_model?: string): number {
  return 1
}

/** Kept for existing callers; reports have no additional retry delay. */
export function antigravityReportAttemptDelayMs(
  _index: number,
  _hostCount: number,
): number {
  return 0
}

/**
 * Run one provider operation. Native recovery owns the complete retry budget.
 * Do not add another retry here: queryWithModel may render a final provider
 * error into an assistant result, losing the original error's handled marker.
 * Replaying that result would multiply attempts and change request identity.
 */
export async function runAntigravityReportWithHostSweep({
  attempt,
  signal,
}: {
  attempt: (attemptIndex: number) => Promise<string>
  /** Retained in the call signature; transport recovery owns classification. */
  isRetryable: (error: unknown) => boolean
  model?: string
  signal?: AbortSignal
}): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return attempt(0)
}
