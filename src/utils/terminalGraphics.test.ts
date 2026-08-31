/**
 * Inline graphics checks: protocol selection, cell geometry, and encoding.
 *
 * The risk this file covers is asymmetric. Getting a protocol wrong does not
 * degrade gracefully — sending a sixel payload to a terminal that cannot decode
 * it dumps raw bytes across the transcript — and an image sized even one row
 * taller than its reserved box shoves the whole transcript down. So the fitting
 * tests assert bounds rather than exact numbers, and detection is verified to
 * be conservative wherever the evidence is weak.
 *
 * Run via: bun run src/utils/terminalGraphics.test.ts
 */

import {
  INITIAL_STATE,
  type ParsedInput,
  parseMultipleKeypresses,
} from '../ink/parse-keypress.js'
import {
  allocateKittyImageId,
  clearCellGeometryStale,
  encodeITerm2Graphics,
  encodeKittyDelete,
  encodeKittyGraphics,
  fitGraphicsToCells,
  getCellPixelSize,
  getGraphicsGeneration,
  isCellGeometryCurrent,
  type GraphicsProtocol,
  isCellGeometryStale,
  markCellGeometryStale,
  renderGraphicsOverlay,
  resolveGraphicsProtocol,
  setCellPixelSize,
} from './terminalGraphics.js'

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

/**
 * Awaited variant. The synchronous `test` would count a promise-returning body
 * as passed the moment it suspended, and report the tally before any assertion
 * inside it had run.
 */
async function asyncTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
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

/** Resolve with an explicit env and DA1 params, assuming a TTY. */
function protocolOf(
  env: NodeJS.ProcessEnv,
  da1: readonly number[] | null = null,
  isTTY = true,
): GraphicsProtocol {
  return resolveGraphicsProtocol(env, da1, isTTY)
}

// --- Protocol selection ----------------------------------------------------

test('kitty and ghostty select the Kitty protocol', () => {
  assertEqual(protocolOf({ TERM: 'xterm-kitty' }), 'kitty', 'kitty via TERM')
  assertEqual(protocolOf({ KITTY_WINDOW_ID: '1' }), 'kitty', 'kitty via env')
  assertEqual(protocolOf({ TERM: 'xterm-ghostty' }), 'kitty', 'ghostty')
  assertEqual(
    protocolOf({ TERM_PROGRAM: 'WezTerm' }),
    'kitty',
    'wezterm implements the Kitty protocol',
  )
})

test('iTerm2 selects its own protocol', () => {
  assertEqual(
    protocolOf({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }),
    'iterm2',
    'iTerm2 inline images',
  )
})

test('sixel comes only from DA1, never from TERM', () => {
  // This is the whole point of the runtime probe: Windows Terminal, foot and
  // plain xterm are indistinguishable by TERM, but only some decode sixel.
  assertEqual(
    protocolOf({ TERM: 'xterm-256color', WT_SESSION: 'x' }, [65, 4, 6, 22]),
    'sixel',
    'DA1 advertising 4 enables sixel',
  )
  assertEqual(
    protocolOf({ TERM: 'xterm-256color', WT_SESSION: 'x' }, [65, 1, 6]),
    'none',
    'no 4 in DA1 means no sixel, despite Windows Terminal',
  )
  assertEqual(
    protocolOf({ TERM: 'xterm-256color' }, null),
    'none',
    'an unanswered DA1 stays off',
  )
})

test('multiplexers are excluded', () => {
  // tmux and screen rewrite the byte stream; without protocol-specific
  // passthrough the payload is mangled and the pane corrupted.
  assertEqual(
    protocolOf({ TMUX: '/tmp/x,1,0', TERM: 'tmux-256color' }, [4]),
    'none',
    'tmux is excluded even with sixel DA1',
  )
  assertEqual(
    protocolOf({ STY: '1234.pts-0', TERM: 'screen' }, [4]),
    'none',
    'screen is excluded',
  )
  assertEqual(
    protocolOf({ TMUX: '/tmp/x,1,0', TERM: 'xterm-kitty' }),
    'none',
    'tmux beats a kitty TERM',
  )
})

test('xterm.js terminals are excluded', () => {
  // VS Code would print the payload as text rather than draw it.
  assertEqual(
    protocolOf({ TERM_PROGRAM: 'vscode' }, [4]),
    'none',
    'vscode is excluded',
  )
})

test('a non-TTY and NO_COLOR are excluded', () => {
  assertEqual(protocolOf({ TERM: 'xterm-kitty' }, [4], false), 'none', 'not a TTY')
  assertEqual(
    protocolOf({ NO_COLOR: '1', TERM: 'xterm-kitty' }, [4]),
    'none',
    'NO_COLOR',
  )
})

