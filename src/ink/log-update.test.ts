/**
 * Frame writer checks for inline images drawn along with their rows.
 *
 * On the main screen rows scroll into terminal history as they are written, and
 * nothing can draw there afterwards. So the writer draws an image the moment
 * the last row of its box goes out, while its top is still on screen, and the
 * pixels scroll into history with the text. These pin down where in the output
 * that happens, and that nothing changes when there is no image.
 *
 * Run via: bun run src/ink/log-update.test.ts
 */

import type { Diff, Frame } from './frame.js'
import { LogUpdate } from './log-update.js'
import {
  CellWidth,
  CharPool,
  charInCellAt,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.js'
import {
  CURSOR_HOME,
  cursorMove,
  cursorTo,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
  eraseLines,
} from './termio/csi.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()
const WIDTH = 20
const ROWS = 10

/** A main-screen frame of these lines, with the cursor below the last one. */
function frameOf(lines: readonly string[]): Frame {
  const screen = createScreen(
    WIDTH,
    lines.length,
    stylePool,
    charPool,
    hyperlinkPool,
  )
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      setCellAt(screen, x, y, {
        char: line[x]!,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  })
  return {
    screen,
    viewport: { width: WIDTH, height: ROWS },
    cursor: { x: 0, y: lines.length, visible: false },
  }
}

const rowsOf = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `row${String(i).padStart(2, '0')}`)

/** The terminal bytes a diff becomes, with a wipe spelled out. */
function serialize(diff: Diff): string {
  let out = ''
  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        out += patch.content
        break
      case 'clear':
        out += `<clear ${patch.count}>`
        break
      case 'clearTerminal':
        out += '<wipe>'
        break
      case 'cursorMove':
        out += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        out += cursorTo(patch.col)
        break
      case 'carriageReturn':
        out += '\r'
        break
      case 'styleStr':
        out += patch.str
        break
      default:
        break
    }
  }
  return out
}

type Planner = NonNullable<ConstructorParameters<typeof LogUpdate>[0]['rowGraphics']>
type Request = Parameters<Planner>[0]
type Graphic = { x: number; y: number; rows: number; sequence: string }

const IMAGE = '<image>'
/** A box over rows 3 to 6, from column 2. */
const BOX: Graphic = { x: 2, y: 3, rows: 4, sequence: IMAGE }

/** Hands over each graphic whose last row a request covers and top it allows. */
function planner(graphics: readonly Graphic[] = [BOX]): {
  calls: Request[]
  plan: Planner
} {
  const calls: Request[] = []
  const plan: Planner = request => {
    calls.push(request)
    return graphics.filter(graphic => {
      const bottom = graphic.y + graphic.rows - 1
      return (
        bottom >= request.startY &&
        bottom < request.endY &&
        graphic.y >= request.topY
      )
    })
  }
  return { calls, plan }
}

/** The bytes that draw `graphic` from `up` rows below its top, cursor kept. */
const drawn = (graphic: Graphic, up: number): string =>
  `\x1b7${cursorMove(0, -up)}${cursorTo(graphic.x + 1)}${graphic.sequence}\x1b8`

test('an image goes out right after the last row of its box, while its top is on screen', () => {
  const { calls, plan } = planner()
  const log = new LogUpdate({ isTTY: true, stylePool, rowGraphics: plan })
  const out = serialize(log.render(frameOf([]), frameOf(rowsOf(15))))
  assert(
    out.includes(`row06\r\n${drawn(BOX, 4)}row07`),
    `drawn between its last row and the next: ${JSON.stringify(out)}`,
  )
  assertEqual(out.indexOf(IMAGE), out.lastIndexOf(IMAGE), 'drawn once')
  assertEqual(calls.length, 1, 'one plan, for the new rows')
  assertEqual(calls[0]!.startY, 0, 'from the first new row')
  assertEqual(calls[0]!.endY, 15, 'to the last')
  assertEqual(calls[0]!.afterClear, false, 'not a reprint')
})

test('an image completed in rows already on screen goes out before new rows push it up', () => {
  const after = rowsOf(14)
  after[5] = 'box05'
  const { calls, plan } = planner()
  const log = new LogUpdate({ isTTY: true, stylePool, rowGraphics: plan })
  const out = serialize(log.render(frameOf(rowsOf(8)), frameOf(after)))
  // The first pass leaves the cursor after "box" on row 5, two rows below the
  // top of the image.
  const at = out.indexOf(drawn(BOX, 2))
  assert(at >= 0, `drawn relative to where the first pass left the cursor: ${JSON.stringify(out)}`)
  assert(out.indexOf('box') < at, 'after the changed row')
  assert(at < out.indexOf('row08'), 'before the first new row')
  assertEqual(calls.length, 2, 'rows on screen, then new rows')
  assertEqual(calls[0]!.startY, 0, 'rows on screen from the top')
  assertEqual(calls[0]!.endY, 8, 'up to the old end')
  assertEqual(calls[1]!.startY, 8, 'new rows from the old end')
})

