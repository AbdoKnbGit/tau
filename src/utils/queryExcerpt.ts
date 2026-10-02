/**
 * Query-scoped excerpts for oversized text.
 *
 * Web search hits and fetched pages are often far larger than the room a tool
 * result has. Cutting them by head keeps navigation, bylines and intros and
 * drops the passage the query was about. These helpers keep the parts that
 * mention the query instead:
 *
 *   - excerptForQuery: windows around query-term matches in plain text,
 *     ranked by how many distinct (and how rare) terms each covers. Used for
 *     search-hit content.
 *   - excerptMarkdownForQuery: heading-aware sections ranked with BM25, with
 *     heading matches weighted up. Used for fetched documentation pages.
 *
 * Everything runs in memory over one document: no index, no native module,
 * nothing persisted, identical on every OS.
 *
 * Determinism contract: output is a pure function of the arguments. No dates,
 * randomness, locale-dependent formatting or environment reads, and every sort
 * has an explicit tiebreak. Tool results are frozen into the conversation once,
 * so callers stay prompt-cache safe on every provider; determinism also keeps
 * retries, tests and transcript replay byte-stable.
 *
 * Output never exceeds the requested budget and never splits a surrogate pair.
 *
 * Leaf module (only wellFormedText), directly unit-testable with bun.
 */

import { surrogateSafeEnd, surrogateSafeStart } from './wellFormedText.js'

const ELLIPSIS = '…'

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Word runs: letters, combining marks, digits and underscore. */
const WORD_RUN = /[\p{L}\p{M}\p{N}_]+/gu
const COMBINING_MARKS = /\p{M}+/gu
const COMBINING_MARK = /\p{M}/u
/**
 * Scripts written without spaces between words. Their runs are matched as
 * overlapping character bigrams, the standard way to search them without a
 * dictionary.
 */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u
const ASCII_LETTERS = /^[a-z]+$/
const DIGITS = /^[0-9]+$/

/**
 * Function words that carry no topic. Stored in normalized form (lowercase,
 * accents stripped). Non-English entries are limited to words that are not
 * also common English words or technical terms (so "mit", "bin", "dos", "em",
 * "os" and the like stay searchable).
 */
const STOPWORDS = new Set(
  (
    // English
    'a about above after again against all also am an and any are as at be ' +
    'because been before being below between both but by can could did do ' +
    'does doing down during each few for from further had has have having ' +
    'he her here hers herself him himself his how i if in into is it its ' +
    'itself just me more most my myself no nor not now of off on once only ' +
    'or other our ours out over own same she should so some such than that ' +
    'the their theirs them themselves then there these they this those ' +
    'through to too under until up us very was we were what when where ' +
    'which while who whom why will with would you your yours yourself ' +
    'yourselves ' +
    // French
    'au aux avec ce ces cette dans de elle en et il ils je la le les leur ' +
    'leurs mais mes nos notre nous ou par pas pour qu que qui sur un une vos ' +
    'votre vous ' +
    // Spanish
    'al como el ella ellos esta este esto las los para pero por sus una uno ' +
    'unos ' +
    // German
    'auch bist dem den einem einen einer eines fur ich ist nach nicht noch ' +
    'oder sich sie sind und uns von vor wie wir zum zur ' +
    // Portuguese
    'ao aos da do ela ele entre essa esse isso mais mas nos pela pelo qual ' +
    'seu sua um uma'
  ).split(' '),
)

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false
  }
  return true
}

/** Lowercase; for non-ASCII also fold compatibility forms and strip accents. */
function normalizeWord(raw: string): string {
  const lower = raw.toLowerCase()
  if (isAscii(lower)) return lower
  return lower.normalize('NFKD').replace(COMBINING_MARKS, '')
}

/**
 * Light English suffix stripping so "plugins", "installing" and "cached" meet
 * "plugin", "install" and "cache". Only plain ASCII words of 4+ letters are
 * touched; everything else matches exactly. Over-stemming is harmless here —
 * it only widens matches, and ranking decides what is shown.
 */
function stem(word: string): string {
  if (word.length < 4 || !ASCII_LETTERS.test(word)) return word
  let w = word
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('sses')) w = w.slice(0, -2)
  else if (w.length > 4 && /(?:ch|sh|x|z)es$/.test(w)) w = w.slice(0, -2)
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1)
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

type TokenVisitor = (
  key: string,
  norm: string,
  start: number,
  end: number,
  unspaced: boolean,
) => void

