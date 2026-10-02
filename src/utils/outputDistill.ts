/**
 * Structure-aware distillation of noisy command output.
 *
 * Applies to previews of PERSISTED tool output only (the <persisted-output>
 * path): the full output is already on disk and retrievable via
 * ToolOutputRetrieve, so dropping noise here loses nothing. Instead of the
 * naive "first 2000 bytes" preview, a recognized test / build / lint run
 * keeps every failure and diagnostic line plus the closing summary, and
 * collapses passing/progress noise into a count — the model sees
 * "2 failed (details), 296 passed" rather than 2KB of green checkmarks.
 *
 * Determinism contract: pure function of (content, maxChars). No dates, no
 * randomness, no locale-sensitive formatting, no environment reads inside
 * the distiller itself. Tool results are mapped once at execution time and
 * frozen into the conversation, and the per-message budget re-applies stored
 * replacement strings verbatim, so a deterministic distiller is prompt-cache
 * safe on every provider (Anthropic explicit cache_control, OpenAI-compat
 * prefix hashing, Gemini/Antigravity content-addressed implicit cache).
 *
 * Unrecognized output returns null and the caller falls back to the existing
 * preview behavior. Recognition is deliberately conservative: distilling a
 * format we misread is worse than the dumb-but-honest head preview.
 */

import { surrogateSafeEnd } from './wellFormedText.js'

const DISTILL_ENV_KEYS = ['TAU_OUTPUT_DISTILL', 'CLAUDE_CODE_OUTPUT_DISTILL'] as const