test('the top a plan may use is the first row still on screen', () => {
  // Fifteen rows in a ten-row window, plus the line the parked cursor scrolled:
  // rows 0 to 5 are already history.
  const { calls, plan } = planner([])
  const log = new LogUpdate({ isTTY: true, stylePool, rowGraphics: plan })
  log.render(frameOf(rowsOf(15)), frameOf(rowsOf(20)))
  assert(calls.length > 0, 'asked')
  for (const call of calls) assertEqual(call.topY, 6, 'row 6 is the top of the window')
})

test('a reprint writes the whole transcript again, every image in its rows', () => {
  const { calls, plan } = planner()
  const log = new LogUpdate({ isTTY: true, stylePool, rowGraphics: plan })
  log.requestFullReset('graphics')
  const diff = log.render(frameOf(rowsOf(15)), frameOf(rowsOf(15)))
  const wipe = diff[0]
  assert(wipe?.type === 'clearTerminal', 'the screen is wiped first')
  assertEqual(wipe.type === 'clearTerminal' && wipe.reason, 'graphics', 'and says why')
  assert(
    serialize(diff).includes(`row06\r\n${drawn(BOX, 4)}row07`),
    'the image goes out with its rows',
  )
  assertEqual(calls.length, 1, 'one plan for the whole transcript')
  assertEqual(calls[0]!.afterClear, true, 'as a reprint')
  assertEqual(calls[0]!.startY, 0, 'from the first row')
  assertEqual(calls[0]!.endY, 15, 'to the last')

  const again = log.render(frameOf(rowsOf(15)), frameOf(rowsOf(15)))
  assert(!again.some(patch => patch.type === 'clearTerminal'), 'owed once, not every frame')
})

test('the alt screen neither draws images with rows nor keeps an owed reprint', () => {
  const { calls, plan } = planner()
  const log = new LogUpdate({ isTTY: true, stylePool, rowGraphics: plan })
  log.requestFullReset('graphics')
  const diff = log.render(frameOf([]), frameOf(rowsOf(8)), true)
  assert(!diff.some(patch => patch.type === 'clearTerminal'), 'no wipe')
  assert(!serialize(diff).includes(IMAGE), 'no image: it redraws its own every frame')
  assertEqual(calls.length, 0, 'never asked')
  const main = log.render(frameOf(rowsOf(8)), frameOf(rowsOf(8)))
  assert(
    !main.some(patch => patch.type === 'clearTerminal'),
    'the reprint is not saved up for the main screen either',
  )
})

test('starting over drops an owed reprint: everything goes out again anyway', () => {
  const { plan } = planner()
  const log = new LogUpdate({ isTTY: true, stylePool, rowGraphics: plan })
  log.requestFullReset('graphics')
  log.reset()
  const diff = log.render(frameOf([]), frameOf(rowsOf(15)))
  assert(!diff.some(patch => patch.type === 'clearTerminal'), 'no wipe')
  assert(
    serialize(diff).includes(`row06\r\n${drawn(BOX, 4)}`),
    'and the image still goes out with its rows',
  )
})

test('with no image to draw, the output is byte for byte unchanged', () => {
  const before = (): Frame => frameOf(rowsOf(12))
  const after = (): Frame => {
    const lines = rowsOf(18)
    lines[4] = 'edited'
    lines[11] = 'edited too'
    return frameOf(lines)
  }
  const plain = new LogUpdate({ isTTY: true, stylePool })
  const withPlanner = new LogUpdate({
    isTTY: true,
    stylePool,
    rowGraphics: () => [],
  })
  assertEqual(
    serialize(withPlanner.render(before(), after())),
    serialize(plain.render(before(), after())),
    'a planner with nothing to hand over changes nothing',
  )
  assertEqual(
    serialize(withPlanner.render(frameOf([]), before())),
    serialize(plain.render(frameOf([]), before())),
    'on a first frame either',
  )
})

