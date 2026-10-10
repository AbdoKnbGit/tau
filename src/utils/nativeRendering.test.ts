import { getNativeHighlightStyle, trimRenderedLine } from './nativeRendering.js'

const ESC = String.fromCharCode(27)

describe('native syntax highlighting', () => {
  test('only uses a native style when it matches the active theme', () => {
    expect(getNativeHighlightStyle('dark')).toBe('github-dark')
    expect(getNativeHighlightStyle('catppuccin-macchiato')).toBeNull()
    expect(getNativeHighlightStyle('light')).toBeNull()
  })

  test('trims trailing blanks, including blanks wrapped in escape codes', () => {
    expect(trimRenderedLine('code   ')).toBe('code')
    expect(trimRenderedLine('\t \t')).toBe('')
    expect(trimRenderedLine('')).toBe('')
    expect(
      trimRenderedLine(
        `${ESC}[38;2;1;2;3mcode${ESC}[0m${ESC}[38;2;9;9;9m   ${ESC}[0m`,
      ),
    ).toBe(`${ESC}[38;2;1;2;3mcode`)
    expect(trimRenderedLine(`  ${ESC}[0m`)).toBe('')
    // No blank at the end: escape codes stay, unfinished ones too.
    expect(trimRenderedLine(`${ESC}[31mcode${ESC}[0m`)).toBe(
      `${ESC}[31mcode${ESC}[0m`,
    )
    expect(trimRenderedLine(`x ${ESC}[`)).toBe(`x ${ESC}[`)
  })

  test('keeps indentation and stays fast on indented highlighted code', () => {
    // The regex this trim replaced took seconds on this line, hours at 32.
    const line = `${ESC}[38;2;201;209;217m${' '.repeat(20)}${ESC}[0m${ESC}[38;2;255;123;114mif${ESC}[0m x:`
    const started = performance.now()
    const trimmed = trimRenderedLine(line)
    expect(performance.now() - started).toBeLessThan(250)
    expect(trimmed).toBe(line)
    const deep = line.replace(' '.repeat(20), ' '.repeat(2000))
    expect(trimRenderedLine(deep)).toBe(deep)
  })
})
