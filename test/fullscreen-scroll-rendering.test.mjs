import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { after, test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import React from 'react'
import sharp from 'sharp'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const configDir = mkdtempSync(join(tmpdir(), 'tau-fullscreen-scroll-'))
process.env.CLAUDE_CONFIG_DIR = configDir
after(() => rmSync(configDir, { recursive: true, force: true }))
const r = await loadBuiltRuntime({
  paths: ['src/ink/ink.tsx', 'src/ink/components/ScrollBox.tsx', 'src/hooks/useVirtualScroll.ts', 'src/components/InlineImage.tsx', 'src/components/FullscreenLayout.tsx'],
  exports: ['Ink', 'Box', 'Text', 'ScrollBox: ScrollBox_default', 'setGraphicsPlacement',
    'setCellPixelSize', 'setDeviceAttributes', 'getDrawnGraphicsSequence', 'nodeCache', 'useVirtualScroll', 'InlineImage',
    'encodeGraphicsRows', 'createClock', 'useAnimationFrame', 'FullscreenLayout', 'setIsInteractive'],
})
const h = React.createElement

function frameText(ink) {
  const screen = ink.frontFrame.screen
  return Array.from({ length: screen.height }, (_, y) => Array.from({ length: screen.width },
    (_, x) => r.cellAt(screen, x, y).char).join('')).join('\n')
}

test('a waiting spinner wakes after scrolling out and back without provider updates', async () => {
  let output = ''
  const stdout = Object.assign(new Writable({ write(chunk, _enc, cb) { output += chunk; cb() } }), { isTTY: true, columns: 60, rows: 16 })
  const stdin = new PassThrough()
  const ink = new r.Ink({ stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false })
  const scroll = React.createRef()
  let paints = 0
  const Spinner = React.memo(function Spinner() {
    const [ref, time] = r.useAnimationFrame(50, true)
    paints++
    return h(r.Box, { ref, height: 1, flexShrink: 0 }, h(r.Text, null, 'spin-' + Math.floor(time / 80)))
  })
  try {
    ink.setAltScreenActive(true)
    ink.render(h(r.Box, { height: 16, flexDirection: 'column' },
      h(r.ScrollBox, { ref: scroll, height: 15, flexShrink: 0, flexDirection: 'column', stickyScroll: true },
        h(r.Box, { height: 35, flexShrink: 0 }), h(Spinner)), h(r.Text, null, 'prompt')))
    await until(() => paints >= 4, 'spinner starts')
    await until(() => frameText(ink).includes('spin-'), 'initial spinner is visible')
    scroll.current.scrollTo(0)
    await pause(150)
    const hidden = paints
    await pause(200)
    assert.equal(paints, hidden, 'hidden ticks do not rerender React')
    scroll.current.scrollToBottom()
    await until(() => paints >= hidden + 4, 'animation resumes without a provider event')
    await until(() => frameText(ink).includes('spin-'), 'resumed spinner is visible')
  } finally { stdout.isTTY = false; ink.unmount(); stdin.destroy() }
})

test('adding and removing clock listeners cannot postpone a busy spinner tick', () => {
  const savedSet = globalThis.setInterval, savedClear = globalThis.clearInterval
  let starts = 0, clears = 0
  globalThis.setInterval = () => { starts++; return starts }
  globalThis.clearInterval = () => { clears++ }
  try {
    const clock = r.createClock(16)
    const stop = clock.subscribe(() => {}, true)
    for (let i = 0; i < 100; i++) clock.subscribe(() => {}, false)()
    assert.equal(starts, 1)
    assert.equal(clears, 0)
    clock.setTickInterval(32)
    assert.equal(starts, 2)
    stop()
    assert.equal(clears, 2)
  } finally {
    globalThis.setInterval = savedSet
    globalThis.clearInterval = savedClear
  }
})

test('cropped previews keep their original pixel scale for sixel, Kitty and iTerm2', async () => {
  const raw = Buffer.alloc(20 * 40 * 4)
  for (let i = 0; i < 20 * 40; i++) { raw[i * 4 + (i < 400 ? 0 : 2)] = 255; raw[i * 4 + 3] = 255 }
  const input = await sharp(raw, { raw: { width: 20, height: 40, channels: 4 } }).png().toBuffer()
  for (const protocol of ['sixel', 'kitty', 'iterm2']) {
    const box = { columns: 5, rows: 8, cellWidth: 4, cellHeight: 5, protocol }
    let pixels
    const output = await r.encodeGraphicsRows(input, box, 3, 2, 55, async (rgba, width, height) => {
      pixels = { width, height, bytes: rgba.length }
      assert.deepEqual([...rgba.slice(0, 4)], [255, 0, 0, 255])
      assert.deepEqual([...rgba.slice(-4)], [0, 0, 255, 255])
      return 'sixelframe'
    })
    if (protocol === 'sixel') assert.deepEqual(pixels, { width: 20, height: 10, bytes: 800 })
    else {
      const encoded = protocol === 'kitty' ? output.slice(output.indexOf(';') + 1, -2) : output.slice(output.indexOf(':') + 1, -1)
      const decoded = await sharp(Buffer.from(encoded, 'base64')).metadata()
      assert.equal(decoded.width, 20)
      assert.equal(decoded.height, 10)
      const rgba = await sharp(Buffer.from(encoded, 'base64')).ensureAlpha().raw().toBuffer()
      assert.deepEqual([...rgba.subarray(0, 4)], [255, 0, 0, 255])
      assert.deepEqual([...rgba.subarray(-4)], [0, 0, 255, 255])
    }
  }
})

async function until(check, message) {
  const end = Date.now() + 5000
  while (!check() && Date.now() < end) await pause(10)
  assert.ok(check(), message)
}

test('pinned transcript includes the final reply arriving during a resize without another input', async () => {
  const scrollRef = { current: { subscribe: () => () => {}, getScrollTop: () => 90,
    getPendingDelta: () => 0, getViewportHeight: () => 12, isSticky: () => true, setClampBounds() {} } }
  const keys = Array.from({ length: 70 }, (_, i) => String(i))
  let finish
  let firstCompletedTail
  function Transcript() {
    const [completed, setCompleted] = React.useState(false)
    finish = () => setCompleted(true)
    const items = completed ? [...keys, 'final-reply'] : keys
    const { range: [start, end] } = r.useVirtualScroll(scrollRef, items, completed ? 64 : 100)
    const tail = items.slice(start, end).at(-1)
    if (completed) firstCompletedTail ??= tail
    return h(r.Text, null, tail)
  }
  const screen = await mount(r, h(Transcript))
  try {
    await screen.waitFor(/69/)
    finish()
    await screen.waitFor(/final-reply/)
    assert.equal(firstCompletedTail, 'final-reply')
  } finally { screen.close() }
})

test('Ink scrolls cell previews and restores both graphics at their new rows without input', async () => {
  let output = ''
  const stdout = Object.assign(new Writable({ write(chunk, _enc, cb) { output += chunk; cb() } }), { isTTY: true, columns: 60, rows: 25 })
  const stdin = new PassThrough()
  const ink = new r.Ink({ stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false })
  const scroll = React.createRef(), nodes = new Map()
  const payload = id => '\x1bPq"1;1;8;6#0;2;100;0;0#0' + id + '\x1b\\'
  function ImageRow({ id }) {
    const ref = React.useRef(null)
    React.useLayoutEffect(() => {
      nodes.set(id, ref.current)
      r.setGraphicsPlacement(id, { node: ref.current, sequence: payload(id), rows: 2, columns: 4, cellWidth: 8, cellHeight: 16 })
      return () => r.setGraphicsPlacement(id, null)
    }, [id])
    return h(r.Box, { ref, height: 2, width: 4, flexShrink: 0 }, h(r.Text, null, 'img'))
  }
  try {
    r.setCellPixelSize({ width: 8, height: 16 })
    ink.setAltScreenActive(true)
    ink.render(h(r.Box, { height: 25, flexDirection: 'column' },
      h(r.ScrollBox, { ref: scroll, flexGrow: 1, flexDirection: 'column' },
        h(r.Box, { height: 8, flexShrink: 0 }), h(ImageRow, { id: 'A' }), h(ImageRow, { id: 'B' }),
        h(r.Box, { height: 30, flexShrink: 0 })),
      h(r.Text, null, 'prompt')))
    await until(() => output.includes(payload('B')), 'both graphics initially painted')
    const start = r.nodeCache.get(nodes.get('A')).y
    let offset = output.length
    scroll.current.scrollTo(3)
    await until(() => r.nodeCache.get(nodes.get('A'))?.y === start - 3, 'coordinates follow the real scroll')
    assert.equal(r.getDrawnGraphicsSequence('A'), undefined, 'old pixels removed during movement')
    await until(() => output.slice(offset).includes(payload('B')), 'pixels restored at rest without another render request from the test')
    assert.equal(output.slice(offset).split(payload('A')).length - 1, 1)
    offset = output.length
    scroll.current.scrollTo(28)
    await until(() => r.getDrawnGraphicsSequence('A') === undefined, 'culled image erased')
    await pause(200)
    assert.ok(!output.slice(offset).includes(payload('A')), 'an offscreen image stays offscreen')
  } finally {
    stdout.isTTY = false
    ink.unmount()
    stdin.destroy()
  }
})

test('two decoded inline previews repaint in a resized sixel viewport while preserving the prompt', async () => {
  const make = (color, format) => sharp({ create: { width: 48, height: 32, channels: 4, background: color } })
    .toFormat(format).toBuffer()
  const images = await Promise.all([make('#e04020', 'png'), make('#3050e0', 'gif')])
  const chunks = []
  const stdout = Object.assign(new Writable({ write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb() } }), { isTTY: true, columns: 90, rows: 35 })
  const stdin = new PassThrough()
  const ink = new r.Ink({ stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false })
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const oldEnv = process.env
  // Model a terminal answering the protocol probes, independent of the
  // developer's terminal. No graphics or clipboard writes go to that terminal.
  process.env = { ...oldEnv, TERM: 'xterm-256color' }
  for (const key of ['CI', 'TAU_INLINE_IMAGES', 'TAU_IMAGE_PROTOCOL', 'TMUX', 'STY', 'NO_COLOR', 'FORCE_COLOR', 'TERM_PROGRAM', 'KITTY_WINDOW_ID']) delete process.env[key]
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  const bothImagesPainted = () => {
    const colors = new Set()
    for (const [payload] of chunks.join('').matchAll(/\x1bP[0-9;]*q[\s\S]*?\x1b\\/g)) {
      for (const [, red, blue] of payload.matchAll(/#\d+;2;(\d+);\d+;(\d+)/g)) {
        if (Number(red) > Number(blue)) colors.add('red')
        if (Number(blue) > Number(red)) colors.add('blue')
      }
    }
    return colors.size === 2
  }
  try {
    r.setDeviceAttributes([62, 4])
    r.setCellPixelSize({ width: 8, height: 16 }, { columns: 90, rows: 35 })
    ink.setAltScreenActive(true)
    const store = r.createStore(r.getDefaultAppState())
    ink.render(h(r.AppStoreContext.Provider, { value: store }, h(r.Box, { flexDirection: 'column' },
      ...images.map((data, i) => h(r.InlineImage, { key: i, base64: data.toString('base64'), maxRows: 4 }, h(r.Text, null, 'photo-' + i))),
      h(r.Text, null, 'input-ready'))))
    await until(bothImagesPainted, 'PNG and GIF both emitted real sixel payloads')
    chunks.length = 0
    stdout.columns = 75
    stdout.rows = 28
    stdout.emit('resize')
    r.setCellPixelSize({ width: 9, height: 18 }, { columns: 75, rows: 28 })
    await until(bothImagesPainted, 'both previews redrawn at the new geometry without a keypress')
    assert.match(chunks.join(''), /input-ready/)
  } finally {
    stdout.isTTY = false
    ink.unmount()
    stdin.destroy()
    process.env = oldEnv
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
    else delete process.stdout.isTTY
  }
})

test('partly visible inline images recover sharp pixels at either edge and clear with the session', async () => {
  const data = await sharp({ create: { width: 48, height: 96, channels: 4, background: '#e04020' } }).png().toBuffer()
  const chunks = []
  const stdout = Object.assign(new Writable({ write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb() } }), { isTTY: true, columns: 80, rows: 20 })
  const stdin = new PassThrough()
  const ink = new r.Ink({ stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false })
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'), oldEnv = process.env
  process.env = { ...oldEnv, TERM: 'xterm-256color' }
  for (const key of ['CI', 'TAU_INLINE_IMAGES', 'TAU_IMAGE_PROTOCOL', 'TMUX', 'STY', 'NO_COLOR', 'FORCE_COLOR', 'TERM_PROGRAM', 'KITTY_WINDOW_ID']) delete process.env[key]
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  const scroll = React.createRef()
  let clear
  function View() {
    const [cleared, setCleared] = React.useState(false)
    clear = () => setCleared(true)
    return h(r.Box, { height: 20, flexDirection: 'column' }, h(r.FullscreenLayout, {
      transcriptKey: cleared ? 'new' : 'old', scrollRef: scroll, centerBottom: cleared,
      bottom: h(r.Text, null, 'input-ready'), scrollable: cleared ? h(r.Text, null, 'WELCOME') : h(React.Fragment, null,
        h(r.Box, { height: 25, flexShrink: 0 }), h(r.InlineImage, { base64: data.toString('base64'), maxRows: 6 }, null),
        h(r.Box, { height: 30, flexShrink: 0 })),
    }))
  }
  const heights = () => [...chunks.join('').matchAll(/\x1bP[0-9;]*q"\d+;\d+;\d+;(\d+)/g)].map(match => Number(match[1]))
  try {
    r.setIsInteractive(true)
    r.setDeviceAttributes([62, 4])
    r.setCellPixelSize({ width: 8, height: 16 }, { columns: 80, rows: 20 })
    ink.setAltScreenActive(true)
    const store = r.createStore(r.getDefaultAppState())
    ink.render(h(r.AppStoreContext.Provider, { value: store }, h(View)))
    await until(() => scroll.current?.getScrollHeight() > 55, 'image occupies the transcript')
    scroll.current.scrollTo(20)
    await until(() => heights().includes(96), 'full image emitted')
    chunks.length = 0
    scroll.current.scrollTo(28)
    await until(() => heights().some(height => height > 0 && height < 96), 'top-clipped image recovers a sharp strip without a keypress')
    assert.match(frameText(ink), /input-ready/)
    chunks.length = 0
    scroll.current.scrollTo(10)
    await until(() => heights().some(height => height > 0 && height < 96), 'bottom-clipped image recovers a sharp strip')
    chunks.length = 0
    scroll.current.scrollTo(20)
    await until(() => heights().includes(96), 'original full image returns at the same scale')
    // Clear while a new crop can still be in flight. It must not repaint into
    // the fresh session when that asynchronous encode completes.
    scroll.current.scrollTo(29)
    clear()
    await until(() => frameText(ink).includes('WELCOME'), 'clear restores welcome without an input event')
    chunks.length = 0
    await pause(250)
    assert.deepEqual(heights(), [], 'no stale image can repaint after clear')
    assert.match(frameText(ink), /input-ready/)
    assert.equal(scroll.current.getScrollTop(), 0)
  } finally {
    stdout.isTTY = false; ink.unmount(); stdin.destroy(); r.setIsInteractive(false)
    process.env = oldEnv
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
    else delete process.stdout.isTTY
  }
})
