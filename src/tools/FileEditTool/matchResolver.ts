/**
 * Flexible old_string resolution + failure diagnostics for the Edit tool.
 *
 * Models chain edits against a mental copy of the file that drifts from the
 * real one — their own earlier edit, a formatter pass, trailing whitespace
 * lost in transit. Exact-match-or-fail turns that drift into a failed call, a
 * Read round-trip, and sometimes a guess-the-variant retry loop. This module
 * recovers the provably-safe cases automatically and makes the rest fixable
 * in a single retry:
 *
 *  - resolveFlexibleMatch: when old_string doesn't match exactly, find the
 *    region the model meant — the same lines modulo trailing whitespace, the
 *    same lines uniformly re-indented, or the same lines with blank lines
 *    added or missing between them — and return the file's REAL text for it
 *    (never the model's guess), re-aligning new_string the same way.
 *    Only fires when that region is unique in the file; any ambiguity falls
 *    through to an error instead of a wrong write.
 *
 *  - describeClosestMatch: when nothing safely matches, locate the most
 *    similar region so the error can show the current content and the next
 *    old_string is copied from truth instead of guessed again.
 *
 *  - isEditLikelyAlreadyApplied: detect the "my previous edit already did
 *    this" case so the model is told to stop retrying instead of looping.
 *
 * Pure string functions, no I/O — keep it that way so tests stay leaf-level.
 */

export type FlexibleMatchType = 'trailing-whitespace' | 'indent' | 'blank-lines'

export type FlexibleMatch = {
  /** Exact text as it exists in the file — safe to String.replace with. */
  actualOldString: string
  /** new_string re-aligned with the file (e.g. same uniform indent shift). */
  actualNewString: string
  matchType: FlexibleMatchType
}

// Perf guards. Flexible matching runs only after an exact match already
// failed, so these just bound pathological inputs.
const MAX_FLEX_FILE_CHARS = 5_000_000
const MAX_FLEX_COMPARISONS = 10_000_000
const MAX_INDENT_CANDIDATES = 8

const MAX_CLOSEST_COMPARISONS = 2_000_000
const MAX_SCORED_LINE_CHARS = 300
const MIN_CLOSEST_SCORE = 0.4
const CLOSEST_CONTEXT_LINES = 3
const MAX_SNIPPET_LINES = 40

// Below this many non-whitespace characters, new_string appearing in the file
// is too weak a signal (a lone `}` matches everywhere) to claim the edit was
// already applied.
const MIN_ALREADY_APPLIED_CHARS = 5

/**
 * True when old_string is gone but the intended end-state text is already in
 * the file — the classic signature of re-issuing an edit that a previous edit
 * (or an equivalent manual fix) already performed.
 */
export function isEditLikelyAlreadyApplied(
  fileContent: string,
  newString: string,
): boolean {
  const trimmed = newString.trim()
  if (trimmed.length < MIN_ALREADY_APPLIED_CHARS) {
    return false
  }
  return fileContent.includes(newString) || fileContent.includes(trimmed)
}

// Stricter bar than isEditLikelyAlreadyApplied: rewriting the input to a
// no-op silently succeeds, so the evidence must be unambiguous, not merely
// suggestive.
const MIN_REWRITE_CHARS = 16

/**
 * Decide whether an edit whose old_string is missing should be normalized
 * into an idempotent no-op (old_string := new_string) because the file
 * already contains the intended end state. This is what turns "model re-runs
 * the edit its previous call already made" from a failed tool call into a
 * clean "no changes needed" success.
 *
 * Requires ALL of:
 *  - old_string absent and different from new_string;
 *  - new_string distinctive (multi-line, or ≥ MIN_REWRITE_CHARS trimmed) and
 *    present in the file EXACTLY once — a repeated or trivial fragment is not
 *    evidence the edit happened;
 *  - no whitespace-flexible match for old_string — if the region still
 *    exists modulo whitespace, the right outcome is a real (healed) edit,
 *    not a no-op.
 */
