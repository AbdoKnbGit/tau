/**
 * Inline image rendering checks.
 *
 * The bulk of this file is the terminal-detection matrix: the renderer itself
 * is pure arithmetic, but picking a color depth has to be right on Windows,
 * WSL, macOS, Linux, tmux and SSH, where the same `TERM` means different
 * things. Each case names the terminal it stands for.
 *
 * Run via: bun run src/utils/terminalImage.test.ts
 */

import { stringWidth } from '../ink/stringWidth.js'
import {
  fitImageToCells,
  maxRowsForViewport,
  type ImageColorDepth,
  renderPixelsToHalfBlocks,
  renderPixelsToQuadrants,
  renderPixelsToSubcells,
  resolveGlyphMode,
  sextantGlyph,
  resolveImageColorDepth,
  subpixelsPerCellX,
  subpixelsPerCellY,
  toAnsi256,
} from './terminalImage.js'

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

/**
 * Async variant. The sync `test` above would count a rejected promise as a
 * pass, so async cases are collected and awaited before the summary prints.
 */
const pending: Array<Promise<void>> = []
function testAsync(name: string, fn: () => Promise<void>): void {
  pending.push(
    fn().then(
      () => {
        passed++
        console.log(`  ok  ${name}`)
      },
      (e: any) => {
        failed++
        console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
      },
    ),
  )
}

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

/** Resolve against an explicit env, with a TTY and chalk at 256-color. */
function depthOf(
  env: NodeJS.ProcessEnv,
  isTTY = true,
  chalkLevel = 2,
): ImageColorDepth {
  return resolveImageColorDepth(env, isTTY, chalkLevel)
}

// --- Platform detection matrix ---------------------------------------------

test('Windows Terminal on win32 gets truecolor', () => {
  assertEqual(
    depthOf({ WT_SESSION: 'abc-123', TERM: 'xterm-256color' }),
    'truecolor',
    'WT_SESSION implies 24-bit',
  )
})

test('WSL inside Windows Terminal gets truecolor, not 256', () => {
  // The regression this guards: in WSL process.platform is "linux" and TERM is
  // a bare xterm-256color, so TERM sniffing alone would settle for ansi256.
  // WT_SESSION is exported through to the Linux side and is the only signal.
  assertEqual(
    depthOf({
      WT_SESSION: 'abc-123',
      WSL_DISTRO_NAME: 'Ubuntu',
      TERM: 'xterm-256color',
    }),
    'truecolor',
    'WSL under Windows Terminal must not degrade',
  )
})

test('macOS Terminal.app stays at 256 colors', () => {
  // Terminal.app advertises xterm-256color and genuinely cannot do 24-bit;
  // sending truecolor SGR there produces a silently wrong palette.
  assertEqual(
    depthOf({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }),
    'ansi256',
    'Terminal.app is 256-color only',
  )
})

