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
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.js'
import { cursorMove, cursorTo } from './termio/csi.js'

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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
