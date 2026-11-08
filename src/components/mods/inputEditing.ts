// What one key does to a mod's Input field: the field's text and cursor
// (counted in code points), a submit, or a move to the control before or
// after. Pure, so the pane's key handler stays small.

export type InputKey = { key: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
export type InputEdit =
  | { kind: 'edit'; text: string; cursor: number }
  | { kind: 'cursor'; cursor: number }
  | { kind: 'submit' }
  | { kind: 'leave'; step: 1 | -1 }

// Names the terminal gives keys that type nothing.
const KEY_NAMES = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'escape', 'tab', 'backspace',
  'delete', 'pageup', 'pagedown', 'home', 'end', 'insert', 'clear', 'wheelup',
  'wheeldown', 'mouse', 'focusin', 'focusout',
])

const isTypedCodePoint = (code: number) => code === 10 || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))

/** Keeps only what a person can type: newlines and printable code points. */
export function typeable(text: string, multiline: boolean): string {
  const unified = text.replace(/\r\n?/g, '\n')
  const lines = multiline ? unified : unified.replace(/\n+/g, ' ')
  return Array.from(lines).filter(char => isTypedCodePoint(char.codePointAt(0)!)).join('')
}

function lineBounds(chars: string[], at: number): { start: number; end: number } {
  let start = at, end = at
  while (start > 0 && chars[start - 1] !== '\n') start--
  while (end < chars.length && chars[end] !== '\n') end++
  return { start, end }
}

/** The cursor one row up or down at the same column, or undefined at the edge. */
function verticalMove(chars: string[], at: number, step: 1 | -1): number | undefined {
  const { start, end } = lineBounds(chars, at)
  const column = at - start
  if (step < 0) {
    if (start === 0) return undefined
    const above = lineBounds(chars, start - 1)
    return Math.min(above.start + column, above.end)
  }
  if (end >= chars.length) return undefined
  const below = lineBounds(chars, end + 1)
  return Math.min(below.start + column, below.end)
}

export function editInput(text: string, cursor: number, key: InputKey, rows: number): InputEdit | undefined {
  const chars = Array.from(text)
  const at = Math.max(0, Math.min(cursor, chars.length))
  const multiline = rows > 1
  const replace = (from: number, to: number, value: string): InputEdit => {
    const added = Array.from(value)
    return { kind: 'edit', text: [...chars.slice(0, from), ...added, ...chars.slice(to)].join(''), cursor: from + added.length }
  }
  const name = key.key
  if (name === 'return' || name === 'enter') {
    // A newline is typed as in the prompt box; a bare Enter submits.
    if (multiline && (key.shift || key.meta)) return replace(at, at, '\n')
    return { kind: 'submit' }
  }
  if (name === 'backspace') return at > 0 ? replace(at - 1, at, '') : { kind: 'cursor', cursor: at }
  if (name === 'delete') return at < chars.length ? replace(at, at + 1, '') : { kind: 'cursor', cursor: at }
  if (name === 'left') return { kind: 'cursor', cursor: Math.max(0, at - 1) }
  if (name === 'right') return { kind: 'cursor', cursor: Math.min(chars.length, at + 1) }
  const line = lineBounds(chars, at)
  if (name === 'home' || (key.ctrl && name === 'a')) return { kind: 'cursor', cursor: line.start }
  if (name === 'end' || (key.ctrl && name === 'e')) return { kind: 'cursor', cursor: line.end }
  if (key.ctrl && name === 'u') return replace(line.start, at, '')
  if (key.ctrl && name === 'k') return replace(at, line.end, '')
  if (key.ctrl && name === 'w') {
    // The word before the cursor, and the spaces after it.
    let from = at
    while (from > line.start && /\s/.test(chars[from - 1]!)) from--
    while (from > line.start && !/\s/.test(chars[from - 1]!)) from--
    return replace(from, at, '')
  }
  if (name === 'up' || name === 'down') {
    const step = name === 'up' ? -1 : 1
    if (multiline) {
      const moved = verticalMove(chars, at, step)
      if (moved !== undefined) return { kind: 'cursor', cursor: moved }
    }
    return { kind: 'leave', step }
  }
  if (key.ctrl || key.meta) return undefined
  // A typed code point, or a paste: text that is no key's name.
  const points = Array.from(name)
  if (points.length === 1) return isTypedCodePoint(points[0]!.codePointAt(0)!) && name !== '\n' ? replace(at, at, name) : undefined
  if (KEY_NAMES.has(name) || /^f\d{1,2}$/.test(name)) return undefined
  const pasted = typeable(name, multiline)
  return pasted ? replace(at, at, pasted) : undefined
}

/** The rows of a multi-row field shown around the cursor, `rows` tall. */
export function inputWindow(text: string, cursor: number, rows: number): { lines: string[]; first: number; cursorLine: number; cursorColumn: number } {
  const lines = text.split('\n')
  let remaining = cursor, cursorLine = 0
  for (; cursorLine < lines.length - 1; cursorLine++) {
    const length = Array.from(lines[cursorLine]!).length
    if (remaining <= length) break
    remaining -= length + 1
  }
  const first = Math.max(0, Math.min(cursorLine - rows + 1, lines.length - rows))
  return { lines, first: Math.max(0, first), cursorLine, cursorColumn: remaining }
}
