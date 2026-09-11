import React from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'
import chalk from 'chalk'
import { ThemeProvider, useTheme } from '../../src/components/design-system/ThemeProvider.js'
import Text from '../../src/components/design-system/ThemedText.js'
import { Ansi } from '../../src/ink/Ansi.js'
import { AlternateScreen } from '../../src/ink/components/AlternateScreen.js'
import Box from '../../src/ink/components/Box.js'
import ScrollBox, { type ScrollBoxHandle } from '../../src/ink/components/ScrollBox.js'
import { TerminalSizeContext } from '../../src/ink/components/TerminalSizeContext.js'
import { createNode } from '../../src/ink/dom.js'
import { FocusManager } from '../../src/ink/focus.js'
import Output from '../../src/ink/output.js'
import reconciler from '../../src/ink/reconciler.js'
import renderNodeToOutput, { resetLayoutShifted } from '../../src/ink/render-node-to-output.js'
import { CharPool, HyperlinkPool, StylePool, cellAt, createScreen } from '../../src/ink/screen.js'
import { getTheme, type ThemeName } from '../../src/utils/theme.js'

export { getTheme }

/** Keep the real reconciler mounted between frames, as an interactive session does. */
export function createSession() {
  const root = createNode('ink-root')
  root.focusManager = new FocusManager(() => false)
  const noop = () => {}
  const throwError = (error: unknown) => { throw error }
  const container = reconciler.createContainer(root, LegacyRoot, null, false, null,
    'theme-test', throwError, throwError, throwError, noop)
  const styles = new StylePool()
  const chars = new CharPool()
  const links = new HyperlinkPool()
  const scrollRef = React.createRef<ScrollBoxHandle>()
  let setTheme: ((theme: ThemeName) => void) | undefined

  function ThemeControl() {
    const [, setter] = useTheme()
    setTheme = setter
    return null
  }

  function paint(width: number) {
    reconciler.flushSyncWork()
    root.yogaNode!.setWidth(width)
    root.yogaNode!.calculateLayout(width)
    const height = Math.ceil(root.yogaNode!.getComputedHeight())
    const screen = createScreen(width, Math.max(1, height), styles, chars, links)
    const output = new Output({ width, height, stylePool: styles, screen })
    resetLayoutShifted()
    renderNodeToOutput(root, output, { prevScreen: undefined })
    output.get()
    const lines = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => cellAt(screen, x, y)!.char).join('').trimEnd())
    return {
      height,
      lines,
      styleAt(x: number, y: number) {
        return styles.get(cellAt(screen, x, y)!.styleId).map(code => code.code).join('')
      },
    }
  }

  return {
    scrollRef,
    switchTheme(theme: ThemeName) { setTheme!(theme) },
    paint,
    render({ theme = 'dark', columns = 40, rows = 24, count = 1, imageRows = 0,
      fullscreen = false, picker = false, ansi = false } = {}) {
      let content = picker ? <Text>{'Theme picker\nDark\nMacchiato\nWhite'}</Text>
        : ansi ? <Box flexDirection="column">
          <Ansi>{'Plain\n\x1b[2mMuted\x1b[22m\n\x1b[38;2;12;150;70mExplicit\x1b[39m\nReset'}</Ansi>
        </Box>
        : <Box flexDirection="column" flexShrink={0}>
          {Array.from({ length: count }, (_, i) => <Text key={i}>{`Message ${i}`}</Text>)}
          {imageRows > 0 && <Box height={imageRows} flexShrink={0}><Text>Image rows</Text></Box>}
          <Text>After image</Text>
        </Box>
      if (!picker && !ansi) {
        const prompt = <Box borderStyle="round" flexShrink={0}><Text>Prompt</Text></Box>
        content = fullscreen ? <AlternateScreen mouseTracking={false}>
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} flexShrink={1} stickyScroll>{content}</ScrollBox>
          {prompt}
        </AlternateScreen> : <Box flexDirection="column">{content}{prompt}</Box>
      }
      const element = <TerminalSizeContext.Provider value={{ columns, rows }}>
        <ThemeProvider initialState={theme} onThemeSave={noop}>
          <ThemeControl />{content}
        </ThemeProvider>
      </TerminalSizeContext.Provider>
      const previousLevel = chalk.level
      chalk.level = 3
      try {
        reconciler.updateContainerSync(element, container, null, noop)
        return paint(columns)
      } finally {
        chalk.level = previousLevel
      }
    },
    close() {
      reconciler.updateContainerSync(null, container, null, noop)
      reconciler.flushSyncWork()
    },
  }
}