export function shouldTreatEditAsAlreadyApplied(
  fileContent: string,
  oldString: string,
  newString: string,
): boolean {
  if (oldString === newString || newString === '') {
    return false
  }
  const trimmed = newString.trim()
  if (trimmed === '') {
    return false
  }
  if (!newString.includes('\n') && trimmed.length < MIN_REWRITE_CHARS) {
    return false
  }
  if (fileContent.includes(oldString)) {
    return false
  }
  if (fileContent.split(newString).length - 1 !== 1) {
    return false
  }
  return resolveFlexibleMatch(fileContent, oldString, newString) === null
}

const RESULT_SNIPPET_MAX_LINES = 30
const RESULT_SNIPPET_MAX_CHARS = 2000

/**
 * Bound the post-edit snippet included in successful Edit results. Cuts on a
 * line boundary and says how much was omitted so the model knows the file
 * continues beyond what it sees.
 */
export function capEditResultSnippet(snippet: string): string {
  if (snippet.length <= RESULT_SNIPPET_MAX_CHARS) {
    const lines = snippet.split('\n')
    if (lines.length <= RESULT_SNIPPET_MAX_LINES) {
      return snippet
    }
    return `${lines.slice(0, RESULT_SNIPPET_MAX_LINES).join('\n')}\n... [${lines.length - RESULT_SNIPPET_MAX_LINES} more lines not shown]`
  }
  const cutoff = snippet.lastIndexOf('\n', RESULT_SNIPPET_MAX_CHARS)
  const kept =
    cutoff > 0
      ? snippet.slice(0, cutoff)
      : snippet.slice(0, RESULT_SNIPPET_MAX_CHARS)
  const keptLines = kept.split('\n').length
  const totalLines = snippet.split('\n').length
  return `${kept}\n... [${Math.max(totalLines - keptLines, 1)} more lines not shown]`
}

/**
 * Resolve old_string against the file when the exact (and quote-normalized)
 * match failed. Three whitespace-only relaxations, in order:
 *
 *  1. trailing-whitespace: every line matches after stripping trailing
 *     whitespace. new_string is used as-is.
 *  2. indent: every line matches after a single uniform leading-whitespace
 *     prefix is added to (or removed from) the model's lines. new_string gets
 *     the same shift so relative indentation is preserved.
 *  3. blank-lines: every non-empty line matches in order, with only empty
 *     lines added or missing between them (matchIgnoringBlankLines).
 *
 * All require the match to be UNIQUE in the file and line-aligned; anything
 * ambiguous or mid-line returns null so the caller errors instead of writing
 * the wrong place. The returned actualOldString is verbatim file content, so
 * the subsequent replace can never introduce hallucinated context.
 */
