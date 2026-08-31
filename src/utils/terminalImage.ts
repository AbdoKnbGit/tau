import type { Buffer } from 'buffer'
import chalk from 'chalk'
import {
  getImageProcessor,
  type SharpInstance,
} from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'

/**
 * Inline image rendering for the TUI, as Unicode half-block cells.
 *
 * Each cell carries two vertical pixels: U+2580 (upper half block) paints the
 * top pixel with the foreground color and the bottom pixel with the background
 * color. A cell is roughly twice as tall as it is wide, so two stacked
 * half-pixels are about square — the pixel grid maps 1:1 onto
 * `columns x (rows * 2)` with no aspect correction needed.
 *
 * Why not a native graphics protocol (Kitty / iTerm2 / Sixel)?
 * Ink renders into a cell buffer: `Output.write()` tokenizes SGR into interned
 * styles, writes grapheme clusters into `Screen`, and `log-update` diffs frames
 * cell-by-cell, re-emitting only what changed. A DCS/APC graphics payload
 * cannot survive that round trip — it would have to be written out-of-band at
 * an absolute cursor position, with per-frame placement bookkeeping to stop
 * images stacking on repaint, plus explicit purges on resize and scrollback
 * eviction. Half-blocks are ordinary styled text, so they flow through the
 * existing renderer untouched: nothing to ghost, nothing to purge, no resize
 * special-casing, and `stringWidth` already measures these glyphs as width 1
 * (it resolves East Asian ambiguous width as narrow).
 *
 * Everything here degrades to `null` rather than throwing: callers fall back to
 * whatever they rendered before.
 */

/** Upper half block: top pixel in the foreground, bottom in the background. */
const UPPER_HALF = '▀'
/** Lower half block: used when only the bottom pixel is opaque. */
const LOWER_HALF = '▄'

/**
 * Quadrant glyphs indexed by a 4-bit occupancy mask over a cell's 2x2 subpixel
 * block: bit 0 top-left, bit 1 top-right, bit 2 bottom-left, bit 3 bottom-right.
 * A set bit means that subpixel takes the foreground color, a clear bit the
 * background — so every one of the sixteen partitions is expressible.
 *
 * All sixteen are Block Elements from Unicode 1.1, the same range as the half
 * blocks, so font coverage is no worse than the half-block renderer.
 */
const QUADRANT_GLYPHS = [
  ' ', // 0000
  '▘', // 0001 TL
  '▝', // 0010 TR
  '▀', // 0011 TL TR
  '▖', // 0100 BL
  '▌', // 0101 TL BL
  '▞', // 0110 TR BL
  '▛', // 0111 TL TR BL
  '▗', // 1000 BR
  '▚', // 1001 TL BR
  '▐', // 1010 TR BR
  '▜', // 1011 TL TR BR
  '▄', // 1100 BL BR
  '▙', // 1101 TL BL BR
  '▟', // 1110 TR BL BR
  '█', // 1111 all
] as const

/**
 * Sextant glyph for a 6-bit mask over a cell's 2x3 subpixel block: bit 0
 * top-left, bit 1 top-right, then middle, then bottom.
 *
 * Sextants live in Symbols for Legacy Computing (U+1FB00..U+1FB3B), which
 * deliberately omits the four masks that already exist as Block Elements —
 * empty, both full columns, and full — so the run is 60 codepoints, not 64, and
 * the index has to skip those four.
 *
 * That block is Unicode 13 (2020). Cascadia, JetBrains Mono, Fira Code and
 * DejaVu carry it; Consolas and Menlo do not, and would render tofu. Hence
 * opt-in rather than default.
 */
export function sextantGlyph(mask: number): string {
  if (mask === 0) return ' '
  if (mask === 63) return '█'
  if (mask === 0b010101) return '▌' // left column
  if (mask === 0b101010) return '▐' // right column
  let index = mask - 1
  if (mask > 0b010101) index--
  if (mask > 0b101010) index--
  return String.fromCodePoint(0x1fb00 + index)
}

export type ImageGlyphMode = 'quadrant' | 'half' | 'sextant'

/**
 * Horizontal subpixels per cell for a glyph mode. Vertical is always two.
 *
 * Quadrants pack two subpixels across, doubling horizontal resolution — the
 * binding constraint, since a half-block image can never be wider in pixels
 * than the terminal is in columns.
 */
export function subpixelsPerCellX(mode: ImageGlyphMode): 1 | 2 {
  return mode === 'half' ? 1 : 2
}

/** Vertical subpixels per cell. Sextants stack three where the others stack two. */
export function subpixelsPerCellY(mode: ImageGlyphMode): 2 | 3 {
  return mode === 'sextant' ? 3 : 2
}

