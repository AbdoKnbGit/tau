import * as React from 'react'
import { useEffect, useState } from 'react'
import {
  Box,
  NoSelect,
  Text,
  type ClickEvent,
  useAnimationFrame,
} from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { interpolateColor, toRGBColor } from '../Spinner/utils.js'

type RGB = { r: number; g: number; b: number }

type Trace = {
  glyph: number
  i: number
  l: number
}

type LogoMap = {
  glyph: Map<string, number>
  trace: Map<string, Trace>
  center: Map<number, { x: number; y: number }>
}

type Burst = {
  x: number
  y: number
  glyph: number
  at: number
  force: number
}

const LETTERS = [
  ['    ▄     ', '▀▀▀▀█▀▀▀▀ ', '    █____ ', '    ▀~~~~ '],
  ['          ', '█▀▀▀▀▀▀▀█ ', '█^^^^^^^█ ', '▀~~~~~~~▀ '],
  ['          ', '█       █ ', '█_______█ ', '▀~~~~~~~▀ '],
] as const

const LETTER_GAP = '  '
const FULL = Array.from({ length: 4 }, (_, y) =>
  LETTERS.map(letter => letter[y]).join(LETTER_GAP),
)
const ROWS = FULL.length
const COLS = Math.max(...FULL.map(line => line.length))
const LINES = FULL.map(line => line.padEnd(COLS, ' '))
const SPAN = Math.hypot(COLS, ROWS * 2) * 0.94
const BUILD_STEP_MS = 26
const BUILD_POP_MS = 260

const NEAR = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const

const BODY_LEFT: RGB = { r: 146, g: 146, b: 154 }
const BODY_RIGHT: RGB = { r: 225, g: 225, b: 230 }
const SHADOW: RGB = { r: 54, g: 54, b: 62 }
const PRIMARY: RGB = { r: 82, g: 232, b: 221 }
const PEAK: RGB = { r: 255, g: 255, b: 255 }

const FRAME_MS = 40
const IDLE_MS = 4600
const RIPPLE_MS = 1020
const BLOOM_MS = 1600
const MAX_BURSTS = 5

let launchPlayed = false

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function ease(t: number): number {
  const p = clamp(t)
  return p * p * (3 - 2 * p)
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return interpolateColor(a, b, clamp(t))
}

function key(x: number, y: number): string {
  return `${x},${y}`
}

function lit(char: string): boolean {
  return char !== ' ' && char !== '_' && char !== '~' && char !== ','
}

function painted(char: string): boolean {
  return char !== ' '
}

function route(list: Array<{ x: number; y: number }>) {
  const left = new Map(list.map(item => [key(item.x, item.y), item]))
  const path: Array<{ x: number; y: number }> = []
  let cur = [...left.values()].sort((a, b) => a.y - b.y || a.x - b.x)[0]
  let dir = { x: 1, y: 0 }

  while (cur) {
    path.push(cur)
    left.delete(key(cur.x, cur.y))
    if (!left.size) return path

    const next = NEAR.map(([dx, dy]) => left.get(key(cur.x + dx, cur.y + dy)))
      .filter((item): item is { x: number; y: number } => !!item)
      .sort((a, b) => {
        const ax = a.x - cur!.x
        const ay = a.y - cur!.y
        const bx = b.x - cur!.x
        const by = b.y - cur!.y
        const adot = ax * dir.x + ay * dir.y
        const bdot = bx * dir.x + by * dir.y
        if (adot !== bdot) return bdot - adot
        return Math.abs(ax) + Math.abs(ay) - (Math.abs(bx) + Math.abs(by))
      })[0]

    if (!next) {
      cur = [...left.values()].sort((a, b) => {
        const da = (a.x - cur!.x) ** 2 + (a.y - cur!.y) ** 2
        const db = (b.x - cur!.x) ** 2 + (b.y - cur!.y) ** 2
        return da - db
      })[0]
      dir = { x: 1, y: 0 }
      continue
    }

    dir = { x: next.x - cur.x, y: next.y - cur.y }
    cur = next
  }

  return path
}

