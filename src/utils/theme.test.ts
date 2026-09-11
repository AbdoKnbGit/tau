import { afterEach, describe, expect, test } from 'bun:test'
import { ColorDiff, ColorFile, getSyntaxTheme, highlightCodeToAnsi } from '../native-ts/color-diff/index.js'
import { getPowerModeWordmarkPalette, setPowerModeTheme } from './modeTheme.js'
import { getTheme, normalizeThemeSetting, THEME_NAMES } from './theme.js'

function luminance(color: string): number {
  const [r, g, b] = color.match(/\d+/g)!.map(Number).map(value => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const l = [luminance(a), luminance(b)].sort((a, b) => b - a)
  return (l[0]! + 0.05) / (l[1]! + 0.05)
}

afterEach(() => setPowerModeTheme('normal', { animate: false }))

describe('Tau themes', () => {
  test('offers exactly the three requested palettes', () => {
    expect(THEME_NAMES).toEqual(['dark', 'catppuccin-macchiato', 'light'])
  })

  test('migrates retired choices and rejects invalid saved values', () => {
    expect(normalizeThemeSetting('studio')).toBe('catppuccin-macchiato')
    for (const name of ['light-ansi', 'light-daltonized']) {
      expect(normalizeThemeSetting(name)).toBe('light')
    }
    for (const value of ['dark-ansi', 'dark-daltonized', 'invalid', undefined, {}]) {
      expect(normalizeThemeSetting(value)).toBe('dark')
    }
    for (const value of [...THEME_NAMES, 'auto'] as const) {
      expect(normalizeThemeSetting(value)).toBe(value)
    }
  })

  test('keeps the original dark palette and silver wordmark', () => {
    setPowerModeTheme('normal', { animate: false })
    expect(getTheme('dark').text).toBe('rgb(206,206,210)')
    expect(getTheme('dark').background).toBe('rgb(22,22,25)')
    expect(getPowerModeWordmarkPalette().bodyRight).toEqual({ r: 235, g: 235, b: 226 })
  })

  test('text, muted labels, and mode borders remain legible on the new canvases', () => {
    for (const mode of ['normal', 'cheap', 'full'] as const) {
      setPowerModeTheme(mode, { animate: false })
      for (const name of ['light', 'catppuccin-macchiato'] as const) {
        const theme = getTheme(name)
        for (const background of [theme.background, theme.backgroundMenu, theme.backgroundElement]) {
          expect(contrast(theme.text, background)).toBeGreaterThanOrEqual(7)
          expect(contrast(theme.inactive, background)).toBeGreaterThanOrEqual(4.5)
          expect(contrast(theme.brand, background)).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  test('silver, bronze, and gold wordmarks stay visible on white', () => {
    for (const mode of ['normal', 'cheap', 'full'] as const) {
      setPowerModeTheme(mode, { animate: false })
      const palette = getPowerModeWordmarkPalette({ theme: 'light' })
      for (const rgb of [palette.bodyLeft, palette.bodyRight, palette.primary, palette.peak]) {
        expect(contrast(`rgb(${rgb.r},${rgb.g},${rgb.b})`, getTheme('light').background)).toBeGreaterThanOrEqual(3)
      }
    }
  })

  test('Macchiato syntax uses its dark pastel palette', () => {
    const previous = process.env.COLORTERM
    process.env.COLORTERM = 'truecolor'
    try {
      expect(getSyntaxTheme('catppuccin-macchiato').theme).toBe('Catppuccin Macchiato')
      const code = highlightCodeToAnsi('const answer = "hello"', 'javascript', 'catppuccin-macchiato')
      expect(code).toContain('38;2;198;160;246')
      expect(code).toContain('38;2;166;218;149')
      expect(getSyntaxTheme('light').theme).toBe('GitHub')
    } finally {
      if (previous === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = previous
    }
  })

  test('pre-rendered code and diff rows keep the themed canvas background', () => {
    const previous = process.env.COLORTERM
    process.env.COLORTERM = 'truecolor'
    try {
      for (const name of ['light', 'catppuccin-macchiato'] as const) {
        const background = getTheme(name).background.match(/\d+/g)!.join(';')
        const expected = `48;2;${background}`
        const code = new ColorFile('const value = 1', 'example.ts').render(name, 40, false)![0]!
        const diff = new ColorDiff({
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [' const value = 1'],
        }, null, 'example.ts').render(name, 40, false)![0]!
        expect(code).toContain(expected)
        expect(diff).toContain(expected)
        expect(code).not.toContain('\x1b[49m')
        expect(diff).not.toContain('\x1b[49m')
      }
    } finally {
      if (previous === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = previous
    }
  })
})
