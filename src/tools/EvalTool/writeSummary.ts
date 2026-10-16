/**
 * What a cell changed in each file it wrote, in line numbers.
 *
 * A plain Python write bypasses Edit, so nothing told the model which lines
 * moved and the safe habit was re-reading the whole file. This names the
 * changed lines and where the lines below them moved, the same way an Edit
 * result does, so the model reads only what it still needs.
 */
import { stat, readFile } from 'fs/promises'
import { structuredPatch } from 'diff'
import { lineShiftAfterEdit } from '../FileEditTool/matchResolver.js'

// Files past this size, binary files and unreadable ones are listed plainly.
const MAX_SUMMARY_BYTES = 1_000_000
const MAX_LISTED_SPANS = 3
const DIFF_TIMEOUT_MS = 2_000

/** The file's text with LF line ends, or null when it cannot be summarized. */
export async function readTextForSummary(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_SUMMARY_BYTES) return null
    const text = await readFile(path, 'utf8')
    return text.includes('\u0000') ? null : text.replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

type Hunk = { oldStart: number; newStart: number; lines: readonly string[] }

/** The changed span of one hunk, in the new file's line numbers. */
function changedSpan(hunk: Hunk): string {
  let newLine = hunk.newStart
  let from: number | undefined
  let to: number | undefined
  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      from ??= newLine
      to = newLine
      newLine++
    } else if (line.startsWith('-')) {
      from ??= newLine
    } else if (line.startsWith(' ')) {
      newLine++
    }
  }
  if (from === undefined) return ''
  if (to === undefined) return `lines removed before line ${from}`
  return from === to ? `line ${from}` : `lines ${from}-${to}`
}

/** One phrase for how `before` became `after`, by line number. */
export function describeTextChange(before: string, after: string): string {
  if (before === after) return 'unchanged'
  const patch = structuredPatch('before', 'after', before, after, undefined, undefined, {
    context: 3,
    timeout: DIFF_TIMEOUT_MS,
  })
  const hunks: Hunk[] = patch?.hunks ?? []
  if (hunks.length === 0) return 'changed'
  const spans = hunks.map(changedSpan).filter(Boolean)
  const more = spans.length - MAX_LISTED_SPANS
  let text = `changed ${spans.slice(0, MAX_LISTED_SPANS).join(', ')}${more > 0 ? ` and ${more} more ${more === 1 ? 'place' : 'places'}` : ''}`
  const shift = lineShiftAfterEdit(hunks)
  const oldLines = before.split('\n').length
  if (shift && shift.firstOldLine <= oldLines) {
    text += `; lines below moved ${shift.delta > 0 ? 'down' : 'up'} ${Math.abs(shift.delta)} (old line ${shift.firstOldLine} is now ${shift.firstOldLine + shift.delta})`
  }
  return text
}

/**
 * The phrase for one written file: `before` is its text when the cell first
 * touched it (null when it was new, large or binary). Empty when there is
 * nothing reliable to say.
 */
export async function describeWrittenFile(
  path: string,
  before: string | null,
  created: boolean,
): Promise<string> {
  const after = await readTextForSummary(path)
  if (after === null) {
    const exists = await stat(path).then(() => true, () => false)
    return exists ? '' : 'deleted'
  }
  if (created) {
    const count = after === '' ? 0 : after.split('\n').length - (after.endsWith('\n') ? 1 : 0)
    return `new, ${count} ${count === 1 ? 'line' : 'lines'}`
  }
  return before === null ? '' : describeTextChange(before, after)
}