/** Emit bigrams (or the single character) of an unspaced-script segment. */
function visitUnspaced(
  segment: string,
  offset: number,
  visit: TokenVisitor,
): void {
  const units: Array<{ text: string; start: number }> = []
  for (let i = 0; i < segment.length; ) {
    const cp = segment.codePointAt(i)!
    const width = cp > 0xffff ? 2 : 1
    const ch = segment.slice(i, i + width)
    // Combining marks belong to the character before them.
    if (units.length > 0 && COMBINING_MARK.test(ch)) {
      units[units.length - 1]!.text += ch
    } else {
      units.push({ text: ch, start: offset + i })
    }
    i += width
  }
  if (units.length === 1) {
    const norm = normalizeWord(units[0]!.text)
    if (norm) visit(norm, norm, units[0]!.start, offset + segment.length, true)
    return
  }
  for (let k = 0; k + 1 < units.length; k++) {
    const norm = normalizeWord(units[k]!.text + units[k + 1]!.text)
    if (!norm) continue
    const end =
      k + 2 < units.length ? units[k + 2]!.start : offset + segment.length
    visit(norm, norm, units[k]!.start, end, true)
  }
}

/** Split a word run that mixes unspaced and spaced scripts into segments. */
function visitMixedRun(run: string, offset: number, visit: TokenVisitor): void {
  let segmentStart = 0
  let segmentUnspaced: boolean | null = null
  const flush = (end: number): void => {
    if (segmentUnspaced === null || end <= segmentStart) return
    const segment = run.slice(segmentStart, end)
    if (segmentUnspaced) {
      visitUnspaced(segment, offset + segmentStart, visit)
      return
    }
    const norm = normalizeWord(segment)
    if (norm) {
      visit(stem(norm), norm, offset + segmentStart, offset + end, false)
    }
  }
  for (let i = 0; i < run.length; ) {
    const cp = run.codePointAt(i)!
    const width = cp > 0xffff ? 2 : 1
    const ch = run.slice(i, i + width)
    if (!COMBINING_MARK.test(ch)) {
      const unspaced = UNSPACED_SCRIPT.test(ch)
      if (segmentUnspaced === null) {
        segmentUnspaced = unspaced
        segmentStart = i
      } else if (unspaced !== segmentUnspaced) {
        flush(i)
        segmentStart = i
        segmentUnspaced = unspaced
      }
    } else if (segmentUnspaced === null) {
      segmentUnspaced = false
      segmentStart = i
    }
    i += width
  }
  flush(run.length)
}

/**
 * Visit every token of `text` in order. `key` is the matching form (stemmed
 * for English words), `norm` the normalized surface form, and start/end are
 * UTF-16 offsets into `text`.
 */
function forEachToken(text: string, visit: TokenVisitor): void {
  for (const match of text.matchAll(WORD_RUN)) {
    const run = match[0]
    const start = match.index ?? 0
    if (!UNSPACED_SCRIPT.test(run)) {
      const norm = normalizeWord(run)
      if (norm) visit(stem(norm), norm, start, start + run.length, false)
      continue
    }
    visitMixedRun(run, start, visit)
  }
}

/**
 * Words that describe the extraction task in a fetch prompt ("extract the
 * full details from this page") rather than its topic. Kept out of prompt
 * terms so they neither rank sections nor make a narrow request look like a
 * question about the whole page. Not applied to search queries, where words
 * like "list" or "content" can be the topic.
 */
const TASK_WORDS = new Set(
  (
    'extract extracting extracted summarize summarise summarized summary ' +
    'summaries overview explain explained describe described description list ' +
    'listing give show tell find provide return include mention mentioned ' +
    'information info detail details content contents page pages article ' +
    'articles document documents documentation docs doc text site website web ' +
    'url link links full complete entire whole everything anything something ' +
    'main key important relevant specific exact exactly please quote quotes ' +
    'quoted verbatim answer question read fetch fetched get point points ' +
    'section sections part parts thing things way ways use using used work ' +
    'works working need want like etc example examples'
  ).split(' '),
)

function isUsefulQueryToken(
  norm: string,
  unspaced: boolean,
  extraStopwords?: ReadonlySet<string>,
): boolean {
  if (unspaced) return true
  if (DIGITS.test(norm)) return norm.length >= 2
  return (
    norm.length >= 2 && !STOPWORDS.has(norm) && !extraStopwords?.has(norm)
  )
}