export function resolveFlexibleMatch(
  fileContent: string,
  oldString: string,
  newString: string,
): FlexibleMatch | null {
  if (oldString.trim() === '') {
    return null
  }
  if (fileContent.length > MAX_FLEX_FILE_CHARS) {
    return null
  }

  const hadTrailingNewline = oldString.endsWith('\n')
  const searchBody = hadTrailingNewline ? oldString.slice(0, -1) : oldString
  const searchLines = searchBody.split('\n')
  const fileLines = fileContent.split('\n')
  if (
    searchLines.length > fileLines.length ||
    searchLines.length * fileLines.length > MAX_FLEX_COMPARISONS
  ) {
    return null
  }

  const fileTrimEnd = fileLines.map(l => l.trimEnd())
  const searchTrimEnd = searchLines.map(l => l.trimEnd())

  const buildMatch = (
    start: number,
    matchType: FlexibleMatchType,
    adaptedNewString: string,
  ): FlexibleMatch | null => {
    const end = start + searchLines.length
    // old_string ended with \n — the file must actually have one after the
    // window, otherwise replacing would silently drop content boundaries.
    if (hadTrailingNewline && end >= fileLines.length) {
      return null
    }
    const actualOldString =
      fileLines.slice(start, end).join('\n') + (hadTrailingNewline ? '\n' : '')
    return { actualOldString, actualNewString: adaptedNewString, matchType }
  }

  // Stage 1: trailing-whitespace-insensitive, line-aligned.
  const wsStarts: number[] = []
  const maxStart = fileLines.length - searchLines.length
  outer: for (let s = 0; s <= maxStart; s++) {
    for (let i = 0; i < searchLines.length; i++) {
      if (fileTrimEnd[s + i] !== searchTrimEnd[i]) {
        continue outer
      }
    }
    wsStarts.push(s)
    if (wsStarts.length > 1) {
      break
    }
  }
  if (wsStarts.length > 1) {
    // Ambiguous — and any indent match would be at least as ambiguous.
    return null
  }
  if (wsStarts.length === 1) {
    return buildMatch(wsStarts[0]!, 'trailing-whitespace', newString)
  }

  // Stage 2: uniform indent shift. Prefilter windows by fully-trimmed line
  // equality (a uniform shift only changes leading whitespace), then verify
  // the shift is one consistent whitespace prefix across all non-blank lines.
  const fileTrimFull = fileTrimEnd.map(l => l.trimStart())
  const searchTrimFull = searchTrimEnd.map(l => l.trimStart())
  const candidates: number[] = []
  outer2: for (let s = 0; s <= maxStart; s++) {
    for (let i = 0; i < searchLines.length; i++) {
      if (fileTrimFull[s + i] !== searchTrimFull[i]) {
        continue outer2
      }
    }
    candidates.push(s)
    if (candidates.length > MAX_INDENT_CANDIDATES) {
      return null
    }
  }

  let match: { start: number; delta: IndentDelta } | null = null
  for (const s of candidates) {
    const delta = indentDeltaForWindow(fileTrimEnd, searchTrimEnd, s)
    if (!delta) {
      continue
    }
    if (match) {
      return null // two valid indent interpretations — ambiguous
    }
    match = { start: s, delta }
  }
  if (!match) {
    return matchIgnoringBlankLines(
      fileLines,
      fileTrimEnd,
      searchTrimEnd,
      hadTrailingNewline,
      newString,
    )
  }

  const adapted = shiftIndent(newString, match.delta)
  if (adapted === null) {
    // new_string can't be shifted cleanly (a line lacks the prefix being
    // removed) — refuse to guess rather than mangle indentation.
    return null
  }
  return buildMatch(match.start, 'indent', adapted)
}

/**
 * Stage 3, blank-line drift: every non-empty line of old_string appears in
 * the file in the same order and otherwise unchanged (trailing whitespace
 * aside), with only empty lines added or missing between them — what a
 * formatter, or a model re-typing a long block, introduces. old_string must
 * start and end on non-empty lines, so the region's extent is never a guess,
 * and exactly one region may match.
 */
function matchIgnoringBlankLines(
  fileLines: string[],
  fileTrimEnd: string[],
  searchTrimEnd: string[],
  hadTrailingNewline: boolean,
  newString: string,
): FlexibleMatch | null {
  const content: number[] = []
  searchTrimEnd.forEach((line, i) => {
    if (line.trim() !== '') content.push(i)
  })
  if (
    content.length < 2 ||
    content[0] !== 0 ||
    content[content.length - 1] !== searchTrimEnd.length - 1
  ) {
    return null
  }

  // File row of each old_string content line, for the one matching region.
  let found: number[] | null = null
  for (let s = 0; s < fileLines.length; s++) {
    if (fileTrimEnd[s] !== searchTrimEnd[0]) continue
    const rows = [s]
    let f = s
    for (let k = 1; k < content.length; k++) {
      f++
      while (f < fileLines.length && fileTrimEnd[f]!.trim() === '') f++
      if (f >= fileLines.length || fileTrimEnd[f] !== searchTrimEnd[content[k]!]) break
      rows.push(f)
    }
    if (rows.length !== content.length) continue
    if (found) return null // two regions — ambiguous
    found = rows
  }
  if (!found) return null
  const start = found[0]!
  const end = found[found.length - 1]!
  if (hadTrailingNewline && end + 1 >= fileLines.length) return null

  const actualNewString = keepFileBlankLines(searchTrimEnd, content, fileLines, found, newString)
  if (actualNewString === null) return null
  return {
    actualOldString:
      fileLines.slice(start, end + 1).join('\n') + (hadTrailingNewline ? '\n' : ''),
    actualNewString,
    matchType: 'blank-lines',
  }
}

// Bound on aligning old_string with new_string (content lines of each).
const MAX_ALIGN_CELLS = 1_000_000

