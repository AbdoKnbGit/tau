import {
  type AnsiCode,
  ansiCodesToString,
  diffAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import type { DOMElement } from './dom.js'
import type { Rectangle } from './layout/geometry.js'
import { nodeCache } from './node-cache.js'
import { cellAt, CellWidth, type Screen, type StylePool } from './screen.js'
import { logForDebugging } from '../utils/debug.js'
import { isCellGeometryStale } from '../utils/terminalGraphics.js'
import { cursorMove, cursorTo } from './termio/csi.js'

/**
 * Out-of-band placement of terminal graphics (sixel / Kitty / iTerm2) inside an
 * Ink frame.
 *
 * Graphics protocols cannot live in the cell buffer: `Output.write()` tokenizes
 * SGR into interned styles and writes grapheme clusters, so a DCS or APC
 * payload would be shredded. They are therefore written *after* the frame's
 * text patches, with the cursor moved to the image's origin and put back
 * afterwards, so the pixels land on top of the cells the layout reserved.
 *
 * The hard part is not drawing but erasing. Pixels are invisible to Ink's cell
 * model: the frame diff rewrites a cell only when its *text* changes, so when a
 * graphic moves — the transcript scrolls, the window resizes — the cells it
 * used to cover often compare equal and are skipped, and the old pixels stay on
 * screen under the new ones. That is the duplicated, overlapping image.
 *
 * Two erases are used, in that order. Kitty can be told to drop an image by id
 * (`a=d`), which needs no cursor position and no theory about where the pixels
 * ended up — it reaches even a payload that overflowed its box or a rectangle
 * clipped away at the viewport edge. Sixel and iTerm2 have nothing equivalent,
 * so a placement also remembers the rectangle it last drew into and repaints
 * those cells from the *current* frame. Repainting rather than blanking is what
 * makes that safe: whatever text has since moved in is restored exactly, and
 * the stale pixels are overwritten as a side effect of writing characters.
 *
 * A placement is skipped — falling back to the cells beneath, after erasing —
 * when the node did not render, when its box is not wholly inside the viewport
 * (the cursor cannot address a row that has scrolled away), when the cell
 * geometry it was encoded against no longer holds, or while a resize has left
 * that geometry unmeasured. The last of those is the zoom case: a payload is a
 * fixed number of pixels, so once the cell size changes it no longer matches
 * the box the layout reserves, and when the new cell is smaller it spills past
 * the rectangle the erase is computed from, where nothing can ever clear it.
 */
export type GraphicsPlacement = {
  /** Node whose {@link nodeCache} rect supplies the absolute screen origin. */
  readonly node: DOMElement
  /** Complete, ready-to-write escape sequence for the image. */
  readonly sequence: string
  /**
   * Protocol-native removal, where one exists (Kitty's `a=d`).
   *
   * Preferred over repainting the cells underneath, which only works because
   * terminals happen to drop an image when text is written over it. Deleting by
   * id also reaches pixels the cell repaint cannot: anything the payload put
   * outside the rectangle it was supposed to occupy, and placements stranded
   * above the viewport where the cursor cannot be addressed.
   */
  readonly eraseSequence?: string
  /** Cell rows the image occupies; must match the box the node reserved. */
  readonly rows: number
  /** Cell columns the image occupies. */
  readonly columns: number
  /**
   * Cell geometry the payload was encoded against.
   *
   * A graphic is measured in pixels but reserved in cells, so the two only
   * agree while the cell size holds. Zooming changes the font size and with it
   * the pixels per cell, and re-measuring is asynchronous — this records what
   * the encode assumed so the draw can be withheld until a fresh encode
   * matches.
   */
  readonly cellWidth: number
  readonly cellHeight: number
}

/** DECSC / DECRC. Brackets every emission so Ink's cursor model stays true. */
const SAVE_CURSOR = '\x1b7'
const RESTORE_CURSOR = '\x1b8'

/** A rectangle of cells, in logical screen coordinates. */
type CellRect = {
  x: number
  /** Logical transcript row. */
  y: number
  columns: number
  rows: number
}

type DrawnRect = CellRect & {
  /**
   * Viewport origin at the moment of drawing.
   *
   * Pixels live in physical screen rows; `y` is a logical transcript row. The
   * two only correspond through this offset, and it changes as the transcript
   * grows. An image can therefore sit still logically while its pixels move —
   * which is exactly the ghost that a logical-only comparison never notices.
   */
  viewportTop: number
  /**
   * The placement's protocol-native removal, copied here at draw time.
   *
   * `lastDrawn` outlives the placement on purpose — an unmounted image still
   * has pixels on screen — so the sequence needed to remove them has to be
   * recorded alongside the rectangle rather than read back from a map the
   * unmount already emptied.
   */
  eraseSequence?: string
  /**
   * Identity of the payload that was drawn.
   *
   * A re-encode — the window widened, the image was re-fitted — produces a new
   * payload, and under Kitty a new image id with it. If that lands on the same
   * cells as the old one the geometry test reports "unmoved" and the previous
   * id is never deleted, leaving an image in the terminal's store for the rest
   * of the session with nothing left that can refer to it.
   */
  sequence: string
  /** Checksum of the covered cells at draw time; see {@link checksumRect}. */
  checksum: number
  /**
   * Redraw epoch this record belongs to; see {@link forceGraphicsRedraw}.
   *
   * A record from an earlier epoch describes pixels that are still on screen
   * but can no longer be trusted to be where the layout now says they are, so
   * it is kept for the erase and treated as a move for the redraw.
   */
  redrawGeneration: number
}

/**
 * Row limit fed back to a placement whose box did not fit the viewport.
 *
 * An overlay is only drawn when its whole rectangle is inside the viewport —
 * the cursor cannot address a row that has scrolled away, and a payload running
 * past the bottom edge can scroll the window. Withholding on that basis is
 * correct but was terminal: the component had no way to learn it had asked for
 * a box that could not be drawn, so it kept re-encoding the same too-tall image
 * and the block-glyph fallback stood indefinitely. Reporting how many rows were
 * actually available closes the loop, and an image that would not fit comes back
 * one size smaller instead of not at all.
 *
 * Only shrinks, and only ever from a bottom overflow — an image scrolled off the
 * top is not helped by being shorter. Monotonic with a floor, so it converges.
 */
const rowLimits = new Map<string, number>()
let constraintGeneration = 0
const constraintListeners = new Set<() => void>()

/** Below this a shrunken image is not worth drawing; the blocks are better. */
const MIN_PLACEMENT_ROWS = 6

/** Rows this placement may occupy, or undefined if it has never been clipped. */
export function getPlacementRowLimit(id: string): number | undefined {
  return rowLimits.get(id)
}

export function getGraphicsConstraintGeneration(): number {
  return constraintGeneration
}

export function subscribeGraphicsConstraints(listener: () => void): () => void {
  constraintListeners.add(listener)
  return () => {
    constraintListeners.delete(listener)
  }
}

/**
 * Record that `id` had only `rows` to work with.
 *
 * Notification is deferred: this runs while Ink is assembling a frame, and
 * waking React synchronously from there would re-enter rendering.
 */
function reportRowLimit(id: string, rows: number): void {
  if (rows < MIN_PLACEMENT_ROWS) return
  const previous = rowLimits.get(id)
  if (previous !== undefined && previous <= rows) return
  rowLimits.set(id, rows)
  constraintGeneration++
  queueMicrotask(() => {
    for (const listener of constraintListeners) listener()
  })
}

const placements = new Map<string, GraphicsPlacement>()
/** Rectangle each placement last painted pixels into. */
const lastDrawn = new Map<string, DrawnRect>()

/** Register (or with `null`, remove) a placement. Keyed by a caller-stable id. */
export function setGraphicsPlacement(
  id: string,
  placement: GraphicsPlacement | null,
): void {
  if (placement === null) {
    placements.delete(id)
    // Deliberately keeps `lastDrawn`: the pixels are still on screen, and the
    // next frame has to erase them even though the placement is gone.
    return
  }
  placements.set(id, placement)
}

export function hasGraphicsPlacements(): boolean {
  return placements.size > 0 || lastDrawn.size > 0
}

/**
 * Epoch counter for {@link forceGraphicsRedraw}.
 *
 * Bumping it makes every recorded rectangle compare as "moved" on the next
 * frame without discarding it, which is the difference between "the terminal
 * dropped the pixels" and "the pixels are still there but everything around
 * them changed".
 */
let redrawGeneration = 0

/**
 * Placements already told about a top overflow in this epoch; see
 * `reportOverflow` in {@link buildGraphicsSequence}.
 */
const topOverflowReported = new Set<string>()

/**
 * Start a new epoch: the *viewport* changed, so every limit learned under the
 * old one is void and every placement gets to answer for the new one.
 *
 * Deliberately not called on a screen wipe. A wipe does not change how much
 * room a box has — and clearing the limits there closed a loop: shrinking an
 * image is a layout change above the viewport, which forces a full reset, whose
 * `clearTerminal` patch wiped the limit that had just been learned, so the
 * image re-encoded at full size, overflowed again, and shrank again. That is
 * the zigzag. Only a resize starts an epoch.
 */
function beginViewportEpoch(): void {
  topOverflowReported.clear()
  if (rowLimits.size === 0) return
  rowLimits.clear()
  constraintGeneration++
  queueMicrotask(() => {
    for (const listener of constraintListeners) listener()
  })
}

/**
 * Forget where the pixels are, because the terminal no longer has them.
 *
 * Only correct when the screen was actually cleared: `lastDrawn` is the sole
 * record of which cells hold stale pixels, so dropping it while they are still
 * on screen strands them permanently — no later frame has anything left to
 * erase. Use {@link forceGraphicsRedraw} whenever the pixels survive.
 */
export function invalidateGraphicsPlacements(): void {
  lastDrawn.clear()
}

/**
 * Redraw every placement on the next frame, keeping the erase rectangles.
 *
 * The main-screen resize case. Nothing clears the terminal there — Ink just
 * re-renders, and log-update decides afterwards whether the diff warrants a
 * full reset — so the pixels are still on screen while the layout underneath
 * them has reflowed. The redraw has to be forced (the image may not have moved
 * in logical rows, and a settled frame reports no damage, so it would be
 * skipped as "already on screen"), but the rectangles have to be kept, or the
 * copy already drawn can never be taken down. Invalidating did both, which is
 * where the surviving ghost came from.
 */
export function forceGraphicsRedraw(): void {
  redrawGeneration++
  beginViewportEpoch()
}


/**
 * Whether two draws occupy the same cells of the *transcript*.
 *
 * This decides whether the payload has to be sent again, and it is deliberately
 * the *logical* rectangle rather than the physical one. The two differ only
 * when the viewport origin moved — the transcript grew and everything scrolled
 * up — and in that case the terminal has already carried the pixels along with
 * the text. Writing text over a sixel clears it, which means the pixels belong
 * to buffer cells rather than to the window, and cells scroll.
 *
 * Comparing physical rectangles instead made every frame of a streaming
 * response a move: `viewportTop` advances by a row, nothing is actually
 * different, and a payload running to hundreds of kilobytes is erased and
 * re-sent. The terminal cannot absorb that at frame rate, so the writes tear
 * and land as partial images — the "it keeps moving and the terminal goes
 * malformed" failure, and the half-drawn leftovers behind it.
 *
 * `viewportTop` is still recorded, because the *erase* has to know which
 * physical rows a rectangle occupied.
 */
function sameLogicalRect(a: DrawnRect, b: DrawnRect): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.columns === b.columns &&
    a.rows === b.rows
  )
}

