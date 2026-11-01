import { afterEach, describe, expect, test } from 'bun:test'
import { ColorDiff, ColorFile, getSyntaxTheme, highlightCodeToAnsi } from '../native-ts/color-diff/index.js'
import { getPowerModeWordmarkPalette, setPowerModeTheme } from './modeTheme.js'
import { getNativeHighlightStyle } from './nativeRendering.js'
import { getTheme, normalizeThemeSetting, THEME_LABELS, THEME_NAMES, themeKeepsTerminalBackdrop } from './theme.js'

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
  test('offers exactly the requested palettes, each with a picker label', () => {
    expect(THEME_NAMES).toEqual(['dark', 'catppuccin-macchiato', 'light', 'lucent-orng'])
    for (const name of THEME_NAMES) expect(THEME_LABELS[name]).toBeTruthy()
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
    expect(getTheme('dark').canvas).toBe('rgb(22,22,25)')
    expect(getPowerModeWordmarkPalette().bodyRight).toEqual({ r: 235, g: 235, b: 226 })
  })

  test('text, muted labels, and mode borders remain legible on the new canvases', () => {
    for (const mode of ['normal', 'cheap', 'full'] as const) {
      setPowerModeTheme(mode, { animate: false })
      for (const name of ['light', 'catppuccin-macchiato', 'lucent-orng'] as const) {
        const theme = getTheme(name)
        for (const background of [theme.canvas, theme.backgroundMenu, theme.backgroundElement]) {
          expect(contrast(theme.text, background)).toBeGreaterThanOrEqual(7)
          expect(contrast(theme.inactive, background)).toBeGreaterThanOrEqual(4.5)
          expect(contrast(theme.brand, background)).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  test('footer pills, task dialogs, and status labels stay visible in every theme', () => {
    // These paint text with the `background` slot, so a theme where it equals the
    // canvas shows nothing while the pill stays clickable.
    for (const mode of ['normal', 'cheap', 'full'] as const) {
      setPowerModeTheme(mode, { animate: false })
      for (const name of THEME_NAMES) {
        const theme = getTheme(name)
        expect(theme.background).not.toBe(theme.canvas)
        expect(contrast(theme.background, theme.canvas)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('the sent-prompt frame, jump pill, and sticky prompt stay legible in every theme', () => {
    for (const name of THEME_NAMES) {
      const theme = getTheme(name)
      expect(contrast(theme.borderActive, theme.canvas)).toBeGreaterThanOrEqual(3)
      expect(contrast(theme.text, theme.selectionBg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(theme.inverseText, theme.brand)).toBeGreaterThanOrEqual(3)
      expect(contrast(theme.inactive, theme.userMessageBackground)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(theme.inactive, theme.userMessageBackgroundHover)).toBeGreaterThanOrEqual(3)
    }
  })

  test('a /mode cross-fade leaves the sent-prompt frame alone', () => {
    // Prompts sit in scrollback. Recoloring them there would force full repaints.
    setPowerModeTheme('normal', { animate: false })
    const before = THEME_NAMES.map(name => getTheme(name).borderActive)
    for (const mode of ['cheap', 'full'] as const) {
      setPowerModeTheme(mode, { animate: false })
      expect(THEME_NAMES.map(name => getTheme(name).borderActive)).toEqual(before)
    }
  })

  test('every slot of every theme is plain rgb, which the chart and fade helpers parse', () => {
    for (const name of THEME_NAMES) {
      for (const [slot, value] of Object.entries(getTheme(name))) {
        expect(`${slot}: ${value}`).toMatch(/: rgb\(\s*\d+,\s*\d+,\s*\d+\s*\)$/)
      }
    }
  })

  test('Lucent Orng keeps the reference palette and the terminal backdrop', () => {
    const theme = getTheme('lucent-orng')
    expect(theme.primary).toBe('rgb(236,91,43)') // #EC5B2B
    expect(theme.secondary).toBe('rgb(238,121,72)') // #EE7948
    expect(theme.accent).toBe('rgb(255,247,241)') // #FFF7F1
    expect(theme.success).toBe('rgb(107,161,230)') // #6ba1e6
    expect(theme.error).toBe('rgb(224,108,117)') // #e06c75
    expect(theme.text).toBe('rgb(238,238,238)') // #eeeeee
    expect(theme.backgroundPanel).toBe('rgb(42,26,21)') // #2a1a15
    expect(themeKeepsTerminalBackdrop('lucent-orng')).toBe(true)
    expect(themeKeepsTerminalBackdrop('dark')).toBe(true)
    expect(themeKeepsTerminalBackdrop('light')).toBe(false)
    expect(themeKeepsTerminalBackdrop('catppuccin-macchiato')).toBe(false)
  })

  test('Lucent Orng output is readable: its own syntax colors, no light canvas', () => {
    // The theme name has no "dark" in it, so the generic path would pick GitHub's
    // dark-on-light syntax colors and paint white rows on a dark terminal.
    const previous = process.env.COLORTERM
    process.env.COLORTERM = 'truecolor'
    try {
      expect(getSyntaxTheme('lucent-orng').theme).toBe('Lucent Orng')
      expect(getNativeHighlightStyle('lucent-orng')).toBeNull()
      const code = highlightCodeToAnsi('const answer = "hello"', 'javascript', 'lucent-orng')
      expect(code).toContain('38;2;236;91;43')
      expect(code).toContain('38;2;107;161;230')
      expect(code).not.toContain('48;2;250;249;246')
      const row = new ColorFile('const value = 1', 'example.ts').render('lucent-orng', 40, false)![0]!
      expect(row).not.toContain('48;2;250;249;246')
      const patch = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const answer = 1', '+const answer = 2'] }
      const rows = new ColorDiff(patch, null, 'example.ts').render('lucent-orng', 60, false)!
      expect(rows).toHaveLength(2)
      for (const diffRow of rows) {
        expect(diffRow).toContain('48;2;62;44;30')
        expect(diffRow).toContain('48;2;98;64;38')
        expect(diffRow).not.toContain('48;2;250;249;246')
      }
    } finally {
      if (previous === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = previous
    }
  })

  test('the Lucent wordmark is orange in normal mode and metal in the power modes', () => {
    setPowerModeTheme('normal', { animate: false })
    expect(getPowerModeWordmarkPalette({ theme: 'lucent-orng' }).bodyRight).toEqual({ r: 255, g: 170, b: 130 })
    setPowerModeTheme('cheap', { animate: false })
    expect(getPowerModeWordmarkPalette({ theme: 'lucent-orng' })).toEqual(getPowerModeWordmarkPalette({ theme: 'dark' }))
    setPowerModeTheme('full', { animate: false })
    expect(getPowerModeWordmarkPalette({ theme: 'lucent-orng' })).toEqual(getPowerModeWordmarkPalette({ theme: 'dark' }))
  })

  test('silver, bronze, and gold wordmarks stay visible on white', () => {
    for (const mode of ['normal', 'cheap', 'full'] as const) {
      setPowerModeTheme(mode, { animate: false })
      const palette = getPowerModeWordmarkPalette({ theme: 'light' })
      for (const rgb of [palette.bodyLeft, palette.bodyRight, palette.primary, palette.peak]) {
        expect(contrast(`rgb(${rgb.r},${rgb.g},${rgb.b})`, getTheme('light').canvas)).toBeGreaterThanOrEqual(3)
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
        const background = getTheme(name).canvas.match(/\d+/g)!.join(';')
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

  test('uses one restrained modification color for paired edits in both new themes', () => {
    const previous = process.env.COLORTERM
    process.env.COLORTERM = 'truecolor'
    try {
      const patch = {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-const answer = 1', '+const answer = 2'],
      }
      const palettes = {
        light: { line: '255;247;200', word: '255;233;148' },
        'catppuccin-macchiato': { line: '64;57;46', word: '81;71;51' },
      } as const

      for (const [name, palette] of Object.entries(palettes)) {
        const rows = new ColorDiff(patch, null, 'example.ts').render(name, 60, false)!
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(row).toContain(`48;2;${palette.line}`)
          expect(row).toContain(`48;2;${palette.word}`)
        }
      }
    } finally {
      if (previous === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = previous
    }
  })
})
