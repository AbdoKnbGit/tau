import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'dist'), { recursive: true })
const outputDirectory = mkdtempSync(join(root, 'dist', 'theme-layout-test-'))
after(() => rmSync(outputDirectory, { recursive: true, force: true }))

// Bundle build flags and external settings dependencies in isolation. Global
// module mocks would change unrelated tests when Bun runs them in one process.
await build({
  entryPoints: [join(root, 'test', 'fixtures', 'theme-layout.tsx')],
  outfile: join(outputDirectory, 'fixture.mjs'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  define: { 'process.env.NODE_ENV': '"test"', 'process.env.USER_TYPE': '"external"' },
  external: ['../../utils/systemThemeWatcher.js'],
  plugins: [{
    name: 'theme-test-dependencies',
    setup(builder) {
      builder.onResolve({ filter: /^bun:bundle$/ }, () => ({ path: 'flags', namespace: 'theme-test' }))
      builder.onResolve({ filter: /(?:^|\/)global\.d\.ts$/ }, () => ({ path: 'declarations', namespace: 'theme-test' }))
      builder.onResolve({ filter: /(?:^|\/)utils\/config\.js$/ }, () => ({ path: 'config', namespace: 'theme-test' }))
      builder.onResolve({ filter: /(?:^|\/)settings\/settings\.js$/ }, () => ({ path: 'settings', namespace: 'theme-test' }))
      builder.onResolve({ filter: /(?:^|\/)utils\/debug\.js$/ }, () => ({ path: 'debug', namespace: 'theme-test' }))
      builder.onLoad({ filter: /.*/, namespace: 'theme-test' }, ({ path }) => ({ contents: ({
        flags: 'export const feature = () => false',
        declarations: '',
        config: 'export const getGlobalConfig = () => ({ theme: "dark" }); export const saveGlobalConfig = () => {}',
        settings: 'export const getInitialSettings = () => ({ powerMode: "normal" })',
        debug: 'export const logForDebugging = () => {}',
      })[path], loader: 'js' }))
    },
  }],
})
const { createSession, getTheme } = await import(pathToFileURL(join(outputDirectory, 'fixture.mjs')).href)
const themes = ['dark', 'catppuccin-macchiato', 'light']

test('theme canvases retain natural short transcript and picker heights', () => {
  for (const theme of themes) {
    for (const rows of [12, 35]) {
      const session = createSession()
      try {
        assert.equal(session.render({ theme, rows }).height, 5)
        const picker = session.render({ theme, rows, picker: true })
        assert.equal(picker.height, 4)
        assert.deepEqual(picker.lines, ['Theme picker', 'Dark', 'Macchiato', 'White'])
      } finally { session.close() }
    }
  }
})

test('long transcripts keep image reservations and prompts in document order in every theme', () => {
  for (const theme of themes) {
    const session = createSession()
    try {
      const frame = session.render({ theme, rows: 12, count: 30, imageRows: 7 })
      assert.equal(frame.height, 41)
      assert.equal(frame.lines[29], 'Message 29')
      assert.equal(frame.lines[30], 'Image rows')
      assert.deepEqual(frame.lines.slice(31, 37), Array(6).fill(''))
      assert.equal(frame.lines[37], 'After image')
      assert.match(frame.lines[39], /Prompt/)
    } finally { session.close() }
  }
})

test('theme switches and terminal resizes preserve main-screen geometry', () => {
  const session = createSession()
  try {
    for (const columns of [40, 18, 70]) {
      const baseline = session.render({ columns, count: 15, imageRows: 6 })
      for (const theme of themes) {
        session.switchTheme(theme)
        const frame = session.render({ columns, rows: 10, count: 15, imageRows: 6 })
        assert.deepEqual(frame.lines, baseline.lines)
        assert.equal(frame.height, baseline.height)
      }
    }
  } finally { session.close() }
})

test('alternate screen retains its viewport, manual scroll, and sticky append across themes', () => {
  const session = createSession()
  try {
    const options = { rows: 12, fullscreen: true, count: 30 }
    let frame = session.render(options)
    assert.equal(frame.height, 12)
    assert.match(frame.lines[10], /Prompt/)
    assert.equal(session.scrollRef.current.getViewportHeight(), 9)
    assert.equal(session.scrollRef.current.getScrollHeight(), 31)
    assert.equal(session.scrollRef.current.getScrollTop(), 22)
    session.scrollRef.current.scrollTo(4)
    frame = session.render(options)
    assert.equal(frame.lines[0], 'Message 4')
    for (const theme of themes) {
      session.switchTheme(theme)
      frame = session.render({ ...options, count: 33 })
      assert.equal(frame.lines[0], 'Message 4')
      assert.match(frame.lines[10], /Prompt/)
      assert.equal(frame.height, 12)
    }
    session.scrollRef.current.scrollToBottom()
    frame = session.render({ ...options, count: 34 })
    assert.equal(frame.lines[8], 'After image')
    assert.equal(session.scrollRef.current.getScrollTop(), 26)
    frame = session.render({ ...options, rows: 16, count: 36 })
    assert.equal(frame.height, 16)
    assert.equal(session.scrollRef.current.getViewportHeight(), 13)
    assert.equal(frame.lines[12], 'After image')
    assert.match(frame.lines[14], /Prompt/)
  } finally { session.close() }
})

test('ANSI defaults and dim spans follow theme switches while explicit colors remain intact', () => {
  const session = createSession()
  const foreground = color => `38;2;${color.match(/\d+/g).join(';')}`
  try {
    session.render({ ansi: true })
    for (const theme of themes) {
      session.switchTheme(theme)
      const frame = session.render({ ansi: true })
      assert.deepEqual(frame.lines, ['Plain', 'Muted', 'Explicit', 'Reset'])
      assert.ok(frame.styleAt(0, 0).includes(foreground(getTheme(theme).text)))
      assert.ok(frame.styleAt(0, 1).includes(foreground(getTheme(theme).inactive)))
      assert.ok(frame.styleAt(0, 2).includes('38;2;12;150;70'))
      assert.ok(frame.styleAt(0, 3).includes(foreground(getTheme(theme).text)))
    }
  } finally { session.close() }
})