function overlaps(rect: CellRect, damage: Rectangle | undefined): boolean {
  if (!damage) return false
  return (
    damage.x < rect.x + rect.columns &&
    rect.x < damage.x + damage.width &&
    damage.y < rect.y + rect.rows &&
    rect.y < damage.y + damage.height
  )
}

/**
 * Cheap checksum of the cells a graphic covers.
 *
 * Answers the only question that matters for a redraw: did this frame write
 * text into the image's rectangle, clearing the pixels there? `damage` cannot,
 * being a bounding box over everything written anywhere — during a streaming
 * response it spans most of the frame, so it reported an overlap on every frame
 * and forced a full re-send of the payload each time. That is what made the
 * image thrash and the terminal tear.
 *
 * The cells under a graphic are its block-glyph fallback, which only changes
 * when the image is re-encoded, and log-update writes a cell only when its
 * content differs. So an unchanged checksum means those cells were not
 * rewritten, which means the pixels are still there.
 *
 * A few thousand cell reads per frame, against a payload of hundreds of
 * kilobytes avoided.
 */
function checksumRect(screen: Screen, rect: CellRect): number {
  let hash = 0x81_1c_9d_c5
  const bottom = Math.min(screen.height, rect.y + rect.rows)
  const right = Math.min(screen.width, rect.x + rect.columns)
  for (let y = Math.max(0, rect.y); y < bottom; y++) {
    for (let x = Math.max(0, rect.x); x < right; x++) {
      const cell = cellAt(screen, x, y)
      hash ^= cell === undefined ? 0 : cell.char.charCodeAt(0) | 0
      hash = Math.imul(hash, 0x01_00_01_93)
      hash ^= cell === undefined ? 0 : cell.styleId
      hash = Math.imul(hash, 0x01_00_01_93)
    }
  }
  return hash | 0
}

