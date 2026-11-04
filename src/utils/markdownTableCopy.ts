import { marked, type Token, type Tokens } from 'marked'

export const MAX_TABLE_COPY_SOURCE_CHARS = 500_000
export const MAX_TABLE_COPY_ROWS = 2_000
export const MAX_TABLE_COPY_COLUMNS = 100
export const MAX_TABLE_COPY_TABLES = 20

export type MarkdownTableCopy = {
  markdown: string
  tsv: string
  rows: number
  columns: number
  neutralizedCells: number
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  Tab: '\t', NewLine: '\n', equals: '=', plus: '+', minus: '\u2212',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : entity
    const value = name[1]?.toLowerCase() === 'x'
      ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : entity
  })
}

function inlineText(tokens: readonly Token[], depth = 0): string {
  if (depth > 32) throw new Error('Table formatting is too deeply nested')
  return tokens.map(token => {
    if (token.type === 'br') return '\n'
    if (token.type === 'html') return /^<br\s*\/?\s*>$/i.test(token.text) ? '\n' : ''
    if (token.type === 'codespan' || token.type === 'code') return token.text
    // Global Marked reads a defined footnote as a reference link, whereas
    // the terminal lexer owns a dedicated token. Both copy the same marker.
    if (token.type === 'link' && /^\[\^[^\]\s]{1,64}\]$/.test(token.raw)) return token.raw
    if ('tokens' in token && Array.isArray(token.tokens)) return inlineText(token.tokens, depth + 1)
    if ('text' in token && typeof token.text === 'string') return decodeEntities(token.text)
    return typeof token.raw === 'string' ? token.raw : ''
  }).join('')
}

function safeTsvCell(text: string): { text: string; neutralized: boolean } {
  // Spreadsheet importers can discard leading whitespace/control characters
  // before recognizing formulas. The explicit safe-TSV action copies these as
  // text; the separate Markdown action always preserves the original source.
  const neutralized = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]*[=+\-@]/u.test(text)
  const safe = neutralized ? `'${text}` : text
  return { text: /[\t\r\n"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe, neutralized }
}

/** Returns the complete table or null; oversized tables are never cut short. */
export function createMarkdownTableCopy(table: Tokens.Table): MarkdownTableCopy | null {
  if (!table.raw || table.raw.length > MAX_TABLE_COPY_SOURCE_CHARS ||
      table.rows.length + 1 > MAX_TABLE_COPY_ROWS || !table.header.length ||
      table.header.length > MAX_TABLE_COPY_COLUMNS) return null
  let neutralizedCells = 0
  let outputChars = 0
  try {
    const tsv = [table.header, ...table.rows].map(row => {
      if (row.length > MAX_TABLE_COPY_COLUMNS) throw new Error('Too many table columns')
      const line = table.header.map((_, index) => {
        const cell = row[index]
        const result = safeTsvCell(cell ? inlineText(cell.tokens) : '')
        if (result.neutralized) neutralizedCells++
        return result.text
      }).join('\t')
      outputChars += line.length + 1
      if (outputChars > MAX_TABLE_COPY_SOURCE_CHARS) throw new Error('Table copy is too large')
      return line
    }).join('\n')
    return { markdown: table.raw, tsv, rows: table.rows.length + 1, columns: table.header.length, neutralizedCells }
  } catch {
    return null
  }
}

/** Called by a copy action, never by the streaming/render path. */
export function extractMarkdownTables(markdown: string): MarkdownTableCopy[] {
  if (markdown.length > MAX_TABLE_COPY_SOURCE_CHARS) return []
  const tables: MarkdownTableCopy[] = []
  try {
    for (const token of marked.lexer(markdown)) {
      if (token.type !== 'table') continue
      const table = createMarkdownTableCopy(token as Tokens.Table)
      if (table) tables.push(table)
      if (tables.length >= MAX_TABLE_COPY_TABLES) break
    }
  } catch {
    return []
  }
  return tables
}
