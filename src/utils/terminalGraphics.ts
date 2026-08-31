import type { Buffer } from 'buffer'
import { getImageProcessor } from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'

/**
 * Pixel-accurate inline graphics: protocol selection, cell geometry, and
 * encoding.
 *
 * This is the high-fidelity path. Where `terminalImage.ts` approximates an
 * image with block glyphs — capped by the terminal's column count, so a
 * downscaled plot loses its axis labels — these protocols hand the terminal
 * real pixels. The two are complementary, not alternatives: the block render
 * reserves the layout box and remains the visible fallback, and the graphic is
 * painted over it by `ink/graphicsPlacement.ts` whenever it can be placed.
 *
 * Three protocols, in descending order of preference:
 *
 * - **Kitty** (`ESC _G`), the most capable and the direction the ecosystem is
 *   moving — kitty, Ghostty, WezTerm, Konsole.
 * - **iTerm2** (`OSC 1337;File=`), simple and reliable on macOS.
 * - **Sixel** (`DCS q`), the oldest and by far the widest fallback: Windows
 *   Terminal 1.22+, foot, contour, mlterm, xterm built with sixel, and recent
 *   VTE. Detected at runtime from DA1, which is authoritative in a way that
 *   sniffing `TERM` never is.
 */

export type GraphicsProtocol = 'kitty' | 'iterm2' | 'sixel' | 'none'

/**
 * Cell geometry in pixels.
 *
 * Every protocol measures in pixels while the layout reserves whole cell rows,
 * so an image can only be fitted to its box once this is known. The default is
 * a deliberate under-estimate of a typical cell: guessing a cell *smaller* than
 * reality makes an image occupy fewer rows than reserved, which leaves a blank
 * strip. Guessing larger would overflow the box and shove the transcript down.
 */
export type CellPixelSize = { width: number; height: number }

const FALLBACK_CELL: CellPixelSize = { width: 7, height: 14 }

/** Character grid a measurement was taken at; see {@link measuredGrid}. */
export type TerminalGrid = { columns: number; rows: number }

/**
 * Cell geometry as the terminal last reported it, and the grid it reported at.
 *
 * The grid is kept because it is the only local evidence about what a resize
 * did to the cell size when the re-measure goes unanswered. Two things can
 * produce a new grid: a zoom, which holds the window and scales the cell by the
 * inverse of the grid change, and a drag, which holds the cell and resizes the
 * window. Nothing here can tell them apart — but between them,
 * `measured * min(1, oldGrid / newGrid)` is a *lower bound* on the new cell,
 * which is all {@link clearCellGeometryStale} needs.
 */
let measuredCell: CellPixelSize | null = null
let measuredGrid: TerminalGrid | null = null

/**
 * Whether {@link measuredCell} still describes the terminal as it is now.
 *
 * A measurement is only meaningful for the grid it was taken at. Changing the
 * font changes pixels-per-cell and the grid together, and dragging the window
 * changes the grid alone — from here the two are indistinguishable, so a grid
 * that no longer matches means the number on record may describe either.
 *
 * Scaling the measurement by the grid ratio to bridge the gap was worse than
 * useless: exact for a zoom, badly wrong for a drag, and a window opened small
 * and then maximised scaled the cell down several times over, so the payload
 * covered a fraction of the box the layout had reserved — a small image
 * stranded in a screenful of blank rows. Refusing to draw at all was worse
 * still, because a terminal that stops answering then never gets its images
 * back. So the measurement stands as taken, and this only says whether it is
 * worth asking again. See {@link isCellGeometryCurrent}.
 */
let measurementCurrent = false

/** Cell geometry every payload is encoded against. */
let cellPixelSize: CellPixelSize | null = null

/**
 * Deadline until which the measured geometry is treated as untrustworthy, or 0.
 * A timestamp rather than a flag so the mark cannot outlive its usefulness —
 * see {@link STALE_TIMEOUT_MS}.
 *
 * Set when the window resizes and the re-measure has not answered yet.
 *
 * Zoom changes how many pixels a cell is without changing the grid, and the
 * only way to learn the new value is to ask the terminal and wait. Every
 * already-encoded payload is a fixed number of pixels sized against the old
 * cell, so between the resize and the reply an image drawn into the box the
 * layout now reserves is the wrong size for it — and when the new cell is
 * smaller, as it is on zoom out, the payload overflows the rectangle that every
 * erase is computed from. Those pixels can never be cleared afterwards. That is
 * the duplicated, half-scaled copy that survives a redraw.
 *
 * Graphics are therefore withheld while this holds, and the block-glyph render
 * — which is measured in cells and so cannot be wrong about them — stands in.
 */
