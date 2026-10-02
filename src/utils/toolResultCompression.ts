import { distillCommandOutput, isOutputDistillEnabled } from './outputDistill.js'
import { surrogateSafeEnd } from './wellFormedText.js'

const TOOL_RESULT_COMPRESSION_ENV_KEYS = [
  'TAU_TOOL_RESULT_COMPRESSION',
  'CLAUDE_CODE_TOOL_RESULT_COMPRESSION',
] as const

const IMPORTANT_LINE =
  /\b(error|failed?|failure|exception|traceback|panic|fatal|warn(?:ing)?|assert(?:ion)?|timeout|timed out|enoent|eacces|eperm|syntaxerror|typeerror|referenceerror)\b|(?:^|\s)[\w./\\-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|cpp|c|h|cs|sh|ps1):\d+(?::\d+)?/i

const MIN_COMPRESSIBLE_CHARS = 4096
const MIN_COMPRESSIBLE_LINES = 40
const HEAD_LINES = 12
const TAIL_LINES = 16
const MAX_DIAGNOSTIC_LINES = 24
/**
 * Longest kept line. Without a cap, one minified line or a page of search
 * results in the first lines used the whole budget, and the diagnostic and
 * last-lines sections never made it into the preview.
 */
const MAX_PREVIEW_LINE_CHARS = 300
/** A line cut shorter than this says nothing; stop filling the section. */
const MIN_PREVIEW_LINE_CHARS = 40
/** Budget shares; the last-lines section gets whatever is left. */
const HEAD_SHARE_WITH_DIAGNOSTICS = 0.3
const DIAGNOSTIC_SHARE = 0.4
const HEAD_SHARE_WITHOUT_DIAGNOSTICS = 0.45

/**
 * Default ON; disable with TAU_TOOL_RESULT_COMPRESSION=0/false/off/no.
 * Same opt-out contract as isOutputDistillEnabled: this is the fallback
 * preview for persisted output the distiller doesn't recognize — a
 * head + diagnostic-lines + tail selection instead of the blind first
 * N bytes. Deterministic, so prompt-cache safe (see outputDistill.ts).
 */
export function isToolResultCompressionEnabled(): boolean {
  for (const key of TOOL_RESULT_COMPRESSION_ENV_KEYS) {
    const value = process.env[key]
    if (
      value &&
      ['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
    ) {
      return false
    }
  }
  return true
}

const HEAD_LABEL = '--- first lines ---'
const DIAGNOSTIC_LABEL = '--- diagnostic lines ---'
const TAIL_LABEL = '--- last lines ---'

function trimRight(line: string): string {
  return line.replace(/\s+$/u, '')
}

function fitToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const suffix = '\n... preview trimmed to budget ...'
  if (maxChars <= suffix.length) {
    return text.slice(0, surrogateSafeEnd(text, maxChars))
  }
  const head = text.slice(0, surrogateSafeEnd(text, maxChars - suffix.length))
  const lastNewline = head.lastIndexOf('\n')
  return head.slice(0, lastNewline > 0 ? lastNewline : head.length) + suffix
}

/** Cut a line to `maxChars`, saying how much was dropped. */
function capLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line
  // Reserve room for the marker using the widest count it can show.
  const reserve = ` [+${line.length} chars]`.length
  const kept = trimRight(line.slice(0, surrogateSafeEnd(line, maxChars - reserve)))
  return `${kept} [+${line.length - kept.length} chars]`
}

/**
 * Keep as many `lines` as fit in `budget` characters (newlines included).
 * Lines longer than MAX_PREVIEW_LINE_CHARS are capped; ordinary lines are
 * kept whole or not at all. With `fromEnd`, the LAST lines are the ones kept.
 */
function fillSection(
  lines: readonly string[],
  budget: number,
  fromEnd: boolean,
): { kept: string[]; used: number } {
  const kept: string[] = []
  let used = 0
  for (let k = 0; k < lines.length; k++) {
    const line = lines[fromEnd ? lines.length - 1 - k : k]!
    const room = budget - used - (kept.length > 0 ? 1 : 0)
    let text =
      line.length > MAX_PREVIEW_LINE_CHARS
        ? capLine(line, MAX_PREVIEW_LINE_CHARS)
        : line
    if (text.length > room) {
      if (line.length <= MAX_PREVIEW_LINE_CHARS || room < MIN_PREVIEW_LINE_CHARS) {
        break
      }
      text = capLine(line, room)
    }
    used += text.length + (kept.length > 0 ? 1 : 0)
    kept.push(text)
  }
  if (fromEnd) kept.reverse()
  return { kept, used }
}

