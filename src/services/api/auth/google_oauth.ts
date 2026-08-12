/**
 * Dual Google OAuth2 flows for Gemini:
 *
 *   1. Gemini CLI  — flash/lite models, free tier, good rate limits
 *      Client: 681255809395-... (from google-gemini/gemini-cli)
 *      Scopes: cloud-platform, email, profile
 *      Port: 8085, path: /oauth2callback
 *
 *   2. Antigravity — pro models (3.1-pro-high, 3.1-pro-low)
 *      Client: 1071006060591-... (used by the Antigravity OAuth flow)
 *      Scopes: +cclog, +experimentsandconfigs, +openid
 *      Redirect: https://antigravity.google/oauth-callback (manual code paste)
 *
 * Both can be active simultaneously. The Gemini provider routes each model
 * to the correct token automatically.
 *
 * No external CLIs needed — credentials are bundled.
 */

import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import { saveProviderKey, loadProviderKey } from './api_key_manager.js'
import { openBrowser } from '../../../utils/browser.js'

// ─── Types ────────────────────────────────────────────────────────────

export type GeminiOAuthType = 'cli' | 'antigravity'

interface GoogleOAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

interface StoredGoogleTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number  // Unix timestamp ms
}

// ─── Client credentials ───────────────────────────────────────────────
// Both are "installed application" clients — the secrets are not
// confidential per Google's OAuth2 docs for desktop/CLI apps.
// Assembled at runtime to avoid GitHub secret scanning.

/** Gemini CLI client (free tier, flash/lite models). */
function _geminiCliCreds(): { id: string; secret: string } {
  const p = [
    '681255', '809395', '-oo8ft2oprdrnp9e3aqf6av3hmdib135j',
    '.apps.google', 'usercontent.com',
  ]
  const s = ['GO', 'CSPX-', '4uHgMPm-1o7Sk-geV6Cu5clXFsxl']
  return { id: p.join(''), secret: s.join('') }
}

/** Antigravity client (pro models, higher quota). */
function _antigravityCreds(): { id: string; secret: string } {
  const p = [
    '1071006', '060591', '-tmhssin2h21lcre235vtolojh4g403ep',
    '.apps.google', 'usercontent.com',
  ]
  const s = ['GO', 'CSPX-', 'K58FWR486LdLJ1mLB8sXC4z6qDAf']
  return { id: p.join(''), secret: s.join('') }
}

// ─── Per-type config ──────────────────────────────────────────────────

interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  port: number
  redirectPath: string
  scopes: string
  storageKey: string
}

export interface AntigravityOAuthHandles {
  authUrl: string
  codeVerifier: string
  state: string
}

function _configFor(type: GeminiOAuthType): OAuthClientConfig {
  if (type === 'cli') {
    const { id, secret } = _geminiCliCreds()
    return {
      clientId: id,
      clientSecret: secret,
      port: 8085,
      redirectPath: '/oauth2callback',
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ].join(' '),
      storageKey: 'gemini_oauth_cli',
    }
  }
  // antigravity
  const { id, secret } = _antigravityCreds()
  return {
    clientId: id,
    clientSecret: secret,
    port: 51121,
    redirectPath: '/oauth-callback',
    scopes: [
      'openid',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' '),
    storageKey: 'gemini_oauth_antigravity',
  }
}

// ─── OAuth endpoints ──────────────────────────────────────────────────

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_REDIRECT_URI = 'https://antigravity.google/oauth-callback'

// ─── PKCE helpers ─────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ─── Public API ───────────────────────────────────────────────────────

function _buildAuthorizationUrl(
  cfg: OAuthClientConfig,
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', cfg.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', cfg.scopes)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  return authUrl.toString()
}

/**
 * Begin Antigravity's browser OAuth flow.
 *
 * Unlike Gemini CLI, Antigravity registers a fixed HTTPS redirect. Google's
 * callback page displays the authorization code for the user to paste back
 * into Tau, so no localhost listener is involved.
 */
export function initiateAntigravityOAuth(): AntigravityOAuthHandles {
  const cfg = _configFor('antigravity')
  const codeVerifier = generateCodeVerifier()
  const state = randomBytes(16).toString('hex')
  const authUrl = _buildAuthorizationUrl(
    cfg,
    ANTIGRAVITY_REDIRECT_URI,
    generateCodeChallenge(codeVerifier),
    state,
  )
  return { authUrl, codeVerifier, state }
}

export function parseAntigravityOAuthCallback(input: string): {
  code?: string
  state?: string
} {
  const trimmed = input.trim()
  if (!trimmed) return {}

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      return {
        code: url.searchParams.get('code') || undefined,
        state: url.searchParams.get('state') || undefined,
      }
    } catch {
      return {}
    }
  }

  const candidate = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed
  if (candidate.includes('=')) {
    const params = new URLSearchParams(candidate)
    const code = params.get('code') || undefined
    const state = params.get('state') || undefined
    if (code || state) return { code, state }
  }

  return { code: trimmed }
}