let staleUntil = 0

/**
 * Timer that announces the deadline when it passes.
 *
 * The mark has to announce its own expiry. Withholding a graphic is a decision
 * taken while rendering, and nothing re-runs on its own when the clock moves
 * past a deadline — so a mark that lapsed quietly left every image on block
 * glyphs with no edge left to bring them back. That was the whole of "it goes
 * blurry when I zoom and never comes back": the probe answer normally supplies
 * the edge, and when it is dropped or coalesced away, nothing else did.
 */
let staleTimer: ReturnType<typeof setTimeout> | null = null

/**
 * How long a mark can stand before it lapses on its own.
 *
 * The mark is normally lifted by the re-measure landing. That cannot be relied
 * on: `TerminalQuerier` never times out — a batch settles only when the DA1
 * sentinel comes back — so a reply dropped during a resize leaves the promise
 * unsettled forever. Gating a visible feature on that would mean images falling
 * back to block glyphs permanently, which is a far worse outcome than a briefly
 * mis-sized one. The deadline makes the withholding self-limiting no matter
 * what the terminal does.
 */
const STALE_TIMEOUT_MS = 400

/**
 * Mark the measured geometry as no longer trustworthy. Called synchronously on
 * resize, well before the debounced probe replies.
 */
export function markCellGeometryStale(): void {
  const wasStale = isCellGeometryStale()
  staleUntil = Date.now() + STALE_TIMEOUT_MS
  armStaleLapse(STALE_TIMEOUT_MS)
  if (!wasStale) announceCapabilityChange()
}

/** Whether a re-measure is outstanding; see {@link markCellGeometryStale}. */
export function isCellGeometryStale(): boolean {
  return staleUntil !== 0 && Date.now() < staleUntil
}

function armStaleLapse(delay: number): void {
  if (staleTimer) clearTimeout(staleTimer)
  const timer = setTimeout(lapseStaleMark, Math.max(1, delay) + 1) as ReturnType<
    typeof setTimeout
  > & { unref?: () => void }
  // Never a reason to hold the process open for this.
  timer.unref?.()
  staleTimer = timer
}

/** Announce that the deadline has passed, so what it withheld is re-encoded. */
function lapseStaleMark(): void {
  staleTimer = null
  if (staleUntil === 0) return
  const remaining = staleUntil - Date.now()
  if (remaining > 0) {
    // A later mark pushed the deadline out. Follow it rather than announcing
    // while graphics are still being withheld.
    armStaleLapse(remaining)
    return
  }
  staleUntil = 0
  announceCapabilityChange()
}

/** Cancel the lapse announcement; the mark has been settled another way. */
function clearStaleLapse(): void {
  if (staleTimer === null) return
  clearTimeout(staleTimer)
  staleTimer = null
}

/**
 * Bumped whenever a capability probe lands.
 *
 * The DA1 and cell-size replies arrive asynchronously, one round-trip after
 * startup, so an image rendered in that window would resolve the protocol as
 * `none` and — with nothing to invalidate it — stay a block render for the rest
 * of the session. Components subscribe and re-encode when this changes.
 */
let capabilityGeneration = 0
const capabilityListeners = new Set<() => void>()

function announceCapabilityChange(): void {
  capabilityGeneration++
  for (const listener of capabilityListeners) listener()
}

/** Current capability generation; changes when a probe result is recorded. */
export function getGraphicsGeneration(): number {
  return capabilityGeneration
}

/** Subscribe to capability changes. Returns an unsubscribe function. */
export function subscribeGraphicsCapability(listener: () => void): () => void {
  capabilityListeners.add(listener)
  return () => {
    capabilityListeners.delete(listener)
  }
}

