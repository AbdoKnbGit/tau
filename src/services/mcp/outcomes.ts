/**
 * Authoritative outcome records for tool operations.
 *
 * Three facts that are routinely conflated, kept separate because they answer
 * different questions and can disagree:
 *
 *   - Dispatch: did the request reach the tool or the wire? A local validation
 *     failure definitely sent nothing. A timeout may have sent everything and
 *     lost the answer.
 *   - Terminal outcome: what happened? Tool-reported success, a tool error, a
 *     refusal that never ran, a cancellation, or genuinely unknown.
 *   - Verification: did anything independently confirm the effect? Tool
 *     success is the tool's own word, which is not the same as a readback.
 *
 * The distinction that motivates the module is `unknown`. When a call times
 * out or is cancelled after the request went out, the operation may well have
 * completed on the server. Reporting that as a failure invites a retry that
 * duplicates a mutation; reporting it as success invents an acknowledgment
 * nobody gave. It has its own outcome so neither happens.
 *
 * Dependency-light on purpose: no React, no provider credentials, no
 * executor. Anything that records an outcome can import this without pulling
 * the runtime in behind it.
 */

/** Bumped when the record shape changes in a way readers must notice. */
export const OUTCOME_RECORD_VERSION = 1

/**
 * How much the boundary knows about whether the request was transmitted.
 *
 * `possibly_sent` is not a hedge. It is the honest answer whenever a write
 * may have crossed the wire and the response did not come back.
 */
export type DispatchEvidence =
  /** Refused locally. Nothing was handed to the tool or the transport. */
  | 'not_sent'
  /** Handed to the tool/transport; the request was made. */
  | 'sent'
  /** The boundary cannot tell whether bytes reached the server. */
  | 'possibly_sent'

export type TerminalOutcome =
  /** Refused before execution: decode, validation, permission, unknown tool. */
  | 'not_run'
  /** The tool reported success. Its own word, not independent proof. */
  | 'success'
  /** The tool or transport reported failure. */
  | 'error'
  /** Cancelled by the user or an abort signal. */
  | 'cancelled'
  /** No authoritative answer: timed out, or the connection dropped mid-call. */
  | 'unknown'

/**
 * Whether anything independently confirmed the operation's effect.
 *
 * Kept apart from `outcome` because a tool that answers "ok" has told us about
 * its own execution, not about the state of the world.
 */
export type VerificationState = 'not_attempted' | 'confirmed' | 'inconclusive'

/** Where an operation stopped, for diagnosis and for honest reporting. */
export type OutcomePhase =
  | 'decode'
  | 'validation'
  | 'permission'
  | 'connect'
  | 'transport'
  | 'result_processing'

export type OutcomeRecord = {
  readonly version: typeof OUTCOME_RECORD_VERSION
  readonly dispatch: DispatchEvidence
  readonly outcome: TerminalOutcome
  readonly verification: VerificationState
  /** Where it stopped. Absent for a plain success. */
  readonly phase?: OutcomePhase
  /** Stable category for reporting; never free-form model prose. */
  readonly category?: string
  /** Elapsed milliseconds, when the boundary measured it. */
  readonly elapsedMs?: number
}

function record(
  dispatch: DispatchEvidence,
  outcome: TerminalOutcome,
  rest: Omit<OutcomeRecord, 'version' | 'dispatch' | 'outcome' | 'verification'> & {
    verification?: VerificationState
  } = {},
): OutcomeRecord {
  const { verification = 'not_attempted', ...fields } = rest
  return {
    version: OUTCOME_RECORD_VERSION,
    dispatch,
    outcome,
    verification,
    ...fields,
  }
}

/** The tool reported success. */
export function succeededOutcome(elapsedMs?: number): OutcomeRecord {
  return record('sent', 'success', { elapsedMs })
}

/**
 * The answer never arrived and the request may have been executed.
 *
 * Used for timeout and for cancellation after send. The caller must not
 * describe this as a rollback, and must not auto-replay it: a mutation that
 * already landed would run twice.
 */
export function unknownOutcome(
  category: string,
  elapsedMs?: number,
): OutcomeRecord {
  return record('possibly_sent', 'unknown', {
    phase: 'transport',
    category,
    elapsedMs,
  })
}

/** Cancelled before anything was sent. Distinct from cancelling mid-flight. */
export function cancelledBeforeSendOutcome(
  phase: OutcomePhase = 'transport',
): OutcomeRecord {
  return record('not_sent', 'cancelled', { phase, category: 'aborted' })
}

/**
 * Refused locally: the call was rejected before anything could run.
 *
 * Covers decode failure, unknown tool, input validation, contract checks and
 * permission denial. They differ in `phase` and `category`, but share the one
 * fact that matters downstream — nothing was sent, so nothing happened and a
 * corrected retry is safe.
 */
export function refusedOutcome(
  phase: OutcomePhase,
  category?: string,
): OutcomeRecord {
  return record('not_sent', 'not_run', { phase, category })
}

/**
 * A failure after the request went out, where the boundary knows it ran.
 *
 * Distinct from `unknownOutcome`: here the tool or transport actually
 * answered with a failure, so the operation's fate is known.
 */
export function failedOutcome(
  phase: OutcomePhase,
  category?: string,
  elapsedMs?: number,
): OutcomeRecord {
  return record('sent', 'error', { phase, category, elapsedMs })
}