// --- Rows in scrollback ------------------------------------------------------
//
// The writer only moves the cursor relatively, so it has to know which rows of
// the previous frame are still on screen. A shrink erases rows in place and
// nothing scrolls back down; deriving the screen's top from the frame's height
// then took rows in scrollback for rows on screen, a cursor-up to one of them
// stopped at the top edge, and that write and every relative move after it,
// in later frames too, landed rows off. Replayed here through a small terminal.

/** The bytes writeDiffToTerminal sends for a diff, minus sync markers. */
function bytesOf(diff: Diff): string {
  let out = ''
  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        out += patch.content
        break
      case 'clear':
        out += eraseLines(patch.count)
        break
      case 'clearTerminal':
        out += ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
        break
      case 'cursorMove':
        out += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        out += cursorTo(patch.col)
        break
      case 'carriageReturn':
        out += '\r'
        break
      case 'styleStr':
        out += patch.str
        break
      default:
        break
    }
  }
  return out
}

/**
 * Just enough of a terminal for the writer's main-screen output: text with a
 * pending wrap at the last column, CR, LF, cursor moves that stop at the edges,
 * EL, ED and history. Growing taller adds blank rows below, as Windows Terminal
 * and ConPTY do, unless `pullsBack` is set: then rows come back out of history
 * first, as xterm does.
 */
class MiniTerminal {
  screen: string[][]
  history: string[] = []
  x = 0
  y = 0
  private wrapPending = false

  constructor(
    readonly width: number,
    public height: number,
    private readonly pullsBack = false,
  ) {
    this.screen = Array.from({ length: height }, () => this.blankRow())
  }

  private blankRow(): string[] {
    return Array<string>(this.width).fill(' ')
  }

  write(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!
      if (ch === '\x1b') {
        if (data[i + 1] === '[') {
          let j = i + 2
          while (j < data.length && !/[@-~]/.test(data[j]!)) j++
          this.csi(data.slice(i + 2, j), data[j]!)
          i = j
        } else {
          i++ // DECSC/DECRC and other two-byte escapes leave the text alone
        }
      } else if (ch === '\r') {
        this.x = 0
        this.wrapPending = false
      } else if (ch === '\n') {
        this.lineFeed()
      } else {
        if (this.wrapPending) {
          this.x = 0
          this.lineFeed()
        }
        this.screen[this.y]![this.x] = ch
        if (this.x === this.width - 1) this.wrapPending = true
        else this.x++
      }
    }
  }

  private lineFeed(): void {
    this.wrapPending = false
    if (this.y < this.height - 1) {
      this.y++
      return
    }
    this.history.push(this.screen.shift()!.join('').trimEnd())
    this.screen.push(this.blankRow())
  }

  private csi(params: string, final: string): void {
    if (final === 'm' || params.startsWith('?')) return
    const [a, b] = params.split(';').map(p => (p === '' ? undefined : Number(p)))
    const n = a ?? 1
    this.wrapPending = false
    switch (final) {
      case 'A':
        this.y = Math.max(0, this.y - n)
        return
      case 'B':
        this.y = Math.min(this.height - 1, this.y + n)
        return
      case 'C':
        this.x = Math.min(this.width - 1, this.x + n)
        return
      case 'D':
        this.x = Math.max(0, this.x - n)
        return
      case 'G':
        this.x = Math.min(this.width - 1, n - 1)
        return
      case 'H':
        this.y = Math.min(this.height - 1, (a ?? 1) - 1)
        this.x = Math.min(this.width - 1, (b ?? 1) - 1)
        return
      case 'K': {
        const row = this.screen[this.y]!
        const mode = a ?? 0
        for (let x = 0; x < this.width; x++) {
          if (mode === 2 || (mode === 0 && x >= this.x) || (mode === 1 && x <= this.x)) row[x] = ' '
        }
        return
      }
      case 'J': {
        const mode = a ?? 0
        if (mode === 3) {
          this.history = []
          return
        }
        for (let y = 0; y < this.height; y++) {
          if (mode === 2 || y > this.y) this.screen[y] = this.blankRow()
          else if (y === this.y) for (let x = this.x; x < this.width; x++) this.screen[y]![x] = ' '
        }
        return
      }
      default:
        throw new Error(`unexpected CSI ${JSON.stringify(params + final)}`)
    }
  }

  /** The window changes height, before the app hears of it. */
  resize(height: number): void {
    while (this.height < height) {
      if (this.pullsBack && this.history.length > 0) {
        this.screen.unshift([...this.history.pop()!.padEnd(this.width)])
        this.y++
      } else {
        this.screen.push(this.blankRow())
      }
      this.height++
    }
    while (this.height > height) {
      // Blank rows below the cursor go first, then the top row into history.
      if (this.y < this.height - 1) {
        this.screen.pop()
      } else {
        this.history.push(this.screen.shift()!.join('').trimEnd())
        this.y--
      }
      this.height--
    }
  }
}

