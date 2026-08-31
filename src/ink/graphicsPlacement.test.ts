/**
 * Graphics placement checks.
 *
 * These cover the erase path, which is where inline graphics actually go wrong.
 * Pixels are invisible to Ink's cell model — the frame diff rewrites a cell only
 * when its *text* changes — so a graphic that moves leaves its old pixels behind
 * unless this module repaints the cells it used to cover. Every duplicated or
 * overlapping image traces back to that.
 *
 * Run via: bun run src/ink/graphicsPlacement.test.ts
 */

import type { DOMElement } from './dom.js'
import {
  buildGraphicsSequence,
  forceGraphicsRedraw,
  getPlacementRowLimit,
  invalidateGraphicsPlacements,
  setGraphicsPlacement,
} from './graphicsPlacement.js'
import { nodeCache } from './node-cache.js'
import {
  clearCellGeometryStale,
  markCellGeometryStale,
} from '../utils/terminalGraphics.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  setCellAt,
  StylePool,
} from './screen.js'

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

const CELL = { width: 10, height: 20 }
const PAYLOAD = '\x1bPq#0;2;100;0;0#0~~~~\x1b\\'
/** Stand-in for Kitty's `a=d` delete-by-id. */
const DELETE = '\x1b_Ga=d,d=I,i=4242,q=2\x1b\\'

/** A screen filled with a recognisable character, so a repaint is detectable. */
function makeScreen(fill = 'X'): {
  screen: Screen
  stylePool: StylePool
} {
  return makeScreenOf(60, 40, fill)
}

/** As above, at an arbitrary size — an erase can outlive the rows it drew into. */
function makeScreenOf(
  width: number,
  height: number,
  fill = 'X',
): { screen: Screen; stylePool: StylePool } {
  const stylePool = new StylePool()
  const screen = createScreen(
    width,
    height,
    stylePool,
    new CharPool(),
    new HyperlinkPool(),
  )
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) {
      setCellAt(screen, x, y, {
        char: fill,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  }
  return { screen, stylePool }
}

function place(
  id: string,
  x: number,
  y: number,
  columns = 8,
  rows = 4,
  eraseSequence?: string,
) {
  const node = {} as DOMElement
  nodeCache.set(node, { x, y, width: columns, height: rows })
  setGraphicsPlacement(id, {
    node,
    sequence: PAYLOAD,
    eraseSequence,
    rows,
    columns,
    cellWidth: CELL.width,
    cellHeight: CELL.height,
  })
  return node
}

function build(screen: Screen, stylePool: StylePool, damage?: any): string {
  return buildGraphicsSequence({
    cursor: { x: 0, y: 0 },
    viewportTop: 0,
    viewportRows: 40,
    viewportColumns: 60,
    damage,
    cell: CELL,
    screen,
    stylePool,
  })
}

function reset(): void {
  for (const id of ['a', 'b']) setGraphicsPlacement(id, null)
  invalidateGraphicsPlacements()
  // Row limits deliberately survive a wipe now, so a test starts a fresh
  // viewport epoch to drop them.
  forceGraphicsRedraw()
}

// --- Drawing ---------------------------------------------------------------

test('a placement draws once and is not re-sent while it sits still', () => {
  reset()
  const { screen, stylePool } = makeScreen()
  place('a', 4, 6)

  const first = build(screen, stylePool)
  assert(first.includes(PAYLOAD), 'draws on the first frame')

  const second = build(screen, stylePool)
  assert(
    !second.includes(PAYLOAD),
    'an untouched image is not re-sent — the payload can be hundreds of KB',
  )
})

test('text written under the image re-sends it', () => {
  // Writing a character into a covered cell clears the pixels there, so the
  // payload has to go back out.
  reset()
  const { screen, stylePool } = makeScreen()
  place('a', 4, 6)
  build(screen, stylePool)

  setCellAt(screen, 5, 7, {
    char: 'Z',
    styleId: stylePool.none,
    width: CellWidth.Narrow,
    hyperlink: undefined,
  })
  const redrawn = build(screen, stylePool, { x: 4, y: 6, width: 8, height: 4 })
  assert(redrawn.includes(PAYLOAD), 'a changed cell under the image redraws it')
})

test('damage overlapping the image is not on its own a reason to re-send', () => {
  // `damage` bounds everything written anywhere in the frame, so during a
  // streaming response it spans most of the screen. Treating that as "the
  // pixels were disturbed" re-sent hundreds of kilobytes every frame, which
  // the terminal cannot absorb — the writes tear and land as partial images.
  reset()
  const { screen, stylePool } = makeScreen()
  place('a', 4, 6)
  build(screen, stylePool)

  const quiet = build(screen, stylePool, { x: 0, y: 0, width: 60, height: 40 })
  assertEqual(quiet, '', 'cells under the image are unchanged, so nothing goes out')
})

// --- Erasing ---------------------------------------------------------------

test('moving a graphic repaints the cells it vacated', () => {
  // The duplicated-image bug: without this the old pixels stay on screen,
  // because the cells beneath them compare equal and the diff skips them.
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 6)
  build(screen, stylePool)

  nodeCache.set(node, { x: 4, y: 20, width: 8, height: 4 })
  const moved = build(screen, stylePool)

  assert(moved.includes(PAYLOAD), 'draws at the new position')
  assert(
    moved.includes('XXXXXXXX'),
    'and rewrites the vacated cells from the current frame',
  )
  // The erase must precede the draw, or it would wipe the new pixels.
  assert(
    moved.indexOf('XXXXXXXX') < moved.indexOf(PAYLOAD),
    'erase is emitted before the redraw',
  )
  assert(
    moved.includes(`\x1b8\x1b7\x1b[20B\x1b[5G${PAYLOAD}\x1b8`),
    'the redraw starts from a restored frame cursor, not the repaint endpoint',
  )
})

