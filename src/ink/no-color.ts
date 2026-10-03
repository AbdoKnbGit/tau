/**
 * NO_COLOR (https://no-color.org): the interface keeps every style except
 * color. Bold, dim, italic, underline, inverse and strikethrough stay — the
 * prompt's cursor is an inverse cell, and hints are dim.
 *
 * Applied as styles enter Ink's StylePool, the one place every cell style
 * passes through: tau's own colors (chalk via colorize), syntax highlighting,
 * diffs, theme backgrounds and ANSI colors in tool output alike. chalk's own
 * level is left alone, since dropping it would drop the other styles too.
 */
import {
  type AnsiCode,
  styledCharsFromTokens,
  tokenize,
} from '@alcalzone/ansi-tokenize'

/** Set and not empty, as the convention asks; any value counts. */
export function isNoColorRequested(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return typeof env.NO_COLOR === 'string' && env.NO_COLOR !== ''
}

const SGR = /^\x1b\[([0-9;:]*)m$/

/**
 * SGR parameters that choose a color: foreground 30-39 and 90-97, background
 * 40-49 and 100-107, underline color 58-59. 38, 48 and 58 take arguments.
 */
function isColorParameter(value: number): boolean {
  return (
    (value >= 30 && value <= 49) ||
    (value >= 90 && value <= 97) ||
    (value >= 100 && value <= 107) ||
    value === 58 ||
    value === 59
  )
}

/**
 * The parameters of one SGR sequence with every color removed, or null when
 * it sets no color. ansi-tokenize keeps a combined sequence such as
 * `1;31;42` whole, so colors are found by parameter, not by end code.
 */
function parametersWithoutColor(body: string): string[] | null {
  const parameters = body === '' ? ['0'] : body.split(';')
  const kept: string[] = []
  let removed = false
  for (let i = 0; i < parameters.length; i++) {
    const parameter = parameters[i]!
    const value = Number(parameter.split(':')[0] || '0')
    if (!isColorParameter(value)) {
      kept.push(parameter)
      continue
    }
    removed = true
    // In the semicolon form, an extended color's arguments follow as
    // parameters of their own: 5;n for a palette index, 2;r;g;b for RGB.
    // The colon form (38:2::r:g:b) is a single parameter.
    if ((value === 38 || value === 48 || value === 58) && !parameter.includes(':')) {
      const mode = parameters[i + 1]
      if (mode === '5') i += 2
      else if (mode === '2') i += 4
    }
  }
  return removed ? kept : null
}

const singleCodes = new Map<string, AnsiCode | null>()

/**
 * One SGR parameter as a code of its own, with the end code ansi-tokenize
 * gives it — exact for a single parameter, unlike for a combined one. Null
 * for a parameter that only resets something.
 */
function singleCode(parameter: string): AnsiCode | null {
  let code = singleCodes.get(parameter)
  if (code === undefined) {
    code =
      styledCharsFromTokens(tokenize(`\x1b[${parameter}m `))[0]?.styles[0] ??
      null
    singleCodes.set(parameter, code)
  }
  return code
}

/** `styles` with every color removed; the same array when there was none. */
export function withoutColor(styles: AnsiCode[]): AnsiCode[] {
  let out: AnsiCode[] | undefined
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i]!
    const match = SGR.exec(style.code)
    const kept = match ? parametersWithoutColor(match[1]!) : null
    if (kept === null) {
      if (out && !out.some(code => code.code === style.code)) out.push(style)
      continue
    }
    out ??= styles.slice(0, i)
    for (const parameter of kept) {
      const code = singleCode(parameter)
      if (code && !out.some(existing => existing.code === code.code)) {
        out.push(code)
      }
    }
  }
  return out ?? styles
}