test('TAU_IMAGE_PROTOCOL overrides detection in both directions', () => {
  assertEqual(
    protocolOf({ TAU_IMAGE_PROTOCOL: 'off', TERM: 'xterm-kitty' }, [4]),
    'none',
    'off is absolute',
  )
  assertEqual(
    protocolOf({ TAU_IMAGE_PROTOCOL: 'sixel', TERM: 'dumb' }, null),
    'sixel',
    'forcing works without any probe',
  )
  assertEqual(
    protocolOf({ TAU_IMAGE_PROTOCOL: 'kitty', TMUX: '/tmp/x' }, null),
    'kitty',
    'an explicit force beats the tmux exclusion',
  )
})

// --- Cell geometry ---------------------------------------------------------

test('implausible cell sizes are rejected, keeping the fallback', () => {
  const before = getCellPixelSize()
  for (const bogus of [
    { width: 0, height: 0 },
    { width: -8, height: 16 },
    { width: 8, height: Number.NaN },
    { width: 4000, height: 16 },
    { width: 8, height: 900 },
    null,
  ]) {
    setCellPixelSize(bogus)
    const now = getCellPixelSize()
    assertEqual(now.width, before.width, `width unchanged for ${JSON.stringify(bogus)}`)
    assertEqual(now.height, before.height, `height unchanged for ${JSON.stringify(bogus)}`)
  }
})

test('a plausible cell size is accepted and floored', () => {
  setCellPixelSize({ width: 9.6, height: 20.4 })
  assertEqual(getCellPixelSize().width, 9, 'width floored')
  assertEqual(getCellPixelSize().height, 20, 'height floored')
})

// --- Fitting ---------------------------------------------------------------

test('a graphic never exceeds its reserved box', () => {
  // The one failure that corrupts the transcript rather than looking wrong.
  const cell = { width: 10, height: 20 }
  for (const [w, h] of [
    [3287, 2023],
    [700, 400],
    [100, 4000],
    [4000, 100],
    [1, 1],
  ]) {
    for (const [cols, rows] of [
      [80, 24],
      [182, 56],
      [10, 3],
    ]) {
      const fit = fitGraphicsToCells(w!, h!, cols!, rows!, cell)
      assert(fit.columns <= cols!, `columns within box for ${w}x${h} @ ${cols}x${rows}`)
      assert(fit.rows <= rows!, `rows within box for ${w}x${h} @ ${cols}x${rows}`)
      assert(fit.pixelWidth >= 1 && fit.pixelHeight >= 1, 'non-degenerate')
      assert(
        fit.pixelHeight <= rows! * cell.height,
        `pixel height fits the reserved rows for ${w}x${h}`,
      )
    }
  }
})

test('a graphic covers its cell box exactly', () => {
  // The ragged-ASCII-border bug: sized to the aspect alone, the graphic lands a
  // fraction of a cell short and the fallback rendered underneath shows through
  // along the right and bottom edges. Pixel extent must be an exact multiple of
  // the cell, so the box it reports is the box it fills.
  for (const cell of [
    { width: 7, height: 14 },
    { width: 10, height: 20 },
    { width: 9, height: 21 },
  ]) {
    for (const [w, h] of [
      [3287, 2023],
      [1130, 680],
      [700, 400],
      [512, 512],
    ]) {
      const fit = fitGraphicsToCells(w!, h!, 140, 40, cell)
      assertEqual(
        fit.pixelWidth,
        fit.columns * cell.width,
        `width is a whole number of cells for ${w}x${h}`,
      )
      assertEqual(
        fit.pixelHeight,
        fit.rows * cell.height,
        `height is a whole number of cells for ${w}x${h}`,
      )
    }
  }
})

test('fitting preserves aspect ratio', () => {
  const cell = { width: 10, height: 20 }
  const fit = fitGraphicsToCells(800, 400, 100, 50, cell)
  assert(
    Math.abs(fit.pixelWidth / fit.pixelHeight - 2) < 0.02,
    `2:1 preserved, got ${fit.pixelWidth}x${fit.pixelHeight}`,
  )
})