function collectTerms(
  text: string,
  maxTerms: number,
  extraStopwords?: ReadonlySet<string>,
): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  forEachToken(text, (key, norm, _start, _end, unspaced) => {
    if (terms.length >= maxTerms) return
    if (!isUsefulQueryToken(norm, unspaced, extraStopwords) || seen.has(key)) {
      return
    }
    seen.add(key)
    terms.push(key)
  })
  return terms
}

/**
 * Distinct matching keys of the topical words in `query`, in query order.
 * Function words, single characters and single digits are dropped. Returns an
 * empty array when nothing topical remains, which every helper below treats
 * as "no ranking possible".
 */
export function extractQueryTerms(query: string, maxTerms = 32): string[] {
  return collectTerms(query, maxTerms)
}

/**
 * Like extractQueryTerms, for an instruction about a page ("Extract the
 * install steps"): task words such as "extract", "page" or "details" are
 * dropped too, leaving the topic.
 */
export function extractPromptTerms(prompt: string, maxTerms = 32): string[] {
  return collectTerms(prompt, maxTerms, TASK_WORDS)
}

// ---------------------------------------------------------------------------
// Plain-text windows
// ---------------------------------------------------------------------------

export type QueryExcerptOptions = {
  /** Characters kept on each side of a match. Defaults from the budget. */
  radius?: number
  /**
   * Leading characters always kept when there is room: titles, bylines and
   * the "Highlights" some search providers put first.
   */
  leadChars?: number
}

/** Below this budget an excerpt cannot show a match in any context. */
const MIN_EXCERPT_CHARS = 120
/** Shortest piece worth adding; smaller leftovers stay unused. */
const MIN_SEGMENT_CHARS = 60
/** How far a cut may move to land on whitespace instead of mid-word. */
const SNAP_CHARS = 32

type Segment = { start: number; end: number }

type MatchWindow = Segment & {
  focus: number
  terms: Set<number>
  hits: number
  score: number
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13
}

/** Move a segment start forward onto a word boundary when one is close. */
function snapStart(text: string, index: number): number {
  if (index <= 0) return 0
  const limit = Math.min(text.length, index + SNAP_CHARS)
  for (let i = index; i < limit; i++) {
    if (isWhitespaceCode(text.charCodeAt(i - 1))) return i
  }
  return surrogateSafeStart(text, index)
}

/** Move a segment end back onto a word boundary when one is close. */
function snapEnd(text: string, index: number): number {
  if (index >= text.length) return text.length
  const limit = Math.max(0, index - SNAP_CHARS)
  for (let i = index; i > limit; i--) {
    if (isWhitespaceCode(text.charCodeAt(i))) return i
  }
  return surrogateSafeEnd(text, index)
}