/**
 * Which glyph family to encode with.
 *
 * Quadrants are the default because horizontal detail is what a downscaled plot
 * loses first. `TAU_INLINE_IMAGE_GLYPHS=half` is the escape hatch for a font
 * that renders the ten less-common quadrant glyphs as tofu while still having
 * the three half blocks.
 */
export function resolveGlyphMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): ImageGlyphMode {
  const raw = env.TAU_INLINE_IMAGE_GLYPHS?.trim().toLowerCase()
  if (raw === 'half' || raw === 'halfblock' || raw === 'half-block') {
    return 'half'
  }
  if (raw === 'sextant' || raw === 'sextants') return 'sextant'
  if (raw === 'quadrant' || raw === 'quadrants') return 'quadrant'
  return hasQuadrantGlyphs(env, platform) ? 'quadrant' : 'half'
}

/**
 * Whether the terminal's font can be relied on to have the quadrant blocks.
 *
 * The 2x2 subpixel grid needs U+2596–U+259F, and those are a much less common
 * font addition than the halves and the full block. The Windows console host is
 * the case that matters: it ships Consolas and Lucida Console, neither of which
 * has them, so every quadrant cell renders as a literal `?` and the picture
 * comes out as a field of question marks. Windows Terminal ships Cascadia Mono,
 * which has the full set.
 *
 * Half blocks give up the horizontal subpixel — one glyph, foreground over
 * background, so two subpixels per cell instead of four — but U+2580 is in
 * essentially every monospace font ever shipped, including the console raster
 * fonts. Half the resolution beats none of the glyphs.
 *
 * `TAU_INLINE_IMAGE_GLYPHS=quadrant` forces them back on for a console host
 * configured with a font that does have them.
 */
function hasQuadrantGlyphs(
  env: NodeJS.ProcessEnv,
  platform: string,
): boolean {
  if (platform !== 'win32') return true
  // Windows Terminal, which also exports this into WSL.
  if (env.WT_SESSION) return true
  // mintty and its family (Git Bash, MSYS2, Cygwin) ship their own fonts.
  if (env.MSYSTEM || env.TERM_PROGRAM === 'mintty') return true
  // VS Code's integrated terminal is xterm.js with a web font.
  if (env.TERM_PROGRAM === 'vscode') return true
  return false
}

/** Alpha at or below this counts as fully transparent (terminal shows through). */
const ALPHA_THRESHOLD = 8

/** Packed-RGB sentinel meaning "no color / terminal default". */
const NO_COLOR = -1

/**
 * Row cap. Bounds both transcript noise and `StylePool` growth — the pool is
 * session-lived and interns one entry per distinct fg/bg pair, so an unbounded
 * image would leak styles for the life of the process.
 */
export const DEFAULT_MAX_IMAGE_ROWS = 40

/** Column cap, applied on top of the terminal width. */
export const DEFAULT_MAX_IMAGE_COLUMNS = 200

/** Floor for the adaptive row budget, so a short window still shows something. */
const MIN_IMAGE_ROWS = 16
/** Ceiling, so one image cannot bury the whole transcript. */
const MAX_IMAGE_ROWS = 72
/** Share of the viewport an image may occupy. */
const VIEWPORT_ROW_SHARE = 0.75
/**
 * Rows kept clear below and around an image: the summary line, the response
 * rail, the prompt and its status line. An image that eats into these is pushed
 * partly off-screen, where the graphics overlay cannot be placed.
 */
const VIEWPORT_CHROME_ROWS = 10

/**
 * Row budget for a viewport of `viewportRows` rows.
 *
 * Aspect ratio ties the two axes together, so a row cap silently caps width as
 * well: a 16:10 image in a 182-column window fits 182 columns only if it may
 * use 56 rows. Capping at a fixed 40 left nearly a third of the terminal width
 * unused and cost more than half the available detail. Scaling with the window
 * spends whatever the user actually has, while `TAU_INLINE_IMAGE_ROWS` lets
 * them trade transcript space for detail directly.
 */