test('protocol cursor side effects are isolated by save and restore', () => {
  // Sixel advances the text cursor in Windows Terminal and xterm. Its exact
  // endpoint is protocol/terminal-specific, so placement must not try to undo
  // it with a guessed relative move.
  reset()
  const { screen, stylePool } = makeScreen()
  place('a', 4, 6)
  const out = build(screen, stylePool)

  assert(
    out.includes(`\x1b7\x1b[6B\x1b[5G${PAYLOAD}\x1b8`),
    'the payload is independently anchored and immediately restored',
  )
})

test('main-screen placements use logical viewport coordinates', () => {
  // With scrollback, nodeCache rows remain logical screen rows. Here rows
  // 17..40 are visible, so y=30 is on-screen even though it exceeds the
  // terminal's 24-row height when incorrectly treated as viewport-relative.
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 30)
  const visible = buildGraphicsSequence({
    cursor: { x: 0, y: 40 },
    viewportTop: 17,
    viewportRows: 24,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })
  assert(visible.includes(PAYLOAD), 'draws a logically visible placement')

  nodeCache.set(node, { x: 4, y: 10, width: 8, height: 4 })
  const offscreen = buildGraphicsSequence({
    cursor: { x: 0, y: 40 },
    viewportTop: 17,
    viewportRows: 24,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })
  assert(!offscreen.includes(PAYLOAD), 'withholds a placement above the viewport')
  assert(offscreen.includes('XXXXXXXX'), 'and erases its old visible pixels')
})

test('a box smaller than the encode withholds the draw', () => {
  // A fixed-size payload in a shrunken box spills pixels outside the rectangle
  // every erase is computed from — an unclearable ghost. Withhold instead.
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 6, 8, 4)
  build(screen, stylePool)

  // Layout granted fewer columns than the payload was encoded for.
  nodeCache.set(node, { x: 4, y: 6, width: 5, height: 4 })
  const out = build(screen, stylePool)
  assert(!out.includes(PAYLOAD), 'not drawn into a box that cannot hold it')
  assert(out.includes('XXXXXXXX'), 'and the previous pixels are erased')
})

