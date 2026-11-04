import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount, KEYS } from './helpers/ink-built-runtime.mjs'

const configDir = mkdtempSync(join(tmpdir(), 'tau-prompt-menu-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.DISABLE_TELEMETRY = '1'
process.env.DISABLE_ERROR_REPORTING = '1'
process.env.TERM = 'xterm-256color'
const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
after(() => {
  if (originalTTY) Object.defineProperty(process.stdout, 'isTTY', originalTTY)
  else delete process.stdout.isTTY
})
after(() => rmSync(configDir, { recursive: true, force: true }))
const ui = await loadBuiltRuntime({
  paths: ['src/components/FullscreenLayout.tsx', 'src/components/MessageSelector.tsx', 'src/components/LogSelector.tsx', 'src/components/design-system/Tabs.tsx'],
  exports: ['FullscreenLayout', 'setIsInteractive', 'useSetPromptOverlay', 'Box', 'Text', 'MessageSelector', 'LogSelector', 'createUserMessage', 'useTerminalSize', 'getOriginalCwd', 'Tabs', 'Tab', 'resetGitFileWatcher: () => gitWatcher.reset()'],
})
after(() => ui.resetGitFileWatcher())

test('a tall command opens at its beginning and exposes its full content by scrolling', async () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  ui.setIsInteractive(true)
  const modalScrollRef = React.createRef()
  let finishLoading
  function Command() {
    const [loaded, setLoaded] = React.useState(false)
    finishLoading = () => setLoaded(true)
    return loaded ? h(ui.Box, { flexDirection: 'column' },
      ...Array.from({ length: 50 }, (_, i) => h(ui.Text, { key: i }, 'Command row ' + i))) : h(ui.Text, null, 'Loading command')
  }
  const screen = await mount(ui, h(ui.Box, { height: 20, flexDirection: 'column' }, h(ui.FullscreenLayout, {
    modalScrollRef, modal: h(Command),
    scrollable: h(ui.Text, null, 'TRANSCRIPT'), bottom: h(ui.Text, null, 'PROMPT'),
  })), { columns: 80, rows: 20 })
  try {
    await screen.waitFor(/Loading command/)
    finishLoading()
    await screen.waitFor(/Command row 0/)
    assert.doesNotMatch(screen.frame(), /Command row 49/)
    modalScrollRef.current.scrollToBottom()
    await screen.waitFor(/Command row 49/)
    assert.equal(screen.frame().split('\n').length, 20)
    modalScrollRef.current.scrollTo(0)
    await screen.waitFor(/Command row 0/)
  } finally { screen.close(); ui.setIsInteractive(false) }
})

test('switching command tabs resets the shared viewport to the new content', async () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  ui.setIsInteractive(true)
  const modalScrollRef = React.createRef()
  const modal = h(ui.Tabs, { useFullWidth: true },
    h(ui.Tab, { title: 'First' }, h(ui.Box, { flexDirection: 'column' },
      ...Array.from({ length: 45 }, (_, i) => h(ui.Text, { key: i }, 'First row ' + i)))),
    h(ui.Tab, { title: 'Second' }, h(ui.Text, null, 'SECOND CONTENT')))
  const screen = await mount(ui, h(ui.Box, { height: 20, flexDirection: 'column' }, h(ui.FullscreenLayout, {
    modalScrollRef, modal, scrollable: h(ui.Text, null, 'TRANSCRIPT'), bottom: h(ui.Text, null, 'PROMPT'),
  })), { columns: 80, rows: 20 })
  try {
    await screen.waitFor(/First row 0/)
    modalScrollRef.current.scrollToBottom()
    await screen.waitFor(/First row 44/)
    await screen.press('\x1b[C')
    await screen.waitFor(/SECOND CONTENT/)
    assert.equal(modalScrollRef.current.getScrollTop(), 0)
    await screen.press('\x1b[D')
    await screen.waitFor(/First row 0/)
  } finally { screen.close(); ui.setIsInteractive(false) }
})