export function maxRowsForViewport(
  viewportRows: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number.parseInt(env.TAU_INLINE_IMAGE_ROWS ?? '', 10)
  if (Number.isFinite(override) && override > 0) {
    return Math.min(MAX_IMAGE_ROWS, Math.max(1, override))
  }
  if (!Number.isFinite(viewportRows) || viewportRows <= 0) {
    return DEFAULT_MAX_IMAGE_ROWS
  }
  // Two independent caps, whichever binds first.
  //
  // The share keeps a big window from being swallowed by one image. The
  // subtractive cap is what makes graphics work at all on a small window: a
  // pixel-accurate overlay is only drawn when its box is *wholly* inside the
  // viewport — a partly-scrolled image cannot be addressed by the cursor — so
  // an image sized to the full window straddles the edge the moment the prompt
  // and summary line are counted, and silently falls back to block glyphs.
  // Reserving room for that chrome is the difference between pixels and ASCII
  // on a short terminal.
  const fitCap = Math.max(1, viewportRows - VIEWPORT_CHROME_ROWS)
  const budget = Math.min(
    MAX_IMAGE_ROWS,
    Math.floor(viewportRows * VIEWPORT_ROW_SHARE),
    fitCap,
  )
  // The floor may never exceed what the viewport can hold. A box that does not
  // fit is not drawn *at all* — the overlay needs its whole rectangle inside the
  // viewport — so raising a short window's budget to the floor trades a small
  // image for no image, and the fallback stands until something resizes again.
  // Below 26 rows that was every image.
  return Math.max(Math.min(MIN_IMAGE_ROWS, fitCap), budget)
}

/**
 * Channel rounding applied to every emitted color.
 *
 * `StylePool` interns one entry per distinct fg/bg pair and is not reset for
 * the life of the session, so an unquantized image can mint thousands of
 * single-use styles. Snapping each channel to a multiple of four collapses the
 * near-duplicates that averaging produces while staying well under the
 * threshold of visible banding.
 */
const COLOR_QUANTIZATION = 4

function quantizeChannel(value: number): number {
  const snapped = Math.round(value / COLOR_QUANTIZATION) * COLOR_QUANTIZATION
  return snapped > 255 ? 252 : snapped < 0 ? 0 : snapped
}

export type ImageColorDepth = 'truecolor' | 'ansi256' | 'none'

/**
 * Terminals that render 24-bit color but do not advertise `COLORTERM`.
 * Matched against `TERM_PROGRAM`, case-insensitively.
 *
 * `Apple_Terminal` is deliberately absent: macOS Terminal.app is 256-color
 * only, and asking it for truecolor yields a silently wrong palette.
 */
const TRUECOLOR_TERM_PROGRAMS = new Set([
  'ghostty',
  'iterm.app',
  'wezterm',
  'vscode',
  'hyper',
  'rio',
  'tabby',
  'warpterminal',
])

/** Matched as substrings of `TERM`. */
const TRUECOLOR_TERM_PATTERNS = [
  'kitty',
  'ghostty',
  'alacritty',
  'wezterm',
  'contour',
  'foot',
  'rio',
  'direct',
]

/**
 * Pick the color depth to encode an inline image at.
 *
 * Deliberately independent of the global `chalk.level` mutations in
 * `ink/colorize.ts`: this decides only how image pixels are encoded, so it can
 * be more generous than app-wide text styling without changing anything else.
 * `chalk.level` is still consulted last, as the backstop that honours
 * `FORCE_COLOR` and chalk's own platform probing.
 *
 * Ordering is significant, and each branch exists for a specific platform:
 *
 * - `TAU_INLINE_IMAGES` is the escape hatch, checked first so a user can always
 *   force a depth or turn the feature off outright.
 * - tmux is clamped to 256-color for the same reason `colorize.ts` clamps
 *   chalk: tmux only re-emits truecolor to the outer terminal when that
 *   terminal advertises `Tc`, which the default config does not.
 * - `WT_SESSION` is checked without a `platform` guard on purpose. Windows
 *   Terminal exports it into WSL, where `process.platform === 'linux'` and
 *   `TERM` is usually a bare `xterm-256color` — the same guard `ink/terminal.ts`
 *   deliberately omits in `hasCursorUpViewportYankBug`. Without this, WSL users
 *   silently drop to a 256-color approximation.
 * - `TERM=linux` (the Linux framebuffer console) reports 8 colors and its font
 *   generally lacks block-drawing glyphs, so images are refused rather than
 *   rendered as garbage.
 */