/**
 * Record cell geometry measured from the terminal.
 *
 * Accepts either the direct `CSI 16 t` answer or one derived by dividing the
 * `CSI 14 t` window size by the character grid. Values are sanity-checked:
 * a terminal that reports zeroes (or absurd numbers) would otherwise produce
 * an image sized to nothing, or one large enough to lock up the encoder.
 */
export function setCellPixelSize(
  size: CellPixelSize | null,
  grid?: TerminalGrid,
): void {
  if (
    size === null ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width < 2 ||
    size.height < 2 ||
    size.width > 64 ||
    size.height > 128
  ) {
    return
  }
  measuredCell = {
    width: Math.floor(size.width),
    height: Math.floor(size.height),
  }
  measuredGrid = sanitizeGrid(grid)
  measurementCurrent = true
  cellPixelSize = measuredCell
  staleUntil = 0
  clearStaleLapse()
  logForDebugging(
    `terminalGraphics: cell size ${cellPixelSize.width}x${cellPixelSize.height}px`,
  )
  announceCapabilityChange()
}

/** A usable grid, or null — a non-TTY reports zero columns. */
function sanitizeGrid(grid: TerminalGrid | undefined): TerminalGrid | null {
  if (!grid) return null
  const columns = Math.floor(grid.columns)
  const rows = Math.floor(grid.rows)
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) return null
  if (columns < 1 || rows < 1) return null
  return { columns, rows }
}

/**
 * Re-check whether the measurement still describes `grid`.
 *
 * Returns whether the answer changed. A grid we cannot read tells us nothing
 * either way, so the measurement is left as it stands.
 */
function recheckMeasurementCurrency(grid: TerminalGrid | null): boolean {
  if (measuredCell === null || grid === null || measuredGrid === null) {
    return false
  }
  const current =
    measuredGrid.columns === grid.columns && measuredGrid.rows === grid.rows
  if (current === measurementCurrent) return false
  measurementCurrent = current
  logForDebugging(
    `terminalGraphics: cell size ${measuredCell.width}x${measuredCell.height}px ` +
      `${current ? 'confirmed for' : 'no longer describes'} ` +
      `grid ${grid.columns}x${grid.rows}`,
  )
  return true
}

/**
 * Drop the stale mark without changing the measurement.
 *
 * For the probe that came back empty: a terminal which answered once and then
 * ignores a later query would otherwise leave graphics switched off for the
 * rest of the session. The previous measurement is the best available estimate,
 * so keep it and let images redraw against it.
 */
export function clearCellGeometryStale(grid?: TerminalGrid): void {
  const wasStale = isCellGeometryStale()
  staleUntil = 0
  clearStaleLapse()
  // The measurement on record describes the font size before this resize, and
  // nothing has confirmed it since. Keeping it verbatim is what let a dropped
  // `CSI 16 t` reply re-enable drawing against geometry known to be out of
  // date: the placement then records the same wrong number the draw compares
  // against, so the guard that exists for exactly this can never fire, and on
  // zoom out the payload overflows its box for good. Step down to a bound that
  // cannot overflow instead.
  //
  // A reply that did land has already refreshed both, so this is a no-op there.
  const changed = recheckMeasurementCurrency(sanitizeGrid(grid))
  if (wasStale || changed) announceCapabilityChange()
}

/** Measured cell geometry, or the conservative fallback. */
export function getCellPixelSize(): CellPixelSize {
  return cellPixelSize ?? FALLBACK_CELL
}

/** Whether the terminal has actually reported its cell geometry. */
export function hasMeasuredCellSize(): boolean {
  return cellPixelSize !== null
}

/**
 * Whether that report still describes the terminal as it is now.
 *
 * Drives the re-probe, and nothing else. Refusing to draw while this is false
 * was a latch: a terminal that stopped answering left every image on block
 * glyphs with no way back, which is far worse than the alternative. The last
 * measurement is *exactly* right for a drag or a maximise, which do not touch
 * the font, and wrong only for a zoom — and a zoom that we failed to measure is
 * corrected the moment any later probe answers. So it stands, and
 * {@link isCellGeometryCurrent} is what keeps asking until it is confirmed.
 */
export function isCellGeometryCurrent(): boolean {
  return cellPixelSize !== null && measurementCurrent
}

/** DA1 parameter advertising sixel support. */
const DA1_SIXEL = 4

