import type { Token, Tokens, TokenizerExtension } from 'marked'

const MAX_NOTES = 100
const MAX_NOTE_CHARS = 4096
const MAX_NOTE_LINES = 32
const MAX_VISITED_TOKENS = 20000

export type FootnoteReference = Tokens.Generic & {
  type: 'terminalFootnote'
  id: string
  number?: number
}

export type FootnoteDefinition = Tokens.Generic & {
  type: 'terminalFootnoteDefinition'
  id: string
  tokens: Token[]
  used?: boolean
  valid?: boolean
}

export type FootnoteList = Tokens.Generic & {
  type: 'terminalFootnoteList'
  entries: { number: number; tokens: Token[] }[]
}

export const footnoteExtensions: TokenizerExtension[] = [{
  name: 'terminalFootnoteDefinition',
  level: 'block',
  start(src) { return src.search(/^ {0,3}\[\^[^\]\s]{1,64}\]:/m) },
  tokenizer(src) {
    const head = /^ {0,3}\[\^([^\]\s]{1,64})\]:[ \t]*([^\n]*)(?:\n|$)/.exec(src)
    if (!head) return
    let raw = head[0]
    const lines = [head[2]!]
    for (let line = 1; line < MAX_NOTE_LINES && raw.length < MAX_NOTE_CHARS; line++) {
      const continuation = /^(?: {4}|\t)([^\n]*)(?:\n|$)/.exec(src.slice(raw.length))
      if (!continuation || raw.length + continuation[0].length > MAX_NOTE_CHARS) break
      raw += continuation[0]
      lines.push(continuation[1]!)
    }
    const text = lines.join('\n')
    const valid = text.length <= MAX_NOTE_CHARS && raw.length <= MAX_NOTE_CHARS &&
      !/^(?: {4}|\t)/.test(src.slice(raw.length))
    return {
      type: 'terminalFootnoteDefinition', raw, text,
      id: head[1]!.toLowerCase(),
      valid,
      tokens: valid ? this.lexer.inlineTokens(text) : [],
    }
  },
}, {
  name: 'terminalFootnote',
  level: 'inline',
  start(src) { return src.indexOf('[^') },
  tokenizer(src) {
    if (this.lexer.state.inRawBlock) return
    const match = /^\[\^([^\]\s]{1,64})\]/.exec(src)
    if (match) return { type: 'terminalFootnote', raw: match[0], id: match[1]!.toLowerCase() }
  },
}]

function childrenOf(token: Token): Token[] {
  if (token.type === 'terminalFootnoteDefinition') return []
  if (token.type === 'list') return token.items
  if (token.type === 'table') return [...token.header, ...token.rows.flat()].flatMap(cell => cell.tokens ?? [])
  return 'tokens' in token && token.tokens ? token.tokens : []
}

/** Resolve once per complete document; growing replies keep their literal source. */
export function resolveTerminalFootnotes(tokens: Token[]): Token[] {
  if (tokens.some(token => token.type === 'terminalFootnoteList')) return tokens
  const definitions = new Map<string, FootnoteDefinition>()
  const references: FootnoteReference[] = []
  const pending = [...tokens].reverse()
  let visited = 0
  while (pending.length) {
    if (++visited > MAX_VISITED_TOKENS) return tokens
    const token = pending.pop()!
    if (token.type === 'terminalFootnoteDefinition') {
      const definition = token as FootnoteDefinition
      if (definition.valid !== false && definitions.size < MAX_NOTES && definition.text.length <= MAX_NOTE_CHARS && !definitions.has(definition.id)) {
        definitions.set(definition.id, definition)
      }
    } else if (token.type === 'terminalFootnote') {
      references.push(token as FootnoteReference)
    } else {
      const children = childrenOf(token)
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!)
    }
  }
  const numbers = new Map<string, number>()
  const entries: FootnoteList['entries'] = []
  for (const reference of references) {
    const definition = definitions.get(reference.id)
    if (!definition) continue
    let number = numbers.get(reference.id)
    if (number === undefined) {
      number = numbers.size + 1
      numbers.set(reference.id, number)
      entries.push({ number, tokens: definition.tokens })
    }
    reference.number = number
    definition.used = true
  }
  if (entries.length) tokens.push({ type: 'terminalFootnoteList', raw: '', entries } as FootnoteList)
  return tokens
}

export function footnoteMarker(number: number): string {
  const digits = '⁰¹²³⁴⁵⁶⁷⁸⁹'
  return String(number).replace(/\d/g, digit => digits[Number(digit)]!)
}
