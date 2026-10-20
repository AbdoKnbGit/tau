import { Marked, type Token, type Tokens, type TokenizerExtension } from 'marked'
import { MAX_MATH_SOURCE } from './terminalMath.js'

export type TerminalMathToken = Tokens.Generic & {
  type: 'terminalMath' | 'terminalMathBlock'
  text: string
  complete: boolean
}

// Recognize delimiters before Markdown consumes backslashes/underscores.
// Code spans, fences, destinations, autolinks and HTML are still owned by
// Marked; never run a replacement over the source or the final ANSI string.
const MATH_START = /\$|\\[([]/
const MARKDOWN_SYNTAX = /[#*`|[>\\_~$-]|\n\n|^\d+\. |\n\d+\. /
const MAX_BLOCK_LINES = 128

export function hasTerminalMarkdownSyntax(text: string): boolean {
  return MARKDOWN_SYNTAX.test(text)
}

function mathToken(raw: string, text: string, complete: boolean, block = false): TerminalMathToken {
  return { type: block ? 'terminalMathBlock' : 'terminalMath', raw, text, complete }
}

function explicitMathBody(text: string): boolean {
  // \( and \[ are also ordinary Markdown escapes. Preserve prose such as
  // "\[old, new\]" while recognizing variables, numbers and math notation.
  return /[\\^_{}=+*/<>\d\u0370-\u03ff\u2200-\u22ff]/u.test(text) ||
    /^[A-Za-z]{1,2}(?:\s*[,;+-]\s*[A-Za-z]{1,2})*$/.test(text.trim())
}

/** Linear delimiter scan. Oversized complete formulas still get a raw token;
 * only the notation parser has to refuse them. Nested math openers terminate
 * the scan so repeated unclosed delimiters cannot cause quadratic rescans. */
function closingIndex(src: string, from: number, close: string, multiline: boolean): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\n' && !multiline) return -1
    if (multiline && i > from && src[i - 1] === '\n' &&
        /^ {0,3}(?:`{3,}|~{3,}|#{1,6} )/.test(src.slice(i, i + 12))) return -1
    if (src.startsWith(close, i)) return i
    if (src[i] === '\\') {
      if (src.startsWith('\\(', i) || src.startsWith('\\[', i)) return -1
      i++
    }
  }
  return -1
}

const inlineMath: TokenizerExtension = {
  name: 'terminalMath',
  level: 'inline',
  start(src) { return src.search(MATH_START) },
  tokenizer(src, tokens) {
    const open = src.startsWith('\\(') ? '\\(' : src.startsWith('\\[') ? '\\['
      : src.startsWith('$$') ? '$$' : src.startsWith('$') ? '$' : ''
    if (!open || this.lexer.state.inRawBlock) return
    if (src.startsWith('$$$')) {
      const raw = /^\$+/.exec(src)![0]
      return mathToken(raw, raw, false)
    }
    const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open
    if (open === '$') {
      const previous = tokens.at(-1)?.raw.at(-1) ?? ''
      // Conservative dollar rules protect currency, $HOME, shell fragments,
      // identifiers and escaped dollars. Explicit \(..\) has no price ambiguity.
      if (/[\w$\\]/.test(previous) || !src[1] || /\s|\$/.test(src[1])) return
    }
    const end = closingIndex(src, open.length, close, false)
    if (end < 0) return
    const body = src.slice(open.length, end)
    if (open.startsWith('\\') && !explicitMathBody(body)) return
    if (open === '$' && (/\s/.test(src[end - 1] ?? '') ||
        /[\w$]/.test(src[end + 1] ?? ''))) return
    const raw = src.slice(0, end + close.length)
    return mathToken(raw, body, body.trim().length > 0)
  },
}

function tokenizeMathBlock(src: string): TerminalMathToken | undefined {
  const match = /^ {0,3}(\$\$(?!\$)|\\\[)/.exec(src)
  if (!match) return
  const open = match[1]!
  const close = open === '$$' ? '$$' : '\\]'
  const end = closingIndex(src, match[0].length, close, true)
  if (end >= 0) {
    const after = end + close.length
    // A display block must own its line. Inline display delimiters in prose
    // are handled by the inline extension, without swallowing following text.
    const tail = /^[ \t]*(?:\n|$)/.exec(src.slice(after))
    if (!tail) return
    const body = src.slice(match[0].length, end)
    if (open === '\\[' && !explicitMathBody(body)) return
    return mathToken(src.slice(0, after + tail[0].length), body, !!body.trim(), true)
  }
  // Only standalone openers reserve a growing block. This keeps blank lines
  // inside a streamed equation from becoming a permanent prefix boundary.
  if (!/^[ \t]*(?:\n|$)/.test(src.slice(match[0].length))) return
  // Recover at a clear Markdown block, so a forgotten closer cannot hide a
  // heading, list, code fence or table. All retained input stays visible.
  let length = match[0].length
  let lines = 0
  for (const line of src.slice(length).split('\n', MAX_BLOCK_LINES + 1)) {
    if (lines > 0 && /^(?: {0,3}(?:#{1,6} |>|`{3,}|~{3,}|[-+*] |\d+[.)] )|\|)/.test(line)) break
    if (++lines > MAX_BLOCK_LINES || length + line.length > MAX_MATH_SOURCE) break
    length += line.length + (length + line.length < src.length ? 1 : 0)
  }
  if (length === match[0].length) return
  return mathToken(src.slice(0, length), src.slice(0, length), false, true)
}

const blockMath: TokenizerExtension = {
  name: 'terminalMathBlock',
  level: 'block',
  start(src) {
    // Marked adds a newline when it rejoins paragraphs after a false block
    // hint. That corrupts raw offsets used by streaming, even if the visible
    // text is unchanged. Only advertise openers the tokenizer will consume.
    for (const match of src.matchAll(/^ {0,3}(?:\$\$(?!\$)|\\\[)/gm)) {
      if (tokenizeMathBlock(src.slice(match.index))) return match.index
    }
  },
  tokenizer(src) { return tokenizeMathBlock(src) },
}

// A private instance is essential: HTML reports, artifact exports, Mermaid
// feedback and /copy also use Marked. Terminal-only tokens must not leak there.
const terminalMarked = new Marked({
  // Preserve Tau's existing approximation notation (~100), without changing
  // strikethrough handling in HTML exports.
  tokenizer: { del() { return undefined } },
  extensions: [inlineMath, blockMath],
})

export function lexTerminalMarkdown(content: string): Token[] {
  return terminalMarked.lexer(content)
}

function hasPendingMath(token: Token): boolean {
  const pending = [token]
  while (pending.length) {
    const next = pending.pop()!
    if (next.type === 'terminalMathBlock' && !next.complete) return true
    if ('tokens' in next && next.tokens) for (const child of next.tokens) pending.push(child)
    if (next.type === 'list') for (const item of next.items) pending.push(item)
  }
  return false
}

/** Shared with the streaming component; test every prefix against this path. */
export function stableMarkdownPrefix(content: string, previous: string): string {
  if (!content.startsWith(previous)) previous = ''
  const tokens = lexTerminalMarkdown(content.slice(previous.length))
  let last = tokens.length - 1
  while (last >= 0 && tokens[last]!.type === 'space') last--
  let advance = 0
  for (let i = 0; i < last; i++) {
    // An apparent list/heading after an unfinished display can still become
    // part of that formula. Keep its containing quote/list mutable as well.
    if (hasPendingMath(tokens[i]!)) break
    advance += tokens[i]!.raw.length
  }
  return content.slice(0, previous.length + advance)
}
