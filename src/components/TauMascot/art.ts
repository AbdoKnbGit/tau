/**
 * Pixel art for Tau's mascot: the little block figure from Logo.png who holds
 * up the τ.
 *
 * Pure data and arithmetic, with no app imports, so it can be unit-tested and
 * previewed outside the CLI. A sprite is SPRITE_W x SPRITE_H pixels drawn
 * facing right. The terminal shows two stacked pixels per cell as a half
 * block, so a sprite is MASCOT_ROWS rows tall and SPRITE_W columns wide, and
 * its pixels come out square on a 1:2 terminal cell.
 */

export const SPRITE_W = 28
export const SPRITE_H = 16
export const MASCOT_ROWS = SPRITE_H / 2

/** A transparent pixel. Colors are 0xRRGGBB. */
export const CLEAR = -1

export type MascotTone = 'dark' | 'light'
export type MascotMode = 'normal' | 'cheap' | 'full'

export type MascotPalette = {
  /** Which tone and mode this palette is for; sprites are cached by it. */
  id: string
  /** Lit front faces, from the logo. */
  front: number
  /** The side of the head and body, a step darker. */
  side: number
  /** The far leg, darker again so the two legs read apart. */
  back: number
  eye: number
  /** The τ: dark on light terminals as in the logo, light on dark ones. */
  tau: number
  /** The τ held up as a lantern, and the light it throws. */
  glow: number
  ray: number
  /** Motion lines around the τ, and speed lines. */
  line: number
  spark: number
  sparkHot: number
  anvil: number
  anvilDark: number
  star: number
  sweat: number
}

// The τ follows the power-mode accent: bronze in cheap mode, gold in full
// power, plain otherwise. Values follow the accents in utils/modeTheme.ts.
const TAU_COLORS: Record<MascotMode, Record<MascotTone, number>> = {
  normal: { dark: 0xf2eee8, light: 0x1c1c1e },
  cheap: { dark: 0xdeb892, light: 0x754f2d },
  full: { dark: 0xf0d28c, light: 0x6a5010 },
}

export function mascotPalette(
  tone: MascotTone,
  mode: MascotMode,
): MascotPalette {
  const id = `${tone}:${mode}`
  const cached = paletteCache.get(id)
  if (cached) return cached
  const dark = tone === 'dark'
  const palette: MascotPalette = {
    id,
    front: 0xca7a5b,
    side: 0xa95a3e,
    back: 0x83442e,
    eye: 0x1c1a1a,
    tau: TAU_COLORS[mode][tone],
    glow: dark ? 0xffc864 : 0xd88a10,
    ray: dark ? 0xffe39a : 0xe8a83a,
    line: dark ? 0x8c8782 : 0xa8a29c,
    spark: dark ? 0xffd45a : 0xe0a000,
    sparkHot: 0xff8c3c,
    anvil: dark ? 0x8c929c : 0x6c727c,
    anvilDark: dark ? 0x5c626c : 0x4a5058,
    star: dark ? 0xffe278 : 0xd09a00,
    sweat: dark ? 0x78beff : 0x2f7fd0,
  }
  paletteCache.set(id, palette)
  return palette
}

const paletteCache = new Map<string, MascotPalette>()

export type Eyes = 'open' | 'joy' | 'blink' | 'left' | 'right' | 'down'
export type Legs = 'together' | 'strideA' | 'strideB' | 'knees'
export type Arm = 'hold' | 'raise' | 'reach' | 'low'
export type TauGrip = 'palm' | 'raised' | 'hammer'
export type Effect =
  | 'lines'
  | 'lines2'
  | 'rays'
  | 'anvil'
  | 'sparks'
  | 'sparks2'
  | 'speed'
  | 'speed2'
  | 'stars0'
  | 'stars1'
  | 'stars2'
  | 'sweat'

export type Pose = {
  /** Body offset: -1 mid-hop, 0 standing, 1 crouched, 2 kneeling. */
  dy: number
  /** Whole-figure shake. */
  dx: number
  legs: Legs
  eyes: Eyes
  arm: Arm
  tau: TauGrip
  /** Extra τ offset on the palm: a sag, a wobble, or trailing in a sprint. */
  tauDx: number
  tauDy: number
  /** The τ glows like a lantern. */
  glow: boolean
  effects: readonly Effect[]
}

