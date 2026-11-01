import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import figures from 'figures'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'dist'), { recursive: true })
const outputDirectory = mkdtempSync(join(root, 'dist', 'prompt-frame-test-'))
after(() => rmSync(outputDirectory, { recursive: true, force: true }))

// The real frame, prompt message, layout and selection code, with the settings and
// state singletons they read swapped out, so this stays a fast rendering test.
const stubs = {
  flags: 'export const feature = () => false',
  declarations: '',
  config: 'export const getGlobalConfig = () => ({ theme: "dark" }); export const saveGlobalConfig = () => {}',
  settings: 'export const getInitialSettings = () => ({ powerMode: "normal" })',
  debug: 'export const logForDebugging = () => {}',
  growthbook: 'export const getFeatureValue_CACHED_MAY_BE_STALE = (_, fallback) => fallback',
  appState: 'export const useAppState = () => undefined',
  thinking: 'export const findThinkingTriggerPositions = () => []; export const getRainbowColor = () => "text"; export const isUltrathinkEnabled = () => false',
  messageActions: 'import { createContext } from "react"; export const MessageActionsSelectedContext = createContext(false)',
}
const stubFor = [
  [/(?:^|\/)global\.d\.ts$/, 'declarations'],
  [/(?:^|\/)utils\/config\.js$/, 'config'],
  [/(?:^|\/)settings\/settings\.js$/, 'settings'],
  [/(?:^|\/)utils\/debug\.js$/, 'debug'],
  [/(?:^|\/)analytics\/growthbook\.js$/, 'growthbook'],
  [/(?:^|\/)state\/AppState\.js$/, 'appState'],
  [/(?:^|\/)utils\/thinking\.js$/, 'thinking'],
  [/(?:^|\/)messageActions\.js$/, 'messageActions'],
]

