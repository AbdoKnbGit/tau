/**
 * Terminal drawing for ```mermaid fences in assistant replies.
 *
 * On by default; the `mermaidDiagrams` setting ("Draw diagrams" in /config)
 * switches it off. While it is on, a finished top-level mermaid block in an
 * assistant reply is drawn as box-drawing art by grok-mermaid, and
 * mermaidDiagramsReminder.ts tells the model the terminal can do this. A block
 * that cannot be drawn is replaced by a one-line reason; the transcript view
 * (ctrl+o) and /export keep its source.
 *
 * Drawing runs synchronously inside a React render, and a render-path
 * exception exits tau, so nothing here throws and the input is capped.
 */
import { diagramKind, render, type Span } from 'grok-mermaid'
import { stringWidth } from '../ink/stringWidth.js'

// grok-mermaid lays out sequence-diagram text in quadratic time: one
// 50,000-character note took 8.4 s, while the slowest sequence diagram within
// 4,000 characters took about 25 ms. The other kinds are bounded by
// grok-mermaid's own node, edge and canvas caps; a 30,000-character flowchart
// at those caps took 22 ms. Drawings are cached below either way.
export const MAX_SEQUENCE_SOURCE_CHARS = 4000
export const MAX_MERMAID_SOURCE_CHARS = 16000
export const MAX_MERMAID_LINE_CHARS = 400

// Columns kept free beside a diagram: the reply's dot prefix plus a margin for
// resize races. MarkdownTable keeps the same margin for the same reasons.
export const MERMAID_WIDTH_MARGIN = 4

const CACHE_LIMIT = 64

// Code point ranges whose display width grok-mermaid and tau's stringWidth
// agree on, checked for every assigned code point in them; all of
// grok-mermaid's own glyphs are inside. Emoji, combining marks, tabs and bidi
// controls are not, and could shift a border by a column, so they are taken
// out of the source before it is drawn.
const WIDTH_SAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e], // ASCII
  [0xa0, 0xac], // Latin-1, without the soft hyphen at 0xad
  [0xae, 0x24f], // rest of Latin-1, Latin Extended-A and -B
  [0x370, 0x3ff], // Greek
  [0x400, 0x482], // Cyrillic, without the combining marks at 0x483-0x489
  [0x48a, 0x4ff],
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2010, 0x2027], // punctuation, without separators and bidi controls
  [0x2030, 0x205e],
  [0x20a0, 0x20c0], // currency
  [0x2190, 0x22ff], // arrows, math operators
  [0x2500, 0x25ff], // box drawing, blocks, geometric shapes
  [0x3000, 0x3029], // CJK punctuation, without the tone marks at 0x302a-0x302f
  [0x3030, 0x3098], // and kana, without the sound marks at 0x3099-0x309a
  [0x309b, 0x30ff],
  [0x3400, 0x4dbf], // CJK ideographs
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff01, 0xff9d], // fullwidth forms, halfwidth katakana
]

export type MermaidArt = {
  /** One entry per terminal row; each span carries grok-mermaid's class. */
  readonly rows: readonly (readonly Span[])[]
  /** Widest row, in terminal columns as tau measures them. */
  readonly width: number
  /** Statements grok-mermaid could not read, left out of the drawing. */
  readonly omitted: number
}

/** Why a block is not drawn. */
export type MermaidFallback =
  | { kind: 'too-large' }
  | { kind: 'unsupported'; name: string | null }
  | { kind: 'unreadable' }
  | { kind: 'characters' }
  | { kind: 'too-wide'; columnsNeeded: number; columns: number }

export type MermaidDrawing =
  | { art: MermaidArt }
  | { art: null; fallback: MermaidFallback }

const cache = new Map<string, MermaidDrawing>()

/** Whether a fence's info string names mermaid (`mermaid`, `Mermaid title=x`). */
export function isMermaidFence(lang: string | undefined): boolean {
  return lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === 'mermaid'
}

/** The drawing of `source` as written, or null when it cannot be drawn. */
export function getMermaidArt(source: string): MermaidArt | null {
  return drawCached(source).art
}

/** Whether `art` fits a terminal `columns` wide with the margin kept free. */
export function mermaidArtFits(art: MermaidArt, columns: number): boolean {
  return art.width <= columns - MERMAID_WIDTH_MARGIN
}

/**
 * What to show in a terminal `columns` wide: the drawing as written or, when
 * only that fits, the flowchart turned the other way (left-to-right and
 * top-down swap). Otherwise the reason it is not drawn.
 */
export function fitMermaidArt(source: string, columns: number): MermaidDrawing {
  const drawn = drawCached(source)
  if (drawn.art === null || mermaidArtFits(drawn.art, columns)) return drawn
  const turnedSource = turnFlowchart(source)
  const turned = turnedSource === null ? null : drawCached(turnedSource)
  if (turned?.art && mermaidArtFits(turned.art, columns)) return turned
  const narrowest = Math.min(drawn.art.width, turned?.art?.width ?? Infinity)
  return {
    art: null,
    fallback: {
      kind: 'too-wide',
      columnsNeeded: narrowest + MERMAID_WIDTH_MARGIN,
      columns,
    },
  }
}