/**
 * new_string with the file's own blank lines put back in every gap that
 * new_string leaves untouched: both lines around it kept unchanged and
 * separated only by old_string's blank lines. Gaps the model rewrote follow
 * new_string. Null when the strings are too large to align.
 */
function keepFileBlankLines(
  searchTrimEnd: string[],
  content: number[],
  fileLines: string[],
  found: number[],
  newString: string,
): string | null {
  const hadTrailingNewline = newString.endsWith('\n')
  const newLines = (hadTrailingNewline ? newString.slice(0, -1) : newString).split('\n')
  const newContent: number[] = []
  newLines.forEach((line, i) => {
    if (line.trim() !== '') newContent.push(i)
  })
  const a = content.map(i => searchTrimEnd[i]!)
  const b = newContent.map(i => newLines[i]!.trimEnd())
  if (a.length * b.length > MAX_ALIGN_CELLS) return null

  // Longest common subsequence of content lines: which old lines new_string
  // kept, and where.
  const width = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const kept = new Array<number | undefined>(a.length)
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      kept[i] = newContent[j]
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      i++
    } else {
      j++
    }
  }

  const gaps: Array<{ upper: number; lower: number; blank: string[] }> = []
  for (let k = 0; k + 1 < content.length; k++) {
    const oldGap = content[k + 1]! - content[k]! - 1
    const fileGap = found[k + 1]! - found[k]! - 1
    const upper = kept[k]
    const lower = kept[k + 1]
    if (oldGap === fileGap || upper === undefined || lower === undefined) continue
    if (lower - upper - 1 !== oldGap) continue
    if (newLines.slice(upper + 1, lower).some(line => line.trim() !== '')) continue
    gaps.push({ upper, lower, blank: fileLines.slice(found[k]! + 1, found[k + 1]!) })
  }
  if (gaps.length === 0) return newString

  const out: string[] = []
  let i = 0
  for (const gap of gaps) {
    while (i <= gap.upper) out.push(newLines[i++]!)
    out.push(...gap.blank)
    i = gap.lower
  }
  while (i < newLines.length) out.push(newLines[i++]!)
  return out.join('\n') + (hadTrailingNewline ? '\n' : '')
}

type IndentDelta = { prefix: string; direction: 'add' | 'remove' }

/**
 * Whitespace prefix uniformly distinguishing the file window from the search
 * lines: `add` means the file has `prefix` MORE leading whitespace than the
 * search on every non-blank line. Blank lines must be blank on both sides.
 * Returns null when there is no single consistent non-empty prefix.
 */
function indentDeltaForWindow(
  fileTrimEnd: string[],
  searchTrimEnd: string[],
  start: number,
): IndentDelta | null {
  let delta: IndentDelta | null = null
  for (let i = 0; i < searchTrimEnd.length; i++) {
    const f = fileTrimEnd[start + i]!
    const s = searchTrimEnd[i]!
    const fBlank = f === ''
    const sBlank = s === ''
    if (fBlank || sBlank) {
      if (fBlank !== sBlank) {
        return null
      }
      continue
    }
    let candidate: IndentDelta
    if (f === s) {
      candidate = { prefix: '', direction: 'add' }
    } else if (f.endsWith(s)) {
      const prefix = f.slice(0, f.length - s.length)
      if (prefix.trim() !== '') {
        return null
      }
      candidate = { prefix, direction: 'add' }
    } else if (s.endsWith(f)) {
      const prefix = s.slice(0, s.length - f.length)
      if (prefix.trim() !== '') {
        return null
      }
      candidate = { prefix, direction: 'remove' }
    } else {
      return null
    }
    if (delta === null) {
      delta = candidate
    } else if (
      delta.prefix !== candidate.prefix ||
      (delta.prefix !== '' && delta.direction !== candidate.direction)
    ) {
      return null
    }
  }
  if (!delta || delta.prefix === '') {
    // All-blank window, or no shift at all (that's stage 1's case).
    return null
  }
  return delta
}

