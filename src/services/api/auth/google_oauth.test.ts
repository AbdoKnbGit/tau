/**
 * Antigravity OAuth flow regression tests.
 *
 * Run: bun run src/services/api/auth/google_oauth.test.ts
 */

import {
  ANTIGRAVITY_REDIRECT_URI,
  completeAntigravityOAuth,
  initiateAntigravityOAuth,
  mergeGoogleOAuthTokens,
  parseAntigravityOAuthCallback,
} from './google_oauth.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, hint: string): asserts condition {
  if (!condition) throw new Error(hint)
}

async function main(): Promise<void> {
  console.log('antigravity oauth:')

  await test('uses the Antigravity HTTPS callback and complete scope set', () => {
    const handles = initiateAntigravityOAuth()
    const url = new URL(handles.authUrl)
    const scopes = new Set((url.searchParams.get('scope') ?? '').split(' '))

    assert(url.searchParams.get('redirect_uri') === ANTIGRAVITY_REDIRECT_URI, 'wrong redirect URI')
    assert(
      url.searchParams.get('client_id') ===
        '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
      'wrong Antigravity client ID',
    )
    assert(scopes.has('openid'), 'openid scope missing')
    assert(scopes.has('https://www.googleapis.com/auth/cclog'), 'cclog scope missing')
    assert(
      scopes.has('https://www.googleapis.com/auth/experimentsandconfigs'),
      'experimentsandconfigs scope missing',
    )
    assert(url.searchParams.get('code_challenge_method') === 'S256', 'PKCE S256 missing')
    assert(url.searchParams.get('state') === handles.state, 'state mismatch')
    assert(url.searchParams.get('access_type') === 'offline', 'offline access missing')
    assert(url.searchParams.get('prompt') === 'consent', 'consent prompt missing')
  })

  await test('preserves the refresh token when a refresh response omits a replacement', () => {
    const stored = mergeGoogleOAuthTokens(
      {
        access_token: 'new-access',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid',
      },
      'saved-refresh',
      1_000,
    )
    assert(stored.accessToken === 'new-access', 'new access token was not stored')
    assert(stored.refreshToken === 'saved-refresh', 'saved refresh token was discarded')
    assert(stored.expiresAt === 3_601_000, `wrong expiry: ${stored.expiresAt}`)
  })

  await test('uses a newly issued refresh token when Google returns one', () => {
    const stored = mergeGoogleOAuthTokens(
      {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid',
      },
      'saved-refresh',
      1_000,
    )
    assert(stored.refreshToken === 'new-refresh', 'new refresh token was not stored')
  })

  await test('does not report persistent Antigravity login without a refresh token', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: 'temporary-access',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid',
    }), { status: 200 })) as typeof fetch

    const handles = initiateAntigravityOAuth()
    let message = ''
    try {
      await completeAntigravityOAuth(handles, `?code=temporary&state=${handles.state}`)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert(/refresh token/i.test(message), `unexpected error: ${message}`)
  })

  await test('accepts a bare code, query string, or full callback URL', () => {
    assert(parseAntigravityOAuthCallback(' 4/example ').code === '4/example', 'bare code failed')

    const query = parseAntigravityOAuthCallback('?code=4%2Fquery&state=s1')
    assert(query.code === '4/query' && query.state === 's1', 'query parsing failed')

    const full = parseAntigravityOAuthCallback(
      'https://antigravity.google/oauth-callback?code=4%2Ffull&state=s2',
    )
    assert(full.code === '4/full' && full.state === 's2', 'URL parsing failed')
  })

  await test('rejects a pasted callback from a different OAuth attempt', async () => {
    const handles = initiateAntigravityOAuth()
    let message = ''
    try {
      await completeAntigravityOAuth(
        handles,
        'https://antigravity.google/oauth-callback?code=unused&state=wrong',
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(/state mismatch/i.test(message), `unexpected error: ${message}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