/** The dim line shown in place of a block that is not drawn. */
export function describeMermaidFallback(fallback: MermaidFallback): string {
  switch (fallback.kind) {
    case 'too-wide':
      return `mermaid · not drawn: it needs ${fallback.columnsNeeded} columns and the terminal has ${fallback.columns}`
    case 'too-large':
      return 'mermaid · not drawn: too large for the terminal'
    case 'unsupported':
      return fallback.name === null
        ? "mermaid · not drawn: this kind of diagram can't be drawn in the terminal"
        : `mermaid · not drawn: ${fallback.name} diagrams can't be drawn in the terminal`
    case 'unreadable':
      return 'mermaid · not drawn: the diagram has a syntax error'
    case 'characters':
      return "mermaid · not drawn: its labels use characters the terminal can't line up"
  }
}

/** The dim line under a drawing that left statements out. */
export function describeMermaidOmissions(omitted: number): string {
  return omitted === 1
    ? 'mermaid · 1 statement could not be read and is not drawn'
    : `mermaid · ${omitted} statements could not be read and are not drawn`
}

/**
 * The source as it is drawn: front matter dropped, then every character whose
 * width is uncertain (emoji, combining marks left after NFC composition,
 * controls) removed together with one space after it, so a label written as
 * an emoji and a word is drawn as the word. Tabs become spaces.
 */
export function prepareMermaidSource(source: string): string {
  let out = ''
  let dropSpace = false
  for (const ch of stripFrontMatter(source).normalize('NFC')) {
    const code = ch.codePointAt(0)!
    if (code === 0x0a) {
      out += ch
    } else if (code === 0x20 || code === 0x09) {
      if (!dropSpace) out += ' '
    } else if (isWidthSafeCode(code)) {
      out += ch
    } else {
      dropSpace = true
      continue
    }
    dropSpace = false
  }
  return out
}

