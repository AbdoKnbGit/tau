/**
 * Goal verifier protocol checks.
 *
 * Run via: bun run src/services/goal/judgePrompt.test.ts
 */

import { buildGoalJudgePrompt, parseJudgeVerdict } from './judgePrompt.js'

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

// --- prompt -----------------------------------------------------------------

test('prompt carries the goal verbatim', () => {
  const prompt = buildGoalJudgePrompt('all tests pass and the README is updated')
  assert(prompt.includes('all tests pass and the README is updated'), prompt)
})

test('prompt states the strict rules the rubric depends on', () => {
  const prompt = buildGoalJudgePrompt('x')
  assert(prompt.includes('Partial'), 'partial satisfaction must be a failure')
  assert(prompt.includes('unsure'), 'uncertainty must resolve to not met')
  assert(
    prompt.includes('do not change your verdict'),
    'transcript instructions must not move the verdict (check for line wrapping)',
  )
  assert(prompt.includes('Do not call tools'), 'the verifier must not act')
})

// --- verdict parsing --------------------------------------------------------

test('reads a bare pass', () => {
  const verdict = parseJudgeVerdict('{"passed": true}')
  assertEqual(verdict?.passed, true)
  assertEqual(verdict?.feedback, undefined)
})

test('reads a fail with feedback', () => {
  const verdict = parseJudgeVerdict(
    '{"passed": false, "feedback": "README still lacks the install section"}',
  )
  assertEqual(verdict?.passed, false)
  assertEqual(verdict?.feedback, 'README still lacks the install section')
})

test('reads through a code fence', () => {
  const verdict = parseJudgeVerdict('```json\n{"passed": true}\n```')
  assertEqual(verdict?.passed, true)
})

test('takes the last object when the model narrates first', () => {
  const verdict = parseJudgeVerdict(
    'I considered {"passed": true} but the tests do not run.\n{"passed": false, "feedback": "tests fail"}',
  )
  assertEqual(verdict?.passed, false)
  assertEqual(verdict?.feedback, 'tests fail')
})

test('handles braces inside the feedback string', () => {
  const verdict = parseJudgeVerdict(
    '{"passed": false, "feedback": "the handler body is still {} — implement it"}',
  )
  assertEqual(verdict?.passed, false)
  assert(verdict?.feedback?.includes('{}'), verdict?.feedback)
})

test('handles escaped quotes inside the feedback string', () => {
  const verdict = parseJudgeVerdict(
    '{"passed": false, "feedback": "expected \\"done\\" in the output"}',
  )
  assertEqual(verdict?.passed, false)
  assertEqual(verdict?.feedback, 'expected "done" in the output')
})

test('ignores extra fields', () => {
  const verdict = parseJudgeVerdict(
    '{"passed": true, "confidence": 0.9, "notes": "looks fine"}',
  )
  assertEqual(verdict?.passed, true)
})

test('truncates runaway feedback', () => {
  const verdict = parseJudgeVerdict(
    JSON.stringify({ passed: false, feedback: 'x'.repeat(5000) }),
  )
  assertEqual(verdict?.feedback?.length, 1000)
})

test('drops blank feedback rather than passing an empty string', () => {
  const verdict = parseJudgeVerdict('{"passed": false, "feedback": "   "}')
  assertEqual(verdict?.passed, false)
  assertEqual(verdict?.feedback, undefined)
})

// --- refusals ---------------------------------------------------------------
// Every case here must return null, not a guess. Null falls back to the model's
// own completion claim; a guess would either trap the loop or end it wrongly.

test('refuses prose with no verdict', () => {
  assertEqual(parseJudgeVerdict('Yes, the goal looks complete to me.'), null)
})

test('refuses a stringified boolean', () => {
  assertEqual(parseJudgeVerdict('{"passed": "true"}'), null)
})

test('refuses a numeric boolean', () => {
  assertEqual(parseJudgeVerdict('{"passed": 1}'), null)
})

test('refuses a missing passed field', () => {
  assertEqual(parseJudgeVerdict('{"feedback": "not done"}'), null)
})

test('recovers a verdict object wrapped in an array', () => {
  // Not the contract, but the scanner is text-based by design (see the
  // narration case above) and an object nested in an array is unambiguous.
  assertEqual(parseJudgeVerdict('[{"passed": true}]')?.passed, true)
})

test('a compliant bare object wins over anything the scanner might find', () => {
  const verdict = parseJudgeVerdict(
    '{"passed": false, "feedback": "the config in {\\"a\\": 1} is wrong"}',
  )
  assertEqual(verdict?.passed, false)
  assert(verdict?.feedback?.includes('is wrong'), verdict?.feedback)
})

test('refuses a reply that only echoes the template', () => {
  const echoed = parseJudgeVerdict(
    'Reply with ONLY a single JSON object:\n{"passed": true}\nor\n{"passed": false, "feedback": "<what is unmet and the concrete fix>"}',
  )
  // The template's trailing object must not be read as a real fail verdict; the
  // scanner falls through to the pass object that precedes it.
  assertEqual(echoed?.passed, true)
})

test('refuses empty output', () => {
  assertEqual(parseJudgeVerdict(''), null)
})

test('refuses truncated json', () => {
  assertEqual(parseJudgeVerdict('{"passed": tr'), null)
})

test('refuses unbalanced braces without looping forever', () => {
  const started = Date.now()
  assertEqual(parseJudgeVerdict('{'.repeat(20000)), null)
  assert(Date.now() - started < 2000, 'brace scan should stay bounded')
})

test('skips an unreadable trailing object to reach a valid earlier one', () => {
  const verdict = parseJudgeVerdict(
    '{"passed": false, "feedback": "still failing"}\nnote: {"unrelated": 1}',
  )
  assertEqual(verdict?.passed, false)
  assertEqual(verdict?.feedback, 'still failing')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