function mapGlyphs(lines: readonly string[]): LogoMap {
  const cells: Array<{ x: number; y: number }> = []

  for (let y = 0; y < lines.length; y++) {
    for (let x = 0; x < (lines[y]?.length ?? 0); x++) {
      if (lit(lines[y]?.[x] ?? ' ')) cells.push({ x, y })
    }
  }

  const all = new Map(cells.map(item => [key(item.x, item.y), item]))
  const seen = new Set<string>()
  const glyph = new Map<string, number>()
  const trace = new Map<string, Trace>()
  const center = new Map<number, { x: number; y: number }>()
  let id = 0

  for (const item of cells) {
    const start = key(item.x, item.y)
    if (seen.has(start)) continue

    const stack = [item]
    const part: Array<{ x: number; y: number }> = []
    seen.add(start)

    while (stack.length) {
      const cur = stack.pop()!
      part.push(cur)
      glyph.set(key(cur.x, cur.y), id)

      for (const [dx, dy] of NEAR) {
        const next = all.get(key(cur.x + dx, cur.y + dy))
        if (!next) continue

        const mark = key(next.x, next.y)
        if (seen.has(mark)) continue

        seen.add(mark)
        stack.push(next)
      }
    }

    const path = route(part)
    path.forEach((cell, i) =>
      trace.set(key(cell.x, cell.y), { glyph: id, i, l: path.length }),
    )
    center.set(id, {
      x: part.reduce((sum, cell) => sum + cell.x, 0) / part.length + 0.5,
      y: (part.reduce((sum, cell) => sum + cell.y, 0) / part.length) * 2 + 1,
    })
    id++
  }

  return { glyph, trace, center }
}

const MAP = mapGlyphs(LINES)
const BUILD_CELLS = LINES.flatMap((line, y) =>
  Array.from(line)
    .map((char, x) => ({ char, x, y }))
    .filter(cell => painted(cell.char)),
).sort((a, b) => {
  const aGlyph = MAP.glyph.get(key(a.x, a.y)) ?? nearestBuildGlyph(a.x, a.y)
  const bGlyph = MAP.glyph.get(key(b.x, b.y)) ?? nearestBuildGlyph(b.x, b.y)
  const aCenter = aGlyph === undefined ? a.x : MAP.center.get(aGlyph)?.x ?? a.x
  const bCenter = bGlyph === undefined ? b.x : MAP.center.get(bGlyph)?.x ?? b.x
  return aCenter - bCenter || a.x - b.x || a.y - b.y
})
const BUILD_INDEX = new Map(
  BUILD_CELLS.map((cell, index) => [key(cell.x, cell.y), index]),
)
const BUILD_MS = BUILD_CELLS.length * BUILD_STEP_MS + BUILD_POP_MS

function nearestBuildGlyph(x: number, y: number): number | undefined {
  let best: number | undefined
  let bestDistance = Infinity

  for (const [glyph, center] of MAP.center.entries()) {
    const distance = Math.hypot(x + 0.5 - center.x, y * 2 + 1 - center.y)
    if (distance < bestDistance) {
      best = glyph
      bestDistance = distance
    }
  }

  return best
}

function select(x: number, y: number): number | undefined {
  const direct = MAP.glyph.get(key(x, y))
  if (direct !== undefined) return direct

  return NEAR.map(([dx, dy]) => MAP.glyph.get(key(x + dx, y + dy))).find(
    (item): item is number => item !== undefined,
  )
}

function nearestGlyph(x: number, y: number): number | undefined {
  let best: number | undefined
  let bestDistance = Infinity

  for (const [glyph, center] of MAP.center.entries()) {
    const distance = Math.hypot(x + 0.5 - center.x, y * 2 + 1 - center.y)
    if (distance < bestDistance) {
      best = glyph
      bestDistance = distance
    }
  }

  return bestDistance <= 2.4 ? best : undefined
}

function noise(x: number, y: number, t: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + t * 0.043) * 43758.5453
  return n - Math.floor(n)
}

function gaussian(value: number, width: number): number {
  return Math.exp(-((value / width) ** 2))
}

function baseInk(x: number): RGB {
  return mix(BODY_LEFT, BODY_RIGHT, COLS > 1 ? x / (COLS - 1) : 1)
}