test('scrolling out of the viewport erases rather than stranding pixels', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 6)
  build(screen, stylePool)

  // Now straddling the bottom edge — undrawable, and the old pixels must go.
  nodeCache.set(node, { x: 4, y: 38, width: 8, height: 4 })
  const out = build(screen, stylePool)
  assert(!out.includes(PAYLOAD), 'a partly-offscreen image is not drawn')
  assert(out.includes('XXXXXXXX'), 'its previous pixels are erased')
})

test('unmounting erases the pixels left behind', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6)
  build(screen, stylePool)

  setGraphicsPlacement('a', null)
  const out = build(screen, stylePool)
  assert(out.includes('XXXXXXXX'), 'a removed placement still erases')

  const after = build(screen, stylePool)
  assert(after === '', 'and only once')
})

test('a cell-geometry change withholds the draw and erases', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6)
  build(screen, stylePool)

  const out = buildGraphicsSequence({
    cursor: { x: 0, y: 0 },
    viewportTop: 0,
    viewportRows: 40,
    viewportColumns: 60,
    damage: undefined,
    cell: { width: 7, height: 14 }, // user zoomed
    screen,
    stylePool,
  })
  assert(!out.includes(PAYLOAD), 'stale geometry is not drawn')
  assert(out.includes('XXXXXXXX'), 'and the old pixels are cleared')
})

test('a screen clear forces a redraw without a stale erase', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6)
  build(screen, stylePool)

  // The terminal dropped the pixels along with the text.
  invalidateGraphicsPlacements()
  const out = build(screen, stylePool)
  assert(out.includes(PAYLOAD), 'redraws after a clear')
  // The destination repaint is unconditional now, so cells are rewritten here
  // too. What matters is that the payload goes back out after the screen was
  // wiped, rather than being suppressed as "already on screen".
})

test('a scrolling transcript does not re-send a stationary payload', () => {
  // The "it keeps moving and the terminal goes malformed" failure. While a
  // response streams, the transcript grows and viewportTop advances every
  // frame. Treating that as a move meant erasing and re-sending a payload of
  // hundreds of kilobytes at frame rate; the terminal cannot absorb it, so the
  // writes tear and land as partial images.
  //
  // Nothing needs sending: the pixels belong to buffer cells — writing text
  // over a sixel clears it — so the terminal scrolls them with the text.
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 20)

  const first = buildGraphicsSequence({
    cursor: { x: 0, y: 30 },
    viewportTop: 5,
    viewportRows: 24,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })
  assert(first.includes(PAYLOAD), 'drawn at first')

  // Same logical row, viewport scrolled by two.
  const scrolled = buildGraphicsSequence({
    cursor: { x: 0, y: 32 },
    viewportTop: 7,
    viewportRows: 24,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })
  assertEqual(scrolled, '', 'a pure scroll emits nothing at all')
})

test('after scrolling, an erase targets the row the image is on now', () => {
  // The record has to follow the scroll even though nothing was sent, or a
  // later erase repaints where the image sat several screens ago.
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 20)
  buildGraphicsSequence({
    cursor: { x: 0, y: 30 },
    viewportTop: 5,
    viewportRows: 24,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })
  // Scroll by two without redrawing, then move the image for real.
  buildGraphicsSequence({
    cursor: { x: 0, y: 32 },
    viewportTop: 7,
    viewportRows: 24,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })
  nodeCache.set(node, { x: 4, y: 26, width: 8, height: 4 })
  const moved = buildGraphicsSequence({
    cursor: { x: 0, y: 32 },
    viewportTop: 7,
    viewportRows: 24,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })
  assert(moved.includes(PAYLOAD), 'a real move redraws')
  assert(moved.includes('XXXXXXXX'), 'and erases the cells it left')
})

test('every emission is bracketed so the cursor is left untouched', () => {
  reset()
  const { screen, stylePool } = makeScreen()
  place('a', 4, 6)
  const out = build(screen, stylePool)
  assert(out.startsWith('\x1b7'), 'saves the cursor')
  assert(out.endsWith('\x1b8'), 'restores the cursor')
})

test('nothing registered emits nothing', () => {
  reset()
  const { screen, stylePool } = makeScreen()
  assert(build(screen, stylePool) === '', 'no placements, no output')
})