test('macOS iTerm2 gets truecolor', () => {
  assertEqual(
    depthOf({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' }),
    'truecolor',
    'iTerm2 renders 24-bit',
  )
})

test('kitty gets truecolor via TERM', () => {
  assertEqual(depthOf({ TERM: 'xterm-kitty' }), 'truecolor', 'kitty is 24-bit')
})

test('ghostty gets truecolor via TERM', () => {
  assertEqual(
    depthOf({ TERM: 'xterm-ghostty' }),
    'truecolor',
    'ghostty is 24-bit',
  )
})

test('GNOME Terminal gets truecolor via VTE_VERSION', () => {
  assertEqual(
    depthOf({ TERM: 'xterm-256color', VTE_VERSION: '7000' }),
    'truecolor',
    'VTE 0.68+ is 24-bit',
  )
})

test('old VTE stays at 256 colors', () => {
  assertEqual(
    depthOf({ TERM: 'xterm-256color', VTE_VERSION: '5202' }),
    'ansi256',
    'pre-0.68 VTE has no truecolor',
  )
})

test('Linux framebuffer console renders nothing', () => {
  // 8 colors, and the console font has no block-drawing glyphs.
  assertEqual(depthOf({ TERM: 'linux' }), 'none', 'TERM=linux is unusable')
})

test('plain SSH session falls back to 256 colors', () => {
  // COLORTERM is not forwarded by default, so this is the common remote shape.
  assertEqual(
    depthOf({ TERM: 'xterm-256color', SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }),
    'ansi256',
    'SSH without COLORTERM degrades safely',
  )
})

test('COLORTERM=truecolor wins over a plain TERM', () => {
  assertEqual(
    depthOf({ TERM: 'xterm', COLORTERM: 'truecolor' }),
    'truecolor',
    'explicit COLORTERM is authoritative',
  )
})

test('VS Code integrated terminal gets truecolor', () => {
  assertEqual(
    depthOf({ TERM_PROGRAM: 'vscode', TERM: 'xterm-256color' }),
    'truecolor',
    'xterm.js has been 24-bit since 2017',
  )
})

// --- tmux ------------------------------------------------------------------

test('tmux clamps to 256 colors even when COLORTERM says truecolor', () => {
  // Matches the clamp in ink/colorize.ts: tmux only re-emits truecolor when the
  // outer terminal advertises Tc, which the default config does not.
  assertEqual(
    depthOf({
      TMUX: '/tmp/tmux-1000/default,123,0',
      TERM: 'tmux-256color',
      COLORTERM: 'truecolor',
    }),
    'ansi256',
    'tmux is clamped by default',
  )
})

test('tmux escape hatch restores truecolor', () => {
  assertEqual(
    depthOf({
      TMUX: '/tmp/tmux-1000/default,123,0',
      TERM: 'tmux-256color',
      COLORTERM: 'truecolor',
      CLAUDE_CODE_TMUX_TRUECOLOR: '1',
    }),
    'truecolor',
    'a configured tmux opts back in',
  )
})

// --- Opt-outs --------------------------------------------------------------

test('NO_COLOR disables inline images', () => {
  assertEqual(
    depthOf({ NO_COLOR: '1', COLORTERM: 'truecolor' }),
    'none',
    'NO_COLOR is honoured',
  )
})

test('FORCE_COLOR=0 disables inline images', () => {
  assertEqual(
    depthOf({ FORCE_COLOR: '0', COLORTERM: 'truecolor' }),
    'none',
    'FORCE_COLOR=0 is an explicit disable',
  )
})

test('a non-TTY renders nothing', () => {
  assertEqual(
    depthOf({ COLORTERM: 'truecolor' }, false),
    'none',
    'piped output has no terminal',
  )
})

test('TERM=dumb renders nothing', () => {
  assertEqual(depthOf({ TERM: 'dumb' }), 'none', 'dumb terminals are excluded')
})

test('a missing TERM falls through to the chalk backstop', () => {
  // Windows does not set TERM outside MSYS/Cygwin. Refusing on a missing TERM
  // would disable images for every PowerShell and cmd user.
  assertEqual(depthOf({}, true, 2), 'ansi256', 'no TERM defers to chalk')
  assertEqual(depthOf({}, true, 0), 'none', 'chalk still gets the last word')
})

test('Windows Terminal from PowerShell works without TERM', () => {
  // The regression this guards: an early "no TERM means no" check used to run
  // before the WT_SESSION branch, disabling images on native Windows shells.
  assertEqual(
    depthOf({ WT_SESSION: 'abc-123' }, true, 1),
    'truecolor',
    'WT_SESSION is enough on its own',
  )
})

test('ConEmu on Windows works without TERM', () => {
  assertEqual(
    depthOf({ ConEmuANSI: 'ON' }, true, 1),
    'truecolor',
    'ConEmu renders 24-bit and sets no TERM',
  )
})

test('an empty or false CI value is not treated as CI', () => {
  assertEqual(
    depthOf({ CI: '', COLORTERM: 'truecolor', TERM: 'xterm-256color' }),
    'truecolor',
    'CI="" means not CI',
  )
  assertEqual(
    depthOf({ CI: 'false', COLORTERM: 'truecolor', TERM: 'xterm-256color' }),
    'truecolor',
    'CI=false means not CI',
  )
})

test('CI renders nothing', () => {
  assertEqual(
    depthOf({ CI: 'true', COLORTERM: 'truecolor', TERM: 'xterm-256color' }),
    'none',
    'CI logs are read as text',
  )
})

test('TAU_INLINE_IMAGES=off beats every positive signal', () => {
  assertEqual(
    depthOf({
      TAU_INLINE_IMAGES: 'off',
      COLORTERM: 'truecolor',
      WT_SESSION: 'x',
    }),
    'none',
    'the kill switch is absolute',
  )
})

test('TAU_INLINE_IMAGES=truecolor forces 24-bit on a bare terminal', () => {
  assertEqual(
    depthOf({ TAU_INLINE_IMAGES: 'truecolor', TERM: 'xterm' }),
    'truecolor',
    'users can force the depth up',
  )
})

test('TAU_INLINE_IMAGES=ansi256 forces the 256 path', () => {
  assertEqual(
    depthOf({ TAU_INLINE_IMAGES: 'ansi256', COLORTERM: 'truecolor' }),
    'ansi256',
    'users can force the depth down',
  )
})

test('TAU_INLINE_IMAGES=auto still runs detection', () => {
  assertEqual(
    depthOf({ TAU_INLINE_IMAGES: 'auto', COLORTERM: 'truecolor' }),
    'truecolor',
    'auto is a no-op passthrough',
  )
})

test('chalk level is the backstop for unknown terminals', () => {
  assertEqual(
    depthOf({ TERM: 'screen' }, true, 3),
    'truecolor',
    'chalk level 3 upgrades an unrecognised TERM',
  )
  assertEqual(
    depthOf({ TERM: 'screen' }, true, 0),
    'none',
    'chalk level 0 means no color at all',
  )
})

// --- Fitting ---------------------------------------------------------------

test('a wide image is bounded by columns', () => {
  const fit = fitImageToCells(1200, 700, 80, 24)
  assertEqual(fit.columns, 80, 'width saturates first')
  assert(fit.rows <= 24, 'row budget is respected')
  assertEqual(fit.pixelHeight, fit.rows * 2, 'two subpixel rows per cell row')
  // A cell is twice as tall as it is wide, so the block is physically
  // `columns` by `2 * rows`. Rounding to whole cells costs at most one row.
  const physicalAspect = fit.columns / (2 * fit.rows)
  assert(
    Math.abs(physicalAspect - 1200 / 700) < 0.05,
    `aspect preserved, got ${physicalAspect}`,
  )
})

test('quadrant mode samples twice the horizontal detail', () => {
  const half = fitImageToCells(1200, 700, 80, 24, 1)
  const quad = fitImageToCells(1200, 700, 80, 24, 2)
  // Same cell box either way — only the sampled grid differs.
  assertEqual(quad.columns, half.columns, 'same column count')
  assertEqual(quad.rows, half.rows, 'same row count')
  assertEqual(quad.pixelWidth, half.pixelWidth * 2, 'twice the sampled width')
  assertEqual(quad.pixelHeight, half.pixelHeight, 'same sampled height')
})

test('a small image is not enlarged in quadrant mode either', () => {
  const fit = fitImageToCells(10, 10, 200, 40, 2)
  assert(fit.rows <= 5, `no vertical upscale, got ${fit.rows} rows`)
  assert(fit.columns <= 10, `no runaway width, got ${fit.columns} columns`)
})

test('a tall image is bounded by rows, not columns', () => {
  const fit = fitImageToCells(400, 4000, 80, 24)
  assert(fit.rows <= 24, 'row budget wins for tall images')
  assert(fit.pixelWidth < 80, 'width shrinks to preserve aspect')
})

test('a small image is never enlarged', () => {
  const fit = fitImageToCells(10, 10, 80, 24)
  assertEqual(fit.pixelWidth, 10, 'no upscaling')
  assertEqual(fit.pixelHeight, 10, 'no upscaling')
})

test('degenerate dimensions do not throw', () => {
  for (const [w, h] of [
    [0, 0],
    [-5, 10],
    [Number.NaN, 10],
    [Number.POSITIVE_INFINITY, 10],
  ]) {
    const fit = fitImageToCells(w!, h!, 80, 24)
    assert(fit.rows >= 1 && fit.columns >= 1, `safe fallback for ${w}x${h}`)
  }
})

// --- Pixel encoding --------------------------------------------------------

/**
 * A 2x3 RGBA cell where set bits of `mask` are opaque white and clear bits are
 * opaque black, so the encoder's best partition is exactly `mask`.
 */
function maskToPixels(mask: number): Uint8Array {
  const out = new Uint8Array(2 * 3 * 4)
  for (let i = 0; i < 6; i++) {
    const on = (mask & (1 << i)) !== 0
    out.set(on ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4)
  }
  return out
}

/** Build a solid RGBA block. */
function solidRgba(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) out.set(rgba, i * 4)
  return out
}

test('two pixel rows collapse into one cell row', () => {
  const lines = renderPixelsToHalfBlocks(
    solidRgba(4, 2, [255, 0, 0, 255]),
    4,
    2,
    4,
    'truecolor',
  )
  assertEqual(lines.length, 1, 'two pixel rows are one cell row')
})

test('an odd pixel height still emits a full final row', () => {
  const lines = renderPixelsToHalfBlocks(
    solidRgba(4, 3, [0, 255, 0, 255]),
    4,
    3,
    4,
    'truecolor',
  )
  assertEqual(lines.length, 2, 'three pixel rows need two cell rows')
  // The final row has no bottom half, so it must not paint a background.
  assert(!lines[1]!.includes('[48;2;'), 'no background on the orphan row')
})

test('every line opens and closes with a reset', () => {
  const lines = renderPixelsToHalfBlocks(
    solidRgba(6, 6, [10, 20, 30, 255]),
    6,
    6,
    4,
    'truecolor',
  )
  for (const line of lines) {
    assert(line.startsWith('\x1b[0m'), 'line opens with a reset')
    assert(line.endsWith('\x1b[0m'), 'line closes with a reset')
  }
})

test('a solid block emits one color transition, not one per cell', () => {
  const lines = renderPixelsToHalfBlocks(
    solidRgba(40, 2, [1, 2, 3, 255]),
    40,
    2,
    4,
    'truecolor',
  )
  const fgCount = (lines[0]!.match(/\x1b\[38;2;/g) ?? []).length
  assertEqual(fgCount, 1, 'run-length encoding collapses the row')
})

test('transparent pixels become uncolored spaces', () => {
  const lines = renderPixelsToHalfBlocks(
    solidRgba(3, 2, [255, 255, 255, 0]),
    3,
    2,
    4,
    'truecolor',
  )
  assertEqual(lines.length, 1, 'still one row')
  assert(!lines[0]!.includes('38;2;'), 'no foreground on transparent cells')
  assert(lines[0]!.includes('   '), 'transparent cells are spaces')
})

test('printable width equals the pixel width', () => {
  const width = 17
  const lines = renderPixelsToHalfBlocks(
    solidRgba(width, 4, [9, 9, 9, 255]),
    width,
    4,
    4,
    'truecolor',
  )
  for (const line of lines) {
    // Layout depends on this: one glyph per column, no wide characters.
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
    assertEqual([...visible].length, width, 'one glyph per column')
  }
})

test('ansi256 output never emits 24-bit SGR', () => {
  const lines = renderPixelsToHalfBlocks(
    solidRgba(8, 4, [200, 100, 50, 255]),
    8,
    4,
    4,
    'ansi256',
  )
  for (const line of lines) {
    assert(!line.includes(';2;'), 'no truecolor sequences at 256-color depth')
    assert(line.includes(';5;'), 'uses palette indices')
  }
})

test('three-channel RGB input is accepted', () => {
  const rgb = new Uint8Array(4 * 2 * 3).fill(120)
  const lines = renderPixelsToHalfBlocks(rgb, 4, 2, 3, 'truecolor')
  assertEqual(lines.length, 1, 'RGB renders without an alpha channel')
})

test('unsupported channel counts render nothing', () => {
  assertEqual(
    renderPixelsToHalfBlocks(new Uint8Array(8), 4, 2, 1, 'truecolor').length,
    0,
    'greyscale-only input is refused rather than misread',
  )
})

test('depth "none" renders nothing', () => {
  assertEqual(
    renderPixelsToHalfBlocks(solidRgba(4, 2, [1, 2, 3, 255]), 4, 2, 4, 'none')
      .length,
    0,
    'disabled means empty',
  )
})

// --- Quadrant encoding -----------------------------------------------------

test('quadrants halve the grid in both axes', () => {
  const lines = renderPixelsToQuadrants(
    solidRgba(8, 6, [30, 60, 90, 255]),
    8,
    6,
    4,
    'truecolor',
  )
  assertEqual(lines.length, 3, '6 subpixel rows -> 3 cell rows')
  const visible = lines[0]!.replace(/\x1b\[[0-9;]*m/g, '')
  assertEqual([...visible].length, 4, '8 subpixel columns -> 4 cells')
})

test('quadrant glyphs measure one column wide', () => {
  // Layout depends on this: every glyph in the table must be narrow.
  const px = new Uint8Array(8 * 4 * 4)
  for (let i = 0; i < 8 * 4; i++) {
    // Alternating pattern forces a spread of partition masks.
    const on = (i % 3 === 0)
    px.set(on ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4)
  }
  const lines = renderPixelsToQuadrants(px, 8, 4, 4, 'truecolor')
  for (const line of lines) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
    assertEqual(stringWidth(visible), 4, 'each glyph occupies one column')
  }
})

test('a split cell picks the matching quadrant glyph', () => {
  // Left column black, right column white -> left half block.
  const px = new Uint8Array(2 * 2 * 4)
  const set = (i: number, v: number[]) => px.set(v, i * 4)
  set(0, [0, 0, 0, 255])
  set(1, [255, 255, 255, 255])
  set(2, [0, 0, 0, 255])
  set(3, [255, 255, 255, 255])
  const [line] = renderPixelsToQuadrants(px, 2, 2, 4, 'truecolor')
  const visible = line!.replace(/\x1b\[[0-9;]*m/g, '')
  assert(
    visible === '▌' || visible === '▐',
    `expected a vertical half block, got ${JSON.stringify(visible)}`,
  )
})

test('a flat cell collapses to a single background run', () => {
  const lines = renderPixelsToQuadrants(
    solidRgba(40, 4, [17, 17, 25, 255]),
    40,
    4,
    4,
    'truecolor',
  )
  const fgCount = (lines[0]!.match(/\x1b\[38;2;/g) ?? []).length
  const bgCount = (lines[0]!.match(/\x1b\[48;2;/g) ?? []).length
  assertEqual(fgCount, 0, 'a flat run needs no foreground')
  assertEqual(bgCount, 1, 'a flat run is one background transition')
})

test('quadrant lines keep the reset discipline', () => {
  const lines = renderPixelsToQuadrants(
    solidRgba(10, 8, [200, 30, 60, 255]),
    10,
    8,
    4,
    'truecolor',
  )
  for (const line of lines) {
    assert(line.startsWith('\x1b[0m'), 'opens with a reset')
    assert(line.endsWith('\x1b[0m'), 'closes with a reset')
  }
})

test('fully transparent quadrants emit bare spaces', () => {
  const lines = renderPixelsToQuadrants(
    solidRgba(6, 4, [255, 255, 255, 0]),
    6,
    4,
    4,
    'truecolor',
  )
  for (const line of lines) {
    assert(!line.includes('38;2;'), 'no foreground')
    assert(!line.includes('48;2;'), 'no background')
  }
})

test('glyph mode resolves from the environment', () => {
  assertEqual(
    resolveGlyphMode({}, 'linux'),
    'quadrant',
    'quadrants are the default where the font has them',
  )
  assertEqual(
    resolveGlyphMode({ TAU_INLINE_IMAGE_GLYPHS: 'half' }),
    'half',
    'half blocks are opt-in',
  )
  assertEqual(subpixelsPerCellX('quadrant'), 2, 'quadrants are 2 wide')
  assertEqual(subpixelsPerCellX('half'), 1, 'half blocks are 1 wide')
})

test('color quantization bounds distinct styles', () => {
  // Every channel must land on a multiple of 4 so near-identical averages
  // collapse into one interned style rather than thousands of singletons.
  const px = new Uint8Array(64 * 2 * 4)
  for (let i = 0; i < 64 * 2; i++) {
    px.set([i % 256, (i * 2) % 256, (i * 3) % 256, 255], i * 4)
  }
  const lines = renderPixelsToQuadrants(px, 64, 2, 4, 'truecolor')
  const channels = [...lines[0]!.matchAll(/\x1b\[[34]8;2;(\d+);(\d+);(\d+)m/g)]
  assert(channels.length > 0, 'produced color transitions')
  for (const m of channels) {
    for (const v of [m[1]!, m[2]!, m[3]!]) {
      assertEqual(Number(v) % 4, 0, `channel ${v} snapped to a multiple of 4`)
    }
  }
})

// --- Adaptive row budget ---------------------------------------------------

test('the row budget scales with the viewport', () => {
  // The bug this guards: a fixed row cap also caps width, because aspect ratio
  // couples the axes. At 40 rows a 16:10 image used only 71% of a 182-column
  // window.
  assert(maxRowsForViewport(80, {}) > maxRowsForViewport(40, {}), 'taller wins')
  assert(maxRowsForViewport(40, {}) >= 16, 'a short window still shows rows')
  assert(maxRowsForViewport(400, {}) <= 72, 'one image cannot bury the transcript')
  assert(maxRowsForViewport(0, {}) > 0, 'a bogus viewport falls back')
  assert(maxRowsForViewport(Number.NaN, {}) > 0, 'NaN falls back')
})

test('the row budget leaves room for the chrome around an image', () => {
  // A graphics overlay is only drawn when its box is wholly inside the
  // viewport. An image sized to the full window straddles the edge once the
  // summary line and prompt are counted, and silently drops to block glyphs —
  // which is the "it goes ASCII at some sizes" failure.
  // The `|| budget === 16` that used to be here was an escape hatch from the
  // invariant this test exists to check, and the minimum-rows floor drove
  // straight through it: below 26 rows the floor exceeded what fits, so every
  // image on a short window was withheld and fell back to blocks. The bound is
  // unconditional now.
  for (const viewport of [12, 18, 20, 24, 26, 30, 40, 50, 60, 80]) {
    const budget = maxRowsForViewport(viewport, {})
    assert(
      budget <= Math.max(1, viewport - 10),
      `viewport ${viewport}: budget ${budget} leaves room for chrome`,
    )
    assert(budget >= 1, `viewport ${viewport}: budget ${budget} is drawable`)
  }
})

test('TAU_INLINE_IMAGE_ROWS overrides the budget', () => {
  assertEqual(
    maxRowsForViewport(40, { TAU_INLINE_IMAGE_ROWS: '60' }),
    60,
    'explicit rows win',
  )
  assertEqual(
    maxRowsForViewport(40, { TAU_INLINE_IMAGE_ROWS: '9999' }),
    72,
    'still clamped to the ceiling',
  )
  assertEqual(
    maxRowsForViewport(40, { TAU_INLINE_IMAGE_ROWS: 'nonsense' }),
    30,
    'garbage falls through to the viewport',
  )
})

test('raising the row budget recovers the full terminal width', () => {
  const narrow = fitImageToCells(3287, 2023, 182, 40, 2)
  const wide = fitImageToCells(3287, 2023, 182, 56, 2)
  assert(narrow.columns < 182, 'a 40-row cap leaves width on the table')
  assertEqual(wide.columns, 182, 'a 56-row budget uses the whole width')
  assert(
    wide.pixelWidth * wide.pixelHeight >
      narrow.pixelWidth * narrow.pixelHeight * 1.8,
    'and roughly doubles the sampled detail',
  )
})

// --- Sextants --------------------------------------------------------------

test('sextants sample 2x3 per cell', () => {
  assertEqual(subpixelsPerCellY('sextant'), 3, 'three subpixel rows')
  assertEqual(subpixelsPerCellY('quadrant'), 2, 'quadrants stack two')
  assertEqual(subpixelsPerCellX('sextant'), 2, 'two across')
  assertEqual(
    resolveGlyphMode({ TAU_INLINE_IMAGE_GLYPHS: 'sextant' }),
    'sextant',
    'opt-in by env',
  )
})

test('every sextant mask maps to exactly one narrow glyph', () => {
  // The Symbols for Legacy Computing run omits the four masks that already
  // exist as Block Elements, so the index must skip them. An off-by-one here
  // would silently shift 60 glyphs.
  const seen = new Set<string>()
  for (let mask = 0; mask < 64; mask++) {
    const glyph = sextantGlyph(mask)
    assertEqual(stringWidth(glyph), 1, `mask ${mask} is one column wide`)
    assert(!seen.has(glyph), `mask ${mask} glyph ${glyph} is a duplicate`)
    seen.add(glyph)
  }
  assertEqual(seen.size, 64, 'all 64 masks are distinct')
})

test('the four Block Element sextant cases are not from the 1FB00 run', () => {
  assertEqual(sextantGlyph(0b000000), ' ', 'empty is a space')
  assertEqual(sextantGlyph(0b111111), '█', 'full is the full block')
  assertEqual(sextantGlyph(0b010101), '▌', 'left column is the left half block')
  assertEqual(sextantGlyph(0b101010), '▐', 'right column is the right half block')
})

test('the other 60 sextants come from U+1FB00..U+1FB3B', () => {
  const specials = new Set([0, 0b010101, 0b101010, 63])
  let count = 0
  for (let mask = 0; mask < 64; mask++) {
    if (specials.has(mask)) continue
    const cp = sextantGlyph(mask).codePointAt(0)!
    assert(
      cp >= 0x1fb00 && cp <= 0x1fb3b,
      `mask ${mask} -> U+${cp.toString(16)} is inside the sextant run`,
    )
    count++
  }
  assertEqual(count, 60, 'exactly 60 masks use the run')
})

test('a sextant cell renders its pattern, up to fg/bg inversion', () => {
  // Complementary partitions are visually identical, and the tie-break keeps
  // the lower mask — so a cell may come back inverted. What must hold is that
  // the glyph describes the same split of the 2x3 block.
  const line = renderPixelsToSubcells(
    maskToPixels(0b000001),
    2,
    3,
    4,
    'truecolor',
    'sextant',
  )[0]!
  const glyph = line.replace(/\x1b\[[0-9;]*m/g, '')
  assert(
    glyph === sextantGlyph(0b000001) || glyph === sextantGlyph(0b111110),
    `expected the top-left split either way round, got ${JSON.stringify(glyph)}`,
  )
})

test('sextant rows halve by three, not two', () => {
  const lines = renderPixelsToSubcells(
    solidRgba(8, 6, [40, 80, 120, 255]),
    8,
    6,
    4,
    'truecolor',
    'sextant',
  )
  assertEqual(lines.length, 2, '6 subpixel rows -> 2 cell rows')
  const visible = lines[0]!.replace(/\x1b\[[0-9;]*m/g, '')
  assertEqual([...visible].length, 4, '8 subpixel columns -> 4 cells')
})

// --- Quantization ----------------------------------------------------------

test('ansi256 maps greys to the ramp and colors to the cube', () => {
  assertEqual(toAnsi256(0, 0, 0), 16, 'black')
  assertEqual(toAnsi256(255, 255, 255), 231, 'white')
  assertEqual(toAnsi256(255, 0, 0), 196, 'pure red')
  const midGrey = toAnsi256(128, 128, 128)
  assert(midGrey >= 232 && midGrey <= 255, 'mid grey uses the 24-step ramp')
})

test('every ansi256 index is in range', () => {
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) {
        const idx = toAnsi256(r, g, b)
        assert(idx >= 16 && idx <= 255, `index in range for ${r},${g},${b}`)
      }
    }
  }
})

// --- Glyph coverage ----------------------------------------------------------

test('the windows console host gets half blocks, not question marks', () => {
  // Consolas and Lucida Console — everything conhost ships — have the halves
  // and the full block but not the quadrants (U+2596..U+259F), so a quadrant
  // cell renders as a literal `?` and the picture comes out as a field of
  // question marks. Half blocks are in every monospace font ever shipped.
  assertEqual(
    resolveGlyphMode({}, 'win32'),
    'half',
    'bare Windows console falls back',
  )
  assertEqual(
    resolveGlyphMode({ WT_SESSION: '1' }, 'win32'),
    'quadrant',
    'Windows Terminal ships Cascadia Mono, which has them',
  )
  assertEqual(
    resolveGlyphMode({ MSYSTEM: 'MINGW64' }, 'win32'),
    'quadrant',
    'mintty picks its own font',
  )
  assertEqual(
    resolveGlyphMode({ TERM_PROGRAM: 'vscode' }, 'win32'),
    'quadrant',
    'xterm.js uses a web font',
  )
  assertEqual(
    resolveGlyphMode({}, 'darwin'),
    'quadrant',
    'nothing to work around off Windows',
  )
  assertEqual(
    resolveGlyphMode({ TAU_INLINE_IMAGE_GLYPHS: 'quadrant' }, 'win32'),
    'quadrant',
    'and the override still wins, for a console with a better font',
  )
})

// --- Exact box fill ----------------------------------------------------------

testAsync('an exact box is filled edge to edge, whatever the image aspect', async () => {
  // The blank-strip bug. When a graphics overlay owns the box, the block render
  // underneath has to cover the same rectangle: it is what shows whenever the
  // overlay is withheld, and any part of the box it leaves over is blank screen
  // rather than image. Its own fit cannot do that — it assumes a cell is exactly
  // twice as tall as it is wide and caps at DEFAULT_MAX_IMAGE_COLUMNS, while the
  // overlay measures real pixels and is bounded only by the viewport.
  const { clearInlineImageCache, renderInlineImage } = await import(
    './terminalImage.js'
  )
  const sharp = (await import('sharp')).default
  const png = async (w: number, h: number) => {
    const raw = Buffer.alloc(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      raw[i * 3] = i % 256
      raw[i * 3 + 1] = (i * 7) % 256
      raw[i * 3 + 2] = (i * 13) % 256
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer()
  }

  clearInlineImageCache()
  for (const [w, h] of [
    [64, 64],
    [160, 40],
    [40, 160],
  ] as const) {
    const data = await png(w, h)
    // A box no aspect-derived fit would choose, and wider than the block
    // renderer's own column cap.
    const exact = { columns: 220, rows: 30 }
    const rendered = await renderInlineImage(data, {
      maxColumns: exact.columns,
      maxRows: exact.rows,
      exact,
      depth: 'truecolor' as const,
    })
    assert(rendered !== null, `renders ${w}x${h}`)
    assertEqual(rendered!.rows, exact.rows, `fills all rows for ${w}x${h}`)
    assertEqual(
      rendered!.columns,
      exact.columns,
      `fills all columns for ${w}x${h}`,
    )
    assertEqual(
      rendered!.lines.length,
      exact.rows,
      `one line per row for ${w}x${h}`,
    )
  }
})

testAsync('without an exact box the aspect fit still applies', async () => {
  const { clearInlineImageCache, renderInlineImage } = await import(
    './terminalImage.js'
  )
  const sharp = (await import('sharp')).default
  const raw = Buffer.alloc(64 * 64 * 3, 128)
  const data = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } })
    .png()
    .toBuffer()

  clearInlineImageCache()
  const rendered = await renderInlineImage(data, {
    maxColumns: 220,
    maxRows: 30,
    depth: 'truecolor' as const,
  })
  assert(rendered !== null, 'renders')
  assert(
    rendered!.columns < 220 || rendered!.rows < 30,
    'a square image does not fill a 220x30 box on its own',
  )
})

// --- Render cache ------------------------------------------------------------

testAsync('the render cache returns an identical result and is bounded', async () => {
  const { clearInlineImageCache, renderInlineImage } = await import(
    './terminalImage.js'
  )
  const sharp = (await import('sharp')).default

  const png = async (seed: number) => {
    const w = 24
    const h = 24
    const raw = Buffer.alloc(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      raw[i * 3] = (i + seed) % 256
      raw[i * 3 + 1] = (i * 3 + seed) % 256
      raw[i * 3 + 2] = seed % 256
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer()
  }

  clearInlineImageCache()
  const opts = { maxColumns: 20, maxRows: 8, depth: 'truecolor' as const }
  const first = await renderInlineImage(await png(1), opts)
  const second = await renderInlineImage(await png(1), opts)
  assert(first !== null && second !== null, 'both renders succeed')
  // Same bytes and same parameters must produce a byte-identical block, so a
  // cache hit can never differ from a fresh render.
  assertEqual(
    JSON.stringify(first),
    JSON.stringify(second),
    'cached render matches',
  )

  // Distinct images must not collide on the content key.
  const other = await renderInlineImage(await png(200), opts)
  assert(
    JSON.stringify(other) !== JSON.stringify(first),
    'different images render differently',
  )

  // Differing render parameters must miss rather than return the wrong size.
  const narrow = await renderInlineImage(await png(1), {
    ...opts,
    maxColumns: 10,
  })
  assert(narrow !== null && narrow.columns <= 10, 'width change bypasses cache')

  // Overflow the cap and confirm the oldest entry is gone but results stay right.
  for (let i = 0; i < 40; i++) {
    await renderInlineImage(await png(i + 10), opts)
  }
  const refetched = await renderInlineImage(await png(1), opts)
  assertEqual(
    JSON.stringify(refetched),
    JSON.stringify(first),
    'an evicted image re-renders identically',
  )
})

await Promise.all(pending)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
