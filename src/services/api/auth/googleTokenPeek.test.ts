/**
 * Read-only Google OAuth token inspection tests.
 *
 * Run: bun run src/services/api/auth/googleTokenPeek.test.ts
 */

import {
  GOOGLE_TOKEN_MARGIN_MS,
  readStoredGoogleToken,
} from './googleTokenPeek.js'

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
const blob = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    accessToken: 'token-value',
    refreshToken: 'refresh-value',
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  })

console.log('google token peek:')

test('reads a token that is still good', () => {
  const result = readStoredGoogleToken(blob(), NOW)
  assert(result.kind === 'ready', `expected ready, got ${result.kind}`)
  assert(result.accessToken === 'token-value', 'the token should come through')
})

test('reports nothing stored as none', () => {
  for (const raw of [null, undefined, '']) {
    assert(
      readStoredGoogleToken(raw, NOW).kind === 'none',
      `${JSON.stringify(raw)} means no credential`,
    )
  }
})

test('reports a spent token as stale, not as none', () => {
  // This distinction is the whole point: a connected account whose token has
  // aged must not be reported as "no account", which settles as a false n/a.
  const spent = blob({ expiresAt: NOW + GOOGLE_TOKEN_MARGIN_MS - 1 })
  assert(readStoredGoogleToken(spent, NOW).kind === 'stale', 'inside the margin')

  const expired = blob({ expiresAt: NOW - 60_000 })
  assert(readStoredGoogleToken(expired, NOW).kind === 'stale', 'already expired')
})

test('treats an unreadable blob as stale rather than absent', () => {
  for (const raw of ['not json', '{', 'null', '{}']) {
    assert(
      readStoredGoogleToken(raw, NOW).kind === 'stale',
      `${raw} is unreadable, not proof of absence`,
    )
  }
})

test('rejects a blob missing the fields it needs', () => {
  assert(
    readStoredGoogleToken(blob({ accessToken: '' }), NOW).kind === 'stale',
    'an empty token is unusable',
  )
  assert(
    readStoredGoogleToken(blob({ accessToken: 42 }), NOW).kind === 'stale',
    'a non-string token is unusable',
  )
  assert(
    readStoredGoogleToken(blob({ expiresAt: 'soon' }), NOW).kind === 'stale',
    'a non-numeric expiry cannot be trusted as valid',
  )
  assert(
    readStoredGoogleToken(blob({ expiresAt: undefined }), NOW).kind === 'stale',
    'a missing expiry cannot be trusted as valid',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