export function resolveImageColorDepth(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout?.isTTY === true,
  chalkLevel: number = chalk.level,
): ImageColorDepth {
  const override = env.TAU_INLINE_IMAGES?.trim().toLowerCase()
  if (override) {
    if (override === 'off' || override === '0' || override === 'false') {
      return 'none'
    }
    if (override === 'truecolor' || override === '24bit') return 'truecolor'
    if (override === 'ansi256' || override === '256') return 'ansi256'
    // "auto" / "1" / "on" fall through to detection below.
  }

  // Standard opt-outs. NO_COLOR is honoured for any non-empty value per the
  // no-color.org spec; FORCE_COLOR=0 is chalk's explicit disable.
  if (env.NO_COLOR) return 'none'
  if (env.FORCE_COLOR === '0') return 'none'

  // Piped or redirected output has no terminal to paint into.
  if (!isTTY) return 'none'

  // Note: a missing TERM is deliberately *not* treated as a refusal. Windows
  // does not set TERM at all outside MSYS/Cygwin shells, so bailing here would
  // disable images for every PowerShell and cmd user — including Windows
  // Terminal, which does render 24-bit color. Unknown environments fall
  // through to the chalk backstop at the end instead.
  const term = env.TERM?.trim().toLowerCase() ?? ''
  if (term === 'dumb') return 'none'
  if (term === 'linux' || term === 'console') return 'none'

  // CI logs are read as text; images would be megabytes of escape codes.
  // An explicit override above still wins, for local reproductions.
  // Empty and explicitly-false values mean "not CI" and must not trigger this.
  const ci = env.CI?.trim().toLowerCase()
  if (ci && ci !== '0' && ci !== 'false') return 'none'

  // tmux: see doc comment. CLAUDE_CODE_TMUX_TRUECOLOR is the same escape hatch
  // ink/colorize.ts uses, kept identical so one setting covers both.
  if (env.TMUX && !env.CLAUDE_CODE_TMUX_TRUECOLOR) return 'ansi256'

  const colorTerm = env.COLORTERM?.trim().toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor'

  // Windows Terminal — also the WSL path, where platform is linux. Must come
  // before the TERM sniffing below, which would otherwise settle for ansi256.
  if (env.WT_SESSION) return 'truecolor'

  const termProgram = env.TERM_PROGRAM?.trim().toLowerCase()
  if (termProgram && TRUECOLOR_TERM_PROGRAMS.has(termProgram)) {
    return 'truecolor'
  }

  if (env.KITTY_WINDOW_ID) return 'truecolor'
  if (env.ZED_TERM) return 'truecolor'
  // ConEmu / Cmder on Windows, which also leaves TERM unset.
  if (env.ConEmuANSI?.trim().toLowerCase() === 'on') return 'truecolor'
  if (TRUECOLOR_TERM_PATTERNS.some(pattern => term.includes(pattern))) {
    return 'truecolor'
  }

  // VTE 0.68+ (GNOME Terminal, Tilix, Terminator) renders truecolor.
  const vte = Number.parseInt(env.VTE_VERSION ?? '', 10)
  if (Number.isFinite(vte) && vte >= 6800) return 'truecolor'

  if (term.includes('256color')) return 'ansi256'

  // Backstop: chalk's own detection, including FORCE_COLOR upgrades.
  if (chalkLevel >= 3) return 'truecolor'
  if (chalkLevel === 2) return 'ansi256'
  return 'none'
}

/**
 * Quantize 24-bit RGB to an xterm-256 palette index.
 *
 * Greys are routed to the 24-step ramp rather than the 6x6x6 cube, which only
 * offers six grey levels — the difference is very visible on the neutral
 * backgrounds most plots use.
 */
export function toAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  return (
    16 +
    36 * Math.round((r / 255) * 5) +
    6 * Math.round((g / 255) * 5) +
    Math.round((b / 255) * 5)
  )
}

/**
 * Pack a color, quantizing on the way in.
 *
 * Quantizing here rather than at emit time means the run-length comparison sees
 * the same values the terminal will, so two nearly-identical colors collapse
 * into one run instead of emitting a redundant SGR between them.
 */
function packRgb(r: number, g: number, b: number): number {
  return (
    (quantizeChannel(r) << 16) | (quantizeChannel(g) << 8) | quantizeChannel(b)
  )
}

function sgrColor(
  packed: number,
  depth: ImageColorDepth,
  isBackground: boolean,
): string {
  const layer = isBackground ? 48 : 38
  const reset = isBackground ? 49 : 39
  if (packed === NO_COLOR) return `\x1b[${reset}m`
  const r = (packed >> 16) & 0xff
  const g = (packed >> 8) & 0xff
  const b = packed & 0xff
  if (depth === 'ansi256') return `\x1b[${layer};5;${toAnsi256(r, g, b)}m`
  return `\x1b[${layer};2;${r};${g};${b}m`
}

/**
 * Fit an image into a cell box while preserving aspect ratio.
 *
 * Height is measured in half-pixels (two per cell row), which is why the
 * vertical budget is `maxRows * 2`. Never enlarges: a 10x10 favicon stays 10
 * columns wide instead of being smeared across the terminal.
 */
