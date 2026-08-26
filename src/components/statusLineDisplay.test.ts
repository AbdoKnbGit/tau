/**
 * Status row resolution tests.
 *
 * Run: bun run src/components/statusLineDisplay.test.ts
 */

import {
  resolveStatusLineDisplay,
  type StatusLineDisplayInput,
} from './statusLineDisplay.js'

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

function resolve(overrides: Partial<StatusLineDisplayInput> = {}) {
  return resolveStatusLineDisplay({
    customCommandConfigured: false,
    customCommandWillRun: false,
    sessionStatusBar: undefined,
    suppressAll: false,
    ...overrides,
  })
}

function assertRows(
  actual: { custom: boolean; builtin: boolean },
  custom: boolean,
  builtin: boolean,
  label: string,
): void {
  assert(
    actual.custom === custom && actual.builtin === builtin,
    `${label}: expected custom=${custom} builtin=${builtin}, got custom=${actual.custom} builtin=${actual.builtin}`,
  )
}

console.log('status line display:')

test('shows the built-in bar when nothing is configured', () => {
  assertRows(resolve(), false, true, 'default session')
})

test('a working custom command replaces the built-in bar', () => {
  assertRows(
    resolve({ customCommandConfigured: true, customCommandWillRun: true }),
    true,
    false,
    'custom statusLine',
  )
})

test('a configured but blocked command keeps the built-in bar', () => {
  // Untrusted workspace or disableAllHooks: the command produces nothing, so
  // hiding the bar too would leave the row empty with no explanation.
  assertRows(
    resolve({ customCommandConfigured: true, customCommandWillRun: false }),
    true,
    true,
    'blocked statusLine',
  )
})

test('sessionStatusBar false turns the built-in bar off', () => {
  assertRows(resolve({ sessionStatusBar: false }), false, false, 'bar off')
})

test('sessionStatusBar false leaves a custom command alone', () => {
  assertRows(
    resolve({
      customCommandConfigured: true,
      customCommandWillRun: true,
      sessionStatusBar: false,
    }),
    true,
    false,
    'bar off with custom',
  )
})

test('sessionStatusBar true keeps the bar beside a custom command', () => {
  assertRows(
    resolve({
      customCommandConfigured: true,
      customCommandWillRun: true,
      sessionStatusBar: true,
    }),
    true,
    true,
    'both rows',
  )
})

test('sessionStatusBar true forces the bar on with no custom command', () => {
  assertRows(resolve({ sessionStatusBar: true }), false, true, 'bar forced on')
})

test('assistant mode hides both rows whatever is configured', () => {
  for (const sessionStatusBar of [undefined, true, false] as const) {
    assertRows(
      resolve({
        customCommandConfigured: true,
        customCommandWillRun: true,
        sessionStatusBar,
        suppressAll: true,
      }),
      false,
      false,
      `assistant mode (sessionStatusBar=${String(sessionStatusBar)})`,
    )
  }
})

test('the two rows never both vanish unless asked', () => {
  // Guards the regression the gate could introduce: a user who configured a
  // custom line must never end up with no status row by accident.
  for (const configured of [true, false]) {
    for (const willRun of [true, false]) {
      const rows = resolve({
        customCommandConfigured: configured,
        customCommandWillRun: configured && willRun,
      })
      assert(
        rows.custom || rows.builtin,
        `configured=${configured} willRun=${willRun} produced an empty status row`,
      )
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
