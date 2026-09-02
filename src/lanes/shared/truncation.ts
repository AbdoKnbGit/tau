/**
 * Output-cap truncation — one rule for every lane.
 *
 * When a provider stops generating because the response hit the output-token
 * ceiling, the last thing the model was writing is half-written. If that was a
 * tool call, its arguments are a fragment: sometimes unparseable JSON, but —
 * and this is the failure that motivated this module — sometimes a *complete*
 * JSON object that is simply missing the fields the model had not reached yet.
 * A provider that closes the object for us (OpenRouter does) hands us
 * `{"content": "<half a file>"}` with no `file_path`, indistinguishable from a
 * call the model finished writing.
 *
 * Two consequences if a lane just forwards that:
 *
 *   1. Best case the tool layer rejects it with "the required parameter
 *      `file_path` is missing" — a message that blames the model for a cap the
 *      user set, three layers away from the cause.
 *   2. Worst case every required field *happened* to arrive before the cut and
 *      the call runs, writing a truncated file with no warning at all.
 *
 * So lanes must do two things when the provider reports truncation:
 *
 *   - Emit `stop_reason: 'max_tokens'`. claude.ts turns that into the
 *     "response exceeded the N output token maximum" path. When the turn is
 *     left with no tool calls at all, query.ts then runs its recovery loop —
 *     retry at a higher cap, else re-prompt the model to resume — instead of
 *     settling the turn as finished. When other tool calls did survive, the
 *     ordinary tool loop runs and the model reissues the dropped call on the
 *     next turn. Either way the synthetic error message claude.ts creates
 *     carries SYNTHETIC_MODEL, which normalizeMessagesForAPI filters out, so
 *     it never reaches the wire and never shifts a prompt-cache prefix.
 *   - Drop the tool call that was still receiving argument deltas. It is the
 *     only block that can be half-written, it has no tool_result yet (nothing
 *     downstream has seen it), and dropping it keeps the tool_use/tool_result
 *     pairing intact. The model re-issues it on the next turn.
 *
 * The deprecated Anthropic-IR adapters (`openai_to_anthropic`,
 * `openai_responses`, `gemini_to_anthropic`) all mapped truncation to
 * `max_tokens`; the native lanes dropped that mapping on the way over. This
 * module is where it lives now.
 */

/** Stop reasons a lane may report on the Anthropic IR. */
export type LaneStopReason = 'end_turn' | 'tool_use' | 'max_tokens'

/**
 * Every spelling of "stopped because the output cap was reached" across the
 * wire formats the lanes speak:
 *   - `length`             OpenAI Chat Completions `choice.finish_reason`
 *   - `max_output_tokens`  OpenAI Responses `response.incomplete_details.reason`
 *   - `max_tokens`         Gemini `candidate.finishReason` (MAX_TOKENS), and
 *                          routers that pass an Anthropic stop_reason through
 */
const OUTPUT_CAP_REASONS = new Set(['length', 'max_output_tokens', 'max_tokens'])

/**
 * Did the provider stop because the response hit the output-token ceiling?
 * Case-insensitive: Gemini shouts `MAX_TOKENS`, OpenAI whispers `length`.
 */
export function isOutputCapTruncation(reason: unknown): boolean {
  return (
    typeof reason === 'string' &&
    OUTPUT_CAP_REASONS.has(reason.trim().toLowerCase())
  )
}

/**
 * The stop reason for a finished lane turn. Truncation outranks `tool_use`:
 * the turn did end with tool calls, but the fact the caller has to act on is
 * that the model was cut off mid-sentence.
 *
 * `hadToolUse` must count the blocks the lane actually emitted — a dropped
 * in-flight call is not one of them.
 */
export function laneStopReason(opts: {
  truncated: boolean
  hadToolUse: boolean
}): LaneStopReason {
  if (opts.truncated) return 'max_tokens'
  return opts.hadToolUse ? 'tool_use' : 'end_turn'
}

/**
 * Tracks which tool call was mid-flight when the stream ended.
 *
 * Providers stream tool calls one at a time, so only the call that most
 * recently received an argument delta can be half-written. Text or reasoning
 * arriving afterwards proves the model moved on and closed that call, so the
 * tracker forgets it — a complete call is never dropped just because the cut
 * happened later in the same turn.
 *
 * `K` is whatever the lane keys its argument buffers by (an OpenAI tool_call
 * index, a Responses output index, …).
 */
export class InFlightToolCall<K> {
  private key: K | null = null

  /** An argument fragment arrived for `key`. */
  noteArgs(key: K): void {
    this.key = key
  }

  /** Text / reasoning arrived — whatever tool call preceded it is closed. */
  noteOtherOutput(): void {
    this.key = null
  }

  /** The provider explicitly finished this call (e.g. `*.done`). */
  noteSettled(key: K): void {
    if (this.key === key) this.key = null
  }

  /**
   * The call to discard when `truncated`, or null when nothing was in flight.
   * Returns null unless truncated, so callers can write the drop unguarded.
   */
  toDrop(truncated: boolean): K | null {
    return truncated ? this.key : null
  }
}
