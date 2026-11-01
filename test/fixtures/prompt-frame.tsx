import React from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'
import chalk from 'chalk'
import { ThemeProvider, useTheme } from '../../src/components/design-system/ThemeProvider.js'
import Text from '../../src/components/design-system/ThemedText.js'
import { PlainTranscriptContext, useFoldedPrompt, UserPromptFrame } from '../../src/components/messages/UserPromptFrame.js'
import { UserPromptMessage } from '../../src/components/messages/UserPromptMessage.js'
import { QueuedMessageProvider } from '../../src/context/QueuedMessageContext.js'
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
import { createSelectionState, finishSelection, getSelectedText, startSelection, updateSelection } from '../../src/ink/selection.js'
import { stringWidth } from '../../src/ink/stringWidth.js'
import { getTheme, type ThemeName } from '../../src/utils/theme.js'

export { getTheme, stringWidth }

/** Keep the real reconciler mounted between frames, as an interactive session does. */
export function createSession() {
  const root = createNode('ink-root')
  root.focusManager = new FocusManager(() => false)
  const noop = () => {}
  const throwError = (error: unknown) => { throw error }
  const container = reconciler.createContainer(root, LegacyRoot, null, false, null,
    'prompt-frame-test', throwError, throwError, throwError, noop)
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
    // Wide characters hold a blank spacer cell, so rebuild rows by display width.
    const lines = Array.from({ length: height }, (_, y) => {
      let row = ''
      for (let x = 0; x < width; x += 1) {
        const char = cellAt(screen, x, y)!.char
        if (char !== '') row += char
      }
      return row.trimEnd()
    })
    return {
      height,
      lines,
      styleAt(x: number, y: number) {
        return styles.get(cellAt(screen, x, y)!.styleId).map(code => code.code).join('')
      },
      /** What a drag across the whole frame would copy. */
      selectRows(fromRow: number, toRow: number) {
        const selection = createSelectionState()
        startSelection(selection, 0, fromRow)
        updateSelection(selection, width - 1, toRow)
        finishSelection(selection)
        return getSelectedText(selection, screen)
      },
    }
  }

  function draw(element: React.ReactNode, { theme = 'dark' as ThemeName, columns = 40, rows = 24 } = {}) {
    const tree = <TerminalSizeContext.Provider value={{ columns, rows }}>
      <ThemeProvider initialState={theme} onThemeSave={noop}>
        <ThemeControl />{element}
      </ThemeProvider>
    </TerminalSizeContext.Provider>
    // initialState only counts on mount, so a mounted session switches like a user would.
    setTheme?.(theme)
    const previousLevel = chalk.level
    chalk.level = 3
    try {
      reconciler.updateContainerSync(tree, container, null, noop)
      return paint(columns)
    } finally {
      chalk.level = previousLevel
    }
  }

  return {
    scrollRef,
    switchTheme(theme: ThemeName) { setTheme!(theme) },
    prompt(text: string, options: {
      theme?: ThemeName
      columns?: number
      addMargin?: boolean
      foldedText?: string
      isTranscriptMode?: boolean
      plain?: boolean
      queued?: boolean
      containerWidth?: number
    } = {}) {
      const { addMargin = false, foldedText, isTranscriptMode, plain = false, queued = false, containerWidth } = options
      let element: React.ReactNode = <UserPromptMessage addMargin={addMargin}
        param={{ type: 'text', text }} foldedText={foldedText} isTranscriptMode={isTranscriptMode} />
      if (queued) element = <QueuedMessageProvider isFirst useBriefLayout={false}>{element}</QueuedMessageProvider>
      if (plain) element = <PlainTranscriptContext.Provider value={true}>{element}</PlainTranscriptContext.Provider>
      return draw(<Box flexDirection="column" width={containerWidth ?? '100%'}>{element}</Box>, options)
    },
    /** What UserTextMessage hands the prompt, on screen, in Ctrl+O, and for a file. */
    foldedFor(display: string | undefined, { isTranscriptMode = false, plain = false } = {}) {
      function Probe() {
        return <Text>{useFoldedPrompt(display, isTranscriptMode) ?? 'FULL TEXT'}</Text>
      }
      const element = plain
        ? <PlainTranscriptContext.Provider value={true}><Probe /></PlainTranscriptContext.Provider>
        : <Probe />
      return draw(element, { columns: 60 }).lines[0]
    },
    bashRow(input: string, options: { theme?: ThemeName, columns?: number } = {}) {
      return draw(<UserPromptFrame addMargin={false} flexDirection="row" borderColor="bashBorder">
        <Text color="bashBorder">! </Text><Text color="text">{input}</Text>
      </UserPromptFrame>, options)
    },
    /** A prompt followed by rows an inline image has reserved, then more transcript. */
    promptThenImage(text: string, imageRows: number, options: { columns?: number } = {}) {
      return draw(<Box flexDirection="column">
        <UserPromptMessage addMargin={true} param={{ type: 'text', text }} />
        <Box height={imageRows} flexShrink={0}><Text>Image rows</Text></Box>
        <Text>After image</Text>
      </Box>, options)
    },
    /** The shape of an answer: a dot, then wrapping text, then a diagram below it. */
    answerWithDiagram(code: string, options: { columns?: number } = {}) {
      return draw(<Box alignItems="flex-start" flexDirection="row" justifyContent="space-between" width="100%">
        <Box flexDirection="row">
          <Box minWidth={2} flexShrink={0}><Text>●</Text></Box>
          <Box flexDirection="column">
            <Box flexDirection="column" gap={1}>
              <Ansi>{code}</Ansi>
              <Box flexDirection="column">
                <Text wrap="truncate-end">DIAGRAM TOP</Text>
                <Text wrap="truncate-end">DIAGRAM BOTTOM</Text>
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>, options)
    },
    fullscreen(prompts: string[], options: { columns?: number, rows?: number, theme?: ThemeName } = {}) {
      return draw(<AlternateScreen mouseTracking={false}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} flexShrink={1} stickyScroll>
          <Box flexDirection="column" flexShrink={0}>
            {prompts.map((text, i) => <React.Fragment key={i}>
              <UserPromptMessage addMargin={true} param={{ type: 'text', text }} />
              <Text>{`Answer ${i}`}</Text>
            </React.Fragment>)}
            <Text>Last row</Text>
          </Box>
        </ScrollBox>
        <Box flexShrink={0}><Text>Footer</Text></Box>
      </AlternateScreen>, options)
    },
    paint,
    close() {
      reconciler.updateContainerSync(null, container, null, noop)
      reconciler.flushSyncWork()
    },
  }
}