// --- Protocol-native erase -------------------------------------------------

test('a moved graphic is deleted by id before the cells are repainted', () => {
  // Kitty can be told to drop an image outright. That reaches pixels the cell
  // repaint cannot — anything the payload put outside its box, and rectangles
  // clipped away at the viewport edge — so it must go out first.
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 6, 8, 4, DELETE)
  build(screen, stylePool)

  nodeCache.set(node, { x: 4, y: 20, width: 8, height: 4 })
  const moved = build(screen, stylePool)
  assert(moved.includes(DELETE), 'the old image is deleted by id')
  assert(
    moved.indexOf(DELETE) < moved.indexOf('XXXXXXXX'),
    'the delete precedes the cell repaint',
  )
  assert(
    moved.indexOf(DELETE) < moved.indexOf(PAYLOAD),
    'and precedes the redraw, so it cannot remove the new copy',
  )
})

test('unmounting deletes by id as well as repainting', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6, 8, 4, DELETE)
  build(screen, stylePool)

  // The placement is gone, so the sequence has to have been recorded alongside
  // the rectangle rather than looked up from the now-empty map.
  setGraphicsPlacement('a', null)
  const out = build(screen, stylePool)
  assert(out.includes(DELETE), 'a removed placement still deletes its image')
})

test('a sixel placement emits no delete, having no protocol for one', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 6)
  build(screen, stylePool)
  nodeCache.set(node, { x: 4, y: 20, width: 8, height: 4 })
  const moved = build(screen, stylePool)
  assert(!moved.includes('\x1b_G'), 'no APC leaks into a sixel session')
  assert(moved.includes('XXXXXXXX'), 'the cell repaint is still the erase')
})

// --- Zoom ------------------------------------------------------------------

test('a wiped screen redraws a stationary image even with no damage', () => {
  // The resize bug. Ink prepends ERASE_SCREEN on resize, ctrl+L, and
  // alt-screen re-entry — none of which is a `clearTerminal` patch, so the
  // invalidation used to be skipped. The image had not moved and a settled
  // frame reports no damage, so the redraw was suppressed as "already on
  // screen" while the terminal had in fact dropped the pixels. What was left
  // was the block-glyph fallback: sharp image, then blurry after a resize,
  // until some later turn happened to repaint those cells.
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6)
  assert(build(screen, stylePool).includes(PAYLOAD), 'drawn')
  assert(
    !build(screen, stylePool).includes(PAYLOAD),
    'and not re-sent while nothing disturbs it',
  )

  invalidateGraphicsPlacements()
  assert(
    build(screen, stylePool).includes(PAYLOAD),
    'but a wipe forces it back out, with no damage to prompt it',
  )
})

// --- Feedback when a box does not fit ---------------------------------------

test('a box overflowing the bottom reports the room it actually had', () => {
  // Withholding a too-tall image is correct but used to be terminal: the
  // component had no way to learn its box could not be drawn, so it re-encoded
  // the same size every time and the block fallback stood for good.
  reset()
  const { screen, stylePool } = makeScreen('X')
  // Viewport is rows 0..39. A 12-row box at row 32 runs four rows past it.
  place('a', 4, 32, 8, 12)
  build(screen, stylePool)
  assertEqual(
    getPlacementRowLimit('a'),
    8,
    'reports the rows between the box top and the viewport bottom',
  )
})

const shortViewport = (
  screen: Screen,
  stylePool: StylePool,
  viewportTop: number,
): string =>
  buildGraphicsSequence({
    cursor: { x: 0, y: 40 },
    viewportTop,
    viewportRows: 16,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen,
    stylePool,
  })

test('a box pushed off the top reports the rows it can still use', () => {
  // The window got shorter. `viewportBottom` is the transcript end plus one, so
  // a box can never run past it — an image too tall for the window loses its
  // own top instead. Nothing below it moves when it shrinks, so the rows still
  // visible are exactly the rows it can have: rows 24..39 are shown, and a
  // 12-row box at row 20 has 8 of them.
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 20, 8, 12)
  shortViewport(screen, stylePool, 24)
  assertEqual(getPlacementRowLimit('a'), 8, 'the rows of the box still on screen')
})

