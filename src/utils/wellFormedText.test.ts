/**
 * Run: bun run src/utils/wellFormedText.test.ts
 */

import {
  isWellFormedText,
  surrogateSafeEnd,
  surrogateSafeStart,
  toWellFormedText,
} from './wellFormedText.js'

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

const EMOJI = String.fromCodePoint(0x1f600)
const HIGH = String.fromCharCode(0xd83d)
const LOW = String.fromCharCode(0xde00)
const REPLACEMENT = String.fromCharCode(0xfffd)

function withoutNative(fn: () => void): void {
  const proto = String.prototype as unknown as Record<string, unknown>
  const saved = {
    isWellFormed: proto.isWellFormed,
    toWellFormed: proto.toWellFormed,
  }
  delete proto.isWellFormed
  delete proto.toWellFormed
  try {
    fn()
  } finally {
    if (saved.isWellFormed) proto.isWellFormed = saved.isWellFormed
    if (saved.toWellFormed) proto.toWellFormed = saved.toWellFormed
  }
}

console.log('well-formed text:')

function checkBothPaths(name: string, fn: () => void): void {
  test(`${name} (native)`, fn)
  test(`${name} (fallback)`, () => withoutNative(fn))
}

checkBothPaths('plain and paired text is well-formed', () => {
  assert(isWellFormedText('plain ascii'), 'ascii')
  assert(isWellFormedText(`a ${EMOJI} b`), 'pair')
  assert(isWellFormedText(''), 'empty')
})

checkBothPaths('lone surrogates are detected', () => {
  assert(!isWellFormedText(`end ${HIGH}`), 'trailing high')
  assert(!isWellFormedText(`${LOW} start`), 'leading low')
  assert(!isWellFormedText(`a${HIGH}b`), 'high before ascii')
  assert(!isWellFormedText(`${LOW}${HIGH}`), 'reversed pair')
})

checkBothPaths('lone surrogates become U+FFFD and pairs survive', () => {
  const fixed = toWellFormedText(`x${HIGH}y${EMOJI}${LOW}z`)
  assert(fixed === `x${REPLACEMENT}y${EMOJI}${REPLACEMENT}z`, JSON.stringify(fixed))
  assert(isWellFormedText(fixed), 'result must be well-formed')
})

checkBothPaths('well-formed text is returned as-is', () => {
  const text = `keep ${EMOJI} me`
  assert(toWellFormedText(text) === text, 'same content')
})

test('cut helpers never split a pair', () => {
  const text = `ab${EMOJI}cd`
  // The emoji occupies indexes 2 and 3.
  assert(surrogateSafeEnd(text, 3) === 2, 'end inside pair steps back')
  assert(surrogateSafeEnd(text, 4) === 4, 'end after pair stays')
  assert(surrogateSafeEnd(text, 2) === 2, 'end before pair stays')
  assert(surrogateSafeStart(text, 3) === 4, 'start inside pair steps forward')
  assert(surrogateSafeStart(text, 2) === 2, 'start at pair stays')
  assert(surrogateSafeEnd(text, 99) === text.length, 'end clamps')
  assert(surrogateSafeStart(text, -5) === 0, 'start clamps')
  for (let i = 0; i <= text.length; i++) {
    assert(isWellFormedText(text.slice(0, surrogateSafeEnd(text, i))), `prefix ${i}`)
    assert(isWellFormedText(text.slice(surrogateSafeStart(text, i))), `suffix ${i}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
