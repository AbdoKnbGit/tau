/**
 * Bounded LaTeX-to-Unicode rendering for terminal text.
 *
 * This is a notation parser, not a TeX evaluator: no macros, IO, HTML, external
 * processes or generated escape sequences. Unsupported/malformed expressions
 * return null so the caller can retain the complete source. Compact notation
 * deliberately uses the existing text wrapping in every terminal surface.
 */
import { MATH_SYMBOLS } from './terminalMathSymbols.js'

export const MAX_MATH_SOURCE = 8192
const MAX_DEPTH = 32
const MAX_STEPS = 8192
const MAX_OUTPUT = 16384
const MAX_CELLS = 256
const CACHE_CHAR_LIMIT = 128 * 1024
const cache = new Map<string, string | null>()
let cacheChars = 0

const superscripts = new Map(Array.from('0123456789+-=()ni').map((c, i) =>
  [c, Array.from('⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ')[i]!]))
const subscripts = new Map(Array.from('0123456789+-=()aehijklmnoprstuvx').map((c, i) =>
  [c, Array.from('₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')[i]!]))
const blackboard = new Map(Array.from('CHNPQRZ').map((c, i) =>
  [c, Array.from('ℂℍℕℙℚℝℤ')[i]!]))
const fontCommands = new Set([
  'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathscr',
  'boldsymbol', 'bm', 'mathnormal',
])
const textCommands = new Set(['text', 'textrm', 'textsf', 'texttt', 'textnormal', 'operatorname'])
const sizeCommands = new Set([
  'left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr',
  'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
])
const styleCommands = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits',
])
const accents = new Map(Object.entries({
  hat: '\u0302', widehat: '\u0302', bar: '\u0304', overline: '\u0305',
  underline: '\u0332', vec: '\u20d7', dot: '\u0307', ddot: '\u0308',
  tilde: '\u0303', widetilde: '\u0303', acute: '\u0301', grave: '\u0300',
  breve: '\u0306', check: '\u030c',
}))
const environments = new Map<string, [string, string]>([
  ['matrix', ['[', ']']], ['smallmatrix', ['[', ']']], ['pmatrix', ['(', ')']],
  ['bmatrix', ['[', ']']], ['Bmatrix', ['{', '}']], ['vmatrix', ['|', '|']],
  ['Vmatrix', ['‖', '‖']], ['cases', ['{', '']], ['cases*', ['{', '']],
  ...['aligned', 'aligned*', 'align', 'align*', 'gather', 'gather*', 'gathered',
    'split', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'array',
    'equation', 'equation*', 'displaymath'].map(name => [name, ['', '']] as [string, [string, string]]),
])

function group(text: string): string {
  // Products such as "bc" need parentheses in a compact denominator or
  // scripted base; only a number or one symbol is unambiguous without them.
  return /^(?:[+-]?\d+(?:\.\d+)?|[^\s])$/u.test(text) ? text : `(${text})`
}

function script(text: string, up: boolean): string {
  const map = up ? superscripts : subscripts
  const chars = Array.from(text)
  return chars.length && chars.every(c => map.has(c))
    ? chars.map(c => map.get(c)).join('')
    : `${up ? '^' : '_'}(${text})`
}

class MathSyntaxError extends Error {}

class MathParser {
  private pos = 0
  private steps = 0
  constructor(private readonly source: string) {}

  private check(depth: number): void {
    if (depth > MAX_DEPTH || ++this.steps > MAX_STEPS) throw new MathSyntaxError()
  }

  private space(): void {
    while (/\s/.test(this.source[this.pos] ?? '') && this.pos < this.source.length) this.pos++
  }

  private sequence(depth: number, stop: () => boolean): string {
    this.check(depth)
    const pieces: Array<{ text: string; scripted: boolean; scripts: Set<string> }> = []
    let length = 0
    while (this.pos < this.source.length && !stop()) {
      this.check(depth)
      const start = this.pos
      const operator = this.source[this.pos]
      if (operator === '^' || operator === '_') {
        const base = pieces.at(-1)
        if (!base || !base.text.trim() || base.scripts.has(operator)) throw new MathSyntaxError()
        this.pos++
        const value = this.argument(depth + 1)
        if (!value) throw new MathSyntaxError()
        const rendered = script(value, operator === '^')
        const text = (base.scripted ? base.text : group(base.text)) + rendered
        length += text.length - base.text.length
        if (length > MAX_OUTPUT) throw new MathSyntaxError()
        base.text = text
        base.scripted = true
        base.scripts.add(operator)
        continue
      }
      const part = this.atom(depth)
      if (this.pos <= start || (length += part.length) > MAX_OUTPUT) throw new MathSyntaxError()
      if (part) pieces.push({ text: part, scripted: false, scripts: new Set() })
    }
    return pieces.map(part => part.text).join('')
  }

