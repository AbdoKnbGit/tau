/**
 * Message header (timestamp · model) formatting + visibility tests.
 *
 * Run: bun run src/utils/messageHeader.test.ts
 */

import {
  DEFAULT_MESSAGE_HEADER_MODE,
  formatMessageHeaderTimestamp,
  MESSAGE_HEADER_MODES,
  messageHeaderShowsDate,
  messageHeaderShowsModel,
  normalizeMessageHeaderMode,
  shouldShowMessageHeader,
} from './messageHeader.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error?.message ?? error}`)
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

console.log('\nmessageHeader')

test('default mode matches upstream (transcript only)', () => {
  assertEqual(DEFAULT_MESSAGE_HEADER_MODE, 'transcript', 'default')
  assertEqual(shouldShowMessageHeader('transcript', true), true, 'transcript')
  assertEqual(shouldShowMessageHeader('transcript', false), false, 'normal')
})

test('every always:* mode shows the header outside transcript mode', () => {
  for (const mode of MESSAGE_HEADER_MODES) {
    if (!mode.startsWith('always')) continue
    assertEqual(shouldShowMessageHeader(mode, false), true, `${mode} normal`)
    assertEqual(shouldShowMessageHeader(mode, true), true, `${mode} transcript`)
  }
})

test("'off' hides the header everywhere", () => {
  assertEqual(shouldShowMessageHeader('off', false), false, 'normal')
  assertEqual(shouldShowMessageHeader('off', true), false, 'transcript')
})

test('mode decides date and model independently', () => {
  assertEqual(messageHeaderShowsDate('always:date+time'), true, 'date on')
  assertEqual(messageHeaderShowsModel('always:date+time'), false, 'model off')
  assertEqual(messageHeaderShowsDate('always:time+model'), false, 'no date')
  assertEqual(messageHeaderShowsModel('always:time+model'), true, 'model on')
  assertEqual(messageHeaderShowsDate('always:time'), false, 'time only date')
  assertEqual(messageHeaderShowsModel('always:time'), false, 'time only model')
  assertEqual(
    messageHeaderShowsDate('always:date+time+model'),
    true,
    'both date',
  )
  assertEqual(
    messageHeaderShowsModel('always:date+time+model'),
    true,
    'both model',
  )
})

test("'transcript' keeps upstream's time + model", () => {
  assertEqual(messageHeaderShowsModel('transcript'), true, 'model')
  assertEqual(messageHeaderShowsDate('transcript'), false, 'no date')
})

test('unknown / missing modes fall back to the default', () => {
  assertEqual(normalizeMessageHeaderMode(undefined), 'transcript', 'undefined')
  assertEqual(normalizeMessageHeaderMode('nonsense'), 'transcript', 'garbage')
  assertEqual(normalizeMessageHeaderMode(true), 'transcript', 'boolean')
  for (const mode of MESSAGE_HEADER_MODES) {
    assertEqual(normalizeMessageHeaderMode(mode), mode, `passthrough ${mode}`)
  }
})

test('the one-build-old bare "always" keeps its meaning', () => {
  assertEqual(
    normalizeMessageHeaderMode('always'),
    'always:time+model',
    'legacy always',
  )
})

test('time-only format matches the transcript format', () => {
  const ts = new Date(2026, 7, 27, 10, 0, 0)
  assertEqual(formatMessageHeaderTimestamp(ts, false), '10:00 AM', 'morning')
  assertEqual(
    formatMessageHeaderTimestamp(new Date(2026, 7, 27, 22, 5, 0), false),
    '10:05 PM',
    'evening',
  )
})

test('date format is day-first with a short month', () => {
  const ts = new Date(2026, 7, 27, 10, 0, 0)
  assertEqual(
    formatMessageHeaderTimestamp(ts, true),
    '27 Aug 2026 10:00 AM',
    'date + time',
  )
})

test('accepts ISO strings and epoch millis', () => {
  const ts = new Date(2026, 7, 27, 10, 0, 0)
  assertEqual(
    formatMessageHeaderTimestamp(ts.toISOString(), true),
    '27 Aug 2026 10:00 AM',
    'iso string',
  )
  assertEqual(
    formatMessageHeaderTimestamp(ts.getTime(), true),
    '27 Aug 2026 10:00 AM',
    'epoch millis',
  )
})

test('malformed timestamps render as empty, never "Invalid Date"', () => {
  assertEqual(formatMessageHeaderTimestamp('not-a-date', true), '', 'garbage')
  assertEqual(formatMessageHeaderTimestamp('', false), '', 'empty string')
  assertEqual(formatMessageHeaderTimestamp(NaN, true), '', 'NaN')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
