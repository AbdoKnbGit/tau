/**
 * Degenerate output-loop detection checks.
 *
 * Run via: bun run src/utils/degenerateRepetition.test.ts
 */

import {
  createRepetitionGuard,
  detectDegenerateRepetition,
  formatRepetitionNotice,
  trimRepeatedTail,
} from './degenerateRepetition.js'

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

function assert(cond: unknown, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg)
}

function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `expected ${String(expected)}, got ${String(actual)}`)
  }
}

// --- fixtures ---------------------------------------------------------------

/** The loop that started this: verbatim unit from the reported session. */
const APOLOGY =
  "I'm here to help with any questions or tasks you have. If you need further assistance, please let me know. "

/** Varied prose of a given length — the main false-positive risk. */
function prose(sentences: number): string {
  const out: string[] = []
  for (let i = 0; i < sentences; i++) {
    out.push(
      `Step ${i}: the resolver walks ${i * 3} candidate paths before it settles on entry ${i % 7}.`,
    )
  }
  return out.join(' ')
}

// --- detection --------------------------------------------------------------

test('detects the reported apology loop', () => {
  const text = `Here is what I found.\n\n${APOLOGY.repeat(40)}`
  const detection = detectDegenerateRepetition(text)
  assert(detection, 'expected a detection')
  assertEqual(detection!.period, APOLOGY.length, 'period should be one apology')
  assertEqual(detection!.repeats, 40)
  assertEqual(detection!.repeatedChars, APOLOGY.length * 40)
})

test('reports the smallest period, not a multiple of it', () => {
  const detection = detectDegenerateRepetition('preamble. ' + 'ab'.repeat(2000))
  assert(detection, 'expected a detection')
  assertEqual(detection!.period, 2)
})

test('detects a loop whose tail is cut mid-unit', () => {
  const full = `${APOLOGY.repeat(40)}I'm here to help with any`
  const detection = detectDegenerateRepetition(full)
  assert(detection, 'phase-shifted tail should still be detected')
  assertEqual(detection!.period, APOLOGY.length)
})

test('detects a single character repeated', () => {
  const detection = detectDegenerateRepetition('output:\n' + '\n'.repeat(4000))
  assert(detection, 'expected a detection')
  assertEqual(detection!.period, 1)
})

test('ignores varied prose of the same length', () => {
  const text = prose(120)
  assert(text.length > 4000, 'fixture should be long enough to be eligible')
  assertEqual(detectDegenerateRepetition(text), null)
})

test('ignores a numbered list whose items only look repetitive', () => {
  const items: string[] = []
  for (let i = 0; i < 200; i++) {
    items.push(`${i}. run the migration and verify the checksum matches.`)
  }
  const text = items.join('\n')
  assert(text.length > 4000, 'fixture should be long enough to be eligible')
  assertEqual(detectDegenerateRepetition(text), null)
})

test('ignores repetition that is not at the tail', () => {
  const text = `${APOLOGY.repeat(40)}\n\nAnyway, ${prose(60)}`
  assertEqual(detectDegenerateRepetition(text), null)
})

test('ignores text shorter than the character threshold', () => {
  assertEqual(detectDegenerateRepetition(APOLOGY.repeat(5)), null)
})

test('ignores too few repeats even when the run is long', () => {
  const paragraph = 'x'.repeat(600) + '.\n'
  // 3 copies is 1806 chars — over the char threshold, under the repeat one.
  assertEqual(detectDegenerateRepetition(paragraph.repeat(3)), null)
})

test('honors custom thresholds', () => {
  const text = APOLOGY.repeat(8)
  assertEqual(detectDegenerateRepetition(text), null, 'default thresholds')
  const detection = detectDegenerateRepetition(text, {
    minRepeats: 4,
    minRepeatedChars: 400,
  })
  assert(detection, 'lowered thresholds should detect')
  assertEqual(detection!.repeats, 8)
})

test('a minRepeats below 2 never matches', () => {
  assertEqual(
    detectDegenerateRepetition(APOLOGY.repeat(40), { minRepeats: 1 }),
    null,
  )
})