test('a box scrolled deep into history reports nothing', () => {
  // Past the floor there is nothing worth drawing, and shrinking really would
  // not bring this one back.
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('b', 4, 4, 8, 6)
  shortViewport(screen, stylePool, 24)
  assertEqual(getPlacementRowLimit('b'), undefined, 'no limit recorded')
})

test('a scrolling transcript does not ratchet an image smaller', () => {
  // Top overflow answers a window change, not a scroll. Acting on it every
  // frame would shrink the image a step at a time as a response streams, each
  // step a layout shift and a full repaint, until it hit the floor and fell
  // back to blocks anyway.
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 20, 8, 12)
  shortViewport(screen, stylePool, 24)
  assertEqual(getPlacementRowLimit('a'), 8, 'answered once')

  shortViewport(screen, stylePool, 26)
  assertEqual(getPlacementRowLimit('a'), 8, 'a further scroll adds nothing')

  forceGraphicsRedraw()
  shortViewport(screen, stylePool, 26)
  assertEqual(getPlacementRowLimit('a'), 6, 'but a resize asks again')
})

test('a recorded limit only ever shrinks, and is cleared by a wipe', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 32, 8, 12)
  build(screen, stylePool)
  assertEqual(getPlacementRowLimit('a'), 8, 'first limit')

  // A later frame with more room must not raise it — that would oscillate.
  nodeCache.set(node, { x: 4, y: 30, width: 8, height: 12 })
  build(screen, stylePool)
  assertEqual(getPlacementRowLimit('a'), 8, 'monotonic')

  // A wipe must NOT clear it. Shrinking an image is a layout change above the
  // viewport, which forces a full reset, whose clearTerminal patch lands here —
  // so clearing the limit closed a loop: re-encode at full size, overflow,
  // shrink, full reset, repeat. That is the zigzag.
  invalidateGraphicsPlacements()
  assertEqual(
    getPlacementRowLimit('a'),
    8,
    'a screen wipe leaves it alone — the viewport did not change',
  )

  forceGraphicsRedraw()
  assertEqual(
    getPlacementRowLimit('a'),
    undefined,
    'only a resize clears it — the limit described the old viewport',
  )
})

test('a shrunken image stays shrunken across the repaint it causes', () => {
  // The zigzag, end to end: the report, the layout shift it causes, and the
  // full reset that follows must settle rather than start over.
  reset()
  const { screen, stylePool } = makeScreen('X')
  const node = place('a', 4, 20, 8, 12)
  shortViewport(screen, stylePool, 24)
  assertEqual(getPlacementRowLimit('a'), 8, 'reported once')

  // The component re-encodes to 8 rows; the shorter box lifts the transcript
  // end, so the viewport top comes down with it and the box now fits.
  setGraphicsPlacement('a', null)
  nodeCache.set(node, { x: 4, y: 20, width: 8, height: 8 })
  place('a', 4, 20, 8, 8)
  invalidateGraphicsPlacements() // the full reset that shift provoked
  const out = shortViewport(screen, stylePool, 20)
  assert(out.includes(PAYLOAD), 'the smaller image draws')
  assertEqual(getPlacementRowLimit('a'), 8, 'and the limit survives the wipe')
})

test('a resize withholds every graphic until the re-measure answers', () => {
  // The zoom ghost. Between the resize and the reply, pixels-per-cell on record
  // still describes the old font size, so an already-encoded payload no longer
  // matches the box the layout reserves — and when the new cell is smaller it
  // overflows, past anything an erase can reach. Take it down instead.
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6, 8, 4, DELETE)
  build(screen, stylePool)

  markCellGeometryStale()
  const during = build(screen, stylePool)
  assert(!during.includes(PAYLOAD), 'nothing is drawn against stale geometry')
  assert(during.includes(DELETE), 'and what was on screen is taken down')

  clearCellGeometryStale()
  const after = build(screen, stylePool)
  assert(after.includes(PAYLOAD), 'it comes back once the measurement lands')
})

