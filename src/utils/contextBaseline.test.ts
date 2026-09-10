/**
 * Initial-context floor and measurement-notification tests.
 *
 * Run: bun run src/utils/contextBaseline.test.ts
 */

import {
  applyInitialContextFloor,
  type ContextUsage,
  getContextBaselineRevision,
  getContextBaselineTokens,
  setContextBaselineTokens,
  subscribeContextBaseline,
} from './contextBaseline.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const REPORTED: ContextUsage = {
  input_tokens: 1_200,
  output_tokens: 300,
  cache_creation_input_tokens: 4_000,
  cache_read_input_tokens: 58_000,
}

console.log('context baseline:')

test('leaves usage alone when nothing has been measured', () => {
  assert(
    applyInitialContextFloor(null, 0, () => 99) === null,
    'no measurement and no report stays unknown',
  )
  assert(
    applyInitialContextFloor(REPORTED, 0, () => 99) === REPORTED,
    'no measurement leaves a report untouched',
  )
})

test('never overrides what the provider reported', () => {
  let estimated = false
  const result = applyInitialContextFloor(REPORTED, 30_000, () => {
    estimated = true
    return 99
  })
  assert(result === REPORTED, 'a real report wins over any measurement')
  assert(!estimated, 'nothing is estimated once the provider has answered')
})

test('reports the initial context plus what was typed since, before the first response', () => {
  const result = applyInitialContextFloor(null, 30_000, () => 1_500)
  assert(result?.input_tokens === 31_500, `expected 31,500, got ${result?.input_tokens}`)
  assert(
    result?.cache_read_input_tokens === 0 &&
      result?.cache_creation_input_tokens === 0,
    'the floor claims no cache activity',
  )
})

test('treats a report of zero prompt tokens as no report', () => {
  const zero: ContextUsage = {
    input_tokens: 0,
    output_tokens: 12,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const result = applyInitialContextFloor(zero, 30_000, () => 0)
  assert(result?.input_tokens === 30_000, `expected the floor, got ${result?.input_tokens}`)
  assert(result?.output_tokens === 12, 'reported output is kept')
})

test('tells subscribers when a measurement lands, and stops once they leave', () => {
  let calls = 0
  const before = getContextBaselineRevision()
  const unsubscribe = subscribeContextBaseline(() => {
    calls += 1
  })
  setContextBaselineTokens('model-a', 41_000)
  assert(calls === 1, `expected one notification, got ${calls}`)
  assert(
    getContextBaselineRevision() === before + 1,
    'the revision moves with each measurement',
  )
  assert(getContextBaselineTokens('model-a') === 41_000, 'readable for its model')
  assert(getContextBaselineTokens('model-b') === 0, 'and only for its model')

  unsubscribe()
  setContextBaselineTokens('model-a', 42_000)
  assert(calls === 1, 'no notification after unsubscribing')
})

test('ignores measurements that are not a positive number', () => {
  let calls = 0
  const before = getContextBaselineRevision()
  const unsubscribe = subscribeContextBaseline(() => {
    calls += 1
  })
  setContextBaselineTokens('model-a', 0)
  setContextBaselineTokens('model-a', Number.NaN)
  unsubscribe()
  assert(calls === 0, 'nothing to announce')
  assert(getContextBaselineRevision() === before, 'the revision does not move')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