/**
 * Deterministic preview for large plain-text tool output.
 * It is intentionally conservative: keep a small head/tail plus high-signal
 * diagnostic lines, while the full raw output remains persisted separately.
 * Each section gets its own share of the budget and long lines are capped,
 * so a few huge lines can no longer crowd out the other sections.
 */
export function buildCompressedToolResultPreview(
  content: string,
  maxChars: number,
): string | null {
  if (content.length < MIN_COMPRESSIBLE_CHARS) return null
  if (maxChars <= 0) return null

  const allLines = content.split(/\r?\n/u)
  if (allLines.length < MIN_COMPRESSIBLE_LINES) return null

  const headEnd = Math.min(HEAD_LINES, allLines.length)
  const tailStart = Math.max(headEnd, allLines.length - TAIL_LINES)
  const head: Array<{ index: number; text: string }> = []
  for (let i = 0; i < headEnd; i++) {
    const text = trimRight(allLines[i] ?? '')
    if (text) head.push({ index: i, text })
  }
  const tail: string[] = []
  for (let i = tailStart; i < allLines.length; i++) {
    const text = trimRight(allLines[i] ?? '')
    if (text) tail.push(text)
  }
  const diagnosticCandidates: Array<{ index: number; text: string }> = []
  for (let i = 0; i < tailStart; i++) {
    const text = trimRight(allLines[i] ?? '')
    if (text && IMPORTANT_LINE.test(text)) diagnosticCandidates.push({ index: i, text })
  }

  if (diagnosticCandidates.length === 0 && tail.length === 0) return null

  const header = `Compressed preview selected from ${allLines.length.toLocaleString('en-US')} lines.`
  const hasDiagnostics = diagnosticCandidates.length > 0
  // "\n\n" before each label and "\n" after it.
  const labelCost = (label: string): number => label.length + 3
  const overhead =
    header.length +
    (head.length > 0 ? labelCost(HEAD_LABEL) : 0) +
    (hasDiagnostics ? labelCost(DIAGNOSTIC_LABEL) : 0) +
    (tail.length > 0 ? labelCost(TAIL_LABEL) : 0)
  const available = maxChars - overhead
  if (available < 2 * MIN_PREVIEW_LINE_CHARS) return null

  const headBudget = Math.floor(
    available *
      (hasDiagnostics ? HEAD_SHARE_WITH_DIAGNOSTICS : HEAD_SHARE_WITHOUT_DIAGNOSTICS),
  )
  const headResult = fillSection(
    head.map(line => line.text),
    headBudget,
    false,
  )

  // Diagnostics already visible among the kept first lines are not repeated;
  // identical diagnostic lines are listed once.
  const shownHead = new Set(head.slice(0, headResult.kept.length).map(line => line.index))
  const seenText = new Set<string>()
  const diagnostics: string[] = []
  for (const { index, text } of diagnosticCandidates) {
    if (shownHead.has(index) || seenText.has(text)) continue
    seenText.add(text)
    diagnostics.push(`[line ${index + 1}] ${text}`)
    if (diagnostics.length >= MAX_DIAGNOSTIC_LINES) break
  }
  const diagnosticBudget = hasDiagnostics
    ? Math.floor(available * DIAGNOSTIC_SHARE) + (headBudget - headResult.used)
    : 0
  const diagnosticResult = fillSection(diagnostics, diagnosticBudget, false)

  const tailBudget = available - headResult.used - diagnosticResult.used
  const tailResult = fillSection(tail, tailBudget, true)

  const out: string[] = [header]
  for (const [label, kept] of [
    [HEAD_LABEL, headResult.kept],
    [DIAGNOSTIC_LABEL, diagnosticResult.kept],
    [TAIL_LABEL, tailResult.kept],
  ] as const) {
    if (kept.length === 0) continue
    out.push('', label, ...kept)
  }

  const preview = fitToBudget(out.join('\n'), maxChars)
  return preview.length < content.length ? preview : null
}

export function selectToolResultPreview(
  fallbackPreview: string,
  originalContent: unknown,
  maxChars: number,
): string {
  if (typeof originalContent !== 'string') {
    return fallbackPreview
  }
  // Structure-aware distillation first (default ON): recognized test/build/
  // lint output keeps failures + summary instead of the first N bytes. The
  // full output is already persisted, so nothing dropped here is lost.
  if (isOutputDistillEnabled()) {
    const distilled = distillCommandOutput(originalContent, maxChars)
    if (distilled !== null) return distilled
  }
  if (!isToolResultCompressionEnabled()) {
    return fallbackPreview
  }
  return (
    buildCompressedToolResultPreview(originalContent, maxChars) ??
    fallbackPreview
  )
}
