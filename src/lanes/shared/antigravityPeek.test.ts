/**
 * Read-only Antigravity account access tests.
 *
 * The property under test is that a status readout can obtain a token without
 * refreshing or persisting anything - see peekAntigravityAccount.
 *
 * Run: bun run src/lanes/shared/antigravityPeek.test.ts
 */

import {
  ANTIGRAVITY_TOKEN_MARGIN_MS,
  peekAntigravityAccount,
  selectActiveAntigravityAccount,
  type AntigravityAccount,
  type AntigravityStore,
} from './antigravity_auth.js'

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

const NOW = 1_700_000_000_000

function account(overrides: Partial<AntigravityAccount> = {}): AntigravityAccount {
  return {
    email: 'a@example.com',
    refreshToken: 'refresh',
    accessToken: 'access',
    expires: NOW + 60 * 60_000,
    projectId: 'project-1',
    addedAt: 0,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    ...overrides,
  }
}

function store(overrides: Partial<AntigravityStore> = {}): AntigravityStore {
  return {
    version: 1,
    accounts: [],
    activeIndex: 0,
    activeIndexByFamily: {},
    ...overrides,
  }
}

console.log('antigravity peek:')

test('reports no account when the store is empty', () => {
  assert(
    peekAntigravityAccount(NOW, store()).kind === 'none',
    'an empty store has no account to read',
  )
})

test('reports a usable token as ready', () => {
  const result = peekAntigravityAccount(NOW, store({ accounts: [account()] }))
  assert(result.kind === 'ready', 'a token an hour from expiry is usable')
  assert(result.account.projectId === 'project-1', 'the project comes with it')
})

test('reports a spent token as stale, not as missing', () => {
  // Inside the refresh margin: the request path will renew this, the reader
  // must not. Conflating it with "none" would report a configured account as
  // unconfigured, which the bar renders as a settled n/a.
  const nearlyExpired = account({ expires: NOW + ANTIGRAVITY_TOKEN_MARGIN_MS - 1 })
  const result = peekAntigravityAccount(NOW, store({ accounts: [nearlyExpired] }))
  assert(result.kind === 'stale', `expected stale, got ${result.kind}`)
})

test('treats an already-expired token as stale', () => {
  const expired = account({ expires: NOW - 60_000 })
  assert(
    peekAntigravityAccount(NOW, store({ accounts: [expired] })).kind === 'stale',
    'an expired token is recoverable, not absent',
  )
})

test('honours the per-family active index the refresh path uses', () => {
  const accounts = [
    account({ email: 'first@example.com' }),
    account({ email: 'flash@example.com' }),
  ]
  const selected = selectActiveAntigravityAccount(
    store({ accounts, activeIndex: 0, activeIndexByFamily: { 'gemini-flash': 1 } }),
  )
  assert(
    selected?.email === 'flash@example.com',
    `the flash family index should win, got ${selected?.email}`,
  )
})

test('falls back to the first enabled account when the index is bogus', () => {
  const accounts = [
    account({ email: 'disabled@example.com', enabled: false }),
    account({ email: 'enabled@example.com' }),
  ]
  const selected = selectActiveAntigravityAccount(
    store({ accounts, activeIndex: 99 }),
  )
  assert(
    selected?.email === 'enabled@example.com',
    `an out-of-range index should fall back, got ${selected?.email}`,
  )
})

test('returns null rather than throwing on an index with no enabled account', () => {
  const accounts = [account({ enabled: false })]
  assert(
    selectActiveAntigravityAccount(store({ accounts, activeIndex: 99 })) === null,
    'no selectable account should be null, not a crash',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
