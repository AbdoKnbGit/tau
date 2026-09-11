import { getNativeHighlightStyle } from './nativeRendering.js'

describe('native syntax highlighting', () => {
  test('only uses a native style when it matches the active theme', () => {
    expect(getNativeHighlightStyle('dark')).toBe('github-dark')
    expect(getNativeHighlightStyle('catppuccin-macchiato')).toBeNull()
    expect(getNativeHighlightStyle('light')).toBeNull()
  })
})