test('counts a run that started long before the scan window', () => {
  // The reported session ran to 142KB, ~1300 copies — far past any window
  // worth searching. Counting only inside the window would place the start of
  // the run at the window edge and leave every earlier copy in place.
  const prefix = 'Here is what I found.\n\n'
  const text = `${prefix}${APOLOGY.repeat(1400)}`
  const detection = detectDegenerateRepetition(text)
  assert(detection, 'expected a detection')
  assertEqual(detection!.period, APOLOGY.length)
  assertEqual(detection!.repeats, 1400, 'whole run counted, not one window of it')
  assertEqual(trimRepeatedTail(text, detection!), `${prefix}${APOLOGY}`)
})

// --- trimming ---------------------------------------------------------------

test('trim keeps the prefix and exactly one copy', () => {
  const prefix = 'Here is what I found.\n\n'
  const text = `${prefix}${APOLOGY.repeat(40)}`
  const detection = detectDegenerateRepetition(text)!
  assertEqual(trimRepeatedTail(text, detection), `${prefix}${APOLOGY}`)
})

test('trim is stable when re-applied', () => {
  const text = `Findings:\n\n${APOLOGY.repeat(40)}`
  const detection = detectDegenerateRepetition(text)!
  const once = trimRepeatedTail(text, detection)
  assertEqual(trimRepeatedTail(once, detection), once)
})

test('trim of a phase-shifted tail still ends on a full unit', () => {
  const text = `${APOLOGY.repeat(40)}I'm here to help with any`
  const detection = detectDegenerateRepetition(text)!
  const trimmed = trimRepeatedTail(text, detection)
  assertEqual(trimmed.length, detection.keepChars)
  assert(trimmed.length < text.length, 'something should have been removed')
  assert(APOLOGY.repeat(2).includes(trimmed), 'kept text is one unit of the loop')
})

test('notice names the shape of the loop', () => {
  const detection = detectDegenerateRepetition(APOLOGY.repeat(40))!
  const notice = formatRepetitionNotice(detection)
  assert(notice.includes(String(detection.repeats)), 'repeat count in notice')
  assert(notice.includes(String(detection.period)), 'period in notice')
})

// --- guard ------------------------------------------------------------------

test('guard stays quiet below the character threshold', () => {
  const guard = createRepetitionGuard()
  assertEqual(guard.check(0, APOLOGY.repeat(5)), null)
})

test('guard fires once the run is long enough', () => {
  const guard = createRepetitionGuard()
  let fired = false
  let text = ''
  for (let i = 0; i < 60 && !fired; i++) {
    text += APOLOGY
    fired = guard.check(0, text) !== null
  }
  assert(fired, 'guard should fire while the loop is still streaming')
  assert(text.length < APOLOGY.length * 30, 'and should fire early, not at the end')
})

test('guard throttles rescans within an interval', () => {
  const guard = createRepetitionGuard()
  const text = APOLOGY.repeat(40)
  assert(guard.check(0, text), 'first check runs')
  assertEqual(guard.check(0, `${text}x`), null, 'one extra char must not rescan')
})

test('guard tracks blocks independently', () => {
  const guard = createRepetitionGuard()
  const looping = APOLOGY.repeat(40)
  assert(guard.check(0, looping), 'block 0 loops')
  assertEqual(guard.check(1, prose(120)), null, 'block 1 is clean')
  assert(guard.check(1, looping), 'block 1 is checked on its own budget')
})

test('streaming: a loop is cut early and the block is left clean', () => {
  // Mirrors what claude.ts does on each text_delta: accumulate, check, then
  // trim and annotate the block when the guard fires. The fixture is the size
  // the reported session actually reached before the model ran out of tokens.
  const prefix = 'Here is what I found.\n\n'
  const full = `${prefix}${APOLOGY.repeat(1306)}`
  assert(full.length > 139_000, 'fixture is the size of the reported runaway')

  const guard = createRepetitionGuard()
  let accumulated = ''
  let detection = null
  for (let i = 0; i < full.length && !detection; i += 24) {
    accumulated += full.slice(i, i + 24)
    detection = guard.check(0, accumulated)
  }

  assert(detection, 'guard should fire while the stream is still open')
  assert(
    accumulated.length < 2500,
    `should stop within a couple KB, read ${accumulated.length} chars`,
  )
  const block =
    trimRepeatedTail(accumulated, detection!) + formatRepetitionNotice(detection!)
  assert(block.startsWith(prefix), 'the real answer survives')
  assert(
    block.length < prefix.length + detection!.period + 200,
    `the run is gone: ${block.length} chars kept out of ${full.length}`,
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