function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Segment[] = []
  for (const segment of sorted) {
    const last = merged[merged.length - 1]
    if (last && segment.start <= last.end) {
      last.end = Math.max(last.end, segment.end)
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

function hardCut(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= ELLIPSIS.length) return text.slice(0, surrogateSafeEnd(text, maxChars))
  return `${text.slice(0, surrogateSafeEnd(text, maxChars - ELLIPSIS.length))}${ELLIPSIS}`
}

/**
 * Keep the parts of `text` around matches of `terms`, within `maxChars`.
 *
 * Returns `text` unchanged when it already fits, and null when there is
 * nothing to rank (no terms, no match, or a budget too small to show a match
 * in context) — callers then keep their existing head cut.
 */
export function excerptForQuery(
  text: string,
  terms: readonly string[],
  maxChars: number,
  options: QueryExcerptOptions = {},
): string | null {
  if (text.length <= maxChars) return text
  if (terms.length === 0 || maxChars < MIN_EXCERPT_CHARS) return null

  const termIndex = new Map<string, number>()
  terms.forEach((term, i) => {
    if (!termIndex.has(term)) termIndex.set(term, i)
  })

  const radius = Math.floor(
    Math.max(40, options.radius ?? Math.min(360, Math.max(80, maxChars / 6))),
  )
  const maxWindow = Math.max(2 * radius + 200, Math.floor(maxChars / 2))
  const windows: MatchWindow[] = []
  forEachToken(text, (key, _norm, start, end) => {
    const term = termIndex.get(key)
    if (term === undefined) return
    const windowStart = Math.max(0, start - radius)
    const windowEnd = Math.min(text.length, end + radius)
    const last = windows[windows.length - 1]
    if (last && windowStart <= last.end && windowEnd - last.start <= maxWindow) {
      last.end = Math.max(last.end, windowEnd)
      last.terms.add(term)
      last.hits++
      return
    }
    windows.push({
      start: windowStart,
      end: windowEnd,
      focus: start,
      terms: new Set([term]),
      hits: 1,
      score: 0,
    })
  })
  if (windows.length === 0) return null

  // A term seen in few windows says more about a window than one seen in all.
  const windowsWithTerm = new Map<number, number>()
  for (const window of windows) {
    for (const term of window.terms) {
      windowsWithTerm.set(term, (windowsWithTerm.get(term) ?? 0) + 1)
    }
  }
  for (const window of windows) {
    let score = 0
    for (const term of window.terms) {
      score +=
        1 + Math.log((windows.length + 1) / ((windowsWithTerm.get(term) ?? 0) + 1))
    }
    window.score = score + Math.min(window.hits, 8) * 0.05
  }

  const separator = text.includes('\n') ? `\n${ELLIPSIS}\n` : ` ${ELLIPSIS} `
  // Leading and trailing ellipses are reserved up front.
  const budget = maxChars - 2 * ELLIPSIS.length
  const picked: Segment[] = []
  let used = 0
  const leadChars = Math.min(
    budget,
    Math.floor(options.leadChars ?? Math.min(240, maxChars * 0.15)),
  )
  if (leadChars >= MIN_SEGMENT_CHARS) {
    picked.push({ start: 0, end: leadChars })
    used += leadChars
  }

  const ranked = [...windows].sort(
    (a, b) => b.score - a.score || a.start - b.start,
  )
  for (const window of ranked) {
    const room = budget - used - separator.length
    if (room < MIN_SEGMENT_CHARS) break
    let { start, end } = window
    if (end - start > room) {
      // Keep the window's first match in view, a third of the way in.
      start = Math.max(
        window.start,
        Math.min(window.focus - Math.floor(room / 3), window.end - room),
      )
      end = start + room
    }
    picked.push({ start, end })
    used += end - start + separator.length
  }

  const parts: string[] = []
  let first = -1
  let last = -1
  for (const segment of mergeSegments(picked)) {
    const start = snapStart(text, segment.start)
    const end = snapEnd(text, segment.end)
    if (end <= start) continue
    const part = text.slice(start, end).trim()
    if (!part) continue
    if (first === -1) first = start
    last = end
    parts.push(part)
  }
  if (parts.length === 0) return null

  const excerpt =
    (first > 0 ? ELLIPSIS : '') +
    parts.join(separator) +
    (last < text.length ? ELLIPSIS : '')
  return hardCut(excerpt, maxChars)
}

// ---------------------------------------------------------------------------
// Markdown sections
// ---------------------------------------------------------------------------

export type MarkdownExcerptOptions = {
  /** Leading characters of the document always kept (title, intro). */
  headChars?: number
  /**
   * After the ranked picks, keep adding the remaining sections in document
   * order while they fit. Also lets an unrankable document (no terms, no
   * match) produce a head-first excerpt instead of null.
   */
  fill?: boolean
  /**
   * Only excerpt a request about a small part of the document: return null
   * unless some query term is distinctive (mentioned in at most a fifth of
   * the sections) and the fewest top sections holding 80% of those terms'
   * BM25 weight are at most this fraction of the document's characters.
   * Otherwise the request is about the whole page and an excerpt would lose
   * too much.
   */
  maxRelevantFraction?: number
}

export type MarkdownExcerpt = {
  text: string
  /** Sections (or parts of long sections) included, wholly or partly. */
  shownSections: number
  totalSections: number
}

/** Long sections are split into parts of at most this many characters. */
const MAX_SECTION_CHARS = 3_000
/** A heading or breadcrumb match counts this many times a body match. */
const HEADING_WEIGHT = 3
const BM25_K1 = 1.2
const BM25_B = 0.75
/** Budget reserved per included section for joins and omission markers. */
const SECTION_OVERHEAD_CHARS = 48
/** Smallest leftover worth filling with a partial section. */
const MIN_PARTIAL_SECTION_CHARS = 400
/** Smallest leading slice of the first section worth keeping on its own. */
const MIN_HEAD_SLICE_CHARS = 200

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const BLOCKQUOTE = /^ {0,3}>/

type Line = { start: number; end: number; text: string }

type Section = {
  start: number
  end: number
  /** Heading breadcrumb, "Guide > Install > Windows". Empty for the preamble. */
  title: string
  /** The heading line as written, shown when a later part stands alone. */
  headingText: string
  /** True for the second and later parts of a split section. */
  continuation: boolean
}

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const raw = text.slice(start, end)
    lines.push({
      start,
      end,
      text: raw.endsWith('\r') ? raw.slice(0, -1) : raw,
    })
    if (newline === -1) break
    start = newline + 1
  }
  return lines
}