/** Apply the window's indent delta to every non-blank line of new_string. */
function shiftIndent(newString: string, delta: IndentDelta): string | null {
  const hadTrailingNewline = newString.endsWith('\n')
  const body = hadTrailingNewline ? newString.slice(0, -1) : newString
  const out: string[] = []
  for (const line of body.split('\n')) {
    if (line.trim() === '') {
      out.push(line)
      continue
    }
    if (delta.direction === 'add') {
      out.push(delta.prefix + line)
    } else if (line.startsWith(delta.prefix)) {
      out.push(line.slice(delta.prefix.length))
    } else {
      return null
    }
  }
  return out.join('\n') + (hadTrailingNewline ? '\n' : '')
}

export type ClosestMatch = {
  /** Raw file lines of the best window plus context (no line numbering). */
  lines: string[]
  /** 1-based line number of the first element of `lines`. */
  startLine: number
  /** Mean per-line bigram similarity of the best window, 0..1. */
  score: number
}

/**
 * Locate the file region most similar to the failed old_string so the error
 * message can show what is actually there now. Line-window scan scored by
 * character-bigram Dice similarity on fully-trimmed lines (indent- and
 * trailing-ws-insensitive — those differences are exactly what we expect
 * after drift). Returns null when nothing clears MIN_CLOSEST_SCORE or the
 * scan would be too large; the caller then falls back to a plain read hint.
 */
export function describeClosestMatch(
  fileContent: string,
  searchString: string,
): ClosestMatch | null {
  const fileLines = fileContent.split('\n')
  const searchLines = oldStringLines(searchString)
  const best = findBestWindow(fileLines, searchLines)
  if (!best) {
    return null
  }

  const from = Math.max(0, best.start - CLOSEST_CONTEXT_LINES)
  const to = Math.min(
    fileLines.length,
    best.start + searchLines.length + CLOSEST_CONTEXT_LINES,
  )
  let lines = fileLines.slice(from, to)
  if (lines.length > MAX_SNIPPET_LINES) {
    lines = lines.slice(0, MAX_SNIPPET_LINES)
  }
  return { lines, startLine: from + 1, score: best.score }
}

/** old_string as lines, without the one trailing newline a block ends with. */
function oldStringLines(oldString: string): string[] {
  return (oldString.endsWith('\n') ? oldString.slice(0, -1) : oldString).split(
    '\n',
  )
}

/**
 * The line window most similar to `searchLines`: 0-based start and mean
 * per-line similarity. Null when nothing clears MIN_CLOSEST_SCORE or the scan
 * would be too large.
 */
function findBestWindow(
  fileLines: string[],
  rawSearchLines: string[],
): { start: number; score: number } | null {
  const searchLines = rawSearchLines.map(l => l.trim())
  if (
    searchLines.length === 0 ||
    searchLines.length > fileLines.length ||
    searchLines.length * fileLines.length > MAX_CLOSEST_COMPARISONS
  ) {
    return null
  }

  const trimmedFile = fileLines.map(l => l.trim())
  const searchGrams = searchLines.map(bigrams)
  const fileGrams: Array<Map<string, number> | null> = new Array(
    fileLines.length,
  ).fill(null)

  const windowLines = searchLines.length
  let bestScore = -1
  let bestStart = 0
  for (let s = 0; s + windowLines <= fileLines.length; s++) {
    let sum = 0
    for (let i = 0; i < windowLines; i++) {
      const fileLine = trimmedFile[s + i]!
      const grams = (fileGrams[s + i] ??= bigrams(fileLine))
      sum += diceSimilarity(searchLines[i]!, searchGrams[i]!, fileLine, grams)
    }
    const score = sum / windowLines
    if (score > bestScore) {
      bestScore = score
      bestStart = s
    }
  }
  return bestScore < MIN_CLOSEST_SCORE
    ? null
    : { start: bestStart, score: bestScore }
}

export type OldStringMismatch = ClosestMatch & {
  /** 1-based line where the most similar region starts. */
  regionStart: number
  /** Leading old_string lines found unchanged there. */
  matchedLines: number
  /** First line where old_string and that region part, when they do. */
  difference?: {
    /** 1-based file line. */
    line: number
    /** That file line, or undefined when the file ends first. */
    file: string | undefined
    oldString: string
    whitespaceOnly: boolean
  }
}