let da1Params: readonly number[] | null = null

/** Record the DA1 response, the authoritative sixel probe. */
export function setDeviceAttributes(params: readonly number[]): void {
  da1Params = params
  logForDebugging(
    `terminalGraphics: DA1 params [${params.join(',')}] — sixel ${
      params.includes(DA1_SIXEL) ? 'advertised' : 'not advertised'
    }`,
  )
  announceCapabilityChange()
}

function envSaysKitty(env: NodeJS.ProcessEnv): boolean {
  const term = env.TERM?.toLowerCase() ?? ''
  if (env.KITTY_WINDOW_ID) return true
  if (term.includes('kitty') || term.includes('ghostty')) return true
  const program = env.TERM_PROGRAM?.toLowerCase()
  return program === 'ghostty' || program === 'wezterm'
}

/**
 * Choose the graphics protocol for this terminal.
 *
 * `TAU_IMAGE_PROTOCOL` forces one (or `off`). Otherwise Kitty and iTerm2 are
 * recognised from the environment, and sixel is taken only from DA1 — never
 * guessed — because sending a DCS payload to a terminal that cannot decode it
 * dumps raw bytes across the transcript.
 *
 * Multiplexers are excluded outright. tmux and screen rewrite the byte stream
 * and would need explicit passthrough wrapping per protocol; without it the
 * payload is mangled and the pane corrupted.
 */
export function resolveGraphicsProtocol(
  env: NodeJS.ProcessEnv = process.env,
  attributes: readonly number[] | null = da1Params,
  isTTY: boolean = process.stdout?.isTTY === true,
): GraphicsProtocol {
  const forced = env.TAU_IMAGE_PROTOCOL?.trim().toLowerCase()
  if (forced === 'off' || forced === 'none' || forced === '0') return 'none'
  if (forced === 'kitty') return 'kitty'
  if (forced === 'iterm2' || forced === 'iterm') return 'iterm2'
  if (forced === 'sixel') return 'sixel'

  if (!isTTY) return 'none'
  if (env.NO_COLOR) return 'none'
  // See doc comment: passthrough is protocol-specific and unimplemented.
  if (env.TMUX || env.STY) return 'none'
  // xterm.js draws neither Kitty APC nor sixel; it would print the payload.
  if (env.TERM_PROGRAM?.toLowerCase() === 'vscode') return 'none'

  if (envSaysKitty(env)) return 'kitty'
  if (env.TERM_PROGRAM === 'iTerm.app') return 'iterm2'
  if (attributes?.includes(DA1_SIXEL)) return 'sixel'
  return 'none'
}

/**
 * Fit an image into a cell box, in whole cells, given real cell geometry.
 *
 * Unlike the block-glyph fit this needs no aspect fudging: pixels are pixels,
 * so the image scales to fit the box's pixel extent and the cell counts follow
 * by division. Never enlarges — an image smaller than its box stays sharp.
 */
export function fitGraphicsToCells(
  imageWidth: number,
  imageHeight: number,
  maxColumns: number,
  maxRows: number,
  cell: CellPixelSize = getCellPixelSize(),
): { columns: number; rows: number; pixelWidth: number; pixelHeight: number } {
  const safeColumns = Math.max(1, Math.floor(maxColumns))
  const safeRows = Math.max(1, Math.floor(maxRows))
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return { columns: 1, rows: 1, pixelWidth: cell.width, pixelHeight: cell.height }
  }

  const availableWidth = safeColumns * cell.width
  const availableHeight = safeRows * cell.height
  const scale = Math.min(
    availableWidth / imageWidth,
    availableHeight / imageHeight,
    1,
  )
  // Snap to whole cells, then take the pixel size *from* that cell count.
  //
  // The graphic has to cover its reserved box exactly. Sized to the aspect
  // alone it lands a fraction of a cell short, and the fallback rendered
  // underneath shows through along the right and bottom edges — which reads as
  // the image having a ragged border of block glyphs. Rounding to the nearest
  // cell costs at most half a cell of aspect distortion (sub-percent
  // horizontally, a couple of percent on a short image) and buys exact
  // coverage, which matters far more.
  const columns = Math.max(
    1,
    Math.min(safeColumns, Math.round((imageWidth * scale) / cell.width)),
  )
  const rows = Math.max(
    1,
    Math.min(safeRows, Math.round((imageHeight * scale) / cell.height)),
  )
  return {
    columns,
    rows,
    pixelWidth: columns * cell.width,
    pixelHeight: rows * cell.height,
  }
}