export function fitImageToCells(
  imageWidth: number,
  imageHeight: number,
  maxColumns: number,
  maxRows: number,
  subpixelX: 1 | 2 = 1,
  subpixelY: 2 | 3 = 2,
): { columns: number; rows: number; pixelWidth: number; pixelHeight: number } {
  const safeColumns = Math.max(1, Math.floor(maxColumns))
  const safeRows = Math.max(1, Math.floor(maxRows))
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return { columns: 1, rows: 1, pixelWidth: subpixelX, pixelHeight: subpixelY }
  }

  // A cell is about twice as tall as it is wide, so a block of `columns` by
  // `rows` cells is physically `columns` wide by `2 * rows` tall in units of
  // cell width. Preserving the image aspect therefore means
  // `columns / (2 * rows) === imageWidth / imageHeight`.
  //
  // Never enlarge: cap the sampled grid at the source resolution, measured on
  // the vertical axis where subpixels are square regardless of glyph mode.
  const naturalRows = Math.ceil(imageHeight / subpixelY)
  const rowBudget = Math.max(1, Math.min(safeRows, naturalRows))

  let columns = safeColumns
  let rows = Math.round((safeColumns * imageHeight) / (2 * imageWidth))
  if (rows > rowBudget) {
    rows = rowBudget
    columns = Math.round((2 * rowBudget * imageWidth) / imageHeight)
  }

  columns = Math.max(1, Math.min(safeColumns, columns))
  rows = Math.max(1, Math.min(rowBudget, rows))

  // Quadrants pack two subpixels across a cell, so the sampled grid is stretched
  // horizontally by that factor. The stretch is undone on screen because each
  // subpixel is half a cell wide — which is why the resize must hit these
  // dimensions exactly rather than preserving the source aspect.
  return {
    columns,
    rows,
    pixelWidth: columns * subpixelX,
    pixelHeight: rows * subpixelY,
  }
}

function readPixel(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  x: number,
  y: number,
): number {
  // Odd pixel heights leave the final row without a bottom half.
  if (y >= height) return NO_COLOR
  const offset = (y * width + x) * channels
  if (channels === 4 && (pixels[offset + 3] ?? 0) <= ALPHA_THRESHOLD) {
    return NO_COLOR
  }
  return packRgb(
    pixels[offset] ?? 0,
    pixels[offset + 1] ?? 0,
    pixels[offset + 2] ?? 0,
  )
}

/**
 * Encode raw pixels as half-block ANSI lines, one string per terminal row.
 *
 * `pixels` is row-major RGB or RGBA (`channels` says which). SGR is emitted
 * only when the color pair changes, so both the byte count and the number of
 * distinct interned styles scale with color runs rather than cell count — flat
 * plot backgrounds collapse to a handful of transitions.
 *
 * Every line is self-contained: it opens by resetting and closes with a reset,
 * so a truncated or reordered line can never leak a background color into the
 * surrounding transcript.
 */
export function renderPixelsToHalfBlocks(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  depth: ImageColorDepth,
): string[] {
  if (depth === 'none' || width <= 0 || height <= 0) return []
  if (channels !== 3 && channels !== 4) return []

  const lines: string[] = []
  const rows = Math.ceil(height / 2)

  for (let row = 0; row < rows; row++) {
    const topY = row * 2
    const bottomY = topY + 1
    // The opening reset puts the terminal at default fg/bg, so the tracked
    // state starts there too — a leading transparent run then emits nothing.
    let line = '\x1b[0m'
    let currentFg = NO_COLOR
    let currentBg = NO_COLOR

    for (let x = 0; x < width; x++) {
      const top = readPixel(pixels, width, height, channels, x, topY)
      const bottom = readPixel(pixels, width, height, channels, x, bottomY)

      // Glyph choice follows which halves are opaque, so a transparent half
      // always shows the terminal background rather than a guessed color.
      let glyph: string
      let fg: number
      let bg: number
      if (top === NO_COLOR && bottom === NO_COLOR) {
        glyph = ' '
        fg = NO_COLOR
        bg = NO_COLOR
      } else if (bottom === NO_COLOR) {
        glyph = UPPER_HALF
        fg = top
        bg = NO_COLOR
      } else if (top === NO_COLOR) {
        glyph = LOWER_HALF
        fg = bottom
        bg = NO_COLOR
      } else {
        glyph = UPPER_HALF
        fg = top
        bg = bottom
      }

      // A blank cell needs no foreground; skipping it avoids a pointless SGR
      // transition through runs of transparent padding.
      if (glyph !== ' ' && fg !== currentFg) {
        line += sgrColor(fg, depth, false)
        currentFg = fg
      }
      if (bg !== currentBg) {
        line += sgrColor(bg, depth, true)
        currentBg = bg
      }
      line += glyph
    }

    lines.push(`${line}\x1b[0m`)
  }

  return lines
}