type Heading = { level: number; title: string; text: string }

/**
 * Find headings outside fenced code; keyed by the line the heading starts on.
 * `inFence` marks lines inside a fence (including its fence lines) and
 * `fenceOpen` the opening line of each fence.
 */
function findHeadings(lines: Line[]): {
  headings: Map<number, Heading>
  inFence: boolean[]
  fenceOpen: boolean[]
} {
  const headings = new Map<number, Heading>()
  const inFence: boolean[] = new Array(lines.length).fill(false)
  const fenceOpen: boolean[] = new Array(lines.length).fill(false)
  let fence: { char: string; length: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text
    if (fence) {
      inFence[i] = true
      const close = FENCE_CLOSE.exec(text)
      if (
        close &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.length
      ) {
        fence = null
      }
      continue
    }
    const open = FENCE_OPEN.exec(text)
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length }
      inFence[i] = true
      fenceOpen[i] = true
      continue
    }
    const atx = ATX_HEADING.exec(text)
    if (atx) {
      const title = (atx[2] ?? '').replace(/[ \t]+#+$/, '').trim()
      headings.set(i, { level: atx[1]!.length, title, text: text.trim() })
      continue
    }
    if (i > 0 && SETEXT_UNDERLINE.test(text)) {
      const previous = lines[i - 1]!.text
      if (
        previous.trim() &&
        !inFence[i - 1] &&
        !headings.has(i - 1) &&
        !FENCE_OPEN.test(previous) &&
        !LIST_ITEM.test(previous) &&
        !BLOCKQUOTE.test(previous) &&
        !SETEXT_UNDERLINE.test(previous)
      ) {
        const title = previous.trim()
        headings.set(i - 1, {
          level: text.trim().startsWith('=') ? 1 : 2,
          title,
          text: title,
        })
      }
    }
  }
  return { headings, inFence, fenceOpen }
}