/**
 * Kitty graphics: transmit and display in one shot, chunked.
 *
 * The protocol caps an APC payload at 4096 base64 bytes, so anything larger is
 * split across continuation chunks (`m=1` on all but the last). `q=2` silences
 * both the acknowledgement and any error reply — neither is read here, and an
 * unread reply would surface as garbage in the input stream. `C=1` leaves the
 * cursor where it was, which the placement code depends on.
 */
/**
 * Next Kitty image id, seeded randomly.
 *
 * Ids are a shared namespace across every client writing to the terminal, and
 * transmitting with an id already in use replaces that image. Starting from a
 * random point in the low 24 bits keeps two Tau sessions — or Tau beside any
 * other image-drawing program — from silently clobbering each other, which is
 * the failure the protocol warns about for clients that just count from 1.
 */
let nextKittyImageId = 1 + Math.floor(Math.random() * 0xff_ff_ff)

/** Reserve an id for one image, so it can later be deleted by that id. */
export function allocateKittyImageId(): number {
  const id = nextKittyImageId
  // Wrap below 2^24: ids above that need the extra placeholder diacritic byte,
  // and nothing here needs the range.
  nextKittyImageId = nextKittyImageId >= 0xff_ff_ff ? 1 : nextKittyImageId + 1
  return id
}

/**
 * Delete an image and every placement of it.
 *
 * `d=I` (uppercase) frees the stored image data as well as removing it from the
 * screen. That is deliberate: the redraw path always retransmits the full
 * payload, so keeping the pixels cached buys nothing while an id-per-encode
 * scheme would otherwise grow the terminal's image store without bound for the
 * lifetime of the session.
 *
 * This is the erase the protocol provides, and it is exact. Overwriting the
 * cells underneath — the only option under sixel — relies on the terminal
 * dropping pixels when text is written over them, which is a convention rather
 * than a guarantee.
 */
export function encodeKittyDelete(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`
}

export function encodeKittyGraphics(
  base64Png: string,
  columns: number,
  rows: number,
  imageId?: number,
): string {
  const CHUNK = 4096
  const identity = imageId === undefined ? '' : `,i=${imageId}`
  const lead = `a=T,f=100,q=2,C=1${identity},c=${columns},r=${rows}`
  if (base64Png.length <= CHUNK) {
    return `\x1b_G${lead};${base64Png}\x1b\\`
  }
  let out = ''
  for (let offset = 0; offset < base64Png.length; offset += CHUNK) {
    const chunk = base64Png.slice(offset, offset + CHUNK)
    const isLast = offset + CHUNK >= base64Png.length
    out +=
      offset === 0
        ? `\x1b_G${lead},m=1;${chunk}\x1b\\`
        : `\x1b_Gq=2,m=${isLast ? 0 : 1};${chunk}\x1b\\`
  }
  return out
}

/** iTerm2 inline image (OSC 1337), sized in cells. */
export function encodeITerm2Graphics(
  base64Image: string,
  columns: number,
  rows: number,
): string {
  return `\x1b]1337;File=inline=1;width=${columns};height=${rows};preserveAspectRatio=1:${base64Image}\x07`
}

/**
 * Encode raw RGBA pixels as a sixel sequence.
 *
 * Returns null rather than throwing: the encoder is an optional dependency and
 * a failure here must fall back to the block-glyph render, not break the frame.
 */
export async function encodeSixelGraphics(
  rgba: Buffer | Uint8Array,
  width: number,
  height: number,
  maxColors = 256,
): Promise<string | null> {
  try {
    const { image2sixel } = await import('sixel')
    return image2sixel(new Uint8Array(rgba), width, height, maxColors)
  } catch (error) {
    logForDebugging(
      `terminalGraphics: sixel encode failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

/**
 * Upper bound on a rendered graphic, in pixels per side.
 *
 * A sixel payload is re-sent whenever the frame repaints the cells under it,
 * and it runs to roughly a third of a byte per pixel — a full-window image can
 * exceed a quarter of a megabyte. Capping the long edge keeps a repaint from
 * stalling the write without costing visible detail at terminal sizes.
 */