/** Default ON; disable with TAU_OUTPUT_DISTILL=0/false/off/no. */
export function isOutputDistillEnabled(): boolean {
  for (const key of DISTILL_ENV_KEYS) {
    const value = process.env[key]
    if (value && ['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())) {
      return false
    }
  }
  return true
}

// --- Line classifiers ------------------------------------------------------
//
// Precedence: summary > failure > pass/progress > diagnostic > other.
// Summary is checked first because closing lines like "Tests: 2 failed,
// 296 passed" would otherwise be eaten by the failure classifier.

/** Closing summaries and counts across jest/vitest/bun/pytest/go/cargo/mocha/
 * tap, plus build wrap-ups (tsc/eslint/webpack/maven/gradle). */
const SUMMARY_LINE =
  /(\b\d+\s+(?:passed|passing|failed|failing|skipped|pending|todo|deselected|xfailed|xpassed|errors?|warnings?|pass|fail|tests?|problems?)\b|\bTests?:|\bTest Suites?:|\bTest Files\b|\btest result:|short test summary|\bRan\s+\d+\s+tests?\b|^\s*OK\b|^\s*FAILED\s*(?:\(|$)|^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+m?s|\(cached\))|\bDone in\b|\bTime:\s|\bDuration\b|\bFound \d+ errors?\b|\bBUILD (?:SUCCESS|FAILED|FAILURE)\b|\bCompiled (?:successfully|with)\b|\bcompilation (?:failed|aborted)\b|^\s*\d+ (?:passing|failing|pending)\b|\bexit code:?\s*\d+|\bExit code:?\s*\d+|# (?:tests|pass|fail) \d+)/i

/** Failure headers/details: jest ✕/●, pytest FAILED/E lines, go --- FAIL,
 * cargo FAILED/panicked, generic error/exception/traceback markers. */
const FAIL_LINE =
  /(✕|✗|✘|⨯|✖|×|\bFAIL(?:ED|S|URE)?\b|--- FAIL|^not ok\b|●|\berror(?:\[[A-Za-z0-9]+\])?\s*[:!]|\bERROR\b|\bError\b|panic(?:ked)?[: ]|\bException\b|Traceback|assert(?:ion)?\s*(?:error|failed)|\bFATAL\b|Unhandled|\bECONN|\bENOENT\b|\bEACCES\b|\bTimeout(?:Error)?\b|timed? ?out)/

/** Passing / progress noise worth collapsing: checkmarks, PASS lines,
 * go === RUN / --- PASS, cargo "test x ... ok", pytest dot-progress rows,
 * spinners and percent progress. */
const PASS_LINE =
  /^\s*(?:✓|✔|√|·|\bPASS\b|--- PASS:|=== (?:RUN|PAUSE|CONT)\b|\bok\b\s+[^ ]|test [^\s]+ \.\.\. ok$|\[\s*OK\s*\]|\d+%\s*$|[-\\|/]\s*$)/

/** pytest-style progress rows: dots with status letters and optional percent. */
const PROGRESS_ROW = /^[.FEsxX]{4,}\s*(?:\[\s*\d+%\s*\])?\s*$/

/** Compiler/linter diagnostics carrying file:line anchors:
 * `src/a.ts(12,5): error TS2304`, `a.c:12:5: error:`, eslint ` 12:5  error  msg`. */
const DIAG_LINE =
  /(?:[\w./\\-]+[:(]\d+(?:[:,]\d+)?\)?:?\s+.*\b(?:error|warning|fatal)\b|^\s+\d+:\d+\s+(?:error|warning)\s)/i

type LineClass = 'summary' | 'fail' | 'pass' | 'diag' | 'other'

function classifyLine(line: string): LineClass {
  if (line.trim().length === 0) return 'other'
  if (SUMMARY_LINE.test(line)) return 'summary'
  if (PROGRESS_ROW.test(line)) return 'pass'
  // Pass markers win over failure keywords: `✓ Error handling works` is a
  // passing test whose NAME mentions errors, not a failure.
  if (PASS_LINE.test(line)) return 'pass'
  if (FAIL_LINE.test(line)) return 'fail'
  if (DIAG_LINE.test(line)) return 'diag'
  return 'other'
}

// --- Distiller -------------------------------------------------------------

const MIN_LINES = 40
const HEAD_LINES = 3
const TAIL_LINES = 6
/** Context kept after each failure line (assertion diffs, expected/received). */
const FAIL_WINDOW = 8
const MAX_FAIL_WINDOWS = 20

type Window = { start: number; end: number } // inclusive line indexes

/** Merge overlapping/adjacent failure windows so blocks read contiguously. */
function mergeWindows(windows: Window[]): Window[] {
  const merged: Window[] = []
  for (const w of windows) {
    const last = merged[merged.length - 1]
    if (last && w.start <= last.end + 1) {
      last.end = Math.max(last.end, w.end)
    } else {
      merged.push({ ...w })
    }
  }
  return merged
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end--
  return lines.slice(0, end)
}

/**
 * Distill recognized test/build/lint output into failures + summary within
 * `maxChars`. Returns null when the content does not look like a noisy
 * structured run (caller keeps its existing preview).
 */
export function distillCommandOutput(
  content: string,
  maxChars: number,
): string | null {
  if (maxChars <= 200) return null
  if (content.length < 2000) return null

  const allLines = content.split(/\r?\n/)
  if (allLines.length < MIN_LINES) return null

  const classes: LineClass[] = new Array(allLines.length)
  let passCount = 0
  let failCount = 0
  let diagCount = 0
  let summaryCount = 0
  for (let i = 0; i < allLines.length; i++) {
    const c = classifyLine(allLines[i]!)
    classes[i] = c
    if (c === 'pass') passCount++
    else if (c === 'fail') failCount++
    else if (c === 'diag') diagCount++
    else if (c === 'summary') summaryCount++
  }

  // Recognition gate — require enough structure to be confident this is a
  // test/build/lint run and that collapsing actually pays for itself.
  const looksLikeTestRun =
    (passCount >= 10 && summaryCount >= 1) ||
    (failCount >= 1 && summaryCount >= 2 && passCount >= 3)
  const looksLikeDiagnostics = diagCount >= 8
  if (!looksLikeTestRun && !looksLikeDiagnostics) return null

  // Failure/diagnostic windows: the marker line plus trailing context.
  const rawWindows: Window[] = []
  for (let i = 0; i < allLines.length; i++) {
    if (classes[i] === 'fail' || classes[i] === 'diag') {
      rawWindows.push({
        start: i,
        end: Math.min(i + (classes[i] === 'fail' ? FAIL_WINDOW : 0), allLines.length - 1),
      })
    }
  }
  const windows = mergeWindows(rawWindows)

  // Assemble, tracking which lines are already shown so head/tail/summary
  // lines never repeat a failure block line. peekRange collects without
  // marking; commit marks accepted lines — a block REJECTED by the budget
  // check must leave its lines available to the summary/tail passes.
  const shown = new Set<number>()
  const peekRange = (
    start: number,
    end: number,
  ): { indexes: number[]; lines: string[] } => {
    const indexes: number[] = []
    const lines: string[] = []
    for (let i = start; i <= end && i < allLines.length; i++) {
      if (shown.has(i)) continue
      indexes.push(i)
      lines.push(allLines[i]!)
    }
    return { indexes, lines }
  }
  const commit = (indexes: readonly number[]): void => {
    for (const i of indexes) shown.add(i)
  }
  const takeRange = (start: number, end: number): string[] => {
    const peeked = peekRange(start, end)
    commit(peeked.indexes)
    return peeked.lines
  }

  const sections: string[] = []
  const problemCount = failCount + diagCount
  const header =
    `[Distilled preview of ${allLines.length}-line output: ` +
    (problemCount > 0
      ? `${problemCount} failure/diagnostic ${problemCount === 1 ? 'line' : 'lines'} kept, `
      : '') +
    `${passCount} passing/progress lines collapsed. Line numbers refer to the saved full output.]`
  sections.push(header)

  const head = trimTrailingBlank(takeRange(0, HEAD_LINES - 1))
  if (head.length > 0) sections.push(head.join('\n'))

  // Reserve footer space (summary + tail) WITHOUT consuming those lines yet —
  // failure blocks get first claim on their own lines, and anything a block
  // already showed is skipped by the footer passes below.
  const tailStart = Math.max(allLines.length - TAIL_LINES, 0)
  let reservedFooter = 0
  for (let i = 0; i < allLines.length; i++) {
    if (classes[i] === 'summary' || i >= tailStart) {
      reservedFooter += allLines[i]!.length + 1
    }
  }
  reservedFooter += 32 // section separators

  let spent = sections.join('\n\n').length
  let windowsShown = 0
  const failureBlocks: string[] = []
  for (const w of windows) {
    if (windowsShown >= MAX_FAIL_WINDOWS) break
    const peeked = peekRange(w.start, w.end)
    const block = trimTrailingBlank(peeked.lines)
    if (block.length === 0) continue
    const rendered = `[from line ${w.start + 1}]\n${block.join('\n')}`
    if (spent + reservedFooter + rendered.length + 2 > maxChars) break
    commit(peeked.indexes)
    failureBlocks.push(rendered)
    spent += rendered.length + 2
    windowsShown++
  }
  if (failureBlocks.length > 0) {
    sections.push(failureBlocks.join('\n'))
  }
  if (windowsShown < windows.length) {
    sections.push(
      `[… ${windows.length - windowsShown} more failure/diagnostic ${windows.length - windowsShown === 1 ? 'block' : 'blocks'} in the saved full output]`,
    )
  }

  const summaryLines: string[] = []
  for (let i = 0; i < allLines.length; i++) {
    if (classes[i] === 'summary' && !shown.has(i)) {
      shown.add(i)
      summaryLines.push(allLines[i]!)
    }
  }
  if (summaryLines.length > 0) {
    sections.push(summaryLines.join('\n'))
  }
  const tail = trimTrailingBlank(takeRange(tailStart, allLines.length - 1))
  if (tail.length > 0) {
    sections.push(`--- last lines ---\n${tail.join('\n')}`)
  }

  let result = sections.join('\n\n')
  if (result.length > maxChars) {
    // Hard trim at a line boundary, keeping the front (header + failures
    // lead; summary already ordered before tail).
    const slice = result.slice(0, surrogateSafeEnd(result, maxChars - 24))
    const lastNewline = slice.lastIndexOf('\n')
    result =
      (lastNewline > maxChars * 0.5 ? slice.slice(0, lastNewline) : slice) +
      '\n[… trimmed to budget]'
  }

  // Only worth using if it actually beats sending the raw head.
  return result.length < content.length ? result : null
}
