/**
 * Read-before-Edit refusal counter unit tests.
 *
 * Run: bun run src/tools/FileEditTool/readFirstGuard.test.ts
 */

import {
  noteFileRead,
  recordUnreadEditRefusal,
  resetReadFirstGuard,
} from './readFirstGuard.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  resetReadFirstGuard()
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

const FILE = '/repo/src/app.ts'
const OTHER = '/repo/src/other.ts'

console.log('read-first refusal counter:')

test('counts the first blind edit as attempt 1', () => {
  assert(recordUnreadEditRefusal(FILE) === 1, 'first refusal is attempt 1')
})

test('keeps counting repeated blind edits; there is no bypass attempt', () => {
  const counts: number[] = []
  for (let i = 0; i < 25; i++) counts.push(recordUnreadEditRefusal(FILE))
  assert(
    counts.every((count, i) => count === i + 1),
    `expected 1..25, got ${counts.join(',')}`,
  )
})

test('reading the file resets the count', () => {
  recordUnreadEditRefusal(FILE)
  recordUnreadEditRefusal(FILE)
  noteFileRead(FILE)
  assert(recordUnreadEditRefusal(FILE) === 1, 'after a read, counting restarts')
})

test('counters are per-file, not global', () => {
  recordUnreadEditRefusal(FILE)
  recordUnreadEditRefusal(FILE)
  assert(recordUnreadEditRefusal(OTHER) === 1, 'a different file counts separately')
})

test('stale counters age out via TTL', () => {
  const t0 = 1_000_000
  recordUnreadEditRefusal(FILE, t0)
  recordUnreadEditRefusal(FILE, t0)
  // Six minutes later (> 5 min TTL) the prior count is purged.
  const t1 = t0 + 6 * 60_000
  assert(
    recordUnreadEditRefusal(FILE, t1) === 1,
    'after TTL the count restarts at 1',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
