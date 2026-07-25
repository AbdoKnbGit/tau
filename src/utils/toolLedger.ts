/**
 * In-session tool ledger and thrash detection.
 *
 * The classic waste pattern: the model runs the same tool with the same input,
 * it fails, and the model runs it again verbatim — three, five, ten times —
 * until the turn budget or the user's patience runs out. Nothing in the loop
 * notices, because each individual call is a legitimate tool use that was
 * permitted and executed.
 *
 * This module derives a ledger of tool calls from the message history and
 * reports that pattern. Two deliberate properties:
 *
 *   - Derived, not tracked. There is no hook to register and no mutable global
 *     to keep in sync with the conversation; compaction, rewind, and forks all
 *     produce a correct ledger for free because the ledger IS the history.
 *   - Read-only. Detection never mutates messages and never reaches the wire,
 *     so it cannot perturb the prompt cache. The caller decides whether to act.
 *
 * Leaf module (only `djb2Hash`), so the checks in toolLedger.test.ts run
 * standalone.
 */

import { djb2Hash } from './hash.js'

/** How many consecutive identical failures before the pattern counts as thrash. */
export const DEFAULT_LOOP_THRESHOLD = 3

/**
 * Messages scanned back from the tail. A run of 3 sequential call/result pairs
 * spans ~6 messages, so this leaves a wide margin for interleaved attachments
 * and still keeps the per-batch scan flat regardless of session length.
 */
export const DEFAULT_SCAN_WINDOW = 40

/** Readable slice of a tool input kept for the guidance message. */
const INPUT_PREVIEW_CHARS = 200

/** Slice of the failure text fed back to the model. */
const ERROR_PREVIEW_CHARS = 500

/**
 * Structural shapes rather than imports of `types/message.js`, which would drag
 * the whole message graph in and cost this module its leaf status. Only the
 * fields read here are declared; real messages carry many more.
 */
type ContentBlockLike = {
  type: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
  text?: string
}

type MessageLike = {
  type: string
  message?: {
    role?: string
    content?: string | readonly ContentBlockLike[]
  }
}

/** One tool call, joined with its result when the result has arrived. */
export type LedgerToolCall = {
  /** tool_use id, the join key between the call and its result. */
  id: string
  name: string
  /** Equality key over the full input: identical inputs share it, different ones do not. */
  inputKey: string
  /** Human-readable slice of the input, for guidance text only. */
  inputPreview: string
  /** `undefined` while the call has no result yet (in-flight, or dropped mid-turn). */
  ok?: boolean
  /** Result text when the call failed. */
  errorText?: string
}

export type ToolLoopDetection = {
  name: string
  inputKey: string
  inputPreview: string
  /** Length of the consecutive identical-failure run at the tail of the ledger. */
  count: number
  errorText: string
}

/**
 * Canonical JSON with object keys sorted, so `{a:1,b:2}` and `{b:2,a:1}` are one
 * input rather than two. Arrays keep their order (order is meaningful there).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key])
    }
    return out
  }
  return value
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(canonicalize(value) ?? null) ?? 'null'
  } catch {
    // Cyclic or otherwise unserializable input. Fall back to a shape that is
    // stable per call but never equal to another call's key, so an
    // unserializable input can't be mistaken for a repeat.
    return `__unserializable__${Math.random()}`
  }
}

/**
 * Equality key for a tool input. Hashed rather than truncated: truncating long
 * inputs would make two different 10KB payloads compare equal and report a loop
 * that isn't happening.
 */
export function toolInputKey(input: unknown): string {
  const canonical = safeStringify(input)
  return `${canonical.length}:${djb2Hash(canonical)}`
}

function previewOf(input: unknown): string {
  const text = safeStringify(input)
  return text.length <= INPUT_PREVIEW_CHARS
    ? text
    : `${text.slice(0, INPUT_PREVIEW_CHARS)}…`
}