/** Mean of the subpixels selected by `mask`, or NO_COLOR when none are. */
function meanOfMask(cell: number[], mask: number, count: number): number {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < count; i++) {
    if ((mask & (1 << i)) === 0) continue
    const c = cell[i]!
    r += (c >> 16) & 0xff
    g += (c >> 8) & 0xff
    b += c & 0xff
    n++
  }
  if (n === 0) return NO_COLOR
  return packRgb(Math.round(r / n), Math.round(g / n), Math.round(b / n))
}

/** Squared error of representing `cell` with `fg` where `mask` is set, `bg` elsewhere. */
function maskError(
  cell: number[],
  mask: number,
  fg: number,
  bg: number,
  count: number,
): number {
  let total = 0
  for (let i = 0; i < count; i++) {
    const ref = (mask & (1 << i)) !== 0 ? fg : bg
    if (ref === NO_COLOR) continue
    const c = cell[i]!
    const dr = ((c >> 16) & 0xff) - ((ref >> 16) & 0xff)
    const dg = ((c >> 8) & 0xff) - ((ref >> 8) & 0xff)
    const db = (c & 0xff) - (ref & 0xff)
    total += dr * dr + dg * dg + db * db
  }
  return total
}

/**
 * Encode raw pixels as quadrant-block ANSI lines, one string per terminal row.
 *
 * `pixels` is a `(columns * 2) x (rows * 2)` grid: each cell covers a 2x2 block
 * of subpixels, so this carries twice the horizontal detail of the half-block
 * encoder at the same column count.
 *
 * A cell can only show two colors, so the encoder searches all sixteen ways to
 * split its four subpixels into a foreground and a background group and keeps
 * the one with the lowest squared error. Sixteen candidates over four pixels is
 * cheap enough to brute-force, and it subsumes the half-block case — a cell
 * whose top and bottom halves differ still resolves to the upper-half glyph.
 * Ties resolve to the lowest mask, which prefers the all-background glyph and
 * so lengthens foreground runs across flat areas.
 */
export function renderPixelsToSubcells(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  depth: ImageColorDepth,
  mode: ImageGlyphMode = 'quadrant',
): string[] {
  if (depth === 'none' || width <= 0 || height <= 0) return []
  if (channels !== 3 && channels !== 4) return []

  const subX = subpixelsPerCellX(mode)
  const subY = subpixelsPerCellY(mode)
  const count = subX * subY
  const maskCount = 1 << count
  const fullMask = maskCount - 1
  const glyphFor =
    mode === 'sextant'
      ? sextantGlyph
      : (mask: number) => QUADRANT_GLYPHS[mask]!

  const columns = Math.ceil(width / subX)
  const rows = Math.ceil(height / subY)
  const lines: string[] = []
  const cell = new Array<number>(count).fill(NO_COLOR)

  for (let row = 0; row < rows; row++) {
    let line = '\x1b[0m'
    let currentFg = NO_COLOR
    let currentBg = NO_COLOR

    for (let col = 0; col < columns; col++) {
      // Subpixels are indexed row-major, matching the bit order of both the
      // quadrant table and the sextant codepoint run.
      let opaqueMask = 0
      for (let sy = 0; sy < subY; sy++) {
        for (let sx = 0; sx < subX; sx++) {
          const i = sy * subX + sx
          const value = readPixel(
            pixels,
            width,
            height,
            channels,
            col * subX + sx,
            row * subY + sy,
          )
          cell[i] = value
          if (value !== NO_COLOR) opaqueMask |= 1 << i
        }
      }

      // Transparent subpixels must show the terminal through, which the
      // two-color search cannot express. Pin them to the background instead and
      // let the opaque ones define the glyph.
      let glyph: string
      let fg: number
      let bg: number
      if (opaqueMask === 0) {
        glyph = ' '
        fg = NO_COLOR
        bg = NO_COLOR
      } else if (opaqueMask !== fullMask) {
        glyph = glyphFor(opaqueMask)
        fg = meanOfMask(cell, opaqueMask, count)
        bg = NO_COLOR
      } else {
        // Exhaustive search over every way to split the cell into a foreground
        // and a background group. Sixteen candidates for quadrants, sixty-four
        // for sextants — small enough to beat any heuristic on both quality and
        // predictability. Ties keep the lowest mask, which favours the
        // all-background glyph and so lengthens foreground runs on flat areas.
        let bestMask = 0
        let bestFg = NO_COLOR
        let bestBg = meanOfMask(cell, fullMask, count)
        let bestError = maskError(cell, 0, NO_COLOR, bestBg, count)
        for (let mask = 1; mask < maskCount; mask++) {
          const candidateFg = meanOfMask(cell, mask, count)
          const candidateBg = meanOfMask(cell, ~mask & fullMask, count)
          const error = maskError(
            cell,
            mask,
            candidateFg,
            candidateBg,
            count,
          )
          if (error < bestError) {
            bestError = error
            bestMask = mask
            bestFg = candidateFg
            bestBg = candidateBg
          }
        }
        glyph = glyphFor(bestMask)
        fg = bestFg
        bg = bestBg
      }

      if (glyph !== ' ' && fg !== currentFg) {
        line += sgrColor(fg, depth, false)
        currentFg = fg
      }
      if (bg !== currentBg) {
        line += sgrColor(bg, depth, true)
        currentBg = bg
      }
      line += glyph
    }

    lines.push(`${line}\x1b[0m`)
  }

  return lines
}