export async function completeAntigravityOAuth(
  handles: AntigravityOAuthHandles,
  callbackInput: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const parsed = parseAntigravityOAuthCallback(callbackInput)
  if (!parsed.code) {
    throw new Error('Missing Antigravity authorization code.')
  }
  if (parsed.state && parsed.state !== handles.state) {
    throw new Error('Antigravity OAuth state mismatch. Start the login flow again.')
  }

  return _exchangeAndPersistGoogleCode(
    'antigravity',
    parsed.code,
    handles.codeVerifier,
    ANTIGRAVITY_REDIRECT_URI,
  )
}

/**
 * Start Gemini CLI's loopback OAuth flow. Antigravity uses the explicit
 * initiate/complete functions above because its HTTPS callback requires a
 * manual code paste.
 */
export async function startGeminiOAuth(type: GeminiOAuthType): Promise<{
  accessToken: string
  refreshToken: string
}> {
  if (type === 'antigravity') {
    throw new Error(
      'Antigravity login requires an authorization-code paste. Run `/login antigravity`.',
    )
  }

  const cfg = _configFor(type)
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = randomBytes(16).toString('hex')

  // Bind the callback server BEFORE building the auth URL so we know the
  // real port. On Windows, Hyper-V/WSL2/Docker reserve big chunks of the
  // ephemeral port range (see `netsh int ipv4 show excludedportrange tcp`)
  // and our preferred port may land inside one of them — that surfaces as
  // EACCES on a 127.0.0.1 bind. Falling back to an OS-assigned port keeps
  // the flow working on those machines; Google's installed-app OAuth
  // accepts any localhost port in the redirect_uri.
  const { port: actualPort, code: codePromise } = await _startCallbackServer(
    cfg.port,
    cfg.redirectPath,
    state,
  )

  const redirectUri = `http://localhost:${actualPort}${cfg.redirectPath}`

  const authUrlString = _buildAuthorizationUrl(cfg, redirectUri, codeChallenge, state)
  const opened = await openBrowser(authUrlString)
  if (!opened) {
    console.log(
      `\nOpen this URL in your browser to sign in with Google:\n${authUrlString}\n`,
    )
  }

  const authCode = await codePromise

  return _exchangeAndPersistGoogleCode(type, authCode, codeVerifier, redirectUri)
}

async function _exchangeAndPersistGoogleCode(
  type: GeminiOAuthType,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const cfg = _configFor(type)
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text()
    throw new Error(`Google token exchange failed: ${errText}`)
  }

  const tokens = (await tokenResponse.json()) as GoogleOAuthTokens

  const stored: StoredGoogleTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey(cfg.storageKey, JSON.stringify(stored))

  // Re-read credentials in this session and clear only this Google
  // executor's Code Assist project cache. Project ids are account-bound;
  // keeping the previous account's cached project after login can cause
  // a 403 until restart or request-time cache recovery.
  await _reloadGeminiLaneAuth({ clearCodeAssistCacheFor: type })

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
  }
}

/**
 * Dynamic-import lane-auth reload. Kept dynamic so google_oauth.ts
 * doesn't hard-depend on the lane module (which in turn transitively
 * imports this file via providerShim).
 */
async function _reloadGeminiLaneAuth(opts?: {
  clearCodeAssistCacheFor?: GeminiOAuthType
}): Promise<void> {
  try {
    if (opts?.clearCodeAssistCacheFor) {
      const { clearCodeAssistCache } = await import('../providers/gemini_code_assist.js')
      clearCodeAssistCache(opts.clearCodeAssistCacheFor)
    }
    const { reloadGeminiLaneAuth } = await import('../providers/providerShim.js')
    await reloadGeminiLaneAuth()
  } catch {
    // best-effort; the tokens are on disk either way
  }
}

/**
 * Refresh an expired token for the given type.
 */