function idle(
  x: number,
  pixelY: number,
  time: number,
): { peak: number; primary: number } {
  const originX = 3.6
  const originY = ROWS * 2 + 4.4
  const reach = SPAN + 10
  let peak = 0
  let primary = 0

  for (let ring = 0; ring < 2; ring++) {
    const phase = ((time / IDLE_MS + ring / 2) % 1 + 1) % 1
    const envelope = ease(Math.sin(phase * Math.PI))
    const wobble =
      (noise(x * 0.35, pixelY * 0.28, time * 0.00045) - 0.5) * 0.24
    const dist =
      Math.hypot(x + 0.5 - originX, pixelY + 0.5 - originY) + wobble
    const head = phase * reach
    const core = gaussian(dist - head, 1.2) * envelope
    const soft = gaussian(dist - head, 8.2) * envelope
    const tail = dist < head ? Math.exp(-(head - dist) / 4.8) * envelope : 0

    peak += core * 0.52 + soft * 0.08
    primary += soft * 0.24 + tail * 0.12
  }

  return {
    peak: 0.04 + peak / 2,
    primary: primary / 2,
  }
}

function burstEffect(
  x: number,
  y: number,
  bursts: readonly Burst[],
  time: number,
): { peak: number; primary: number } {
  let peak = 0
  let primary = 0

  for (const burst of bursts) {
    const age = time - burst.at
    if (age < 0 || age > BLOOM_MS) continue

    const p = age / RIPPLE_MS
    const dx = x + 0.5 - burst.x
    const dy = y * 2 + 1 - burst.y
    const dist = Math.hypot(dx, dy)

    if (age <= RIPPLE_MS) {
      const radius = SPAN * (1 - (1 - clamp(p)) ** 1.62)
      const fade = (1 - clamp(p)) ** 1.32
      const edge = gaussian(dist - radius, 0.76) * fade * burst.force
      const trail = dist < radius ? Math.exp(-(radius - dist) / 2.3) * fade : 0
      const flash =
        gaussian(dist, 2.2) * Math.max(0, 1 - age / 140) * burst.force
      const shimmer =
        edge *
        (0.72 + noise(x + burst.x * 0.5, y + burst.y * 0.4, age * 0.06) * 0.5)

      peak += shimmer * 0.8 + flash * 0.95
      primary += edge * 0.5 + trail * 0.2
    }

    const step = MAP.trace.get(key(x, y))
    if (step && step.glyph === burst.glyph && step.l > 1) {
      const life = clamp(age / BLOOM_MS)
      const head = (age * 0.033) % step.l
      const distance = Math.min(
        Math.abs(step.i - head),
        step.l - Math.abs(step.i - head),
      )
      const trace = gaussian(distance, 1.05) * (1 - life) ** 0.58
      peak += trace * 0.9 * burst.force
      primary += trace * 0.42 * burst.force
    }

    const center = MAP.center.get(burst.glyph)
    if (center && MAP.glyph.get(key(x, y)) === burst.glyph) {
      const life = clamp(age / BLOOM_MS)
      const centerDistance = Math.hypot(x + 0.5 - center.x, y * 2 + 1 - center.y)
      const bloom = gaussian(centerDistance, 3.2) * (1 - life) ** 2
      peak += bloom * 0.42 * burst.force
      primary += bloom * 0.55 * burst.force
    }
  }

  return { peak, primary }
}

function tone(base: RGB, peak: number, primary: number): string {
  const tinted = mix(base, PRIMARY, Math.min(0.74, primary))
  return toRGBColor(mix(tinted, PEAK, Math.min(0.88, peak)))
}

function colorFor(
  base: RGB,
  x: number,
  pixelY: number,
  bursts: readonly Burst[],
  time: number,
  animatable: boolean,
  extraPeak = 0,
  extraPrimary = 0,
): string {
  if (!animatable) return toRGBColor(base)

  const pulse = idle(x, pixelY, time)
  const burst = burstEffect(x, Math.floor(pixelY / 2), bursts, time)
  return tone(
    base,
    pulse.peak + burst.peak + extraPeak,
    pulse.primary + burst.primary + extraPrimary,
  )
}