// Mermaid's diagram type keywords, and the comment or front matter a block may
// start with: what must follow a glued "```mermaid" for it to open a block.
const MERMAID_FIRST_LINE =
  /^\s*(?:%%|---|(?:flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|sankey|xychart|block|packet|architecture|kanban|radar|C4\w*)(?:-v2|-beta)?\b)/i
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/
const GLUED_OPENER = /^(?!\s*>)(.*[^\s`])[ \t]*(`{3,}[ \t]*mermaid)[ \t]*$/i

type OpenFence = { char: string; length: number; mermaid: boolean }

/**
 * Repairs the fence mistakes models make around mermaid blocks, so the block
 * is drawn instead of shown as text:
 * - "...as follows:```mermaid" followed by a diagram line: the opening fence
 *   glued to a sentence moves to its own line;
 * - "```mermaid" (or another language) inside an open mermaid block closes it
 *   before opening the next one;
 * - "A --> B```": a closing fence glued to the last diagram line is split off;
 * - "```Then ...": a closing fence glued to the next sentence closes the block
 *   before the sentence.
 * Only complete lines change, blocks of other languages are left alone, and
 * applying it twice changes nothing more.
 */
export function normalizeMermaidFences(markdown: string): string {
  if (!/mermaid/i.test(markdown)) return markdown
  const lines = markdown.split('\n')
  // Text after the last newline may still be streaming in.
  const complete = lines.length - 1
  const out: string[] = []
  let fence: OpenFence | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence === null) {
      const opener = FENCE_OPENER.exec(line)
      if (opener && !(opener[1]![0] === '`' && opener[2]!.includes('`'))) {
        fence = {
          char: opener[1]![0]!,
          length: opener[1]!.length,
          mermaid: isMermaidFence(opener[2]),
        }
        out.push(line)
        continue
      }
      const glued =
        i + 1 < complete && MERMAID_FIRST_LINE.test(lines[i + 1]!)
          ? GLUED_OPENER.exec(line)
          : null
      if (glued) {
        out.push(glued[1]!, '', glued[2]!)
        fence = { char: '`', length: /^`+/.exec(glued[2]!)![0].length, mermaid: true }
        continue
      }
      out.push(line)
      continue
    }
    const closer =
      fence.char === '`'
        ? /^ {0,3}(`{3,})[ \t]*$/.exec(line)
        : /^ {0,3}(~{3,})[ \t]*$/.exec(line)
    if (closer && closer[1]!.length >= fence.length) {
      fence = null
      out.push(line)
      continue
    }
    if (fence.mermaid && fence.char === '`' && i < complete) {
      const gluedCloser = /^(.*[^\s`])[ \t]*(`{3,})[ \t]*$/.exec(line)
      if (gluedCloser && gluedCloser[2]!.length >= fence.length) {
        out.push(gluedCloser[1]!, gluedCloser[2]!)
        fence = null
        continue
      }
      const closerThenText = /^ {0,3}(`{3,})[ \t]*([^`\s].*)$/.exec(line)
      if (closerThenText && closerThenText[1]!.length >= fence.length) {
        const rest = closerThenText[2]!.trim()
        if (/^[\w+#.-]+$/.test(rest)) {
          // A language name: the next block was opened without closing this one.
          out.push('`'.repeat(fence.length), line)
          fence = {
            char: '`',
            length: closerThenText[1]!.length,
            mermaid: isMermaidFence(rest),
          }
        } else {
          out.push(closerThenText[1]!, '', closerThenText[2]!)
          fence = null
        }
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

// Turning LR/RL into TD, and TD/TB/BT (or no direction) into LR, keeps every
// node and edge and only changes which way the layout runs.
function turnFlowchart(source: string): string | null {
  const lines = source.split('\n')
  const header = lines.findIndex(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('%%')
  })
  if (header < 0) return null
  const match = /^(\s*(?:flowchart|graph))(?:\s+(TB|TD|BT|RL|LR))?(\s*;?\s*)$/.exec(
    lines[header]!,
  )
  if (!match) return null
  const [, head, direction = 'TD', tail] = match
  const turned = direction === 'LR' || direction === 'RL' ? 'TD' : 'LR'
  lines[header] = `${head} ${turned}${tail}`
  return lines.join('\n')
}

// Mermaid front matter: "---", title or config lines, "---", before the header.
function stripFrontMatter(source: string): string {
  const match = /^\s*---[ \t]*\r?\n[\s\S]*?\n[ \t]*---[ \t]*(?:\r?\n|$)/.exec(source)
  return match ? source.slice(match[0].length) : source
}

function withinCaps(source: string): boolean {
  if (source.length > MAX_MERMAID_SOURCE_CHARS) return false
  let start = 0
  while (start <= source.length) {
    let end = source.indexOf('\n', start)
    if (end === -1) end = source.length
    if (end - start > MAX_MERMAID_LINE_CHARS) return false
    start = end + 1
  }
  return true
}

function isWidthSafeCode(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true
  return WIDTH_SAFE_RANGES.some(([low, high]) => code >= low && code <= high)
}

function isWidthSafe(text: string): boolean {
  for (const ch of text) {
    if (!isWidthSafeCode(ch.codePointAt(0)!)) return false
  }
  return true
}

// grok-mermaid's warnings quote what they dropped. A stray ";" or "]" left over
// from a broken label loses nothing worth reporting.
function countOmissions(warnings: readonly string[]): number {
  let omitted = 0
  for (const warning of warnings) {
    const dropped = /: "([\s\S]*)"$/.exec(warning)?.[1]
    if (dropped === undefined || /[\p{L}\p{N}]/u.test(dropped)) omitted++
  }
  return omitted
}

// The type named on a diagram's first line ("pie", "gantt"), for the reason
// shown when grok-mermaid does not draw that type.
function diagramName(source: string): string | null {
  for (const line of source.split('\n', 64)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('%%')) continue
    return /^[A-Za-z][A-Za-z0-9-]{0,30}/.exec(trimmed)?.[0].toLowerCase() ?? null
  }
  return null
}

function drawCached(source: string): MermaidDrawing {
  if (!withinCaps(source)) return { art: null, fallback: { kind: 'too-large' } }
  const hit = cache.get(source)
  if (hit !== undefined) {
    cache.delete(source)
    cache.set(source, hit)
    return hit
  }
  const drawing = draw(source)
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(source, drawing)
  return drawing
}

function draw(source: string): MermaidDrawing {
  try {
    const prepared = prepareMermaidSource(source)
    const kind = diagramKind(prepared)
    if (kind === 'sequence' && source.length > MAX_SEQUENCE_SOURCE_CHARS) {
      return { art: null, fallback: { kind: 'too-large' } }
    }
    const drawn = render(prepared)
    if (drawn === null) {
      return {
        art: null,
        fallback:
          kind === null
            ? { kind: 'unsupported', name: diagramName(prepared) }
            : { kind: 'unreadable' },
      }
    }
    let width = 0
    for (const row of drawn.styled) {
      const text = row.map(span => span.text).join('')
      // The source was cleaned above, so this only catches a glyph of
      // grok-mermaid's own that tau measures differently.
      if (!isWidthSafe(text)) return { art: null, fallback: { kind: 'characters' } }
      width = Math.max(width, stringWidth(text))
    }
    return {
      art: { rows: drawn.styled, width, omitted: countOmissions(drawn.warnings) },
    }
  } catch {
    return { art: null, fallback: { kind: 'unreadable' } }
  }
}
