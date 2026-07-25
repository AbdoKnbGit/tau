/**
 * Goal argument parsing and state transition checks, focused on the --judge
 * mode added on top of the check/self-report modes.
 *
 * Run via: bun run src/services/goal/state.test.ts
 */

import {
  createGoalState,
  parseGoalArgs,
  recordFailedCheck,
  recordRejectedClaim,
  resumeGoal,
  pauseGoal,
} from './state.js'
import {
  buildGoalContinuationInstruction,
  buildGoalStartInstruction,
} from './instructions.js'

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

// --- parsing ----------------------------------------------------------------

test('plain description still parses to self-report mode', () => {
  const parsed = parseGoalArgs('make the tests pass')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.description, 'make the tests pass')
  assertEqual(parsed.checkCommand, undefined)
  assertEqual(parsed.judge, undefined)
})

test('--check still parses unchanged', () => {
  const parsed = parseGoalArgs('green build --check npm test')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.description, 'green build')
  assertEqual(parsed.checkCommand, 'npm test')
})

test('trailing --judge sets the flag and leaves the description clean', () => {
  const parsed = parseGoalArgs('rewrite the README --judge')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.description, 'rewrite the README')
  assertEqual(parsed.judge, true)
})

test('leading --judge works too', () => {
  const parsed = parseGoalArgs('--judge rewrite the README')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.description, 'rewrite the README')
  assertEqual(parsed.judge, true)
})

test('mid-string --judge is lifted out without leaving a double space', () => {
  const parsed = parseGoalArgs('rewrite the --judge README')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.description, 'rewrite the README')
  assertEqual(parsed.judge, true)
})

test('a word merely containing "judge" is not the flag', () => {
  const parsed = parseGoalArgs('improve the judgement logic')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.description, 'improve the judgement logic')
  assertEqual(parsed.judge, undefined)
})

test('--judgement is not --judge', () => {
  const parsed = parseGoalArgs('ship it --judgement')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.judge, undefined)
  assert(parsed.description.includes('--judgement'), parsed.description)
})

test('--judge inside a check command belongs to the command', () => {
  const parsed = parseGoalArgs('lint clean --check npm run lint -- --judge')
  assert(parsed.ok)
  if (!parsed.ok) return
  assertEqual(parsed.checkCommand, 'npm run lint -- --judge')
  assertEqual(parsed.judge, undefined)
})

test('combining --judge and --check is refused with a reason', () => {
  const parsed = parseGoalArgs('green build --judge --check npm test')
  assertEqual(parsed.ok, false)
  if (parsed.ok) return
  assert(parsed.error.includes('cannot be combined'), parsed.error)
})

test('--judge alone is not a description', () => {
  const parsed = parseGoalArgs('--judge')
  assertEqual(parsed.ok, false)
})

test('a bare --check is still a typo, not self-report', () => {
  const parsed = parseGoalArgs('do the thing --check ')
  assertEqual(parsed.ok, false)
})

// --- state ------------------------------------------------------------------

test('judge flag lands on the goal state', () => {
  const goal = createGoalState('do it', undefined, true)
  assertEqual(goal.judge, true)
})

test('a check command overrides the judge flag', () => {
  // Both set would mean paying for a verdict that cannot change the outcome.
  const goal = createGoalState('do it', 'npm test', true)
  assertEqual(goal.judge, undefined)
  assertEqual(goal.checkCommand, 'npm test')
})

test('a rejected claim spends a turn and carries the feedback', () => {
  const goal = createGoalState('do it', undefined, true)
  const next = recordRejectedClaim(goal, 'uuid-1', 'the README has no install section')
  assertEqual(next.turnCount, 1)
  assertEqual(next.lastCheckedUuid, 'uuid-1')
  assertEqual(next.lastJudgeFeedback, 'the README has no install section')
  assertEqual(next.status, 'active')
})

test('a plain failed turn clears stale judge feedback', () => {
  const rejected = recordRejectedClaim(
    createGoalState('do it', undefined, true),
    'uuid-1',
    'not done',
  )
  const next = recordFailedCheck(rejected, 'uuid-2', '')
  assertEqual(
    next.lastJudgeFeedback,
    undefined,
    'feedback from an earlier claim must not leak into a later nudge',
  )
})

test('resume clears judge feedback along with the turn budget', () => {
  const rejected = recordRejectedClaim(
    createGoalState('do it', undefined, true),
    'uuid-1',
    'not done',
  )
  const resumed = resumeGoal(pauseGoal(rejected, 'stopped'))
  assertEqual(resumed.turnCount, 0)
  assertEqual(resumed.lastJudgeFeedback, undefined)
})

// --- instructions -----------------------------------------------------------

test('start instruction warns that claims are verified', () => {
  const text = buildGoalStartInstruction(createGoalState('do it', undefined, true))
  assert(text.includes('verifier'), text)
})

test('start instruction stays quiet when there is no judge', () => {
  const text = buildGoalStartInstruction(createGoalState('do it', undefined, false))
  assert(!text.includes('verifier'), text)
})

test('continuation nudge surfaces the rejection reason', () => {
  const rejected = recordRejectedClaim(
    createGoalState('do it', undefined, true),
    'uuid-1',
    'tests still fail on Windows',
  )
  const text = buildGoalContinuationInstruction(rejected)
  assert(text.includes('rejected'), text)
  assert(text.includes('tests still fail on Windows'), text)
})

test('continuation nudge is unchanged without a rejection', () => {
  const goal = recordFailedCheck(
    createGoalState('do it', undefined, true),
    'uuid-1',
    '',
  )
  const text = buildGoalContinuationInstruction(goal)
  assert(!text.includes('rejected'), text)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