export function TauWordmark(): React.ReactNode {
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const animatable = !reducedMotion
  const [ref, time] = useAnimationFrame(animatable ? FRAME_MS : null)
  const [buildStartedAt] = useState(() => (animatable && !launchPlayed ? time : null))
  const [bursts, setBursts] = useState<readonly Burst[]>([])

  const progress =
    buildStartedAt == null ? 1 : clamp((time - buildStartedAt) / BUILD_MS)

  useEffect(() => {
    if (progress >= 1) launchPlayed = true
  }, [progress])

  useEffect(() => {
    if (bursts.length === 0) return

    setBursts(list => {
      const next = list.filter(burst => time - burst.at <= BLOOM_MS)
      return next.length === list.length ? list : next
    })
  }, [bursts.length, time])

  const handleClick = (event: ClickEvent) => {
    if (!animatable) return

    const x = Math.floor(event.localCol)
    const y = Math.floor(event.localRow)
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return

    const glyph = select(x, y) ?? nearestGlyph(x, y)
    if (glyph === undefined) return

    event.stopImmediatePropagation()
    setBursts(list => [
      ...list.slice(Math.max(0, list.length - MAX_BURSTS + 1)),
      {
        x: x + 0.5,
        y: y * 2 + 1,
        glyph,
        at: time,
        force: 1 + Math.min(0.45, list.length * 0.12),
      },
    ])
  }

  const renderCell = (char: string, x: number, y: number) => {
    const index = BUILD_INDEX.get(key(x, y))
    const buildAge =
      buildStartedAt == null || index === undefined
        ? Infinity
        : time - buildStartedAt - index * BUILD_STEP_MS
    const revealed = index === undefined || buildAge >= 0
    if (!revealed) return <Text key={x}> </Text>

    const pop =
      animatable && buildStartedAt !== null && index !== undefined
        ? 1 - ease(clamp(buildAge / BUILD_POP_MS))
        : 0
    const extraPeak = pop * 0.78
    const extraPrimary = pop * 0.34

    const inkTop = colorFor(
      baseInk(x),
      x,
      y * 2,
      bursts,
      time,
      animatable,
      extraPeak,
      extraPrimary,
    )
    const inkBottom = colorFor(
      baseInk(x),
      x,
      y * 2 + 1,
      bursts,
      time,
      animatable,
      extraPeak,
      extraPrimary,
    )
    const shadowTop = colorFor(
      SHADOW,
      x,
      y * 2,
      bursts,
      time,
      animatable,
      extraPeak * 0.22,
      extraPrimary * 0.2,
    )
    const shadowBottom = colorFor(
      SHADOW,
      x,
      y * 2 + 1,
      bursts,
      time,
      animatable,
      extraPeak * 0.22,
      extraPrimary * 0.2,
    )

    if (char === ' ') {
      return <Text key={x}> </Text>
    }

    if (char === '_') {
      return (
        <Text key={x} color={shadowBottom} backgroundColor={shadowBottom}>
          {' '}
        </Text>
      )
    }

    if (char === '^') {
      return (
        <Text key={x} color={inkTop} backgroundColor={shadowBottom}>
          ▀
        </Text>
      )
    }

    if (char === '~') {
      return (
        <Text key={x} color={shadowTop}>
          ▀
        </Text>
      )
    }

    if (char === ',') {
      return (
        <Text key={x} color={shadowBottom}>
          ▄
        </Text>
      )
    }

    if (char === '█') {
      return (
        <Text
          key={x}
          color={colorFor(
            baseInk(x),
            x,
            y * 2 + 1,
            bursts,
            time,
            animatable,
            extraPeak,
            extraPrimary,
          )}
          bold
        >
          █
        </Text>
      )
    }

    if (char === '▀') {
      return (
        <Text key={x} color={inkTop}>
          ▀
        </Text>
      )
    }

    if (char === '▄') {
      return (
        <Text key={x} color={inkBottom}>
          ▄
        </Text>
      )
    }

    return (
      <Text key={x} color={tone(baseInk(x), 0, 0)}>
        {char}
      </Text>
    )
  }

  return (
    <NoSelect ref={ref} flexDirection="column" onClick={handleClick}>
      {LINES.map((line, y) => (
        <Box key={y}>{Array.from(line).map((char, x) => renderCell(char, x, y))}</Box>
      ))}
    </NoSelect>
  )
}
