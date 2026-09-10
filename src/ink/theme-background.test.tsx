import { describe, expect, mock, spyOn, test } from 'bun:test'
import React from 'react'

// Build-only declarations are erased by the production bundler.
mock.module('./global.d.ts', () => ({}))
const { default: Box } = await import('./components/Box.js')
const { default: Text } = await import('./components/Text.js')
const { renderToScreen } = await import('./render-to-screen.js')
const { cellAt, StylePool } = await import('./screen.js')
const { default: chalk } = await import('chalk')

describe('theme canvas inheritance', () => {
  test('transparent prompt borders, padding, text, and opaque menus share the canvas', () => {
    const previousLevel = chalk.level
    chalk.level = 3
    const styles = new Map<number, string>()
    const originalIntern = StylePool.prototype.intern
    const intern = spyOn(StylePool.prototype, 'intern').mockImplementation(function (this: InstanceType<typeof StylePool>, codes) {
      const id = originalIntern.call(this, codes)
      styles.set(id, codes.map(style => style.code).join(' '))
      return id
    })
    try {
      const { screen } = renderToScreen(
        <Box flexDirection="column" height={8} backgroundColor="rgb(250,249,246)">
          <Box borderStyle="round" borderColor="rgb(92,99,112)" paddingX={1}>
            <Text color="rgb(40,43,51)">Prompt</Text>
          </Box>
          <Box opaque height={2}><Text color="rgb(40,43,51)">Menu</Text></Box>
        </Box>, 24,
      )
      expect(screen.height).toBe(8)
      for (let y = 0; y < screen.height; y++) {
        for (let x = 0; x < screen.width; x++) {
          const cell = cellAt(screen, x, y)!
          expect(styles.get(cell.styleId)).toContain('48;2;250;249;246')
        }
      }
    } finally {
      chalk.level = previousLevel
      intern.mockRestore()
    }
  })

})