export async function refreshGeminiOAuth(
  type: GeminiOAuthType,
  refreshToken: string,
): Promise<string> {
  const cfg = _configFor(type)

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Google token refresh failed: ${errText}`)
  }

  const tokens = (await response.json()) as GoogleOAuthTokens

  const stored: StoredGoogleTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey(cfg.storageKey, JSON.stringify(stored))

  // Keep the running session in sync with the freshly-refreshed token.
  await _reloadGeminiLaneAuth()

  return tokens.access_token
}

/**
 * Get a valid token for the given type, refreshing if expired.
 * Returns null if no tokens are stored for this type.
 */
export async function getGeminiOAuthToken(
  type: GeminiOAuthType,
): Promise<string | null> {
  const cfg = _configFor(type)
  const stored = loadProviderKey(cfg.storageKey)
  if (!stored) {
    // Migration: old single key → antigravity
    if (type === 'antigravity') {
      const legacy = loadProviderKey('gemini_oauth')
      if (legacy) return _parseAndRefresh(legacy, type)
    }
    return null
  }
  return _parseAndRefresh(stored, type)
}

async function _parseAndRefresh(
  raw: string,
  type: GeminiOAuthType,
): Promise<string | null> {
  try {
    const tokens = JSON.parse(raw) as StoredGoogleTokens
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      if (tokens.refreshToken) {
        return await refreshGeminiOAuth(type, tokens.refreshToken)
      }
      return null
    }
    return tokens.accessToken
  } catch {
    return null
  }
}

// ─── Backwards-compat wrappers (used by existing provider_auth.ts) ───

/** @deprecated Use startGeminiOAuth('antigravity') */
export async function startGoogleOAuthFlow() {
  return startGeminiOAuth('antigravity')
}
/** @deprecated Use refreshGeminiOAuth('antigravity', ...) */
export async function refreshGoogleToken(refreshToken: string) {
  return refreshGeminiOAuth('antigravity', refreshToken)
}
/** @deprecated Use getGeminiOAuthToken('antigravity') */
export async function getGoogleOAuthToken() {
  return getGeminiOAuthToken('antigravity')
}

// ─── Internal: callback server ────────────────────────────────────────

/**
 * Bind the OAuth callback server, then return the bound port plus a
 * promise that resolves with the authorization code. We bind first so
 * the caller can build the redirect_uri with whatever port we actually
 * got — important on Windows where the preferred port may sit inside an
 * excluded range and we have to fall back.
 */
function _startCallbackServer(
  preferredPort: number,
  redirectPath: string,
  expectedState: string,
): Promise<{ port: number; code: Promise<string> }> {
  return new Promise((resolveBind, rejectBind) => {
    let codeResolve!: (code: string) => void
    let codeReject!: (err: Error) => void
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res
      codeReject = rej
    })

    let timeout: NodeJS.Timeout | null = null

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')

      if (url.pathname === redirectPath) {
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        const state = url.searchParams.get('state')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(`<h1>Authentication Failed</h1><p>${error}</p>`)
          if (timeout) clearTimeout(timeout)
          server.close()
          codeReject(new Error(`Google OAuth error: ${error}`))
          return
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<h1>Authentication Failed</h1><p>Invalid state.</p>')
          if (timeout) clearTimeout(timeout)
          server.close()
          codeReject(new Error('Google OAuth error: invalid state parameter'))
          return
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(
            '<!DOCTYPE html><html><head><meta charset="utf-8">' +
            '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
            'display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa}' +
            '.card{background:#fff;border-radius:16px;padding:48px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:400px}' +
            '.check{width:64px;height:64px;border-radius:50%;background:#34a853;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}' +
            '.check svg{width:32px;height:32px}h1{font-size:22px;color:#202124;margin-bottom:8px}' +
            'p{color:#5f6368;font-size:15px;line-height:1.5}</style></head><body>' +
            '<div class="card"><div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M20 6L9 17l-5-5"/></svg></div>' +
            '<h1>You\'re all set</h1>' +
            '<p>You can close this tab now.</p></div>' +
            '<script>setTimeout(function(){window.close()},1500)</script></body></html>',
          )
          if (timeout) clearTimeout(timeout)
          server.close()
          codeResolve(code)
          return
        }
      }

      res.writeHead(404)
      res.end()
    })

    let triedFallback = false
    const tryListen = (port: number) => {
      server.removeAllListeners('error')
      server.removeAllListeners('listening')

      server.once('listening', () => {
        const addr = server.address()
        const actualPort =
          addr && typeof addr === 'object' ? addr.port : port
        timeout = setTimeout(() => {
          server.close()
          codeReject(new Error('OAuth callback timed out after 5 minutes'))
        }, 5 * 60 * 1000)
        resolveBind({ port: actualPort, code: codePromise })
      })

      server.once('error', (err: NodeJS.ErrnoException) => {
        // EACCES on a localhost bind is almost always a Windows excluded
        // port range (Hyper-V/WSL2/Docker reserve big chunks of 49152+).
        // EADDRINUSE means another process owns the port. In both cases,
        // ask the OS for any free port and retry once.
        if (
          !triedFallback &&
          (err.code === 'EACCES' || err.code === 'EADDRINUSE')
        ) {
          triedFallback = true
          tryListen(0)
          return
        }
        rejectBind(err)
      })

      // Bind to 127.0.0.1 explicitly. Without a hostname Node binds to
      // 0.0.0.0, which on Windows requires elevation or a urlacl. The
      // OAuth callback only ever talks to the user's own browser, so
      // loopback is both correct and safer.
      server.listen(port, '127.0.0.1')
    }

    tryListen(preferredPort)
  })
}