test('Rewind keeps its selected entry and footer visible and navigates to the first message', async () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  ui.setIsInteractive(true)
  const messages = Array.from({ length: 20 }, (_, i) => ui.createUserMessage({ content: 'Prompt number ' + i }))
  try {
    for (const [columns, rows] of [[120, 32], [80, 24], [50, 16], [40, 12]]) {
      const screen = await mount(ui, h(ui.Box, { height: rows, flexDirection: 'column' }, h(ui.FullscreenLayout, {
        expandedBottom: true, scrollable: h(ui.Text, null, 'TRANSCRIPT'),
        bottom: h(ui.MessageSelector, { messages, onClose() {}, onPreRestore() {}, onRestoreMessage() {}, onRestoreCode() {}, onSummarize() {} }),
      })), { columns, rows })
      try {
        await screen.waitFor(/\(current\)/)
        assert.match(screen.frame(), /Esc to\s+exit/)
        assert.equal(screen.frame().split('\n').length, rows)
        for (let i = 0; i < 20; i++) await screen.press(KEYS.up)
        assert.match(screen.frame(), /Prompt number 0/)
        assert.match(screen.frame(), /Esc to\s+exit/)
      } finally { screen.close() }
    }
  } finally { ui.setIsInteractive(false) }
})

test('Resume receives the actual modal dimensions and shows its first entry and controls', async () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  ui.setIsInteractive(true)
  const logs = Array.from({ length: 25 }, (_, i) => ({
    value: i, messages: [], sessionId: 'session-' + i, firstPrompt: 'Saved session ' + i,
    customTitle: 'Saved session ' + i, date: '2026-11-01', created: new Date('2026-11-01'), modified: new Date('2026-11-01'),
    messageCount: 4, isSidechain: false, isLite: true, projectPath: ui.getOriginalCwd(),
  }))
  function Resume() {
    const { rows } = ui.useTerminalSize()
    return h(ui.LogSelector, { logs, maxHeight: rows, onSelect() {}, onCancel() {} })
  }
  try {
    for (const [columns, rows] of [[120, 32], [80, 24], [50, 16]]) {
      const screen = await mount(ui, h(ui.Box, { height: rows, flexDirection: 'column' }, h(ui.FullscreenLayout, {
        modal: h(Resume), scrollable: h(ui.Text, null, 'TRANSCRIPT'), bottom: h(ui.Text, null, 'PROMPT'),
      })), { columns, rows })
      try {
        await screen.waitFor(/Saved session 0/)
        assert.match(screen.frame(), /Resume Session/)
        assert.match(screen.frame(), /Esc\s+to\s+cancel/)
        assert.equal(screen.frame().split('\n').length, rows)
        for (let i = 0; i < 24; i++) await screen.press(KEYS.down)
        assert.match(screen.frame(), /Saved session 24/)
      } finally { screen.close() }
    }
  } finally { ui.setIsInteractive(false) }
})
const h = React.createElement
const menu = {
  suggestions: Array.from({ length: 10 }, (_, i) => ({
    id: 'command-' + i, displayText: '/command' + i, description: 'Long description '.repeat(15),
  })),
  selectedSuggestion: 7,
}
function Prompt() {
  ui.useSetPromptOverlay(menu)
  return h(ui.Box, { flexDirection: 'column' }, h(ui.Text, null, 'PROMPT'), h(ui.Text, null, 'STATUS'))
}

test('slash suggestions use the space below both fresh and docked prompts', async () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  process.env.TERM = 'xterm-256color'
  ui.setIsInteractive(true)
  try {
    for (const [columns, rows, centered] of [[120, 30, true], [61, 16, true], [100, 14, true], [120, 30, false], [50, 8, false]]) {
      const screen = await mount(ui, h(ui.Box, { height: rows, flexDirection: 'column' },
        h(ui.FullscreenLayout, {
          centerBottom: centered, bottom: h(Prompt), scrollable: h(ui.Text, null, 'WELCOME'),
        })), { columns, rows })
      try {
        await screen.waitFor(/\/command7/)
        const lines = screen.frame().split('\n')
        const prompt = lines.findIndex(line => line.includes('PROMPT'))
        const status = lines.findIndex(line => line.includes('STATUS'))
        const items = lines.flatMap((line, y) => line.includes('/command') ? [y] : [])
        assert.ok(lines.some(line => line.includes('WELCOME')))
        assert.equal(status, prompt + 1)
        const left = lines[prompt].indexOf('PROMPT')
        for (const y of items) {
          assert.ok(y > status && y < rows, 'menu placement\n' + lines.join('\n'))
          assert.equal(lines[y].indexOf('/command'), left + 2)
          assert.ok(lines[y].length <= columns - left + 1)
        }
        assert.ok(items.length > 0 && items.length <= 5)
      } finally { screen.close() }
    }
  } finally {
    ui.setIsInteractive(false)
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
    else delete process.stdout.isTTY
  }
})