export function poseKey(pose: Pose): string {
  return [
    pose.dy,
    pose.dx,
    pose.legs,
    pose.eyes,
    pose.arm,
    pose.tau,
    pose.tauDx,
    pose.tauDy,
    pose.glow ? 1 : 0,
    pose.effects.join('+'),
  ].join('|')
}

// --- The τ ------------------------------------------------------------------

// The Greek tau from the logo: a top bar whose left end droops, a two-pixel
// stem a little right of center, and a foot that curls up to the right.
const TAU_GLYPH = [
  '.KKKKKKK',
  'KK..KK..',
  'K...KK..',
  '....KK..',
  '....KK..',
  '....KK.K',
  '.....KK.',
] as const

// The τ swung as a hammer: the stem is the handle, the bar the head, striking
// downward with the drooping end of the bar on top.
const TAU_HAMMER = [
  '.....KKK',
  '.....KK.',
  'KKKKKKK.',
  '.....KK.',
  '.....KK.',
  '.....KK.',
] as const

/** The column of the upright τ's stem, so the stem lands on the palm. */
export const TAU_STEM_X = 4

// --- Drawing ----------------------------------------------------------------

// The figure is drawn this far in from the sprite's left edge, leaving room
// behind it for speed lines.
const OX = 3

type Canvas = Int32Array

function blank(): Canvas {
  return new Int32Array(SPRITE_W * SPRITE_H).fill(CLEAR)
}

function put(canvas: Canvas, x: number, y: number, color: number): void {
  if (x < 0 || x >= SPRITE_W || y < 0 || y >= SPRITE_H) return
  canvas[y * SPRITE_W + x] = color
}

function fill(
  canvas: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) put(canvas, x, y, color)
  }
}

function stamp(
  canvas: Canvas,
  art: readonly string[],
  x0: number,
  y0: number,
  color: number,
): void {
  art.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '.') put(canvas, x0 + x, y0 + y, color)
    }
  })
}

function points(
  canvas: Canvas,
  list: readonly (readonly [number, number])[],
  color: number,
  dx: number,
  dy: number,
): void {
  for (const [x, y] of list) put(canvas, x + dx, y + dy, color)
}

// Eye pixels on the front face, relative to (OX, eye row).
const EYES: Record<Eyes, readonly (readonly [number, number])[]> = {
  open: [[5, 0], [5, 1], [8, 0], [8, 1]],
  // The logo's squeezed "> <".
  joy: [[5, -1], [6, 0], [5, 1], [9, -1], [8, 0], [9, 1]],
  blink: [[5, 1], [6, 1], [8, 1], [9, 1]],
  left: [[4, 0], [4, 1], [7, 0], [7, 1]],
  right: [[6, 0], [6, 1], [9, 0], [9, 1]],
  down: [[5, 1], [5, 2], [8, 1], [8, 2]],
}

// The near arm from the shoulder to the hand, as rows of [y, x0, x1]
// relative to (OX, standing height).
const ARMS: Record<Arm, readonly (readonly [number, number, number])[]> = {
  hold: [[8, 13, 17], [9, 10, 12], [10, 9, 10]],
  raise: [[7, 12, 16], [8, 11, 12], [9, 10, 11], [10, 9, 10]],
  reach: [[9, 13, 14], [10, 9, 14]],
  low: [[9, 11, 16], [10, 9, 11]],
}

/** Top-left of the upright τ for each grip, relative to (OX, standing height). */
const UPRIGHT_AT: Partial<Record<TauGrip, readonly [number, number]>> = {
  palm: [11, 1],
  raised: [10, 0],
}

// The anvil the hammer rings on, as rows of [y, x0, x1] in sprite pixels.
const ANVIL = [
  [13, 21, 26],
  [14, 22, 25],
  [15, 21, 26],
] as const