await build({
  entryPoints: [join(root, 'test', 'fixtures', 'prompt-frame.tsx')],
  outfile: join(outputDirectory, 'fixture.mjs'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { 'process.env.NODE_ENV': '"test"', 'process.env.USER_TYPE': '"external"' },
  external: ['../../utils/systemThemeWatcher.js'],
  plugins: [{
    name: 'prompt-frame-test-dependencies',
    setup(builder) {
      builder.onResolve({ filter: /^bun:bundle$/ }, () => ({ path: 'flags', namespace: 'frame-test' }))
      for (const [filter, path] of stubFor) {
        builder.onResolve({ filter }, () => ({ path, namespace: 'frame-test' }))
      }
      builder.onLoad({ filter: /.*/, namespace: 'frame-test' }, ({ path }) => ({ contents: stubs[path], loader: 'js', resolveDir: root }))
    },
  }],
})
const { createSession, getTheme, stringWidth } = await import(pathToFileURL(join(outputDirectory, 'fixture.mjs')).href)
const themes = ['dark', 'catppuccin-macchiato', 'light', 'lucent-orng']
// GitHub's Windows runners have no Unicode terminal, and draw this as ">".
const pointer = figures.pointer

/** Throws unless the framed rows form one clean rectangle no wider than the terminal. */
function assertRectangle(lines, columns) {
  const rows = lines.filter(line => line !== '')
  assert.ok(rows.length >= 3, `too few rows: ${rows.join('\n')}`)
  const width = stringWidth(rows[0])
  assert.ok(width <= columns, `frame is ${width} wide in ${columns} columns`)
  assert.match(rows[0], /^╭─+╮$/)
  assert.match(rows.at(-1), /^╰─+╯$/)
  assert.equal(stringWidth(rows.at(-1)), width)
  for (const row of rows.slice(1, -1)) {
    assert.ok(row.startsWith('│'), `no left side: ${row}`)
    assert.ok(row.endsWith('│'), `no right side: ${row}`)
    assert.equal(stringWidth(row), width, `row is not ${width} wide: ${row}`)
  }
  return rows
}
const textOf = rows => rows.slice(1, -1).map(row => row.slice(1, -1)).join('').replace(/\s/g, '')

test('a short prompt gets a frame that hugs it', () => {
  const session = createSession()
  try {
    assert.deepEqual(session.prompt('hello', { columns: 80 }).lines, [
      '╭─────────╮',
      `│ ${pointer} hello │`,
      '╰─────────╯',
    ])
  } finally { session.close() }
})

test('the margin row stays above the frame', () => {
  const session = createSession()
  try {
    assert.deepEqual(session.prompt('hello', { columns: 80, addMargin: true }).lines, [
      '',
      '╭─────────╮',
      `│ ${pointer} hello │`,
      '╰─────────╯',
    ])
  } finally { session.close() }
})

test('long prompts wrap inside the frame at every width down to the minimum', () => {
  const session = createSession()
  const text = 'the quick brown fox jumps over the lazy dog '.repeat(12).trim()
  try {
    for (let columns = 16; columns <= 90; columns += 1) {
      const rows = assertRectangle(session.prompt(text, { columns }).lines, columns)
      assert.equal(textOf(rows), `${pointer}${text}`.replace(/\s/g, ''), `text changed at ${columns} columns`)
    }
  } finally { session.close() }
})

test('awkward text stays inside the frame', () => {
  const session = createSession()
  const samples = {
    unbroken: 'x'.repeat(400),
    wide: '你好世界 日本語のテキスト 한국어 텍스트 '.repeat(6),
    emoji: '🎉🚀 party ✔ done ⚠ careful '.repeat(8),
    combining: 'éà café '.repeat(20),
    tabs: 'one\ttwo\t\tthree\tfour',
    windowsLines: 'first\r\nsecond\rthird\nfourth',
    blankLines: 'above\n\n\nbelow',
    onlySpaces: 'a    b    c',
  }
  try {
    for (const [name, text] of Object.entries(samples)) {
      for (const columns of [16, 17, 23, 40, 77, 120]) {
        assert.doesNotThrow(() => assertRectangle(session.prompt(text, { columns }).lines, columns), `${name} at ${columns}`)
      }
    }
  } finally { session.close() }
})

test('very narrow terminals drop the frame and never crash', () => {
  const session = createSession()
  try {
    for (let columns = 15; columns >= 1; columns -= 1) {
      const { lines } = session.prompt('a prompt that has to wrap a lot', { columns })
      assert.ok(!lines.some(line => /[╭╮╰╯]/.test(line)), `frame at ${columns} columns: ${lines.join('|')}`)
    }
    assert.equal(session.prompt('hi', { columns: 15 }).lines[0], `${pointer} hi`)
  } finally { session.close() }
})

test('a narrow container keeps the frame inside it', () => {
  const session = createSession()
  try {
    const { lines } = session.prompt('words that need more room than the container can give them', { columns: 100, containerWidth: 24 })
    assertRectangle(lines, 24)
  } finally { session.close() }
})

test('resizing the same mounted prompt re-wraps it cleanly, both ways', () => {
  const session = createSession()
  const text = 'resize me and keep the box square, whatever the width turns out to be '.repeat(3).trim()
  try {
    for (const columns of [100, 60, 30, 16, 12, 30, 100, 200, 40]) {
      const { lines } = session.prompt(text, { columns })
      if (columns >= 16) assertRectangle(lines, columns)
      else assert.ok(!lines.some(line => /[╭╮╰╯]/.test(line)))
    }
  } finally { session.close() }
})

test('the frame takes its color from the theme and follows a live theme switch', () => {
  const session = createSession()
  const foreground = color => `38;2;${color.match(/\d+/g).join(';')}`
  try {
    for (const theme of themes) {
      const frame = session.prompt('hello', { theme, columns: 40 })
      const expected = foreground(getTheme(theme).borderActive)
      assert.ok(frame.styleAt(0, 0).includes(expected), `${theme} corner: ${frame.styleAt(0, 0)}`)
      assert.ok(frame.styleAt(0, 1).includes(expected), `${theme} side: ${frame.styleAt(0, 1)}`)
      // The pointer matches the frame; the words keep the theme's text color.
      assert.ok(frame.styleAt(2, 1).includes(expected), `${theme} pointer: ${frame.styleAt(2, 1)}`)
      assert.ok(frame.styleAt(4, 1).includes(foreground(getTheme(theme).text)), `${theme} text: ${frame.styleAt(4, 1)}`)
    }
  } finally { session.close() }
})

test('a painted canvas continues under the frame, and a transparent one stays transparent', () => {
  const session = createSession()
  const background = color => `48;2;${color.match(/\d+/g).join(';')}`
  try {
    for (const theme of ['light', 'catppuccin-macchiato']) {
      const frame = session.prompt('hello', { theme, columns: 40 })
      const expected = background(getTheme(theme).canvas)
      for (const [x, y] of [[0, 0], [0, 1], [1, 1], [4, 1], [8, 1], [0, 2]]) {
        assert.ok(frame.styleAt(x, y).includes(expected), `${theme} at ${x},${y}: ${frame.styleAt(x, y)}`)
      }
    }
    for (const theme of ['dark', 'lucent-orng']) {
      const frame = session.prompt('hello', { theme, columns: 40 })
      for (const [x, y] of [[0, 0], [0, 1], [4, 1]]) {
        assert.ok(!frame.styleAt(x, y).includes('48;'), `${theme} painted ${x},${y}: ${frame.styleAt(x, y)}`)
      }
    }
  } finally { session.close() }
})

test('the folded form is what shows, while Ctrl+O and files show the full text', () => {
  const session = createSession()
  const full = 'explain\nline one\nline two\nline three'
  const foldedText = '[Pasted text #3 +3 lines] explain'
  try {
    let { lines } = session.prompt(full, { columns: 60, foldedText })
    assert.deepEqual(lines, [
      '╭─────────────────────────────────────╮',
      `│ ${pointer} [Pasted text #3 +3 lines] explain │`,
      '╰─────────────────────────────────────╯',
    ])
    // With no folded form, the whole prompt shows inside the frame.
    lines = session.prompt(full, { columns: 60 }).lines
    assert.ok(lines.some(line => line.includes('line three')))
    assertRectangle(lines, 60)
  } finally { session.close() }
})

test('the fold applies on screen only: Ctrl+O and files get the full text', () => {
  const session = createSession()
  const display = '[Pasted text #3 +3 lines] explain'
  try {
    assert.equal(session.foldedFor(display), display)
    assert.equal(session.foldedFor(display, { isTranscriptMode: true }), 'FULL TEXT')
    assert.equal(session.foldedFor(display, { plain: true }), 'FULL TEXT')
    assert.equal(session.foldedFor(undefined), 'FULL TEXT')
  } finally { session.close() }
})

test('text written to a file has no frame', () => {
  const session = createSession()
  try {
    assert.deepEqual(session.prompt('hello', { columns: 40, plain: true }).lines, [`${pointer} hello`])
  } finally { session.close() }
})

test('a queued preview has no frame: it has not been sent and rows are short there', () => {
  const session = createSession()
  try {
    const { lines } = session.prompt('waiting my turn', { columns: 40, queued: true })
    assert.ok(!lines.some(line => /[╭╮╰╯]/.test(line)), lines.join('|'))
    assert.ok(lines.some(line => line.includes('waiting my turn')))
  } finally { session.close() }
})

test('a bash line keeps its own frame color', () => {
  const session = createSession()
  const foreground = color => `38;2;${color.match(/\d+/g).join(';')}`
  try {
    for (const theme of themes) {
      const frame = session.bashRow('echo hi', { theme, columns: 40 })
      assert.deepEqual(frame.lines, ['╭───────────╮', '│ ! echo hi │', '╰───────────╯'])
      assert.ok(frame.styleAt(0, 0).includes(foreground(getTheme(theme).bashBorder)), theme)
    }
    assertRectangle(session.bashRow('echo a very long command line that must wrap around '.repeat(4), { columns: 30 }).lines, 30)
  } finally { session.close() }
})

test('copying a framed prompt gives the text, not the box', () => {
  const session = createSession()
  try {
    const frame = session.prompt('first line of the prompt\nsecond line of the prompt', { columns: 50 })
    const copied = frame.selectRows(0, frame.height - 1)
    assert.ok(!/[╭╮╰╯│─]/.test(copied), JSON.stringify(copied))
    assert.equal(copied.trim(), `${pointer} first line of the prompt\nsecond line of the prompt`)

    // Soft-wrapped rows join back into the line that was typed, even with the
    // frame's right side at the end of each row.
    const text = 'a long sentence that has to wrap more than once inside of this frame'
    const wrapped = session.prompt(text, { columns: 30 })
    assert.ok(wrapped.height > 3)
    assert.equal(wrapped.selectRows(0, wrapped.height - 1).trim(), `${pointer} ${text}`)

    // A border row has nothing to copy.
    assert.equal(wrapped.selectRows(0, 0).trim(), '')
  } finally { session.close() }
})

test('rows an inline image reserved start below the frame and move with it', () => {
  const session = createSession()
  try {
    for (const columns of [100, 40, 20, 16, 10]) {
      const { lines } = session.promptThenImage('a prompt that wraps when the terminal gets narrow enough', 6, { columns })
      const closes = lines.findLastIndex(line => line.startsWith('╰'))
      const lastPromptRow = closes >= 0 ? closes : lines.findIndex(line => line.includes('Image rows')) - 1
      const image = lines.findIndex(line => line.includes('Image rows'))
      assert.equal(image, lastPromptRow + 1, `image starts at ${image}, prompt ends at ${lastPromptRow}`)
      assert.match(lines[image + 6], /^After/)
      assert.deepEqual(lines.slice(image + 1, image + 6), Array(5).fill(''))
    }
  } finally { session.close() }
})

test('narrowing a mounted answer never lets a diagram cover its last wrapped row', () => {
  const session = createSession()
  const code = 'const answer: number = 42 // the answer\nfunction greet(name: string) { return `hi ${name}` }'
  const words = code.replace(/\s/g, '')
  try {
    for (const columns of [100, 60, 30, 20, 60, 100, 26, 80, 30]) {
      const { lines } = session.answerWithDiagram(code, { columns })
      const top = lines.findIndex(line => line.includes('DIAGRAM TOP'))
      const above = lines.slice(0, top).join('').replace(/●/, '').replace(/\s/g, '')
      assert.equal(above, words, `at ${columns} columns:\n${lines.join('\n')}`)
      assert.equal(lines[top - 1], '', `no gap above the diagram at ${columns} columns:\n${lines.join('\n')}`)
    }
  } finally { session.close() }
})

test('in a scroll box frames count toward the height, clip cleanly, and follow to the bottom', () => {
  const session = createSession()
  const prompts = Array.from({ length: 12 }, (_, i) => `prompt number ${i}`)
  try {
    let frame = session.fullscreen(prompts, { rows: 12 })
    assert.equal(frame.height, 12)
    assert.equal(frame.lines[11], 'Footer')
    // Each prompt is a margin row, three frame rows and an answer; then the last row.
    assert.equal(session.scrollRef.current.getScrollHeight(), 12 * 5 + 1)
    assert.equal(session.scrollRef.current.getViewportHeight(), 11)
    assert.equal(frame.lines[10], 'Last row')

    // Scrolled so a frame is cut at the top and another at the bottom: no stray rows.
    for (const top of [0, 1, 2, 3, 4, 7, 19, 33]) {
      session.scrollRef.current.scrollTo(top)
      frame = session.fullscreen(prompts, { rows: 12 })
      assert.equal(frame.lines[11], 'Footer', `footer overwritten at ${top}`)
      for (const line of frame.lines.slice(0, 11)) {
        assert.ok(line === '' || /^[╭╰│]/.test(line) || /^Answer \d+$/.test(line) || line === 'Last row', `at ${top}: ${line}`)
      }
    }

    session.scrollRef.current.scrollToBottom()
    frame = session.fullscreen(prompts, { rows: 12 })
    assert.equal(frame.lines[10], 'Last row')
  } finally { session.close() }
})
