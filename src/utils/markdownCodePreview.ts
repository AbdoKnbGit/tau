import { stringWidth } from '../ink/stringWidth.js'

export const CODE_FOLD_LINES = 20
export const CODE_EXPAND_AT = 30
export const CODE_MAX_RENDER_LINES = 400
export const CODE_MAX_RENDER_CHARS = 60_000

/** Display bounds never alter the source used by copy or export. */
export function markdownCodePreview(source: string, expanded: boolean, width = Infinity): {
  text: string; totalLines: number; hidden: boolean; foldable: boolean
} {
  let totalLines = source ? 1 : 0
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) totalLines++
  const foldable = totalLines > CODE_EXPAND_AT || source.length > CODE_MAX_RENDER_CHARS
  const limit = !expanded && foldable ? CODE_FOLD_LINES : CODE_MAX_RENDER_LINES
  let end = 0
  for (let line = 0; line < limit; line++) {
    const next = source.indexOf('\n', end)
    if (next === -1) { end = source.length; break }
    end = next + 1
  }
  end = Math.min(end, CODE_MAX_RENDER_CHARS)
  if (Number.isFinite(width)) {
    const room = Math.max(1, Math.floor(width) - String(totalLines).length - 4)
    let rows = 1
    let column = 0
    let position = 0
    while (position < end) {
      const point = String.fromCodePoint(source.codePointAt(position)!)
      if (point === '\n') {
        rows++
        column = 0
      } else {
        const cells = point === '\t' ? 8 : stringWidth(point)
        if (column + cells > room && column > 0) { rows++; column = 0 }
        rows += Math.max(0, Math.ceil(cells / room) - 1)
        column += cells > room ? cells % room || room : cells
      }
      if (rows > CODE_MAX_RENDER_LINES) break
      position += point.length
    }
    end = position
  }
  if (end > 0 && /[\uD800-\uDBFF]/.test(source[end - 1]!) && /[\uDC00-\uDFFF]/.test(source[end] ?? '')) end--
  return { text: source.slice(0, end).replace(/\n$/, ''), totalLines, hidden: end < source.length, foldable }
}