/**
 * Rewrite a rectangle of cells from the current frame.
 *
 * Mirrors log-update's full-frame serializer for a sub-rectangle: interned
 * styles are diffed between cells so only transitions are emitted, and each row
 * ends reset so nothing leaks into the surrounding frame. Writing characters is
 * what actually clears pixels — a terminal drops the image data for a cell the
 * moment text is drawn into it.
 *
 * `anchorRow` is the logical row the terminal cursor is on. Only the row is
 * needed: the column is addressed absolutely, so it cannot drift and cannot
 * inherit a pending wrap left by the previous row's text.
 */
function repaintRect(
  screen: Screen,
  stylePool: StylePool,
  rect: CellRect,
  anchorRow: number,
): string {
  let out = ''
  let cy = anchorRow
  let styles: AnsiCode[] = []

  for (let row = 0; row < rect.rows; row++) {
    const y = rect.y + row
    if (y < 0) continue

    let line = ''
    if (y >= screen.height) {
      // A row the image outlived: the transcript shrank and this row is no
      // longer part of the frame, so there are no cells to restore — but the
      // pixels are still on screen and only written characters remove them.
      // The caller has clipped to the viewport, so these rows are Ink's own.
      const reset = diffAnsiCodes(styles, [])
      if (reset.length > 0) {
        line += ansiCodesToString(reset)
        styles = []
      }
      line += ' '.repeat(
        Math.max(0, Math.min(rect.columns, screen.width - rect.x)),
      )
    } else {
      for (let x = rect.x; x < rect.x + rect.columns; x++) {
        if (x < 0 || x >= screen.width) continue
        const cell = cellAt(screen, x, y)
        // A wide glyph's trailing half carries no character of its own.
        if (!cell || cell.width === CellWidth.SpacerTail) continue
        const cellStyles = stylePool.get(cell.styleId)
        const transition = diffAnsiCodes(styles, cellStyles)
        if (transition.length > 0) {
          line += ansiCodesToString(transition)
          styles = cellStyles
        }
        line += cell.char === '' ? ' ' : cell.char
      }
    }
    if (line === '') continue

    out += cursorMove(0, y - cy) + cursorTo(rect.x + 1)
    cy = y
    out += line
    // Reset per row so the next row's transition starts from a known state.
    const reset = diffAnsiCodes(styles, [])
    if (reset.length > 0) {
      out += ansiCodesToString(reset)
      styles = []
    }
  }
  return out
}