/** Index of the first line whose start is >= offset (binary search). */
function firstLineAtOrAfter(lines: Line[], offset: number): number {
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.start < offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Split [start, end) into contiguous parts of at most `maxChars`: at
 * paragraph breaks outside code fences first, then at line starts, then hard.
 */
function splitRange(
  text: string,
  lines: Line[],
  fences: { inFence: boolean[]; fenceOpen: boolean[] },
  start: number,
  end: number,
  maxChars: number,
): Segment[] {
  if (end - start <= maxChars) return [{ start, end }]

  const firstLine = firstLineAtOrAfter(lines, start)
  const paragraphStarts: number[] = []
  const lineStarts: number[] = []
  for (let i = Math.max(1, firstLine); i < lines.length; i++) {
    const line = lines[i]!
    if (line.start >= end) break
    if (line.start <= start) continue
    lineStarts.push(line.start)
    const previous = lines[i - 1]!
    // A blank line inside a code fence is not a paragraph break; the fence's
    // own opening line is.
    if (
      !previous.text.trim() &&
      line.text.trim() &&
      (!fences.inFence[i] || fences.fenceOpen[i])
    ) {
      paragraphStarts.push(line.start)
    }
  }

  const pieces: Segment[] = []
  const pushHard = (pieceStart: number, pieceEnd: number): void => {
    let s = pieceStart
    while (pieceEnd - s > maxChars) {
      let cut = surrogateSafeEnd(text, s + maxChars)
      if (cut <= s) cut = s + maxChars
      pieces.push({ start: s, end: cut })
      s = cut
    }
    if (pieceEnd > s) pieces.push({ start: s, end: pieceEnd })
  }
  const pushByLines = (pieceStart: number, pieceEnd: number): void => {
    let s = pieceStart
    let candidate = -1
    for (const lineStart of lineStarts) {
      if (lineStart <= s) continue
      if (lineStart >= pieceEnd) break
      if (lineStart - s <= maxChars) {
        candidate = lineStart
        continue
      }
      if (candidate > s) {
        pieces.push({ start: s, end: candidate })
        s = candidate
        candidate = lineStart - s <= maxChars ? lineStart : -1
        if (candidate === -1) {
          pushHard(s, lineStart)
          s = lineStart
        }
      } else {
        pushHard(s, lineStart)
        s = lineStart
      }
    }
    if (pieceEnd - s > maxChars && candidate > s) {
      pieces.push({ start: s, end: candidate })
      s = candidate
    }
    pushHard(s, pieceEnd)
  }

  let paragraphStart = start
  for (const boundary of [...paragraphStarts, end]) {
    if (boundary <= paragraphStart) continue
    if (boundary - paragraphStart <= maxChars) {
      pieces.push({ start: paragraphStart, end: boundary })
    } else {
      pushByLines(paragraphStart, boundary)
    }
    paragraphStart = boundary
  }

  // Pack consecutive pieces back together up to the size limit.
  const parts: Segment[] = []
  for (const piece of pieces) {
    const last = parts[parts.length - 1]
    if (last && piece.end - last.start <= maxChars) {
      last.end = piece.end
    } else {
      parts.push({ ...piece })
    }
  }
  return parts
}

function splitSections(markdown: string, maxSectionChars: number): Section[] {
  const lines = splitLines(markdown)
  const { headings, inFence, fenceOpen } = findHeadings(lines)
  const boundaries = [...headings.keys()].sort((a, b) => a - b)

  const ranges: Array<{ start: number; end: number; heading?: Heading }> = []
  const firstHeadingStart =
    boundaries.length > 0 ? lines[boundaries[0]!]!.start : markdown.length
  if (markdown.slice(0, firstHeadingStart).trim()) {
    ranges.push({ start: 0, end: firstHeadingStart })
  }
  boundaries.forEach((lineIndex, k) => {
    const start = lines[lineIndex]!.start
    const next = boundaries[k + 1]
    const end = next === undefined ? markdown.length : lines[next]!.start
    ranges.push({ start, end, heading: headings.get(lineIndex) })
  })

  const sections: Section[] = []
  const stack: Heading[] = []
  for (const range of ranges) {
    if (range.heading) {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= range.heading.level) {
        stack.pop()
      }
      stack.push(range.heading)
    }
    const title = range.heading
      ? stack
          .map(heading => heading.title)
          .filter(Boolean)
          .join(' > ')
      : ''
    const headingText = range.heading?.text ?? ''
    splitRange(
      markdown,
      lines,
      { inFence, fenceOpen },
      range.start,
      range.end,
      maxSectionChars,
    ).forEach(
      (part, k) => {
        sections.push({
          start: part.start,
          end: part.end,
          title,
          headingText,
          continuation: k > 0,
        })
      },
    )
  }
  return sections
}

type ScoredSection = Section & { score: number }

type SectionScores = {
  sections: ScoredSection[]
  /** weights[s][t]: term t's share of section s's BM25 score. */
  weights: number[][]
  /** Number of sections mentioning each term. */
  documentFrequency: number[]
}

function scoreSections(
  markdown: string,
  sections: Section[],
  terms: readonly string[],
): SectionScores {
  const termIndex = new Map<string, number>()
  terms.forEach((term, i) => {
    if (!termIndex.has(term)) termIndex.set(term, i)
  })
  const bodyTf = sections.map(() => new Array<number>(terms.length).fill(0))
  const lengths = new Array<number>(sections.length).fill(0)
  let index = 0
  forEachToken(markdown, (key, _norm, start) => {
    while (index < sections.length - 1 && start >= sections[index]!.end) index++
    if (sections.length === 0) return
    lengths[index]!++
    const term = termIndex.get(key)
    if (term !== undefined) bodyTf[index]![term]!++
  })

  const titleTfCache = new Map<string, number[]>()
  const titleTf = sections.map(section => {
    const cached = titleTfCache.get(section.title)
    if (cached) return cached
    const counts = new Array<number>(terms.length).fill(0)
    forEachToken(section.title, key => {
      const term = termIndex.get(key)
      if (term !== undefined) counts[term]!++
    })
    titleTfCache.set(section.title, counts)
    return counts
  })

  const count = sections.length
  const documentFrequency = new Array<number>(terms.length).fill(0)
  for (let s = 0; s < count; s++) {
    for (let t = 0; t < terms.length; t++) {
      if (bodyTf[s]![t]! + titleTf[s]![t]! > 0) documentFrequency[t]!++
    }
  }
  const idf = documentFrequency.map(df =>
    Math.log(1 + (count - df + 0.5) / (df + 0.5)),
  )
  const averageLength = Math.max(
    1,
    lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, count),
  )

  const weights = sections.map((_, s) => {
    const lengthNorm =
      1 - BM25_B + (BM25_B * Math.max(1, lengths[s]!)) / averageLength
    return terms.map((_, t) => {
      const tf = bodyTf[s]![t]! + HEADING_WEIGHT * titleTf[s]![t]!
      if (tf === 0) return 0
      return (idf[t]! * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm)
    })
  })
  const scored = sections.map((section, s) => ({
    ...section,
    score: weights[s]!.reduce((sum, weight) => sum + weight, 0),
  }))
  return { sections: scored, weights, documentFrequency }
}

