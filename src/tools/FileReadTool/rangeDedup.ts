/**
 * Range-aware Read dedup.
 *
 * FileReadTool.call already answers a Read whose offset and limit equal the
 * last Read of an unchanged file. Models also re-read lines they hold through
 * other ranges: a slice of an earlier whole-file read, or the same lines after
 * an Edit elsewhere in the file. This answers such a Read with a short note
 * naming the earlier result, under three rules that keep the note true:
 *
 *  - That result showed exactly these lines: same text at the same line
 *    numbers. Compared on text, not mtimes, so an Edit elsewhere keeps the
 *    untouched lines reusable, and lines it shifted are sent again.
 *  - That result is still in the conversation with its content (not rewound,
 *    compacted or cleared). Only Reads whose result the model receives as a
 *    tool_result are recorded.
 *  - A Read repeated right after a note sends the text, so a model that cannot
 *    find the earlier result recovers in one call instead of looping.
 *
 * Pure functions; FileReadTool keeps the state in FileState.seenRanges.
 */
import type { Message } from '../../types/message.js'
import { addLineNumbers } from '../../utils/file.js'
import type { FileState, SeenRange } from '../../utils/fileStateCache.js'

// Per file, so a long session's read history stays small.
const MAX_SEEN_RANGES = 16
const MAX_SEEN_CHARS = 250_000

/**
 * `ranges` plus `range`, without the older ranges it fully covers and without
 * the oldest ones past the per-file bounds.
 */
export function withSeenRange(
  ranges: readonly SeenRange[] | undefined,
  range: SeenRange,
): readonly SeenRange[] | undefined {
  if (range.text === '' || range.text.length > MAX_SEEN_CHARS) return ranges
  const kept = (ranges ?? []).filter(
    r => r.start < range.start || r.end > range.end,
  )
  kept.push(range)
  let chars = kept.reduce((sum, r) => sum + r.text.length, 0)
  while (kept.length > MAX_SEEN_RANGES || chars > MAX_SEEN_CHARS) {
    chars -= kept.shift()!.text.length
  }
  return kept
}

/**
 * The earlier Read result that already shows `text` (the lines a Read is about
 * to return, starting at line `start`) unchanged, or undefined when they must
 * be sent.
 */
export function findUnchangedSeenRange(
  previous: FileState | undefined,
  start: number,
  text: string,
  messages: readonly Message[] | undefined,
): SeenRange | undefined {
  const ranges = previous?.seenRanges
  if (!ranges || text === '') return undefined
  const wanted = text.split('\n')
  const end = start + wanted.length - 1
  const stub = previous?.lastRangeStub
  if (stub && stub.start <= end && stub.end >= start) return undefined
  for (let i = ranges.length - 1; i >= 0; i--) {
    const seen = ranges[i]!
    if (seen.start > start || seen.end < end) continue
    const lines = seen.text.split('\n')
    const at = start - seen.start
    if (
      wanted.every((line, k) => lines[at + k] === line) &&
      resultStillInContext(messages, seen, lines)
    ) {
      return seen
    }
  }
  return undefined
}

/** Whether the Read that showed `seen` still has its result in `messages`. */
function resultStillInContext(
  messages: readonly Message[] | undefined,
  seen: SeenRange,
  lines: string[],
): boolean {
  if (!messages) return false
  // Its first non-empty line, numbered as Read numbers it, must be there:
  // a cleared or replaced result no longer carries it.
  const k = lines.findIndex(line => line !== '')
  const probe =
    k === -1
      ? ''
      : addLineNumbers({ content: lines[k]!, startLine: seen.start + k })
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type !== 'tool_result' || block.tool_use_id !== seen.toolUseId) {
        continue
      }
      const shown = toolResultText(block.content)
      return probe === '' ? shown.length > 0 : shown.includes(probe)
    }
  }
  return false
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      part && typeof part === 'object' && part.type === 'text'
        ? String(part.text ?? '')
        : '',
    )
    .join('')
}