// --- Anchoring -------------------------------------------------------------

test('rows are measured from the anchor, columns are addressed absolutely', () => {
  // The misplaced-image bug. The anchor is where the cursor physically is when
  // the sequence runs, and that is the frame's own position only once the
  // frame's patches have moved it there. A frame with an empty text diff writes
  // nothing, leaving the cursor parked at the prompt caret — several rows above
  // and a few columns right — so every draw and every erase landed at that
  // offset. Rows have to follow the anchor; columns must not.
  reset()
  const { screen, stylePool } = makeScreen()
  place('a', 4, 30)
  const anchored = (cursor: { x: number; y: number }): string => {
    invalidateGraphicsPlacements()
    return buildGraphicsSequence({
      cursor,
      viewportTop: 10,
      viewportRows: 30,
      viewportColumns: 60,
      damage: undefined,
      cell: CELL,
      screen,
      stylePool,
    })
  }

  const fromFrameCursor = anchored({ x: 0, y: 39 })
  const fromParkedCaret = anchored({ x: 6, y: 36 })
  assert(
    fromFrameCursor.includes(`\x1b[9A\x1b[5G${PAYLOAD}`),
    'nine rows up from row 39 reaches row 30',
  )
  assert(
    fromParkedCaret.includes(`\x1b[6A\x1b[5G${PAYLOAD}`),
    'six rows up from row 36 reaches the same row — the anchor is honoured',
  )
  assert(
    fromParkedCaret.includes('\x1b[5G'),
    'and the column is the same absolute address from either anchor',
  )
})

// --- Redraw versus invalidate ----------------------------------------------

test('a forced redraw keeps the rectangle the erase needs', () => {
  // A main-screen resize clears nothing — Ink just re-renders, and log-update
  // decides afterwards whether the diff warrants a full reset. The copy already
  // drawn is therefore still on screen and has to be taken down. Invalidating
  // instead dropped the only record of where it was, and the ghost survived
  // every later frame because nothing was left to erase.
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6, 8, 4, DELETE)
  assert(build(screen, stylePool).includes(PAYLOAD), 'drawn')

  forceGraphicsRedraw()
  const out = build(screen, stylePool)
  assert(out.includes(DELETE), 'the copy on screen is taken down')
  assert(out.includes(PAYLOAD), 'and the payload goes back out')
  assert(
    out.indexOf(DELETE) < out.indexOf(PAYLOAD),
    'in that order, or the erase would remove the fresh pixels',
  )
})

test('a wipe forgets the rectangle, having nothing left to erase', () => {
  reset()
  const { screen, stylePool } = makeScreen('X')
  place('a', 4, 6, 8, 4, DELETE)
  build(screen, stylePool)

  invalidateGraphicsPlacements()
  const out = build(screen, stylePool)
  assert(out.includes(PAYLOAD), 'redrawn after the clear')
  assert(
    !out.includes(DELETE),
    'and nothing is deleted — the screen clear already dropped the pixels',
  )
})

test('an erase reaches rows the frame has since dropped', () => {
  // The transcript collapsed under the image. Those rows are no longer part of
  // the frame, so there are no cells to restore — but the pixels are still on
  // screen, and clipping the repaint to the frame's height left them where no
  // later frame could reach them.
  reset()
  const tall = makeScreenOf(60, 40, 'X')
  place('a', 4, 30)
  buildGraphicsSequence({
    cursor: { x: 0, y: 40 },
    viewportTop: 0,
    viewportRows: 40,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen: tall.screen,
    stylePool: tall.stylePool,
  })

  setGraphicsPlacement('a', null)
  const short = makeScreenOf(60, 20, 'X')
  const out = buildGraphicsSequence({
    cursor: { x: 0, y: 20 },
    viewportTop: 0,
    viewportRows: 40,
    viewportColumns: 60,
    damage: undefined,
    cell: CELL,
    screen: short.screen,
    stylePool: short.stylePool,
  })
  assert(
    out.includes(`\x1b[10B\x1b[5G${' '.repeat(8)}`),
    'the vacated rows are blanked rather than skipped',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