  parse(): string {
    const result = this.sequence(0, () => false).trim()
    if (!result && this.source.trim()) throw new MathSyntaxError()
    return result
  }

  private argument(depth: number): string {
    this.check(depth)
    this.space()
    if (this.pos >= this.source.length) throw new MathSyntaxError()
    if (this.source[this.pos] === '{') {
      this.pos++
      const body = this.sequence(depth + 1, () => this.source[this.pos] === '}')
      if (this.source[this.pos++] !== '}') throw new MathSyntaxError()
      return body
    }
    return this.atom(depth + 1)
  }

  private rawGroup(): string {
    this.space()
    if (this.source[this.pos++] !== '{') throw new MathSyntaxError()
    const start = this.pos
    let nesting = 1
    while (this.pos < this.source.length) {
      this.check(0)
      const c = this.source[this.pos++]!
      if (c === '\\') this.pos++
      else if (c === '{') nesting++
      else if (c === '}' && --nesting === 0) return this.source.slice(start, this.pos - 1)
      if (nesting > MAX_DEPTH) throw new MathSyntaxError()
    }
    throw new MathSyntaxError()
  }

  private atom(depth: number): string {
    this.check(depth)
    const c = this.source[this.pos]
    if (c === '{') return this.argument(depth + 1)
    if (c === '}' || c === '&' || c === '$' || c === '%' || c === undefined) throw new MathSyntaxError()
    if (c === '\\') return this.command(depth + 1)
    this.pos++
    if (c === '^' || c === '_') {
      throw new MathSyntaxError()
    }
    if (/\s/.test(c)) {
      this.space()
      // Ignore whitespace immediately before a script, including after a
      // command separator; keep prose-like spacing everywhere else.
      return /[_^]/.test(this.source[this.pos] ?? '') ? '' : ' '
    }
    if (c === '~') return ' '
    return c
  }