test('a small graphic is not scaled up beyond cell rounding', () => {
  // Exact cell coverage and exact source dimensions cannot both hold: a 30px
  // image in 20px cells is either one row or two, never one and a half.
  // Coverage wins — a fractional cell is where the fallback shows through —
  // so the guarantee is that rounding never moves the image by more than one
  // cell in either direction.
  const cell = { width: 10, height: 20 }
  const fit = fitGraphicsToCells(40, 30, 200, 60, cell)
  assert(
    Math.abs(fit.pixelWidth - 40) <= cell.width,
    `width within one cell of source, got ${fit.pixelWidth}`,
  )
  assert(
    Math.abs(fit.pixelHeight - 30) <= cell.height,
    `height within one cell of source, got ${fit.pixelHeight}`,
  )
  // Still no wholesale upscaling: a small image stays small.
  assert(fit.columns <= 5 && fit.rows <= 2, 'occupies only the cells it needs')
})

test('rounding stays negligible at realistic image sizes', () => {
  // The distortion is bounded by half a cell, so it only matters for images
  // measured in a handful of cells. Screenshots and plots are unaffected.
  const cell = { width: 10, height: 20 }
  for (const [w, h] of [
    [3287, 2023],
    [1130, 680],
    [800, 450],
  ]) {
    const fit = fitGraphicsToCells(w!, h!, 140, 40, cell)
    const sourceAspect = w! / h!
    const renderedAspect = fit.pixelWidth / fit.pixelHeight
    const error = Math.abs(renderedAspect - sourceAspect) / sourceAspect
    assert(error < 0.05, `aspect within 5% for ${w}x${h}, got ${(error * 100).toFixed(1)}%`)
  }
})

test('degenerate dimensions do not throw', () => {
  for (const [w, h] of [[0, 0], [-5, 10], [Number.NaN, 10]]) {
    const fit = fitGraphicsToCells(w!, h!, 80, 24, { width: 10, height: 20 })
    assert(fit.columns >= 1 && fit.rows >= 1, `safe fallback for ${w}x${h}`)
  }
})

test('stale cell geometry is what overflows the box', () => {
  // The ghost-image bug: encode believing a cell is 10x20, then the user zooms
  // out and a cell becomes 7x14. The payload now needs more rows than were
  // reserved, so it spills past the cells that would have erased it.
  const box = { columns: 112, rows: 22 }
  const encoded = fitGraphicsToCells(1200, 800, box.columns, box.rows, {
    width: 10,
    height: 20,
  })
  const rowsAfterZoom = Math.ceil(encoded.pixelHeight / 14)
  assert(
    rowsAfterZoom > box.rows,
    `stale geometry overflows: needs ${rowsAfterZoom} of ${box.rows} rows`,
  )

  // Re-measuring and re-encoding fits again — which is why cell size is
  // re-probed on resize rather than measured once at startup.
  const reencoded = fitGraphicsToCells(1200, 800, box.columns, box.rows, {
    width: 7,
    height: 14,
  })
  assert(
    Math.ceil(reencoded.pixelHeight / 14) <= box.rows,
    're-encoding against true geometry fits',
  )
})

test('a graphic fits its box for any plausible cell geometry', () => {
  for (const cell of [
    { width: 6, height: 12 },
    { width: 7, height: 14 },
    { width: 10, height: 20 },
    { width: 14, height: 30 },
    { width: 20, height: 44 },
  ]) {
    const fit = fitGraphicsToCells(3287, 2023, 112, 22, cell)
    assert(
      Math.ceil(fit.pixelHeight / cell.height) <= 22,
      `fits at ${cell.width}x${cell.height}`,
    )
    assert(
      Math.ceil(fit.pixelWidth / cell.width) <= 112,
      `width fits at ${cell.width}x${cell.height}`,
    )
  }
})

// --- Encoding --------------------------------------------------------------

test('a small Kitty payload is a single APC', () => {
  const seq = encodeKittyGraphics('AAAA', 10, 5)
  assertEqual(
    seq,
    '\x1b_Ga=T,f=100,q=2,C=1,c=10,r=5;AAAA\x1b\\',
    'single chunk',
  )
})

test('a large Kitty payload is chunked with correct continuation flags', () => {
  const seq = encodeKittyGraphics('x'.repeat(10_000), 20, 10)
  const chunks = seq.split('\x1b\\').filter(Boolean)
  assertEqual(chunks.length, 3, '10000 base64 chars span three 4096 chunks')
  assert(chunks[0]!.includes(',m=1;'), 'first chunk continues')
  assert(chunks[1]!.includes('m=1;'), 'middle chunk continues')
  assert(chunks[2]!.includes('m=0;'), 'last chunk terminates')
  assert(chunks[0]!.includes('c=20,r=10'), 'geometry only on the first chunk')
})

test('the iTerm2 payload carries inline geometry', () => {
  const seq = encodeITerm2Graphics('QUJD', 12, 6)
  assert(seq.startsWith('\x1b]1337;File=inline=1;'), 'OSC 1337 introducer')
  assert(seq.includes('width=12;height=6'), 'sized in cells')
  assert(seq.endsWith('QUJD\x07'), 'BEL terminated')
})