/**
 * Settle one execution attempt into its single terminal record.
 *
 * The one place that decides an outcome, so the eight rejection sites in the
 * executor cannot drift into eight different opinions about what "failed"
 * means. An outcome carried on the error always wins: the transport is the
 * only layer that knows whether bytes left the machine, and a caller
 * guessing `error` over its `unknown` is what turns a timed-out write into a
 * duplicated one.
 */
export function finalizeOutcome(
  error: unknown,
  fallback: OutcomeRecord,
): OutcomeRecord {
  return outcomeOf(error) ?? fallback
}

/** True when replaying the operation could duplicate a completed effect. */
export function mayHaveExecuted(outcome: OutcomeRecord): boolean {
  return outcome.dispatch !== 'not_sent'
}

/** Shape check for a value crossing a trust or persistence boundary. */
export function isOutcomeRecord(value: unknown): value is OutcomeRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<OutcomeRecord>
  return (
    candidate.version === OUTCOME_RECORD_VERSION &&
    typeof candidate.dispatch === 'string' &&
    typeof candidate.outcome === 'string' &&
    typeof candidate.verification === 'string'
  )
}

/**
 * Carrier for an outcome travelling on a thrown error.
 *
 * A throw is the only channel some failures have, and the fact that matters —
 * whether the request may already have executed — would otherwise be lost in
 * a message string. Non-enumerable so it never lands in a JSON-serialized
 * error payload or a telemetry blob by accident.
 */
const OUTCOME_CARRIER = Symbol.for('tau.mcp.outcome')

/** Attach an outcome to an error. Returns the same error for chaining. */
export function attachOutcome<E extends object>(
  error: E,
  outcome: OutcomeRecord,
): E {
  Object.defineProperty(error, OUTCOME_CARRIER, {
    value: outcome,
    enumerable: false,
    configurable: true,
  })
  return error
}

/**
 * Read an outcome off a thrown value, if one was attached.
 *
 * Returns undefined for anything else, so a caller can fall back to its own
 * classification rather than assuming a failure shape.
 */
export function outcomeOf(error: unknown): OutcomeRecord | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined
  }
  const carried = (error as Record<symbol, unknown>)[OUTCOME_CARRIER]
  return isOutcomeRecord(carried) ? carried : undefined
}

/**
 * How many consecutive failures of one tool are tolerated before the runtime
 * stops accepting another near-identical attempt.
 *
 * Two is the point where the evidence says the assumption is wrong rather
 * than the keystroke: one failure is a typo, two is a misunderstanding. The
 * third attempt is the one that starts a loop.
 */
export const REPEATED_FAILURE_LIMIT = 2

/**
 * Detect a model correcting one field at a time against a contract it has not
 * re-read.
 *
 * The observed shape: a strict server rejects a call, the model patches only
 * the key the diagnostic named, sends again, is rejected for the next key,
 * and repeats. Each payload differs, so exact-match detection sees nothing,
 * while the call is going nowhere and every attempt costs a round trip — and
 * against a mutating tool, risks a partial effect.
 *
 * What counts as progress is deliberately narrow: a failing call is a repeat
 * unless the arguments changed in a way that could plausibly answer the last
 * refusal, meaning a key was added or removed. Editing a value the server
 * never objected to is the loop, not an escape from it.
 *
 * Server-agnostic by construction. It reads argument keys and failure counts,
 * never error text, so no server's wording or field names are baked in.
 */
export function isRepeatedFailingCall(
  previousAttempts: ReadonlyArray<{ input: unknown; failed: boolean }>,
  nextInput: unknown,
  limit: number = REPEATED_FAILURE_LIMIT,
): boolean {
  // Only an unbroken run of failures counts. A success in between means the
  // model recovered, and the next failure starts a fresh run.
  let consecutive = 0
  for (let i = previousAttempts.length - 1; i >= 0; i--) {
    if (!previousAttempts[i]?.failed) break
    consecutive += 1
  }
  if (consecutive < limit) return false

  const recent = previousAttempts.slice(-consecutive)
  const nextKeys = topLevelKeys(nextInput)
  // If the key set never changes across the run and still does not change
  // now, the model is editing values while the server objects to shape.
  return recent.every(
    attempt => sameKeySet(topLevelKeys(attempt.input), nextKeys),
  )
}

function topLevelKeys(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  return Object.keys(input as Record<string, unknown>).sort()
}

function sameKeySet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/**
 * One short line of evidence for the model, derived from the record.
 *
 * Phrased so an uncertain write reads as uncertain. Never says "failed" for
 * something that may have succeeded, and never invents a cause.
 */
export function describeOutcome(outcome: OutcomeRecord): string {
  switch (outcome.outcome) {
    case 'success':
      return 'The tool reported success.'
    case 'not_run':
      return 'The call was refused before it ran; nothing was sent.'
    case 'cancelled':
      return mayHaveExecuted(outcome)
        ? 'Cancelled after the request was sent; it may have been carried out.'
        : 'Cancelled before the request was sent; it did not run.'
    case 'unknown':
      return 'No result came back, so it is unknown whether this was carried out. Check the current state before trying again, rather than repeating it.'
    case 'error':
      return 'The tool reported an error.'
  }
}
