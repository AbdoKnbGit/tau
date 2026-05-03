/**
 * Tau startup screen: dark terminal base with ember red and brown glow.
 * Called once at CLI startup before the Ink UI renders.
 */

const ESC = '\x1b['
const RESET = `${ESC}0m`

type RGB = [number, number, number]
const rgb = (r: number, g: number, b: number): string =>
  `${ESC}38;2;${r};${g};${b}m`
const bg = (r: number, g: number, b: number): string =>
  `${ESC}48;2;${r};${g};${b}m`

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function gradAt(stops: readonly RGB[], t: number): RGB {
  const c = Math.max(0, Math.min(1, t))
  const s = c * (stops.length - 1)
  const i = Math.floor(s)
  if (i >= stops.length - 1) return stops[stops.length - 1]!
  return lerp(stops[i]!, stops[i + 1]!, s - i)
}

function paintLineDiagonal(
  text: string,
  stops: readonly RGB[],
  lineT: number,
): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const horizontal = text.length > 1 ? i / (text.length - 1) : 0
    const t = lineT * 0.42 + horizontal * 0.58
    const [r, g, b] = gradAt(stops, t)
    out += `${bg(...BASE)}${rgb(r, g, b)}${text[i]}`
  }
  return out + RESET
}

const BASE: RGB = [9, 5, 4]
const TAU_GLOW: readonly RGB[] = [
  [255, 96, 72],
  [238, 58, 48],
  [184, 70, 42],
  [112, 54, 36],
  [190, 75, 42],
  [255, 122, 76],
]

const LOGO: readonly string[] = [
  '       ████████╗ █████╗ ██╗   ██╗',
  '       ╚══██╔══╝██╔══██╗██║   ██║',
  '          ██║   ███████║██║   ██║',
  '          ██║   ██╔══██║██║   ██║',
  '          ██║   ██║  ██║╚██████╔╝',
  '          ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ',
]

export function printStartupScreen(): void {
  if (process.env.CI || !process.stdout.isTTY) return
  if (process.argv.includes('-p') || process.argv.includes('--print')) return
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return

  const out: string[] = ['']

  for (let i = 0; i < LOGO.length; i++) {
    const lineT = LOGO.length > 1 ? i / (LOGO.length - 1) : 0
    out.push(paintLineDiagonal(LOGO[i]!, TAU_GLOW, lineT))
  }

  out.push('')
  process.stdout.write(out.join('\n') + '\n')
}