function rowText(frame: Frame, y: number): string {
  let line = ''
  for (let x = 0; x < frame.screen.width; x++) line += charInCellAt(frame.screen, x, y) ?? ' '
  return line.trimEnd()
}

/**
 * What a correct writer leaves behind: history and the rows above the cursor
 * are the frame, row for row, and nothing below the cursor.
 */
function assertShows(term: MiniTerminal, frame: Frame, label: string): void {
  const expected: string[] = []
  for (let y = 0; y < frame.screen.height; y++) expected.push(rowText(frame, y))
  const shown = [
    ...term.history,
    ...term.screen.slice(0, term.y).map(row => row.join('').trimEnd()),
  ]
  if (JSON.stringify(shown) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: terminal shows ${JSON.stringify(shown.slice(-12))} ` +
        `instead of ${JSON.stringify(expected.slice(-12))}`,
    )
  }
  for (let y = term.y; y < term.height; y++) {
    const text = term.screen[y]!.join('').trim()
    if (text !== '') throw new Error(`${label}: row ${y} below the cursor shows ${JSON.stringify(text)}`)
  }
  assertEqual(term.x, 0, `${label}: cursor column`)
}

/** A frame of `lines` for a window `rows` tall. */
function frameFor(lines: readonly string[], rows: number): Frame {
  const frame = frameOf(lines)
  return { ...frame, viewport: { width: WIDTH, height: rows } }
}

/** Writes each frame through `log` into `term`, checking the screen each time. */
function replay(
  log: LogUpdate,
  term: MiniTerminal,
  frames: ReadonlyArray<readonly string[]>,
  label: string,
): Diff[] {
  const diffs: Diff[] = []
  let prev = frameFor([], term.height)
  frames.forEach((lines, i) => {
    const next = frameFor(lines, term.height)
    const diff = log.render(prev, next)
    diffs.push(diff)
    term.write(bytesOf(diff))
    assertShows(term, next, `${label}, frame ${i}`)
    prev = next
  })
  return diffs
}

const wiped = (diff: Diff): boolean => diff.some(patch => patch.type === 'clearTerminal')

test('a row that went to scrollback before a shrink is not written over another row', () => {
  // 30 rows in a 10-row window: rows 0-20 are history. The last 4 go away
  // (spinner, todo list): the screen now ends in blank rows, and row 18 is
  // still history even though a 26-row frame would have it on screen.
  const lines = rowsOf(30)
  const shrunk = lines.slice(0, 26)
  const edited = [...shrunk]
  edited[18] = 'row18 edited'
  const log = new LogUpdate({ isTTY: true, stylePool })
  const diffs = replay(log, new MiniTerminal(WIDTH, ROWS), [lines, shrunk, edited], 'edit in history')
  assert(!wiped(diffs[1]!), 'the shrink itself only erases rows')
  assert(wiped(diffs[2]!), 'the edit can only be shown by writing everything again')
  assertEqual(log.rowsInScrollback, 17, 'and the screen is bottom-aligned again')
})

test('after a shrink, rows still on screen are edited in place', () => {
  const lines = rowsOf(30)
  const shrunk = lines.slice(0, 26)
  const edited = [...shrunk]
  edited[23] = 'row23 edited'
  edited[25] = 'row25 edited'
  const log = new LogUpdate({ isTTY: true, stylePool })
  const diffs = replay(log, new MiniTerminal(WIDTH, ROWS), [lines, shrunk, edited, shrunk], 'edit on screen')
  assert(!diffs.slice(1).some(wiped), 'no full reset needed')
  assertEqual(log.rowsInScrollback, 21, 'the rows in scrollback stay where they were')
})

test('rows added after a shrink fill the blank rows first, then scroll', () => {
  const log = new LogUpdate({ isTTY: true, stylePool })
  const term = new MiniTerminal(WIDTH, ROWS)
  replay(log, term, [rowsOf(30), rowsOf(24), rowsOf(27)], 'refill')
  assertEqual(log.rowsInScrollback, 21, 'three new rows fit in the six blank ones')
  const log2 = new LogUpdate({ isTTY: true, stylePool })
  replay(log2, new MiniTerminal(WIDTH, ROWS), [rowsOf(30), rowsOf(24), rowsOf(27), rowsOf(35)], 'scroll')
  assertEqual(log2.rowsInScrollback, 26, 'the overflow once the blank rows are used up')
})

test('a taller window that adds blank rows below keeps history out of reach', () => {
  const log = new LogUpdate({ isTTY: true, stylePool })
  const term = new MiniTerminal(WIDTH, ROWS)
  replay(log, term, [rowsOf(30)], 'before')
  term.resize(14)
  const edited = rowsOf(30)
  edited[19] = 'row19 edited' // history: a 14-row bottom-aligned window would show it
  edited[28] = 'row28 edited'
  const next = frameFor(edited, 14)
  const diff = log.render(frameFor(rowsOf(30), ROWS), next)
  term.write(bytesOf(diff))
  assertShows(term, next, 'taller window')
  assert(wiped(diff), 'row 19 can only be shown by writing everything again')
})

test('a taller window that brings rows back still lands every write', () => {
  const log = new LogUpdate({ isTTY: true, stylePool })
  const term = new MiniTerminal(WIDTH, ROWS, true)
  replay(log, term, [rowsOf(30)], 'before')
  term.resize(14)
  const edited = rowsOf(30)
  edited[28] = 'row28 edited'
  const next = frameFor(edited, 14)
  term.write(bytesOf(log.render(frameFor(rowsOf(30), ROWS), next)))
  assertShows(term, next, 'rows brought back')
})

test('the alt screen never counts rows in scrollback', () => {
  const log = new LogUpdate({ isTTY: true, stylePool })
  log.render(frameOf([]), frameOf(rowsOf(30)))
  assert(log.rowsInScrollback > 0, 'main screen overflow is counted')
  const alt = (lines: string[]): Frame => ({ ...frameOf(lines), viewport: { width: WIDTH, height: ROWS + 1 }, cursor: { x: 0, y: ROWS - 1, visible: false } })
  log.render(alt(rowsOf(ROWS)), alt(rowsOf(ROWS)), true)
  assertEqual(log.rowsInScrollback, 0, 'alt screen')
})

test('starting over forgets the rows in scrollback', () => {
  const log = new LogUpdate({ isTTY: true, stylePool })
  log.render(frameOf([]), frameOf(rowsOf(30)))
  log.reset()
  assertEqual(log.rowsInScrollback, 0, 'after reset')
  log.render(frameOf([]), frameOf(rowsOf(12)))
  assertEqual(log.rowsInScrollback, 3, 'a fresh frame counts only its own overflow')
})

test('random frames always leave the terminal showing exactly the frame', () => {
  // Seeded, so a failure reproduces.
  let seed = 0x5eed
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = (n: number): number => Math.floor(random() * n)
  const text = (): string => {
    const r = random()
    if (r < 0.15) return ''
    if (r < 0.3) return 'x'.repeat(WIDTH) // exactly as wide as the window
    return `line ${pick(1000)}`.slice(0, 1 + pick(WIDTH))
  }
  let frames = 0
  for (const pullsBack of [false, true]) {
    for (let run = 0; run < 150; run++) {
      const log = new LogUpdate({ isTTY: true, stylePool })
      let rows = 6 + pick(10)
      const term = new MiniTerminal(WIDTH, rows, pullsBack)
      let transcript: string[] = []
      let bottom: string[] = ['> prompt']
      let prev = frameFor([], rows)
      for (let step = 0; step < 40; step++) {
        const r = random()
        if (r < 0.3) {
          for (let k = 1 + pick(6); k > 0; k--) transcript.push(text())
        } else if (r < 0.5) {
          // The spinner, todo list or a panel above the prompt comes and goes.
          bottom = Array.from({ length: pick(12) }, text).concat('> prompt')
        } else if (r < 0.7 && transcript.length > 0) {
          transcript[pick(transcript.length)] = text()
        } else if (r < 0.8 && transcript.length > 0) {
          transcript.splice(pick(transcript.length), 1 + pick(4))
        } else if (r < 0.9) {
          rows = Math.max(4, Math.min(24, rows + pick(9) - 4))
          term.resize(rows)
        } else {
          bottom[pick(bottom.length)] = text()
        }
        const next = frameFor([...transcript, ...bottom], rows)
        term.write(bytesOf(log.render(prev, next)))
        assertShows(term, next, `run ${run}${pullsBack ? ' (pulls back)' : ''}, step ${step}`)
        prev = next
        frames++
      }
    }
  }
  assert(frames === 2 * 150 * 40, 'every frame checked')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