// When old_string parts from the file past the first ~30 shown lines, the
// snippet starts this many lines above that line instead of at the region.
const DIFFERENCE_CONTEXT_BEFORE = 5
const DIFFERENCE_CONTEXT_AFTER = 10
// Exact lines locate a region only when they carry this much text: a lone
// `}` or a blank line matches almost anywhere.
const MIN_ANCHOR_CHARS = 16

/**
 * Where a failed old_string stops matching the file, with the file lines to
 * show centered on that line. A long old_string usually fails on one
 * remembered line far below the region's top, which a snippet of the region's
 * first lines never reaches. The region is the one sharing the most exact
 * text with old_string, else the most similar one (near-identical rows such
 * as `row 4` and `row 64` would fool similarity alone). Null when no region is
 * similar enough.
 */
export function describeOldStringMismatch(
  fileContent: string,
  oldString: string,
): OldStringMismatch | null {
  const fileLines = fileContent.split('\n')
  const searchLines = oldStringLines(oldString)
  const last = searchLines.length - 1
  // old_string may start and end mid-line, so its first line only has to end
  // its file line, its last line only has to start one.
  const lineMatches = (start: number, i: number): boolean => {
    const fileLine = fileLines[start + i]
    const line = searchLines[i]!
    if (fileLine === undefined) return false
    if (last === 0) return fileLine.includes(line)
    if (i === 0) return fileLine.endsWith(line)
    if (i === last) return fileLine.startsWith(line)
    return fileLine === line
  }
  const best =
    findAnchoredWindow(fileLines, searchLines, lineMatches) ??
    findBestWindow(fileLines, searchLines)
  if (!best) {
    return null
  }

  let matched = 0
  while (matched <= last && lineMatches(best.start, matched)) {
    matched++
  }

  const regionFrom = Math.max(0, best.start - CLOSEST_CONTEXT_LINES)
  const regionTo = Math.min(
    fileLines.length,
    best.start + searchLines.length + CLOSEST_CONTEXT_LINES,
  )
  const differs = matched <= last
  const diffIndex = best.start + matched
  const from =
    differs &&
    diffIndex - regionFrom >= MAX_SNIPPET_LINES - DIFFERENCE_CONTEXT_AFTER
      ? Math.max(0, diffIndex - DIFFERENCE_CONTEXT_BEFORE)
      : regionFrom
  const to = Math.min(regionTo, from + MAX_SNIPPET_LINES)
  const fileLine = fileLines[diffIndex]
  const oldLine = searchLines[matched]
  return {
    lines: fileLines.slice(from, to),
    startLine: from + 1,
    score: best.score,
    regionStart: best.start + 1,
    matchedLines: matched,
    ...(differs && {
      difference: {
        line: diffIndex + 1,
        file: fileLine,
        oldString: oldLine!,
        whitespaceOnly:
          fileLine !== undefined &&
          fileLine.replace(/\s+/g, '') === oldLine!.replace(/\s+/g, ''),
      },
    }),
  }
}

/**
 * The window where old_string sits in the file, by exact lines (lineMatches),
 * or null when no window reaches MIN_ANCHOR_CHARS. A window whose first lines
 * match (a leading run of at least MIN_ANCHOR_CHARS) wins, longest run first:
 * that is where old_string begins, and a line it gained or lost only shifts
 * what follows, which would otherwise make a shifted window look better.
 * Without such a run, the window matching the most text wins. Score is the
 * share of old_string lines matched.
 */
function findAnchoredWindow(
  fileLines: string[],
  searchLines: string[],
  lineMatches: (start: number, i: number) => boolean,
): { start: number; score: number } | null {
  const k = searchLines.length
  if (k > fileLines.length || k * fileLines.length > MAX_CLOSEST_COMPARISONS) {
    return null
  }
  const weight = searchLines.map(line => line.trim().length)
  let best: { start: number; lead: number; chars: number; exact: number } | null = null
  for (let s = 0; s + k <= fileLines.length; s++) {
    let chars = 0
    let exact = 0
    let lead = 0
    let leading = true
    for (let i = 0; i < k; i++) {
      if (lineMatches(s, i)) {
        chars += weight[i]!
        exact++
        if (leading) lead += weight[i]!
      } else {
        leading = false
      }
    }
    if (chars < MIN_ANCHOR_CHARS) continue
    const anchored = lead >= MIN_ANCHOR_CHARS ? lead : 0
    const bestAnchored = best && best.lead >= MIN_ANCHOR_CHARS ? best.lead : 0
    if (
      !best ||
      anchored > bestAnchored ||
      (anchored === bestAnchored && chars > best.chars)
    ) {
      best = { start: s, lead, chars, exact }
    }
  }
  return best ? { start: best.start, score: best.exact / k } : null
}