/**
 * Build the escape sequence that erases stale graphics and draws current ones.
 *
 * `cursor` is the anchor: where the terminal cursor physically is at the moment
 * this sequence runs. Rows are addressed relative to it, because the physical
 * row of a logical transcript row is only knowable through the cursor — Ink
 * never learns where on the screen its output began. Columns are addressed
 * absolutely, so only the anchor's row is load-bearing.
 *
 * The caller owns that value and must not assume it: the cursor is at the
 * frame's declared position only once the frame's patches have moved it there.
 * A frame whose text diff is empty writes nothing, leaving the cursor parked
 * wherever the previous frame put it — and anchoring to the wrong row drew and
 * erased every image at that offset, which no amount of erase logic can fix
 * because the erase misses by the same amount.
 *
 * Every emission is bracketed in DECSC/DECRC, so the caller's own positioning
 * is unaffected. Returns an empty string when there is nothing to do.
 */
export function buildGraphicsSequence(options: {
  cursor: { x: number; y: number }
  /** Logical row at the top of the physical terminal viewport. */
  viewportTop: number
  viewportRows: number
  viewportColumns: number
  damage: Rectangle | undefined
  /** Cell geometry as currently measured; see `GraphicsPlacement.cellWidth`. */
  cell: { width: number; height: number }
  screen: Screen
  stylePool: StylePool
}): string {
  if (placements.size === 0 && lastDrawn.size === 0) return ''
  const {
    cursor,
    viewportTop,
    viewportRows,
    viewportColumns,
    damage,
    cell,
    screen,
    stylePool,
  } = options

  let body = ''
  const viewportBottom = viewportTop + viewportRows
  /** Per-frame trace, emitted only when debug logging is on. */
  const trace: string[] = []

  /**
   * Run one operation from the known frame cursor and restore it afterwards.
   *
   * Protocols do not share cursor semantics: Kitty can preserve it, while
   * Windows Terminal advances the text cursor to the final sixel band. A
   * relative inverse move after the payload is therefore unknowable and can
   * scroll the viewport. Keeping each erase/draw in its own DECSC/DECRC pair
   * also prevents one repaint's text cursor from offsetting the next draw.
   */
  const fromFrameCursor = (sequence: string): void => {
    if (sequence !== '') body += SAVE_CURSOR + sequence + RESTORE_CURSOR
  }

  /**
   * Repaint one rectangle's cells, clipped to the addressable window.
   *
   * Only physical viewport cells can be reached. Main-screen `nodeCache` rows
   * are logical transcript coordinates, so the visible window may begin far
   * below zero — clip rather than moving above the viewport, where a terminal
   * clamps the cursor and repaints the wrong row.
   */
  const repaintClipped = (rect: CellRect): void => {
    const left = Math.max(0, rect.x)
    const top = Math.max(viewportTop, rect.y)
    const right = Math.min(viewportColumns, screen.width, rect.x + rect.columns)
    // Deliberately not clipped to `screen.height`. When the transcript shrinks,
    // rows an image used to cover fall outside the frame while still being on
    // screen; clipping them away left pixels that no later frame could reach.
    // `repaintRect` blanks a row the frame no longer has cells for.
    const bottom = Math.min(viewportBottom, rect.y + rect.rows)
    if (left >= right || top >= bottom) return
    fromFrameCursor(
      repaintRect(
        screen,
        stylePool,
        {
          x: left,
          y: top,
          columns: right - left,
          rows: bottom - top,
        },
        cursor.y,
      ),
    )
  }

  /**
   * Tell a placement how much room its box actually had, when that can help.
   *
   * Overflowing the **bottom** means the box starts at an addressable row and
   * is simply too tall — the alt-screen shape, where the viewport ends before
   * the content does.
   *
   * Overflowing the **top** is the main-screen shape, and it is the one that
   * actually happens. `viewportBottom` is the transcript end plus one, so a box
   * can never run past it; an image too tall for the window loses its own
   * *top*. Nothing below the image moves when it shrinks, so removing one row
   * lifts the transcript end by one and drops the box's top by one relative to
   * the viewport — shrinking to exactly the rows still visible lands the top on
   * `viewportTop`, exactly. Declining to report that was the whole of "it goes
   * blocky when the window gets shorter and never comes back": the row budget
   * leaves a fixed ten rows for chrome, which stops being enough below a 40-row
   * viewport, and the only recovery path was one that cannot fire here.
   *
   * Budgeted per epoch so this answers a *window* change, not a scroll. A
   * streaming transcript pushes an image off the top too, and shrinking there
   * would fight the scroll a step at a time until it hit the floor and fell
   * back to blocks anyway. An image genuinely scrolled into history yields a
   * number below `MIN_PLACEMENT_ROWS`, which `reportRowLimit` declines, so the
   * two cases separate themselves.
   */
  const reportOverflow = (id: string, target: DrawnRect): void => {
    if (target.y >= viewportTop && target.y + target.rows > viewportBottom) {
      reportRowLimit(id, viewportBottom - target.y)
      return
    }
    if (target.y < viewportTop && !topOverflowReported.has(id)) {
      topOverflowReported.add(id)
      reportRowLimit(id, target.y + target.rows - viewportTop)
    }
  }

  /**
   * Erase what `id` last drew, restoring the cells from this frame.
   *
   * Both candidate locations are cleared. Pixels sit in physical rows, and when
   * the viewport origin has moved since the draw there is no way to tell from
   * here whether the terminal scrolled them along with the text (they follow it)
   * or Ink repainted in place (they did not). Guessing wrong strands a ghost, so
   * clear both: an erase only rewrites cells from the current frame, making a
   * redundant one cost bandwidth and nothing else.
   */
  const erase = (id: string): void => {
    const previous = lastDrawn.get(id)
    if (!previous) return
    lastDrawn.delete(id)
    const scrolledY = previous.y - previous.viewportTop + viewportTop
    trace.push(
      `erase ${id} at ${previous.x},${previous.y} vt=${previous.viewportTop}` +
        (previous.eraseSequence ? ' by id' : '') +
        (scrolledY !== previous.y ? ` and scrolled ${scrolledY}` : ''),
    )
    // Ask the terminal to drop the image first, where the protocol allows it.
    // This needs no cursor position and no knowledge of where the pixels ended
    // up, so it also covers the cases the cell repaint below cannot: a payload
    // that overflowed its box, and a rectangle clipped away at the viewport
    // edge. The repaint still runs, since it is the only erase sixel has and
    // costs a rectangle of text either way.
    if (previous.eraseSequence) fromFrameCursor(previous.eraseSequence)
    repaintClipped(previous)
    if (scrolledY !== previous.y) {
      repaintClipped({ ...previous, y: scrolledY })
    }
  }

  // Placements removed since the last frame still have pixels on screen.
  for (const id of [...lastDrawn.keys()]) {
    if (!placements.has(id)) erase(id)
  }

  for (const [id, placement] of placements) {
    const rect = nodeCache.get(placement.node)
    // Not rendered this frame: unmounted, or culled by a ScrollBox.
    if (rect === undefined) {
      erase(id)
      continue
    }

    const target: DrawnRect = {
      x: rect.x,
      y: rect.y,
      columns: placement.columns,
      rows: placement.rows,
      viewportTop,
      eraseSequence: placement.eraseSequence,
      sequence: placement.sequence,
      checksum: 0,
      redrawGeneration,
    }

    // The window changed size and the re-measure has not answered. Every
    // payload on screen was encoded against the previous pixels-per-cell, so
    // none of them fits the box the layout now reserves — on zoom out they
    // overflow it, past where any erase can reach. Take them down and let the
    // block render, which is exact in cells, stand until a fresh encode lands.
    if (isCellGeometryStale()) {
      trace.push(`skip ${id}: cell geometry stale, awaiting re-measure`)
      erase(id)
      continue
    }

    // The payload is a fixed number of pixels, sized against the box the
    // component asked to reserve. Yoga does not always grant that box — a
    // flex-shrinking parent, a clipping ancestor, or a terminal that narrowed
    // between encode and layout all produce a smaller one. Drawing anyway spills
    // pixels into cells outside the rectangle, and every erase is computed from
    // that rectangle, so nothing will ever clear them. That is a permanent
    // ghost, so withhold instead and let the block render stand.
    if (rect.width < placement.columns || rect.height < placement.rows) {
      trace.push(
        `skip ${id}: box ${rect.width}x${rect.height} smaller than ` +
          `payload ${placement.columns}x${placement.rows}`,
      )
      erase(id)
      continue
    }

    // The cursor cannot address rows outside the viewport, so a box that is
    // partly scrolled away would draw at the wrong origin.
    if (
      target.y < viewportTop ||
      target.x < 0 ||
      target.y + target.rows > viewportBottom ||
      target.x + target.columns > viewportColumns
    ) {
      trace.push(
        `skip ${id}: rows ${target.y}-${target.y + target.rows} ` +
          `outside viewport ${viewportTop}-${viewportBottom}`,
      )
      reportOverflow(id, target)
      erase(id)
      continue
    }

    // Encoded against different cell geometry — the payload would no longer fit
    // the rows reserved for it. Withhold until it is re-encoded.
    if (
      placement.cellWidth !== cell.width ||
      placement.cellHeight !== cell.height
    ) {
      erase(id)
      continue
    }

    const previous = lastDrawn.get(id)
    // An epoch bump means the pixels are still on screen but nothing about
    // where they sit can be trusted — the window was resized under them. Treat
    // it as a move: the record is kept, so the erase below can still reach the
    // copy already drawn, and the payload goes back out afterwards.
    const moved =
      previous === undefined ||
      previous.redrawGeneration !== redrawGeneration ||
      !sameLogicalRect(previous, target)
    // Same cells, new viewport origin: the transcript scrolled and the terminal
    // moved the pixels with it. Nothing to send — but the record has to follow,
    // or the erase that eventually runs would target the row the image sat on
    // several screens ago.
    if (!moved && previous !== undefined && previous.viewportTop !== viewportTop) {
      lastDrawn.set(id, target)
    }
    // A fresh encode of the same image at the same size and place. Rare, but
    // the old payload is a different image as far as the terminal is concerned,
    // so it has to be taken down rather than silently superseded.
    const reencoded =
      previous !== undefined && previous.sequence !== placement.sequence
    // An untouched image is still on screen, and re-sending a payload that can
    // run to hundreds of kilobytes would stall the write. `damage` narrows this
    // cheaply — it bounds everything written this frame, so no overlap is a
    // certain no — but it is coarse enough to cover the whole frame during a
    // streaming response, so confirm against the cells themselves.
    const checksum =
      moved || reencoded ? 0 : overlaps(target, damage)
        ? checksumRect(screen, target)
        : previous!.checksum
    if (!moved && !reencoded && checksum === previous!.checksum) continue

    // Erase first: the old pixels sit outside the new rectangle whenever the
    // image moved, and nothing else will clear them.
    if (moved || reencoded) erase(id)

    // Then clear the destination itself, unconditionally. Tracking where pixels
    // went is inference — the terminal may scroll them, a previous erase may
    // have been clipped at the viewport edge, a placement may have been dropped
    // while its pixels stayed. Repainting the cells about to be covered removes
    // whatever drifted in, without needing to know how it got there. It is only
    // a rectangle of text, and it is immediately overdrawn.
    repaintClipped(target)

    // Row relative to the anchor, column absolute — see `repaintRect`.
    fromFrameCursor(
      cursorMove(0, target.y - cursor.y) +
        cursorTo(target.x + 1) +
        placement.sequence,
    )
    trace.push(
      `draw ${id} at ${target.x},${target.y} vt=${viewportTop} ` +
        `anchor=${cursor.y} ${target.columns}x${target.rows} ` +
        `moved=${String(moved)}`,
    )
    // Recorded after the repaint above, so it describes the cells as they are
    // now — the state a later frame has to compare against.
    target.checksum = checksumRect(screen, target)
    lastDrawn.set(id, target)
  }

  if (trace.length > 0) {
    // The count is the first thing to check when an image appears twice: two
    // registered placements means two components mounted for one image, which
    // no amount of erasing can fix.
    logForDebugging(
      `graphics: ${placements.size} placement(s) — ${trace.join(' | ')}`,
    )
  }
  return body
}
