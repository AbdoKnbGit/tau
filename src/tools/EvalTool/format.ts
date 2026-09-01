import {
  DEFAULT_CELL_TIMEOUT_SEC,
  MAX_BRIDGE_LINES,
  MAX_CELL_TIMEOUT_SEC,
  MAX_RESULT_CHARS,
} from './constants.js'

/**
 * Pure presentation helpers for the Eval tool.
 *
 * A leaf module on purpose: `EvalTool.ts` pulls in React and the ink design
 * system, which makes it unimportable from a plain `bun run` test. Everything
 * here is a pure function so the invariants can be checked directly.
 */

export type BridgeCallRecord = {
  name: string
  detail: string
  ms: number
  error?: string
}

const TRACEBACK_HEADER = 'Traceback (most recent call last):'

/**
 * Split a cell result around its traceback block, for display only.
 *
 * A raw traceback is five to ten lines of machinery for one mistyped
 * character. The reader wants the exception and where it landed; the frames
 * are noise until they are not. So the collapsed transcript shows one line and
 * Ctrl+O shows everything.
 *
 * The block is EXCISED rather than truncated from. A failed cell's text is
 * stdout, then the traceback, then the `[tool bridge]` summary, so cutting to
 * the end would swallow the bridge section too. Whatever the cell printed
 * before it died is kept — that output is usually why the failure makes sense.
 *
 * Returns null when there is no traceback to collapse, which leaves the result
 * rendered verbatim rather than guessing at its shape.
 *
 * Display only: the model's copy of the result still carries the whole
 * traceback. It is the one that has to debug the cell.
 */
export function splitFailure(
  text: string,
): { rest: string; headline: string; hiddenLines: number } | null {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === TRACEBACK_HEADER)
  if (start === -1) return null

  // Frames are indented; the first unindented line after the header is the
  // exception, and it ends the block.
  let end = start + 1
  while (end < lines.length && (lines[end] ?? '').trim() === '') end += 1
  while (end < lines.length && /^\s/.test(lines[end] ?? '')) end += 1
  const exception = (lines[end] ?? '').trim()
  if (!exception) return null

  const rest = [...lines.slice(0, start), ...lines.slice(end + 1)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const location = /File "<cell>", line (\d+)/.exec(text)
  return {
    rest,
    headline: location ? `${exception} · line ${location[1]}` : exception,
    hiddenLines: end - start,
  }
}

export function resolveTimeoutMs(seconds: number | undefined): number {
  if (seconds === undefined) return DEFAULT_CELL_TIMEOUT_SEC * 1000
  if (seconds === 0) return 0
  return Math.min(Math.max(seconds, 1), MAX_CELL_TIMEOUT_SEC) * 1000
}

/**
 * Keep the head and the tail. A cell that prints a lot usually puts the shape
 * of the data at the top and the answer at the bottom; cutting only the tail
 * loses the part the model actually needs.
 */
export function clampOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false }
  const head = Math.floor(MAX_RESULT_CHARS * 0.7)
  const tail = MAX_RESULT_CHARS - head
  const omitted = text.length - MAX_RESULT_CHARS
  // Plain digits, not toLocaleString(): the truncation notice is part of the
  // serialized conversation, and a locale-dependent separator would make the
  // same cell produce different bytes on different machines.
  return {
    text: `${text.slice(0, head)}\n\n... [${omitted} characters omitted — print less, or aggregate inside the cell] ...\n\n${text.slice(-tail)}`,
    truncated: true,
  }
}

/**
 * One line per bridged call while there are few of them, an aggregate once
 * there are many. A loop over 400 files must not spend 400 lines of the
 * model's context describing itself.
 */
/**
 * A bridge error already appears in the cell's traceback. Repeating it here at
 * full length printed the same paragraph twice for a single failed call, which
 * is how one mistyped tool name filled a screen.
 */
const MAX_BRIDGE_ERROR_CHARS = 160

function shortError(error: string): string {
  const oneLine = error.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_BRIDGE_ERROR_CHARS
    ? `${oneLine.slice(0, MAX_BRIDGE_ERROR_CHARS - 1)}…`
    : oneLine
}

export function summarizeBridgeCalls(calls: readonly BridgeCallRecord[]): string {
  if (calls.length === 0) return ''
  const lines: string[] = []
  if (calls.length <= MAX_BRIDGE_LINES) {
    for (const call of calls) {
      const suffix = call.error ? ` — failed: ${shortError(call.error)}` : ''
      lines.push(`  ${call.name}${call.detail ? ` ${call.detail}` : ''}${suffix}`)
    }
  } else {
    const counts = new Map<string, number>()
    for (const call of calls) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
    }
    const parts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${count} ${name}`)
    lines.push(`  ${parts.join(', ')}`)
    for (const failure of calls.filter(call => call.error).slice(0, 3)) {
      lines.push(`  ${failure.name} failed: ${shortError(failure.error ?? '')}`)
    }
  }
  return `\n[tool bridge]\n${lines.join('\n')}`
}
