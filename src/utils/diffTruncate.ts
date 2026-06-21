import type { StructuredPatchHunk } from 'diff'
import { count } from './array.js'

/**
 * Cap for overwrite/edit diff previews: render at most this many diff rows,
 * then a "+N lines (ctrl+o to expand)" hint, so a large change doesn't dump the
 * whole file. Applies to BOTH Write overwrites and Edits so the two behave
 * identically (FileWriteTool + FileEditTool share this).
 */
export const MAX_DIFF_LINES_TO_RENDER = 14

/** Total rendered rows in a structured patch (context + added + removed). */
export function countDiffRows(hunks: StructuredPatchHunk[]): number {
  let total = 0
  for (const hunk of hunks) total += hunk.lines.length
  return total
}

/**
 * Trim a patch to the first `maxRows` rendered rows, splitting the hunk that
 * straddles the limit. old/new line counts are recomputed for the kept slice
 * so the diff gutter stays correctly sized.
 */
export function truncateHunks(
  hunks: StructuredPatchHunk[],
  maxRows: number,
): StructuredPatchHunk[] {
  const result: StructuredPatchHunk[] = []
  let used = 0
  for (const hunk of hunks) {
    if (used >= maxRows) break
    const remaining = maxRows - used
    if (hunk.lines.length <= remaining) {
      result.push(hunk)
      used += hunk.lines.length
    } else {
      const lines = hunk.lines.slice(0, remaining)
      result.push({
        ...hunk,
        lines,
        oldLines: count(lines, l => l.startsWith('-') || l.startsWith(' ')),
        newLines: count(lines, l => l.startsWith('+') || l.startsWith(' ')),
      })
      used += remaining
    }
  }
  return result
}