// --- Parser addition -------------------------------------------------------

/** Parse one sequence and return the first parsed item. */
function parseOne(sequence: string): ParsedInput | undefined {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, sequence)
  return items[0]
}

test('XTWINOPS pixel reports parse as responses, not keys', () => {
  const cell = parseOne('\x1b[6;20;10t')
  assertEqual(cell?.kind, 'response', 'CSI 6 is a response, not a key')
  const cellResponse = (cell as any)?.response
  assertEqual(cellResponse?.type, 'pixelSize', 'recognised as a pixel report')
  assertEqual(cellResponse?.kind, 'cell', 'CSI 16 t answers cell size')
  assertEqual(cellResponse?.height, 20, 'height is reported first')
  assertEqual(cellResponse?.width, 10, 'width second')

  const win = parseOne('\x1b[4;1080;1920t')
  const winResponse = (win as any)?.response
  assertEqual(winResponse?.kind, 'window', 'CSI 14 t answers window size')
  assertEqual(winResponse?.height, 1080, 'window height')
  assertEqual(winResponse?.width, 1920, 'window width')
})

test('the pixel-size pattern does not swallow ordinary input', () => {
  // A regex loose enough to match a keypress would eat real typing — the worst
  // possible failure for an input-path change.
  for (const seq of [
    'a',
    '\x1b[A',
    '\x1b[1;5A',
    '\x1b[3~',
    '\r',
    '\x1b[27;2;13~',
    '\x1b[13;2u',
  ]) {
    const parsed = parseOne(seq)
    const type = (parsed as any)?.response?.type
    assert(
      type !== 'pixelSize',
      `${JSON.stringify(seq)} must not parse as a pixel report`,
    )
  }
})

// --- Kitty identity and deletion -------------------------------------------

test('a Kitty payload carries the image id it can later be deleted by', () => {
  // Without an id the terminal assigns its own, nothing can refer to the image
  // afterwards, and every redraw stacks another placement no erase can reach.
  const id = allocateKittyImageId()
  const seq = encodeKittyGraphics('AAAA', 10, 5, id)
  assert(seq.includes(`,i=${id},`), 'the transmit names the image')
  assertEqual(
    encodeKittyDelete(id),
    `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`,
    'and the delete addresses that same id',
  )
})

test('an omitted id leaves the transmit unchanged', () => {
  assert(
    !encodeKittyGraphics('AAAA', 10, 5).includes('i='),
    'no id key when none was allocated',
  )
})

test('allocated image ids are distinct and stay in the low 24 bits', () => {
  // Ids are a namespace shared with every other program drawing to this
  // terminal, and transmitting with one already in use replaces that image.
  // Above 2^24 the Unicode placeholder encoding needs an extra diacritic byte.
  const ids = new Set<number>()
  for (let i = 0; i < 500; i++) {
    const id = allocateKittyImageId()
    assert(id >= 1 && id <= 0xff_ff_ff, `${id} is within the 24-bit range`)
    assert(!ids.has(id), 'ids are not reused')
    ids.add(id)
  }
})

// --- Geometry staleness ----------------------------------------------------

test('a resize marks geometry stale until a measurement lands', () => {
  setCellPixelSize({ width: 10, height: 20 })
  assert(!isCellGeometryStale(), 'a fresh measurement is not stale')
  markCellGeometryStale()
  assert(isCellGeometryStale(), 'the resize marked it')
  setCellPixelSize({ width: 8, height: 16 })
  assert(!isCellGeometryStale(), 'the new measurement cleared it')
  assertEqual(getCellPixelSize().height, 16, 'and took effect')
})

test('a probe that never answers does not disable graphics forever', () => {
  markCellGeometryStale()
  clearCellGeometryStale()
  assert(
    !isCellGeometryStale(),
    'the last known geometry stands rather than being lost',
  )
})

await asyncTest('the stale mark lapses on its own', async () => {
  // The mark is normally lifted by the re-measure landing, and that cannot be
  // relied on: TerminalQuerier never times out — a batch settles only when its
  // DA1 sentinel returns — so a reply dropped during a resize leaves the
  // promise unsettled for good. Nothing here may depend on it: a mark that
  // outlives its window means every image falls back to block glyphs
  // permanently, which is what "sharp at first, blurry after I resize" was.
  setCellPixelSize({ width: 10, height: 20 })
  markCellGeometryStale()
  assert(isCellGeometryStale(), 'marked')
  await new Promise(resolve => setTimeout(resolve, 450))
  assert(
    !isCellGeometryStale(),
    'the mark expired without anyone clearing it',
  )
  const overlay = await renderGraphicsOverlay(
    Buffer.from('not really a png'),
    40,
    20,
    'sixel',
  )
  // Null here because the payload is not a real image, not because of the mark
  // — what matters is that the geometry guard is no longer the thing stopping
  // it. A live run re-encodes and the image comes back sharp.
  assertEqual(overlay, null, 'decode fails on its own merits, not on the mark')
})