/** Back-compat alias: quadrant encoding is the 2x2 case of {@link renderPixelsToSubcells}. */
export function renderPixelsToQuadrants(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  depth: ImageColorDepth,
): string[] {
  return renderPixelsToSubcells(pixels, width, height, channels, depth, 'quadrant')
}

/**
 * Minimal surface needed to decode to raw pixels.
 *
 * Declared locally rather than widening the shared `SharpInstance`: the bundled
 * build can substitute `image-processor-napi`, which implements the resize and
 * encode surface but not necessarily `raw()`. The member is optional and
 * feature-detected at call time so that substitution degrades to the caller's
 * fallback instead of throwing.
 */
// `resize`/`toBuffer` are omitted before intersecting: keeping the originals
// would leave the narrower `SharpInstance` signatures in play, so `.resize()`
// would come back typed as `SharpInstance` and lose the `raw()` member.
type RawPixelSharp = Omit<SharpInstance, 'resize' | 'toBuffer'> & {
  raw?: () => RawPixelSharp
  resize: (
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ) => RawPixelSharp
  toBuffer: (options?: {
    resolveWithObject?: boolean
  }) => Promise<RawPixelResult | Buffer>
}

type RawPixelResult = {
  data: Buffer
  info: { width: number; height: number; channels: number }
}

function isRawPixelResult(value: unknown): value is RawPixelResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RawPixelResult>
  return (
    !!candidate.data &&
    !!candidate.info &&
    typeof candidate.info.width === 'number' &&
    typeof candidate.info.height === 'number' &&
    typeof candidate.info.channels === 'number'
  )
}

export type InlineImageOptions = {
  /** Terminal width; the rendered block never exceeds this. */
  maxColumns: number
  maxRows?: number
  depth?: ImageColorDepth
  glyphMode?: ImageGlyphMode
  /**
   * Fill this cell box exactly, instead of deriving one from the image aspect.
   *
   * Passed when a graphics overlay has already chosen the box. The two fits
   * disagree by construction — this one assumes a cell is exactly twice as tall
   * as it is wide and caps at {@link DEFAULT_MAX_IMAGE_COLUMNS}, while the
   * overlay measures real pixels and is bounded by the viewport — so the block
   * render came out *inside* the reserved box and the remainder stayed blank.
   * On a cell that is not 1:2 that is a strip along the bottom; on a wide
   * terminal it is a strip down the side; and when the overlay is withheld the
   * blank is all the user sees. Filling the box exactly also means the layout
   * is identical whether the graphic is drawn or not, so nothing shifts when
   * one replaces the other.
   */
  exact?: { columns: number; rows: number }
}

export type InlineImage = {
  lines: string[]
  columns: number
  rows: number
}

/**
 * Bounded memo of rendered images, keyed by content and render parameters.
 *
 * The transcript remounts result components as they scroll through the
 * virtualized list, and each mount would otherwise re-run a full decode and
 * resize. Entries are small (a 24-row block is a few KB of strings), so a
 * modest cap keeps scrolling free without meaningfully holding memory.
 *
 * A plain Map is the LRU: insertion order is iteration order, so refreshing an
 * entry is delete-then-set and eviction takes the first key.
 */
const RENDER_CACHE_LIMIT = 16
const renderCache = new Map<string, InlineImage>()

/**
 * Content key for {@link renderCache}.
 *
 * Hashing every byte would be O(n) on payloads that reach megabytes, and this
 * runs on the render path. Length plus both ends distinguishes any two images
 * that differ at all in size or content near their boundaries — and a PNG
 * carries its dimensions in the first bytes and its CRC in the last, so a
 * collision would need two images of identical length agreeing on both.
 */
function renderCacheKey(
  imageData: Buffer,
  maxColumns: number,
  maxRows: number,
  depth: ImageColorDepth,
  exact?: { columns: number; rows: number },
): string {
  const head = imageData.subarray(0, 32).toString('base64')
  const tail = imageData.subarray(-32).toString('base64')
  const box = exact ? `${exact.columns}x${exact.rows}` : '-'
  return `${imageData.length}:${maxColumns}:${maxRows}:${box}:${depth}:${head}:${tail}`
}

