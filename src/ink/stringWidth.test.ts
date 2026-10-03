/**
 * Cell widths of the JavaScript stringWidth, the one tau uses on Node.
 *
 * Terminals draw a lone pictograph that defaults to text presentation — ✔ ⚠ ❤
 * ⚙ © — in one cell, and so does Bun.stringWidth. Counting two cells put every
 * later cell of the row one column right of where the terminal drew it: the
 * cells meant to be cleared there were never reached, and stray characters and
 * mascot pixels stayed on screen. These pin the widths, and that nothing else
 * moved: emoji by default, U+FE0F forms and emoji sequences stay two cells.
 *
 * Run via: bun run src/ink/stringWidth.test.ts
 */

import { stringWidthJavaScript as width } from './stringWidth.js'

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

function assertEqual(actual: unknown, expected: unknown, hint: string): void {
  if (actual !== expected) {
    throw new Error(`${hint}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

const cp = (...points: number[]) => String.fromCodePoint(...points)
const VS15 = 0xfe0e
const VS16 = 0xfe0f
const ZWJ = 0x200d

test('lone text-presentation pictographs take one cell', () => {
  // ✔ figures.tick in Windows Terminal, ⚠ tau's own warnings, the rest common
  // in model replies.
  for (const point of [0x2714, 0x26a0, 0x2764, 0x2733, 0x2611, 0x2716, 0x2699, 0x2600, 0x270f, 0x2702, 0x2665, 0x267b, 0x263a, 0x261d]) {
    assertEqual(width(cp(point)), 1, `U+${point.toString(16)}`)
  }
})

test('the same with the text selector U+FE0E', () => {
  assertEqual(width(cp(0x2714, VS15)), 1, 'heavy check + text selector')
  assertEqual(width(cp(0x00a9, VS15)), 1, 'copyright + text selector')
  assertEqual(width(cp(0x2194, VS15)), 1, 'left-right arrow + text selector')
  assertEqual(width(cp(0x00b7, 0x2714, VS15, 0x00b7)), 3, 'BRIDGE_READY_INDICATOR')
})

test('text-presentation pictographs outside U+2600-27BF', () => {
  assertEqual(width(cp(0x1f5a5)), 1, 'desktop computer')
  assertEqual(width(cp(0x1f441)), 1, 'eye')
  // Measured in a string that also needs segmentation.
  assertEqual(width(`${cp(0x00a9)} ${cp(0x2714)}`), 3, '© ✔')
})

test('wide text-presentation code points keep their East Asian width', () => {
  assertEqual(width(cp(0x3030)), 2, 'wavy dash')
  assertEqual(width(cp(0x3297)), 2, 'circled ideograph congratulation')
})

test('emoji presentation stays two cells', () => {
  assertEqual(width(cp(0x2714, VS16)), 2, 'heavy check + emoji selector')
  assertEqual(width(cp(0x26a0, VS16)), 2, 'warning + emoji selector')
  assertEqual(width(cp(0x2764, VS16)), 2, 'heart + emoji selector')
  assertEqual(width(cp(0x2705)), 2, '✅')
  assertEqual(width(cp(0x274c)), 2, '❌')
  assertEqual(width(cp(0x2728)), 2, '✨')
  assertEqual(width(cp(0x2b50)), 2, '⭐')
  assertEqual(width(cp(0x1f600)), 2, '😀')
  // Emoji by default: the text selector does not narrow it (Bun.stringWidth agrees).
  assertEqual(width(cp(0x231a, VS15)), 2, 'watch + text selector')
})

test('emoji sequences stay two cells', () => {
  assertEqual(width(cp(0x261d, 0x1f3fb)), 2, 'text-default base + skin tone')
  assertEqual(width(cp(0x1f44d, 0x1f3fd)), 2, 'thumbs up + skin tone')
  assertEqual(width(cp(0x1f468, ZWJ, 0x1f469, ZWJ, 0x1f467)), 2, 'family')
  assertEqual(width(cp(0x1f441, ZWJ, 0x1f5e8)), 2, 'eye in speech bubble')
  assertEqual(width(cp(0x2764, VS16, ZWJ, 0x1f525)), 2, 'heart on fire')
  assertEqual(width(cp(0x1f1eb, 0x1f1f7)), 2, 'flag')
  assertEqual(width(cp(0x31, VS16, 0x20e3)), 2, 'keycap')
})

test('unchanged special cases', () => {
  assertEqual(width(cp(0x1f1e6)), 1, 'lone regional indicator')
  assertEqual(width(cp(0x31, VS16)), 1, 'incomplete keycap')
  assertEqual(width(cp(0x2713)), 1, '✓ is not an emoji')
  assertEqual(width(cp(0x221a)), 1, '√ figures fallback tick')
  assertEqual(width('abc'), 3, 'ascii')
  assertEqual(width(''), 0, 'empty')
  assertEqual(width(`${cp(0x4e2d)}${cp(0x6587)}`), 4, 'CJK')
})

test('the rows that left debris', () => {
  assertEqual(width(`  ${cp(0x2714)} Test context/scouting`), 25, 'completed todo row')
  assertEqual(width(`${cp(0x26a0)} Import check: missing name`), 28, 'warning line')
})

// Under Bun the app uses Bun.stringWidth; the fallback should agree with it on
// every lone pictograph, the case this fix is about.
const bun = (globalThis as { Bun?: { stringWidth(s: string, o: object): number } }).Bun
if (bun) {
  test('agrees with Bun.stringWidth on every lone pictograph, with and without U+FE0E', () => {
    const pictograph = /\p{Extended_Pictographic}/u
    const regionalIndicator = /^[\u{1f1e6}-\u{1f1ff}]$/u
    let checked = 0
    const mismatches: string[] = []
    for (const [lo, hi] of [[0x00a0, 0x00ff], [0x2000, 0x2bff], [0x3000, 0x33ff], [0x1f000, 0x1faff]] as const) {
      for (let point = lo; point <= hi; point++) {
        const c = cp(point)
        // Bun counts a lone regional indicator with a selector as two cells,
        // which no real text contains; leave that quirk out.
        if (!pictograph.test(c) || regionalIndicator.test(c)) continue
        for (const s of [c, c + cp(VS15), c + cp(VS16)]) {
          checked++
          const expected = bun.stringWidth(s, { ambiguousIsNarrow: true })
          if (width(s) !== expected) mismatches.push(`U+${point.toString(16)}${s.length > c.length ? '+sel' : ''}`)
        }
      }
    }
    assertEqual(mismatches.length, 0, `${mismatches.slice(0, 10).join(' ')} (of ${checked} checked)`)
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