// Motion lines round the raised τ, in two flickering sets (from OX).
const LINES: readonly (readonly [number, number])[] = [
  [21, 1], [22, 0], [21, 4], [22, 4], [21, 7], [22, 8],
]
const LINES2: readonly (readonly [number, number])[] = [
  [22, 1], [23, 0], [22, 3], [23, 4], [22, 7], [23, 8],
]
// The lantern's light, round the glowing τ (from OX).
const RAYS: readonly (readonly [number, number])[] = [
  [20, 2], [21, 1], [21, 5], [22, 5], [20, 8], [21, 9],
]
// Sparks off the anvil's face, two alternating bursts (sprite pixels).
type Spark = readonly [number, number, 'spark' | 'sparkHot']
const SPARKS: readonly Spark[] = [
  [21, 12, 'spark'], [25, 12, 'spark'], [20, 10, 'sparkHot'], [26, 10, 'spark'],
]
const SPARKS2: readonly Spark[] = [
  [20, 12, 'sparkHot'], [26, 12, 'spark'], [21, 9, 'spark'], [25, 9, 'sparkHot'],
]
// Speed lines trailing a sprint (sprite pixels; they sit behind the figure).
const SPEED: readonly (readonly [number, number])[] = [
  [0, 5], [1, 5], [1, 9], [2, 9], [0, 12], [1, 12],
]
const SPEED2: readonly (readonly [number, number])[] = [
  [1, 6], [2, 6], [0, 10], [1, 10], [1, 13], [2, 13],
]
// Stars circling over a dazed head, three steps of the turn (from OX).
const STARS: readonly (readonly (readonly [number, number])[])[] = [
  [[2, 1], [6, 0], [9, 2]],
  [[3, 0], [8, 1], [1, 2]],
  [[5, 1], [9, 0], [2, 0]],
]

/**
 * Draws one pose facing right. The upright τ is left out: `spriteFor` stamps
 * it unmirrored, so the letter reads the right way round whichever way the
 * figure faces. The τ swung as a hammer mirrors with the arm that swings it.
 */
function drawFigure(pose: Pose, palette: MascotPalette): Canvas {
  const canvas = blank()
  const dy = pose.dy
  const x = OX + pose.dx

  // Legs, the far one first so the near one overlaps it. Mid-hop they leave
  // the ground row empty.
  const legTop = 13 + Math.max(dy, -1)
  const legBottom = dy < 0 ? 14 : 15
  if (pose.legs === 'knees') {
    fill(canvas, x + 3, 15, x + 5, 15, palette.back)
    fill(canvas, x + 6, 15, x + 9, 15, palette.front)
  } else {
    const [farX, nearX] =
      pose.legs === 'strideA'
        ? [3, 8]
        : pose.legs === 'strideB'
          ? [8, 3]
          : [4, 7]
    fill(canvas, x + farX, legTop, x + farX + 1, legBottom, palette.back)
    fill(canvas, x + nearX, legTop, x + nearX + 1, legBottom, palette.front)
  }

  // Body: a narrower block under the head, its side in shade.
  fill(canvas, x + 3, 10 + dy, x + 4, 12 + dy, palette.side)
  fill(canvas, x + 5, 10 + dy, x + 8, 12 + dy, palette.front)

  // Head: the logo's cube, seen with its shaded side and an ear.
  fill(canvas, x + 2, 3 + dy, x + 3, 9 + dy, palette.side)
  fill(canvas, x + 4, 3 + dy, x + 9, 9 + dy, palette.front)
  fill(canvas, x + 1, 5 + dy, x + 1, 6 + dy, palette.side)
  points(canvas, EYES[pose.eyes], palette.eye, x, 5 + dy)

  // The near arm, up to the hand that carries the τ.
  for (const [y, x0, x1] of ARMS[pose.arm]) {
    fill(canvas, x + x0, y + dy, x + x1, y + dy, palette.front)
  }
  if (pose.tau === 'hammer') {
    stamp(canvas, TAU_HAMMER, x + 14, 7 + dy, palette.tau)
  }

  for (const effect of pose.effects) {
    switch (effect) {
      case 'lines':
        points(canvas, LINES, palette.line, x, dy)
        break
      case 'lines2':
        points(canvas, LINES2, palette.line, x, dy)
        break
      case 'rays':
        points(canvas, RAYS, palette.ray, x, dy)
        break
      case 'anvil':
        for (const [y, x0, x1] of ANVIL) {
          fill(canvas, x0, y, x1, y, y === 13 ? palette.anvil : palette.anvilDark)
        }
        break
      case 'sparks':
      case 'sparks2':
        for (const [sx, sy, role] of effect === 'sparks' ? SPARKS : SPARKS2) {
          put(canvas, sx, sy, palette[role])
        }
        break
      case 'speed':
        points(canvas, SPEED, palette.line, 0, 0)
        break
      case 'speed2':
        points(canvas, SPEED2, palette.line, 0, 0)
        break
      case 'stars0':
      case 'stars1':
      case 'stars2':
        points(canvas, STARS[Number(effect.slice(-1))]!, palette.star, x, dy)
        break
      case 'sweat':
        put(canvas, x + 10, 4 + dy, palette.sweat)
        put(canvas, x + 10, 5 + dy, palette.sweat)
        break
    }
  }
  return canvas
}

