/**
 * Literal search inside a persisted tool output.
 *
 * When a tool result is too large to inline, Tau parks it on disk and hands the
 * model a path. Until now the only way back in was a byte or line range, so
 * finding one stack trace in a 60 KB build log meant guessing offsets: probe,
 * miss, probe again. Each probe costs a turn and leaves the irrelevant slice
 * sitting in the conversation.
 *
 * Parked results are written once (`flag: 'wx'` in toolResultStorage) and never
 * rewritten, so a query against one is deterministic for as long as the file
 * exists: the same file and the same query always render the same bytes into
 * the prompt. That is what makes this safe to run on a replayed message: it
 * cannot shift a prefix that is already cached.
 *
 * Literal, case-insensitive substring only, deliberately not a regex. A
 * model-supplied pattern would be a backtracking hazard on exactly the payloads
 * this exists to search (a minified JSON body parked as one 60 KB line), and it
 * would need escaping rules the model gets wrong. Anything more complex still
 * has the line-range read as an escape hatch.
 *
 * Leaf module (fs + readline only), so the checks in toolResultSearch.test.ts
 * run standalone.
 */

import { createReadStream } from 'fs'
import { createInterface } from 'readline'

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_BYTES = 100_000
/**
 * Per-line ceiling before a match is windowed. Parked `.json` results are
 * routinely one enormous line; without this, a single hit would paste the whole
 * file back into the context the parking existed to protect.
 */
const DEFAULT_MAX_LINE_CHARS = 400
const DEFAULT_DEADLINE_MS = 5_000
/** Only the head of the file is sniffed for NUL: binary payloads declare themselves early. */
const BINARY_SNIFF_CHARS = 8_000
/** Checking the clock per line costs more than the scan on small files. */
const DEADLINE_CHECK_INTERVAL = 512

export type ToolResultSearchOptions = {
  maxMatches?: number
  maxBytes?: number
  maxLineChars?: number
  deadlineMs?: number
}

export type ToolResultSearchOutcome = {
  /** Matching lines, each prefixed with its 1-based line number. */
  content: string
  /** Matching lines included in `content`. */
  matches: number
  /** Lines read before the scan stopped. Equals the file's line count when `completed`. */
  scannedLines: number
  /** True when the scan reached end of file without hitting a cap. */
  completed: boolean
  /** True when the payload looks binary; `content` is then empty. */
  binary: boolean
  /** True when a cap or the deadline cut results short. */
  truncated: boolean
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/**
 * Return `line` when it fits, else a window centred on the hit so the model
 * sees the match in context instead of the first `maxChars` of boilerplate.
 * Elisions are marked so a windowed line is never mistaken for the whole line.
 */
export function windowAround(
  line: string,
  at: number,
  needleLength: number,
  maxChars: number,
): string {
  if (line.length <= maxChars) return line
  const pad = Math.max(Math.floor((maxChars - needleLength) / 2), 0)
  const start = Math.max(at - pad, 0)
  const end = Math.min(start + maxChars, line.length)
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

/**
 * Scan `path` for lines containing `query`, case-insensitively.
 *
 * Streams rather than reading the file in: a parked result holds the output
 * that was already too big to inline, so its size has no useful upper bound.
 */
export async function searchToolResultFile(
  path: string,
  query: string,
  options: ToolResultSearchOptions = {},
): Promise<ToolResultSearchOutcome> {
  const needle = query.toLowerCase()
  const maxMatches = positiveInt(options.maxMatches, DEFAULT_MAX_MATCHES)
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES)
  const maxLineChars = positiveInt(options.maxLineChars, DEFAULT_MAX_LINE_CHARS)
  const deadline = Date.now() + positiveInt(options.deadlineMs, DEFAULT_DEADLINE_MS)

  const blocks: string[] = []
  let matches = 0
  let scannedLines = 0
  let size = 0
  let sniffed = 0
  let binary = false
  let truncated = false
  let completed = true

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    scannedLines++

    if (sniffed < BINARY_SNIFF_CHARS) {
      sniffed += line.length + 1
      if (line.includes('\u0000')) {
        binary = true
        completed = false
        rl.close()
        break
      }
    }

    if (scannedLines % DEADLINE_CHECK_INTERVAL === 0 && Date.now() > deadline) {
      truncated = true
      completed = false
      rl.close()
      break
    }

    const at = line.toLowerCase().indexOf(needle)
    if (at === -1) continue

    const rendered = `${scannedLines}: ${windowAround(line, at, needle.length, maxLineChars)}`
    if (size + rendered.length > maxBytes) {
      truncated = true
      completed = false
      rl.close()
      break
    }

    blocks.push(rendered)
    matches++
    size += rendered.length + 1

    if (matches >= maxMatches) {
      truncated = true
      completed = false
      rl.close()
      break
    }
  }

  return {
    content: binary ? '' : blocks.join('\n'),
    matches: binary ? 0 : matches,
    scannedLines,
    completed,
    binary,
    truncated,
  }
}