const MAX_GRAPHIC_EDGE_PX = 1400

/** Minimal sharp surface used here; see `terminalImage.ts` for why it is local. */
type GraphicsSharp = {
  metadata(): Promise<{ width: number; height: number }>
  resize: (
    width: number,
    height: number,
    options?: { fit?: string },
  ) => GraphicsSharp
  ensureAlpha: () => GraphicsSharp
  raw: () => GraphicsSharp
  png: () => GraphicsSharp
  toBuffer: (options?: {
    resolveWithObject?: boolean
  }) => Promise<
    | Buffer
    | { data: Buffer; info: { width: number; height: number; channels: number } }
  >
}

/**
 * Whether a pipeline implements the methods a protocol needs.
 *
 * The methods are typed as required above so the chained calls check, but the
 * bundled build can substitute `image-processor-napi`, which implements the
 * resize/encode surface without necessarily providing `raw()`. Probing before
 * use turns that substitution into a fallback rather than a crash.
 */
function pipelineSupports(
  pipeline: GraphicsSharp,
  ...methods: Array<keyof GraphicsSharp>
): boolean {
  const candidate = pipeline as Partial<GraphicsSharp>
  return methods.every(method => typeof candidate[method] === 'function')
}

/**
 * Widen raw pixels to the four-byte stride the sixel encoder indexes by.
 *
 * Done here rather than with the processor's `ensureAlpha()`, which was the one
 * call in this path the block renderer does not also make. That asymmetry is a
 * silent-degradation trap: any pipeline that can `raw()` but stumbles on
 * `ensureAlpha()` — a substituted processor, or two copies of the native image
 * library loaded into one process, where the second one's colourspace enum no
 * longer resolves — produced block glyphs on every image with nothing visible
 * to explain it. The two renderers now need exactly the same capability, so
 * they succeed and fail together.
 *
 * Sixel has no alpha of its own; the fourth byte is stride, not transparency.
 */
