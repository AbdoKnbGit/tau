import assert from 'node:assert/strict'
import test from 'node:test'

import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// Phase 6: MCP_TOOL_TIMEOUT must name a duration a timer can actually wait.
//
// `parseInt(x, 10) || DEFAULT` accepted values that make every call fail
// instantly instead of waiting longer: Node clamps a negative delay and
// anything above 2^31-1 to 1ms. `parseInt` also stops at the first
// non-numeric character, so `1e9` became `1` — a one-millisecond timeout for
// someone asking for a long one.

const runtime = await loadMcpRuntime()

const DEFAULT_MS = 100_000_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Reads the timeout with MCP_TOOL_TIMEOUT set to `value`. */
function withEnv(value) {
  const previous = process.env.MCP_TOOL_TIMEOUT
  if (value === undefined) delete process.env.MCP_TOOL_TIMEOUT
  else process.env.MCP_TOOL_TIMEOUT = value
  try {
    return runtime.getMcpToolTimeoutMs()
  } finally {
    if (previous === undefined) delete process.env.MCP_TOOL_TIMEOUT
    else process.env.MCP_TOOL_TIMEOUT = previous
  }
}

test('a plain millisecond value is used as written', () => {
  assert.equal(withEnv('5000'), 5000)
  assert.equal(withEnv('  60000  '), 60000, 'surrounding whitespace is fine')
})

test('exponent notation is understood rather than truncated', () => {
  // parseInt stopped at the `e` and returned 1, so a request for ~11 days
  // became a one-millisecond timeout.
  assert.equal(withEnv('1e6'), 1_000_000)
})

test('a negative value is refused, not passed to the timer', () => {
  // Node clamps a negative delay to 1ms, so this used to make every MCP call
  // fail immediately — the opposite of what the setting asks for.
  assert.equal(withEnv('-1'), DEFAULT_MS)
  assert.equal(withEnv('-60000'), DEFAULT_MS)
})

test('a value too large for a timer is refused', () => {
  // Above 2^31-1 Node clamps to 1ms and warns. Falling back to the default is
  // the only reading that does not contradict the user's intent.
  assert.equal(withEnv(String(MAX_TIMER_DELAY_MS + 1)), DEFAULT_MS)
  assert.equal(withEnv('999999999999999999999'), DEFAULT_MS)
  assert.equal(
    withEnv(String(MAX_TIMER_DELAY_MS)),
    MAX_TIMER_DELAY_MS,
    'the largest representable delay is still usable',
  )
})

test('zero, unset and non-numeric values fall back to the default', () => {
  assert.equal(withEnv(undefined), DEFAULT_MS)
  assert.equal(withEnv(''), DEFAULT_MS)
  assert.equal(withEnv('   '), DEFAULT_MS)
  assert.equal(withEnv('0'), DEFAULT_MS)
  assert.equal(withEnv('abc'), DEFAULT_MS)
  assert.equal(withEnv('Infinity'), DEFAULT_MS)
  assert.equal(withEnv('NaN'), DEFAULT_MS)
})

test('trailing garbage is refused rather than silently truncated', () => {
  // parseInt read '60000abc' as 60000. Accepting that hides a typo in a
  // setting whose whole job is to bound a hang.
  assert.equal(withEnv('60000abc'), DEFAULT_MS)
  assert.equal(withEnv('60_000'), DEFAULT_MS)
})

test('a fractional value is floored to whole milliseconds', () => {
  assert.equal(withEnv('1500.75'), 1500)
})

test('every accepted value is a delay a timer can actually wait', () => {
  // The invariant behind the rest: whatever comes back must be finite,
  // positive and representable, so it can never mean "fire immediately".
  for (const candidate of [
    undefined, '', '0', '-1', 'abc', '5000', '1e6', '1e99',
    '999999999999999999999', '  60000  ', '60000abc', 'Infinity', 'NaN',
    '-0', '1500.75', String(MAX_TIMER_DELAY_MS), String(MAX_TIMER_DELAY_MS + 1),
  ]) {
    const value = withEnv(candidate)
    assert.ok(
      Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS,
      `${JSON.stringify(candidate)} produced an unusable delay: ${value}`,
    )
    assert.ok(Number.isInteger(value), `${JSON.stringify(candidate)} produced ${value}`)
  }
})
