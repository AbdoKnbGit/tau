/**
 * NO_COLOR: no color reaches the terminal, every other style does.
 *
 * Run via: bun run src/ink/no-color.test.ts
 */

import type { AnsiCode } from '@alcalzone/ansi-tokenize'
import { LogUpdate } from './log-update.js'
import { isNoColorRequested, withoutColor } from './no-color.js'
import Output from './output.js'
import { CharPool, createScreen, HyperlinkPool, StylePool } from './screen.js'

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
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${hint}: expected ${e}, got ${a}`)
}

const ESC = String.fromCharCode(27)
const sgr = (body: string, end: string): AnsiCode => ({
  type: 'ansi',
  code: `${ESC}[${body}m`,
  endCode: `${ESC}[${end}m`,
})
/** The codes, as `body→end` pairs, for readable failures. */
const show = (codes: AnsiCode[]): string[] =>
  codes.map(c => `${c.code.slice(2, -1)}>${c.endCode.slice(2, -1)}`)

test('NO_COLOR counts when set and not empty, whatever its value', () => {
  assertEqual(isNoColorRequested({}), false, 'unset')
  assertEqual(isNoColorRequested({ NO_COLOR: '' }), false, 'empty')
  assertEqual(isNoColorRequested({ NO_COLOR: '1' }), true, '1')
  assertEqual(isNoColorRequested({ NO_COLOR: '0' }), true, '0 is still a value')
})

test('single color codes go', () => {
  for (const [body, end] of [
    ['38;2;202;122;91', '39'],
    ['48;2;250;249;246', '49'],
    ['38;5;174', '39'],
    ['48;5;17', '49'],
    ['31', '39'],
    ['91', '39'],
    ['42', '49'],
    ['103', '49'],
    ['38:2::1:2:3', '39'],
    ['58;2;9;9;9', '59'],
  ] as const) {
    assertEqual(show(withoutColor([sgr(body, end)])), [], body)
  }
})

test('other styles stay, untouched', () => {
  const styles = [sgr('1', '22'), sgr('2', '22'), sgr('3', '23'), sgr('4', '24'), sgr('7', '27'), sgr('9', '29')]
  assert(withoutColor(styles) === styles, 'the same array when nothing changes')
})

test('combined codes keep their other parameters, each with its own end code', () => {
  assertEqual(show(withoutColor([sgr('1;31;42', '0')])), ['1>22'], 'bold red on green')
  assertEqual(show(withoutColor([sgr('91;7', '39')])), ['7>27'], 'bright red inverse')
  assertEqual(show(withoutColor([sgr('4;58;2;9;9;9', '49')])), ['4>24'], 'underline with a color')
  assertEqual(show(withoutColor([sgr('01;34', '22')])), ['01>22'], 'ls-style bold blue')
  assertEqual(show(withoutColor([sgr('38;5;2;1', '39')])), ['1>22'], 'palette color, then bold')
  assertEqual(show(withoutColor([sgr('38;2;1;2;3;3', '39')])), ['3>23'], 'rgb color, then italic')
  assertEqual(show(withoutColor([sgr('0;32', '0')])), [], 'a reset with a color leaves nothing')
})

test('order is kept and duplicates are not', () => {
  assertEqual(
    show(withoutColor([sgr('2', '22'), sgr('38;2;1;1;1', '39'), sgr('1;31', '22'), sgr('7', '27')])),
    ['2>22', '1>22', '7>27'],
    'dim, bold, inverse',
  )
  assertEqual(show(withoutColor([sgr('1', '22'), sgr('1;31', '22')])), ['1>22'], 'bold once')
})

test('malformed extended colors do not swallow the next style', () => {
  assertEqual(show(withoutColor([sgr('38', '39')])), [], 'bare 38')
  assertEqual(show(withoutColor([sgr('38;5', '39')])), [], 'missing index')
})

test('a colorless pool interns colors away; a default pool keeps them', () => {
  const plain = new StylePool({ colors: false })
  assertEqual(plain.intern([sgr('38;2;1;2;3', '39')]), plain.none, 'a color alone is no style')
  assertEqual(
    plain.intern([sgr('1', '22'), sgr('48;2;1;2;3', '49')]),
    plain.intern([sgr('1', '22')]),
    'bold on a background is bold',
  )
  const colored = new StylePool()
  assert(colored.intern([sgr('38;2;1;2;3', '39')]) !== colored.none, 'default keeps colors')
})

test('selection shows as inverse when colors are off', () => {
  const plain = new StylePool({ colors: false })
  plain.setSelectionBg(sgr('48;2;60;60;90', '49'))
  const base = plain.intern([sgr('1', '22')])
  assertEqual(plain.withSelectionBg(base), plain.withInverse(base), 'inverse, not an invisible background')
  assert(plain.withSelectionBg(base) !== base, 'and it does change the cell')
})

test('a frame written with colors off carries no color, and keeps bold and inverse', () => {
  const stylePool = new StylePool({ colors: false })
  const screen = createScreen(30, 2, stylePool, new CharPool(), new HyperlinkPool())
  const output = new Output({ width: 30, height: 2, stylePool, screen })
  output.write(0, 0, `${ESC}[38;2;202;122;91m${ESC}[48;2;20;20;30mtau${ESC}[49m${ESC}[39m ${ESC}[1mbold${ESC}[22m`)
  output.write(0, 1, `${ESC}[1;31;42mmixed${ESC}[0m ${ESC}[7mcursor${ESC}[27m`)
  const frame = {
    screen: output.get(),
    viewport: { width: 30, height: 10 },
    cursor: { x: 0, y: 2, visible: false },
  }
  const empty = { ...frame, screen: createScreen(0, 0, stylePool, new CharPool(), new HyperlinkPool()), cursor: { x: 0, y: 0, visible: true } }
  const diff = new LogUpdate({ isTTY: true, stylePool }).render(empty, frame)
  let bytes = ''
  for (const patch of diff) {
    if (patch.type === 'stdout') bytes += patch.content
    else if (patch.type === 'styleStr') bytes += patch.str
  }
  const colorCodes = bytes.match(new RegExp(`${ESC}\\[[0-9;]*(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;[0-9;]*)?m`, 'g')) ?? []
  assertEqual(colorCodes, [], 'no color parameter in any SGR')
  assert(bytes.includes(`${ESC}[1m`), 'bold kept')
  assert(bytes.includes(`${ESC}[7m`), 'inverse kept')
  assert(bytes.includes('tau') && bytes.includes('mixed') && bytes.includes('cursor'), 'text kept')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