/** Drop every memoized render. Exported for tests. */
export function clearInlineImageCache(): void {
  renderCache.clear()
}

/**
 * Decode, downscale and encode an image for inline display.
 *
 * Returns `null` — never throws — when the terminal cannot show it, when the
 * optional image processor is unavailable, or when decoding fails. Callers keep
 * their existing fallback for that case.
 */
export async function renderInlineImage(
  imageData: Buffer,
  options: InlineImageOptions,
): Promise<InlineImage | null> {
  const depth = options.depth ?? resolveImageColorDepth()
  if (depth === 'none') return null

  const maxColumns = Math.min(
    DEFAULT_MAX_IMAGE_COLUMNS,
    Math.max(1, Math.floor(options.maxColumns)),
  )
  const maxRows = Math.max(
    1,
    Math.floor(options.maxRows ?? DEFAULT_MAX_IMAGE_ROWS),
  )

  const glyphMode = options.glyphMode ?? resolveGlyphMode()
  const subpixelX = subpixelsPerCellX(glyphMode)
  const subpixelY = subpixelsPerCellY(glyphMode)

  // Keyed on the clamped parameters, so a cache hit is byte-identical to what a
  // fresh render would produce. Glyph mode is part of the key: the same image at
  // the same size encodes differently under quadrants and half blocks.
  // The box the caller demands, if any — clamped, but not to the block
  // renderer's own column cap: the overlay derived this from the viewport and
  // the real cell size, and shrinking it here is what reopens the blank strip.
  const exact =
    options.exact === undefined
      ? undefined
      : {
          columns: Math.max(1, Math.floor(options.exact.columns)),
          rows: Math.max(1, Math.floor(options.exact.rows)),
        }
  const key = `${glyphMode}|${renderCacheKey(imageData, maxColumns, maxRows, depth, exact)}`
  const cached = renderCache.get(key)
  if (cached) {
    // Refresh recency: delete + set moves the entry to the end of the Map.
    renderCache.delete(key)
    renderCache.set(key, cached)
    return cached
  }

  try {
    const processor = await getImageProcessor()
    const probe = processor(imageData) as RawPixelSharp
    if (typeof probe.raw !== 'function') {
      logForDebugging(
        'terminalImage: image processor lacks raw() — skipping inline render',
      )
      return null
    }

    // `metadata()` may report undefined dimensions for some formats;
    // `fitImageToCells` rejects non-finite input rather than propagating NaN.
    const metadata = await probe.metadata()
    const fit =
      exact === undefined
        ? fitImageToCells(
            metadata.width,
            metadata.height,
            maxColumns,
            maxRows,
            subpixelX,
            subpixelY,
          )
        : {
            columns: exact.columns,
            rows: exact.rows,
            pixelWidth: exact.columns * subpixelX,
            pixelHeight: exact.rows * subpixelY,
          }

    // `fit: 'fill'` on purpose: fitImageToCells already applied the image aspect
    // when choosing the cell box, and the quadrant grid is deliberately stretched
    // horizontally to match the half-width subpixels. Preserving the source
    // aspect here would undo that and letterbox the result.
    const result = await (processor(imageData) as RawPixelSharp)
      .resize(fit.pixelWidth, fit.pixelHeight, { fit: 'fill' })
      .raw!()
      .toBuffer({ resolveWithObject: true })

    if (!isRawPixelResult(result)) {
      logForDebugging('terminalImage: raw decode returned an unexpected shape')
      return null
    }

    const { data, info } = result
    const lines =
      glyphMode === 'half'
        ? renderPixelsToHalfBlocks(
            data,
            info.width,
            info.height,
            info.channels,
            depth,
          )
        : renderPixelsToSubcells(
            data,
            info.width,
            info.height,
            info.channels,
            depth,
            glyphMode,
          )
    if (lines.length === 0) return null

    const rendered: InlineImage = {
      lines,
      columns: Math.ceil(info.width / subpixelX),
      rows: lines.length,
    }
    // Failures are deliberately not cached: a missing processor or a transient
    // decode error should be retried, not remembered for the session.
    renderCache.set(key, rendered)
    if (renderCache.size > RENDER_CACHE_LIMIT) {
      const oldest = renderCache.keys().next().value
      if (oldest !== undefined) renderCache.delete(oldest)
    }
    return rendered
  } catch (error) {
    // Missing sharp, an unsupported format, or a corrupt file all land here.
    // Inline preview is decorative; the caller still renders its summary.
    logForDebugging(
      `terminalImage: inline render failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}