  private command(depth: number): string {
    this.check(depth)
    this.pos++ // backslash
    const start = this.pos
    while (/[A-Za-z]/.test(this.source[this.pos] ?? '') && this.pos < this.source.length) this.pos++
    const word = this.pos > start
    if (!word) this.pos++
    const name = this.source.slice(start, this.pos)
    if (!name) throw new MathSyntaxError()

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const a = this.argument(depth + 1)
      const b = this.argument(depth + 1)
      if (!a || !b) throw new MathSyntaxError()
      return `${group(a)}⁄${group(b)}`
    }
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      return `binom(${this.argument(depth + 1)}, ${this.argument(depth + 1)})`
    }
    if (name === 'sqrt') {
      this.space()
      let index = ''
      if (this.source[this.pos] === '[') {
        this.pos++
        index = this.sequence(depth + 1, () => this.source[this.pos] === ']')
        if (this.source[this.pos++] !== ']' || !index) throw new MathSyntaxError()
      }
      const radicand = this.argument(depth + 1)
      if (!radicand) throw new MathSyntaxError()
      return `${index ? script(index, true) : ''}√${group(radicand)}`
    }
    if (textCommands.has(name)) {
      if (name === 'operatorname' && this.source[this.pos] === '*') this.pos++
      const text = this.rawGroup()
      // Text contents are literal. Only the common escaped text punctuation
      // is interpreted; nested TeX and macros keep the entire formula raw.
      if (/[{}]/.test(text.replace(/\\[{}]/g, '')) ||
          /\\(?![\\{}%$#&_ ])/.test(text)) throw new MathSyntaxError()
      return text.replace(/\\([\\{}%$#&_ ])/g, '$1').replace(/\s+/g, ' ')
    }
    if (fontCommands.has(name)) return this.argument(depth + 1)
    if (name === 'mathbb') {
      return Array.from(this.argument(depth + 1)).map(c => blackboard.get(c) ?? c).join('')
    }
    if (styleCommands.has(name)) {
      this.space()
      return ''
    }
    if (sizeCommands.has(name)) {
      this.space()
      if (this.source[this.pos] === '.') { this.pos++; return '' }
      if (this.source[this.pos] === '\\') return this.command(depth + 1)
      const delimiter = this.source[this.pos++]
      if (!delimiter || !'()[]|<>'.includes(delimiter)) throw new MathSyntaxError()
      return delimiter
    }
    if (accents.has(name)) {
      const body = this.argument(depth + 1)
      // Applying a combining accent to a compound expression changes its
      // meaning. Leave such constructs in source form instead of guessing.
      if (Array.from(body).length !== 1) throw new MathSyntaxError()
      return body + accents.get(name)
    }
    if (name === 'boxed') return `[${this.argument(depth + 1)}]`
    if (name === 'begin') return this.environment(depth + 1)
    if ([',', ';', ':', ' ', 'quad', 'enspace', 'thinspace'].includes(name)) return ' '
    if (name === 'qquad') return '  '
    if (name === '!' || name === 'negthinspace') return ''
    if (name === '\\') return '; '
    const symbol = MATH_SYMBOLS.get(name)
    if (symbol === undefined) throw new MathSyntaxError()
    return symbol
  }

  private environment(depth: number): string {
    this.check(depth)
    const name = this.rawGroup()
    const delimiters = environments.get(name)
    if (!delimiters) throw new MathSyntaxError()
    if (name === 'array') {
      const columns = this.rawGroup()
      if (!/^[lcr| ]+$/.test(columns)) throw new MathSyntaxError()
    }
    const rows: string[] = []
    let cells: string[] = []
    const separator = delimiters[0] ? ', ' : ' '
    let count = 0
    const end = `\\end{${name}}`
    while (this.pos < this.source.length) {
      this.check(depth)
      if (++count > MAX_CELLS) throw new MathSyntaxError()
      cells.push(this.sequence(depth + 1, () => this.source[this.pos] === '&' ||
        this.source.startsWith('\\\\', this.pos) || this.source.startsWith('\\end', this.pos)).trim())
      if (this.source.startsWith(end, this.pos)) {
        this.pos += end.length
        if (cells.some(Boolean)) rows.push(cells.join(separator))
        return delimiters[0] + rows.join('; ') + delimiters[1]
      }
      if (this.source[this.pos] === '&') { this.pos++; continue }
      if (!this.source.startsWith('\\\\', this.pos)) throw new MathSyntaxError()
      this.pos += 2
      rows.push(cells.join(separator))
      cells = []
      // Optional row spacing is presentation-only; accept a small dimension.
      if (this.source[this.pos] === '[') {
        const close = this.source.indexOf(']', this.pos + 1)
        if (close < 0 || !/^-?\d+(?:\.\d+)?(?:pt|em|ex|mm|cm)$/.test(
          this.source.slice(this.pos + 1, close))) throw new MathSyntaxError()
        this.pos = close + 1
      }
    }
    throw new MathSyntaxError()
  }
}

/** Returns null on unsupported input. The caller owns the unchanged source. */
export function renderTerminalMath(source: string): string | null {
  if (source.length > MAX_MATH_SOURCE) return null
  // A formula must never introduce terminal control sequences. Newlines/tabs
  // are the only controls accepted, and become ordinary spacing.
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(source)) return null
  if (cache.has(source)) {
    const value = cache.get(source)!
    cache.delete(source)
    cache.set(source, value)
    return value
  }
  let result: string | null = null
  try {
    result = new MathParser(source).parse()
    if (result.length > MAX_OUTPUT) result = null
  } catch {
    // Generated/streamed input must not escape into React's error boundary.
  }
  const cost = source.length + (result?.length ?? 0)
  while (cache.size >= 128 || cacheChars + cost > CACHE_CHAR_LIMIT) {
    const first = cache.keys().next().value
    if (first === undefined) break
    cacheChars -= first.length + (cache.get(first)?.length ?? 0)
    cache.delete(first)
  }
  cache.set(source, result)
  cacheChars += cost
  return result
}