/** tool_result content is a string, or blocks of which only text carries meaning. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as readonly ContentBlockLike[]) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function blocksOf(message: MessageLike): readonly ContentBlockLike[] {
  const content = message.message?.content
  return Array.isArray(content) ? content : []
}

/**
 * Walk the history and pair every `tool_use` with its `tool_result`.
 *
 * Calls are returned in issue order, including ones still awaiting a result
 * (`ok === undefined`) so callers can tell "in flight" from "succeeded".
 *
 * `scanLastMessages` bounds the walk to the tail of the history. Detection only
 * ever reads the tail (see {@link detectToolLoop}), while a full walk
 * re-serializes every tool input in the session on every tool batch — measured
 * at ~10ms per scan for a 500-call session with large Write payloads, paid in
 * the query loop for nothing. A window that comfortably exceeds the threshold
 * gets identical answers for a fraction of the work. Truncating mid-pair is
 * safe: an orphaned result is ignored, and that can only happen at the head of
 * the window, never at the tail the detector reads.
 */
export function collectToolCalls(
  messages: readonly MessageLike[],
  options?: { scanLastMessages?: number },
): LedgerToolCall[] {
  const calls: LedgerToolCall[] = []
  const byId = new Map<string, LedgerToolCall>()

  const window = options?.scanLastMessages
  const scanned =
    window !== undefined && window > 0 && messages.length > window
      ? messages.slice(-window)
      : messages

  for (const message of scanned) {
    for (const block of blocksOf(message)) {
      if (!block) continue

      if (block.type === 'tool_use' && typeof block.id === 'string') {
        // A duplicate id would mean the same call was recorded twice (resume
        // replaying a transcript); keep the first and ignore the echo.
        if (byId.has(block.id)) continue
        const call: LedgerToolCall = {
          id: block.id,
          name: typeof block.name === 'string' ? block.name : 'unknown',
          inputKey: toolInputKey(block.input),
          inputPreview: previewOf(block.input),
        }
        calls.push(call)
        byId.set(block.id, call)
        continue
      }

      if (
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        const call = byId.get(block.tool_use_id)
        // A result whose call is not in the window (history truncated by
        // compaction) has nothing to attach to.
        if (!call || call.ok !== undefined) continue
        call.ok = block.is_error !== true
        if (call.ok === false) {
          const text = resultText(block.content).trim()
          call.errorText =
            text.length > ERROR_PREVIEW_CHARS
              ? `${text.slice(0, ERROR_PREVIEW_CHARS)}…`
              : text
        }
      }
    }
  }

  return calls
}

/**
 * Report a run of identical failing calls at the tail of the ledger.
 *
 * Only the tail counts, and only consecutive calls: one success, or one call
 * with different arguments, clears the run. That is the difference between a
 * model that is stuck and a model that hit the same error twice while making
 * progress in between — the second one should not be interrupted.
 *
 * In-flight calls are skipped rather than treated as breaks, so a detection
 * made while the next batch is already dispatched still fires.
 */
export function detectToolLoop(
  calls: readonly LedgerToolCall[],
  options?: { threshold?: number },
): ToolLoopDetection | null {
  const threshold = options?.threshold ?? DEFAULT_LOOP_THRESHOLD
  if (threshold < 2) return null

  const resolved = calls.filter(call => call.ok !== undefined)
  const last = resolved[resolved.length - 1]
  if (!last || last.ok !== false) return null

  let count = 0
  for (let i = resolved.length - 1; i >= 0; i--) {
    const call = resolved[i]!
    if (call.ok !== false) break
    if (call.name !== last.name || call.inputKey !== last.inputKey) break
    count++
  }

  if (count < threshold) return null

  return {
    name: last.name,
    inputKey: last.inputKey,
    inputPreview: last.inputPreview,
    count,
    errorText: last.errorText ?? '',
  }
}

/**
 * The nudge injected after a detection. Deliberately does not tell the model
 * what to do instead — it has the context to decide, and a wrong instruction
 * here is worse than none. It only makes the repetition itself visible, which
 * is the thing the model cannot see from inside the loop.
 */
export function buildLoopBreakerGuidance(
  detection: ToolLoopDetection,
): string {
  const lines = [
    `You have called ${detection.name} ${detection.count} times in a row with identical arguments, and it failed every time.`,
    '',
    `Arguments: ${detection.inputPreview}`,
  ]
  if (detection.errorText) {
    lines.push('', 'Latest failure:', detection.errorText)
  }
  lines.push(
    '',
    'Repeating the same call will produce the same failure. Change the approach:',
    'fix what the error actually reports, use a different tool, or stop and explain',
    'what is blocking you. Do not issue this call again unchanged.',
  )
  return lines.join('\n')
}