/**
 * A term names a small part of the document when at most this share of its
 * sections mention it. Words that appear everywhere ("option", "file") say
 * nothing about where the answer is.
 */
const DISTINCTIVE_SECTION_FRACTION = 0.2
/** Share of the distinctive terms' weight the "answer sections" must hold. */
const DISTINCTIVE_WEIGHT_SHARE = 0.8

/**
 * Characters of the fewest top sections holding most of the distinctive
 * terms' weight — where the answer is — or null when no query term is
 * distinctive (the request is about the whole page).
 */
function targetedSectionChars(scores: SectionScores): number | null {
  const { sections, weights, documentFrequency } = scores
  const rareLimit = Math.max(
    1,
    Math.floor(sections.length * DISTINCTIVE_SECTION_FRACTION),
  )
  const distinctive = documentFrequency.map(df => df > 0 && df <= rareLimit)
  const mass = weights.map(row =>
    row.reduce((sum, weight, t) => sum + (distinctive[t] ? weight : 0), 0),
  )
  const total = mass.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  const order = mass
    .map((_, s) => s)
    .filter(s => mass[s]! > 0)
    .sort((a, b) => mass[b]! - mass[a]! || a - b)
  let covered = 0
  let chars = 0
  for (const s of order) {
    covered += mass[s]!
    chars += sections[s]!.end - sections[s]!.start
    if (covered >= total * DISTINCTIVE_WEIGHT_SHARE) break
  }
  return chars
}

type Pick = { start: number; end: number; text?: string; cut: boolean }

function omittedMarker(count: number): string {
  return `[${ELLIPSIS} ${count} section${count === 1 ? '' : 's'} omitted ${ELLIPSIS}]`
}

/** Drop leading blank lines and trailing whitespace; keep code indentation. */
function trimBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

function renderPicks(
  markdown: string,
  sections: Section[],
  picks: Map<number, Pick>,
): string {
  const pieces: string[] = []
  let previous = -1
  for (const index of [...picks.keys()].sort((a, b) => a - b)) {
    const pick = picks.get(index)!
    const gap = index - previous - 1
    if (gap > 0) pieces.push(omittedMarker(gap))
    let body = trimBlankEdges(pick.text ?? markdown.slice(pick.start, pick.end))
    if (pick.cut) body += `\n${ELLIPSIS}`
    const section = sections[index]!
    if (section.continuation && section.headingText && !picks.has(index - 1)) {
      body = `${section.headingText} (continued)\n${body}`
    }
    pieces.push(body)
    previous = index
  }
  const trailing = sections.length - 1 - previous
  if (trailing > 0) pieces.push(omittedMarker(trailing))
  return pieces.join('\n\n')
}

/** Largest line-boundary cut of [start, start + maxChars). */
function cutAtLine(markdown: string, start: number, maxChars: number): number {
  const limit = surrogateSafeEnd(markdown, start + maxChars)
  const newline = markdown.lastIndexOf('\n', limit - 1)
  return newline > start ? newline : limit
}

/**
 * Keep the sections of `markdown` that best match `terms`, within `maxChars`.
 *
 * Returns null when the document already fits, when there is nothing to rank
 * (unless `fill` is set), or when `maxRelevantFraction` says the query is
 * about the whole document. Sections are rendered in document order; skipped
 * runs are marked "[… N sections omitted …]".
 */