/**
 * How an edit moved the lines below it: the first old line after the last
 * change, and how far it and every later line moved. Null when the line
 * count did not change. Hunk lines carry diff prefixes (' ', '-', '+').
 */
export function lineShiftAfterEdit(
  hunks: ReadonlyArray<{ oldStart: number; lines: readonly string[] }>,
): { firstOldLine: number; delta: number } | null {
  let delta = 0
  let lastChangedOld = 0
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart
    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        delta--
        lastChangedOld = oldLine
        oldLine++
      } else if (line.startsWith('+')) {
        delta++
        lastChangedOld = oldLine - 1
      } else if (line.startsWith(' ')) {
        oldLine++
      }
    }
  }
  return delta === 0
    ? null
    : { firstOldLine: Math.max(1, lastChangedOld + 1), delta }
}

const OLD_STRING_ECHO_CHARS = 300
const OLD_STRING_ECHO_LINE_CHARS = 120

/**
 * old_string as an Edit error quotes it back: whole when short, else its first
 * and last lines. The model's own call already holds the full text, so echoing
 * a long old_string only costs tokens.
 */
export function previewOldString(oldString: string): string {
  if (oldString.length <= OLD_STRING_ECHO_CHARS) {
    return oldString
  }
  const clip = (line: string) =>
    line.length > OLD_STRING_ECHO_LINE_CHARS
      ? `${line.slice(0, OLD_STRING_ECHO_LINE_CHARS)}…`
      : line
  const lines = oldStringLines(oldString)
  if (lines.length < 3) {
    return `${clip(oldString)} (${oldString.length} characters)`
  }
  return `${clip(lines[0]!)}\n… ${lines.length - 2} more lines …\n${clip(lines[lines.length - 1]!)}`
}

/**
 * 1-based lines where the first `max` non-overlapping occurrences of `needle`
 * start, counted the way String.split counts matches.
 */
export function occurrenceLines(
  fileContent: string,
  needle: string,
  max: number,
): number[] {
  const lines: number[] = []
  if (needle === '') {
    return lines
  }
  let line = 1
  let counted = 0
  for (
    let at = fileContent.indexOf(needle);
    at !== -1 && lines.length < max;
    at = fileContent.indexOf(needle, at + needle.length)
  ) {
    for (
      let nl = fileContent.indexOf('\n', counted);
      nl !== -1 && nl < at;
      nl = fileContent.indexOf('\n', nl + 1)
    ) {
      line++
    }
    counted = at
    lines.push(line)
  }
  return lines
}

function bigrams(s: string): Map<string, number> {
  const t =
    s.length > MAX_SCORED_LINE_CHARS ? s.slice(0, MAX_SCORED_LINE_CHARS) : s
  const m = new Map<string, number>()
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

function diceSimilarity(
  a: string,
  aGrams: Map<string, number>,
  b: string,
  bGrams: Map<string, number>,
): number {
  if (a === b) {
    return 1 // includes two blank lines
  }
  if (a.length < 2 || b.length < 2) {
    return 0
  }
  let aTotal = 0
  for (const n of aGrams.values()) {
    aTotal += n
  }
  let bTotal = 0
  for (const n of bGrams.values()) {
    bTotal += n
  }
  if (aTotal === 0 || bTotal === 0) {
    return 0
  }
  let overlap = 0
  const [small, large] = aGrams.size <= bGrams.size ? [aGrams, bGrams] : [bGrams, aGrams]
  for (const [g, n] of small) {
    const other = large.get(g)
    if (other !== undefined) {
      overlap += Math.min(n, other)
    }
  }
  return (2 * overlap) / (aTotal + bTotal)
}