function widenToRgba(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array | null {
  if (channels === 4) return new Uint8Array(data)
  if (channels !== 1 && channels !== 3) return null
  const pixels = width * height
  const out = new Uint8Array(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    const src = i * channels
    const dst = i * 4
    const r = data[src] ?? 0
    out[dst] = r
    out[dst + 1] = channels === 1 ? r : (data[src + 1] ?? 0)
    out[dst + 2] = channels === 1 ? r : (data[src + 2] ?? 0)
    out[dst + 3] = 255
  }
  return out
}

export type GraphicsOverlay = {
  /** Ready-to-write escape sequence. */
  sequence: string
  /**
   * Sequence that removes this graphic from the terminal, where the protocol
   * has one. Kitty does; sixel and iTerm2 do not, and there the only recourse
   * is writing text over the cells.
   */
  eraseSequence?: string
  protocol: GraphicsProtocol
  /** Cell box the graphic covers exactly. The caller must reserve this. */
  columns: number
  rows: number
  pixelWidth: number
  pixelHeight: number
  /** Cell geometry used to size and encode this payload. */
  cellWidth: number
  cellHeight: number
}

/**
 * Encode an image and report the cell box it occupies.
 *
 * The graphic owns the box, rather than being fitted into one the block render
 * chose. Those two size images by different rules — blocks stretch to the 1:2
 * cell and count subpixels, graphics use real pixels — so a graphic fitted into
 * a block-derived box is always slightly smaller than it, and the blocks show
 * through around the edges. Deriving the box here, from real cell geometry,
 * makes coverage exact.
 *
 * Returns null on any problem, leaving the caller to size and render blocks
 * however it likes.
 */
export async function renderGraphicsOverlay(
  imageData: Buffer,
  maxColumns: number,
  maxRows: number,
  protocol: GraphicsProtocol = resolveGraphicsProtocol(),
): Promise<GraphicsOverlay | null> {
  // Every path out of here falls back to block glyphs, and for a long time all
  // of them were silent — which is why "it just renders blurry" took so many
  // rounds to place. Each one now names itself under `tau --debug`.
  if (protocol === 'none') {
    logForDebugging('terminalGraphics: no graphics protocol for this terminal')
    return null
  }
  if (maxColumns < 1 || maxRows < 1) {
    logForDebugging(`terminalGraphics: no room — ${maxColumns}x${maxRows}`)
    return null
  }

  // Every protocol here sizes in pixels while the layout reserves whole cells,
  // so the conversion between them is the one number that must be right. Guess
  // it and the payload is drawn at a size the reserved box does not match: too
  // small leaves the block render showing around the edges, too large spills
  // pixels past the rectangle every erase is computed from, where nothing will
  // ever clear them. A terminal that advertises sixel through DA1 but never
  // answers `CSI 16 t` or `CSI 14 t` gets the block render, which is exact in
  // cells by construction.
  if (!hasMeasuredCellSize()) {
    logForDebugging('terminalGraphics: terminal never reported its cell size')
    return null
  }
  if (isCellGeometryStale()) {
    logForDebugging('terminalGraphics: awaiting re-measure after a resize')
    return null
  }

  try {
    const processor = await getImageProcessor()
    const probe = processor(imageData) as unknown as GraphicsSharp
    const metadata = await probe.metadata()

    const cell = getCellPixelSize()
    const fit = fitGraphicsToCells(
      metadata.width,
      metadata.height,
      maxColumns,
      maxRows,
      cell,
    )

    // The payload cap shrinks the cell box rather than the pixels inside it.
    // Trimming pixels alone would leave the graphic smaller than the box it
    // reported, reopening the very gap this function exists to close.
    let columns = fit.columns
    let rows = fit.rows
    const longest = Math.max(columns * cell.width, rows * cell.height)
    if (longest > MAX_GRAPHIC_EDGE_PX) {
      const shrink = MAX_GRAPHIC_EDGE_PX / longest
      columns = Math.max(1, Math.round(columns * shrink))
      rows = Math.max(1, Math.round(rows * shrink))
    }
    const pixelWidth = columns * cell.width
    const pixelHeight = rows * cell.height

    if (protocol === 'sixel') {
      const pipeline = processor(imageData) as unknown as GraphicsSharp
      if (!pipelineSupports(pipeline, 'raw')) {
        logForDebugging('terminalGraphics: processor cannot produce raw pixels')
        return null
      }
      const result = await pipeline
        .resize(pixelWidth, pixelHeight, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (!('data' in result)) return null
      const rgba = widenToRgba(
        result.data,
        result.info.width,
        result.info.height,
        result.info.channels,
      )
      if (rgba === null) {
        logForDebugging(
          `terminalGraphics: unexpected channel count ${result.info.channels}`,
        )
        return null
      }
      const sequence = await encodeSixelGraphics(
        rgba,
        result.info.width,
        result.info.height,
      )
      if (!sequence) return null
      return {
        sequence,
        protocol,
        columns,
        rows,
        pixelWidth,
        pixelHeight,
        cellWidth: cell.width,
        cellHeight: cell.height,
      }
    }

    const pipeline = processor(imageData) as unknown as GraphicsSharp
    if (!pipelineSupports(pipeline, 'png')) return null
    const encoded = await pipeline
      .resize(pixelWidth, pixelHeight, { fit: 'fill' })
      .png()
      .toBuffer()
    if ('data' in encoded) return null
    const base64 = encoded.toString('base64')
    // Kitty images are addressable by id, so give this one its own and hand
    // back the matching delete. Without an id the terminal assigns its own,
    // nothing can refer to the image afterwards, and every redraw stacks
    // another placement that no erase can reach — the accumulating ghost.
    const kittyImageId =
      protocol === 'kitty' ? allocateKittyImageId() : undefined
    const sequence =
      protocol === 'kitty'
        ? encodeKittyGraphics(base64, columns, rows, kittyImageId)
        : encodeITerm2Graphics(base64, columns, rows)
    return {
      sequence,
      ...(kittyImageId !== undefined && {
        eraseSequence: encodeKittyDelete(kittyImageId),
      }),
      protocol,
      columns,
      rows,
      pixelWidth,
      pixelHeight,
      cellWidth: cell.width,
      cellHeight: cell.height,
    }
  } catch (error) {
    logForDebugging(
      `terminalGraphics: overlay failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}