function mirrored(canvas: Canvas): Canvas {
  const out = blank()
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      out[y * SPRITE_W + (SPRITE_W - 1 - x)] = canvas[y * SPRITE_W + x]!
    }
  }
  return out
}

const spriteCache = new Map<string, Canvas>()
const SPRITE_CACHE_LIMIT = 256

/**
 * The sprite for a pose, facing right (1) or left (-1). Cached: a walk or a
 * reaction cycles through a handful of frames.
 */
export function spriteFor(
  pose: Pose,
  facing: 1 | -1,
  palette: MascotPalette,
): Int32Array {
  const key = `${poseKey(pose)}#${facing}#${palette.id}`
  const cached = spriteCache.get(key)
  if (cached) return cached

  const figure = drawFigure(pose, palette)
  const canvas = facing === 1 ? figure : mirrored(figure)
  const upright = UPRIGHT_AT[pose.tau]
  if (upright) {
    const y0 = upright[1] + pose.dy + pose.tauDy
    const rightX = OX + upright[0] + pose.dx + pose.tauDx
    // Facing left the hand is mirrored: put the stem back over it.
    const x0 =
      facing === 1 ? rightX : SPRITE_W - 1 - (rightX + TAU_STEM_X + 1) - TAU_STEM_X
    stamp(canvas, TAU_GLYPH, x0, y0, pose.glow ? palette.glow : palette.tau)
  }

  if (spriteCache.size >= SPRITE_CACHE_LIMIT) spriteCache.clear()
  spriteCache.set(key, canvas)
  return canvas
}

// --- Terminal cells ---------------------------------------------------------

/** A run of cells sharing one style; `fg`/`bg` unset means inherited. */
export type Run = { text: string; fg?: number; bg?: number }

const UPPER_HALF = String.fromCodePoint(0x2580)
const LOWER_HALF = String.fromCodePoint(0x2584)

/**
 * The sprite at column `x` of a track `track` columns wide, as MASCOT_ROWS
 * rows of styled runs. Transparent pixels carry no color, so they show
 * whatever background the theme painted, and a row ends at its last drawn
 * cell. No row is wider than `track`, and none is empty: an empty row would
 * be laid out zero lines tall and pull the rows under it up.
 */
export function composeRows(
  sprite: Int32Array,
  x: number,
  track: number,
): Run[][] {
  const left = Math.max(0, Math.min(x, track - 1))
  const visible = Math.max(0, Math.min(SPRITE_W, track - left))
  const rows: Run[][] = []

  for (let row = 0; row < MASCOT_ROWS; row++) {
    const cells: Run[] = []
    let lastDrawn = -1
    for (let col = 0; col < visible; col++) {
      const top = sprite[row * 2 * SPRITE_W + col]!
      const bottom = sprite[(row * 2 + 1) * SPRITE_W + col]!
      let cell: Run
      if (top === CLEAR && bottom === CLEAR) cell = { text: ' ' }
      else if (bottom === CLEAR) cell = { text: UPPER_HALF, fg: top }
      else if (top === CLEAR) cell = { text: LOWER_HALF, fg: bottom }
      else cell = { text: UPPER_HALF, fg: top, bg: bottom }
      if (cell.text !== ' ') lastDrawn = col
      cells.push(cell)
    }
    if (lastDrawn < 0) {
      rows.push([{ text: ' ' }])
      continue
    }

    const runs: Run[] = []
    let pending: Run | null = left > 0 ? { text: ' '.repeat(left) } : null
    for (let col = 0; col <= lastDrawn; col++) {
      const cell = cells[col]!
      if (pending && pending.fg === cell.fg && pending.bg === cell.bg) {
        pending.text += cell.text
      } else {
        if (pending) runs.push(pending)
        pending = { ...cell }
      }
    }
    if (pending) runs.push(pending)
    rows.push(runs)
  }
  return rows
}

/** Visible width of a composed row, in columns. */
export function rowWidth(runs: readonly Run[]): number {
  let width = 0
  for (const run of runs) width += [...run.text].length
  return width
}