export function excerptMarkdownForQuery(
  markdown: string,
  terms: readonly string[],
  maxChars: number,
  options: MarkdownExcerptOptions = {},
): MarkdownExcerpt | null {
  if (markdown.length <= maxChars) return null
  if (maxChars < MIN_PARTIAL_SECTION_CHARS + SECTION_OVERHEAD_CHARS) return null

  const scores = scoreSections(
    markdown,
    splitSections(markdown, MAX_SECTION_CHARS),
    terms,
  )
  const { sections } = scores
  if (sections.length === 0) return null

  const relevant = sections
    .map((section, index) => ({ index, score: section.score }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  if (relevant.length === 0 && !options.fill) return null
  if (options.maxRelevantFraction !== undefined) {
    const targetChars = targetedSectionChars(scores)
    if (
      targetChars === null ||
      targetChars > markdown.length * options.maxRelevantFraction
    ) {
      return null
    }
  }

  const picks = new Map<number, Pick>()
  const pickOrder: number[] = []
  let used = 0
  const costOf = (index: number, length: number): number =>
    length +
    SECTION_OVERHEAD_CHARS +
    (sections[index]!.continuation ? sections[index]!.headingText.length + 16 : 0)

  // Head anchor: the page title and intro orient every reader.
  const headChars = Math.max(
    0,
    Math.floor(options.headChars ?? Math.min(2_000, maxChars * 0.1)),
  )
  let headUsed = 0
  for (let index = 0; index < sections.length && headUsed < headChars; index++) {
    const section = sections[index]!
    const length = section.end - section.start
    if (headUsed + length <= headChars) {
      picks.set(index, { start: section.start, end: section.end, cut: false })
      pickOrder.push(index)
      headUsed += length
      used += costOf(index, length)
      continue
    }
    const room = headChars - headUsed
    if (room >= MIN_HEAD_SLICE_CHARS) {
      const end = cutAtLine(markdown, section.start, room)
      picks.set(index, { start: section.start, end, cut: true })
      pickOrder.push(index)
      used += costOf(index, end - section.start)
    }
    break
  }

  for (const { index } of relevant) {
    const section = sections[index]!
    const length = section.end - section.start
    const existing = picks.get(index)
    if (existing && !existing.cut) continue
    const room = maxChars - used
    if (existing) {
      // A head slice of a relevant section: complete it when it fits.
      const extra = section.end - existing.end
      if (extra <= room) {
        picks.set(index, { start: section.start, end: section.end, cut: false })
        used += extra
      }
      continue
    }
    const cost = costOf(index, length)
    if (cost <= room) {
      picks.set(index, { start: section.start, end: section.end, cut: false })
      pickOrder.push(index)
      used += cost
      continue
    }
    // Too big to fit whole: keep its best-matching passages instead. A
    // section that matched only through its heading has no body windows,
    // so the loop moves on to smaller sections.
    const partialRoom = room - costOf(index, 0)
    if (partialRoom >= MIN_PARTIAL_SECTION_CHARS) {
      const text = excerptForQuery(
        markdown.slice(section.start, section.end),
        terms,
        partialRoom,
      )
      if (text !== null) {
        picks.set(index, { start: section.start, end: section.end, text, cut: false })
        pickOrder.push(index)
        used += costOf(index, text.length)
      }
    }
  }

  if (options.fill) {
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index]!
      const existing = picks.get(index)
      if (existing) {
        // Complete the head slice when the rest of its section fits.
        if (existing.cut && existing.text === undefined) {
          const extra = section.end - existing.end
          if (extra <= maxChars - used) {
            picks.set(index, { start: section.start, end: section.end, cut: false })
            used += extra
          }
        }
        continue
      }
      const cost = costOf(index, section.end - section.start)
      if (cost > maxChars - used) continue
      picks.set(index, { start: section.start, end: section.end, cut: false })
      pickOrder.push(index)
      used += cost
    }
  }

  if (picks.size === 0) return null

  // The overhead reserve makes overflow rare; if it happens, drop the most
  // recent picks (the least relevant) until the render fits.
  let text = renderPicks(markdown, sections, picks)
  while (text.length > maxChars && pickOrder.length > 1) {
    picks.delete(pickOrder.pop()!)
    text = renderPicks(markdown, sections, picks)
  }
  if (text.length > maxChars) text = hardCut(text, maxChars)

  return {
    text,
    shownSections: picks.size,
    totalSections: sections.length,
  }
}
