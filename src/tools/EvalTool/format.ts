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
export function summarizeBridgeCalls(calls: readonly BridgeCallRecord[]): string {
  if (calls.length === 0) return ''
  const lines: string[] = []
  if (calls.length <= MAX_BRIDGE_LINES) {
    for (const call of calls) {
      const suffix = call.error ? ` — failed: ${call.error}` : ''
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
      lines.push(`  ${failure.name} failed: ${failure.error}`)
    }
  }
  return `\n[tool bridge]\n${lines.join('\n')}`
}