await asyncTest('no graphic is encoded while the cell size is unknown', async () => {
  // Pixels per cell is the one number that must be right: the payload is sized
  // in pixels and the box reserved in cells. Encoding against the previous font
  // size draws something the box does not match, and on zoom out — smaller
  // cells — it overflows into cells no erase will ever reach.
  markCellGeometryStale()
  const overlay = await renderGraphicsOverlay(
    Buffer.from('not really a png'),
    40,
    20,
    'sixel',
  )
  clearCellGeometryStale()
  assertEqual(overlay, null, 'withheld until the re-measure answers')
})

test('a measurement stops being usable once the grid moves under it', () => {
  // Scaling the old number by the grid ratio was exact for a zoom and badly
  // wrong for a drag, and a window that grew several times over — opened small,
  // then maximised — scaled the cell down far enough that the payload covered a
  // fraction of the box the layout had reserved: a small image stranded in a
  // screenful of blank rows. Nothing local can tell a zoom from a drag, so the
  // answer is to stop guessing and ask again.
  setCellPixelSize({ width: 10, height: 20 }, { columns: 120, rows: 40 })
  assert(isCellGeometryCurrent(), 'a fresh measurement describes its own grid')
  markCellGeometryStale()
  clearCellGeometryStale({ columns: 480, rows: 160 })
  assert(!isCellGeometryCurrent(), 'and stops describing a different one')
  assertEqual(getCellPixelSize().width, 10, 'the measurement itself is untouched')
})

test('the same grid keeps the measurement usable', () => {
  // A resize that did not change the grid, or a probe that answered: neither is
  // a reason to take graphics away.
  setCellPixelSize({ width: 10, height: 20 }, { columns: 120, rows: 40 })
  markCellGeometryStale()
  clearCellGeometryStale({ columns: 120, rows: 40 })
  assert(isCellGeometryCurrent(), 'still current')
})

test('a reply for the new grid makes it usable again', () => {
  setCellPixelSize({ width: 10, height: 20 }, { columns: 120, rows: 40 })
  markCellGeometryStale()
  clearCellGeometryStale({ columns: 480, rows: 160 })
  assert(!isCellGeometryCurrent(), 'withheld meanwhile')
  setCellPixelSize({ width: 6, height: 12 }, { columns: 480, rows: 160 })
  assert(isCellGeometryCurrent(), 'the retry restores it')
  assertEqual(getCellPixelSize().height, 12, 'at the size the terminal reported')
})

test('a grid we cannot read is not evidence either way', () => {
  // A non-TTY reports zero columns; that says nothing about the font.
  setCellPixelSize({ width: 10, height: 20 }, { columns: 120, rows: 40 })
  markCellGeometryStale()
  clearCellGeometryStale({ columns: 0, rows: 0 })
  assert(isCellGeometryCurrent(), 'left as it stands')
})

await asyncTest('the stale mark announces its own expiry', async () => {
  // The latch behind "it goes blurry when I zoom and never comes back".
  // Withholding a graphic is a decision taken while rendering, and nothing
  // re-runs on its own when the clock passes a deadline — so the mark lapsing
  // quietly left every image on block glyphs with no edge left to bring them
  // back. The probe reply normally supplies that edge, and it is exactly what
  // goes missing in a resize burst: coalesced into a query already out, or
  // dropped along with the DA1 sentinel that would have settled it.
  setCellPixelSize({ width: 10, height: 20 }, { columns: 120, rows: 40 })
  const before = getGraphicsGeneration()
  markCellGeometryStale()
  await new Promise(resolve => setTimeout(resolve, 450))
  assert(!isCellGeometryStale(), 'the mark expired')
  assert(
    getGraphicsGeneration() > before + 1,
    'and announced the expiry, not just the marking',
  )
})

await asyncTest('a measurement that lands cancels the pending announcement', async () => {
  markCellGeometryStale()
  setCellPixelSize({ width: 10, height: 20 }, { columns: 120, rows: 40 })
  const settled = getGraphicsGeneration()
  await new Promise(resolve => setTimeout(resolve, 450))
  assertEqual(
    getGraphicsGeneration(),
    settled,
    'no stray announcement once the mark has been settled another way',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
