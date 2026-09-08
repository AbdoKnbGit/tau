/**
 * OpenAI OAuth2 PKCE flow for API access.
 *
 * Uses the same bundled OAuth client ID as OpenAI's Codex CLI
 * (a public PKCE client — no client secret needed).
 *
 * Flow:
 *   1. Generate PKCE code_verifier + code_challenge (S256)
 *   2. Start local HTTP server on 127.0.0.1:1455 for the redirect callback
 *   3. Open browser to OpenAI consent screen
 *   4. Exchange authorization code → id_token + access_token + refresh_token
 *   5. Token-exchange the id_token → API-capable access token
 *      (matches Codex's obtain_api_key() — the first access token is only
 *       valid for auth service calls, not the OpenAI API)
 *   6. Redirect browser to /success, store tokens, done
 *   7. Auto-refresh when expired
 *
 * No env vars required — works out of the box.
 * The user signs in with their ChatGPT / OpenAI account.
 */

import { createServer, type Server } from 'http'
import { randomBytes, createHash } from 'crypto'
import { execSync } from 'child_process'
import { saveProviderKey, loadProviderKey } from './api_key_manager.js'
import { openBrowser } from '../../../utils/browser.js'

// ─── Bundled OAuth credentials (from openai/codex CLI) ───────────────
// Source: https://github.com/openai/codex — public PKCE client, no secret
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

// ─── OAuth endpoints ──────────────────────────────────────────────────

// IMPORTANT: must be /oauth/authorize (not /authorize) — the shorter path
// returns a blank / broken page in the browser.
const OPENAI_ISSUER = 'https://auth.openai.com'
const OPENAI_AUTH_URL = `${OPENAI_ISSUER}/oauth/authorize`
const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`
const REDIRECT_PATH = '/auth/callback'
const SUCCESS_PATH = '/success'
// Codex CLI's registered port — OpenAI validates redirect URIs exactly
const DEFAULT_PORT = 1455

// ─── Active server tracking ──────────────────────────────────────────
// Keeps a reference to the callback server so repeat /login calls can
// close the stale one instead of failing with EADDRINUSE.
let _activeServer: Server | null = null

function _cleanupActiveServer(): void {
  if (_activeServer) {
    try { _activeServer.close() } catch {}
    _activeServer = null
  }
}

/**
 * Force-close any TCP server in this process that is bound to the given port.
 * Handles the edge case where a previous /login created a callback server
 * with old code that didn't track it in _activeServer.
 */
function _forceCloseServersOnPort(port: number): void {
  try {
    // Node internals: _getActiveHandles() returns all open handles
    // (sockets, servers, timers, etc.) in the current event loop.
    const handles = (process as any)._getActiveHandles?.() as any[] | undefined
    if (!handles) return
    for (const h of handles) {
      // TCP servers have a .close() method and an address() that returns
      // { port, address, family } when bound.
      if (typeof h?.close === 'function' && typeof h?.address === 'function') {
        try {
          const addr = h.address()
          if (addr && addr.port === port) {
            h.close()
          }
        } catch { /* not a server or already closed */ }
      }
    }
  } catch { /* _getActiveHandles may not exist in all runtimes */ }
}

// Clean up on process exit so we never leave a stale listener behind.
// Only use 'exit' — adding SIGINT/SIGTERM listeners can interfere with
// the main graceful shutdown flow in gracefulShutdown.ts.
process.on('exit', _cleanupActiveServer)

// Must match the scopes the Codex CLI public client is registered for.
// Only these 4 are accepted — adding api.connectors.* or api.responses.*
// triggers "invalid_scope" on the consent screen.
const SCOPES = 'openid profile email offline_access'

interface OpenAIOAuthTokens {
  access_token: string
  id_token?: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

interface StoredOpenAITokens {
  accessToken: string   // API key from token exchange (for api.openai.com)
  sessionToken: string  // First-exchange access_token (for chatgpt.com/backend-api)
  refreshToken: string
  expiresAt: number     // Unix timestamp ms
}

// ─── PKCE Helpers ──────────────────────────────────────────────────

function generateCodeVerifier(): string {
  // 96 random bytes → 128 base64url characters.
  // Matches CLIProxyAPI's PKCE implementation exactly.
  return randomBytes(96).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ─── OAuth Flow ────────────────────────────────────────────────────

/**
 * Start the OpenAI OAuth PKCE flow.
 * Opens the user's browser to sign in with their OpenAI/ChatGPT account.
 * No configuration required — uses bundled Codex CLI credentials.
 */
export async function startOpenAIOAuthFlow(): Promise<{
  accessToken: string
  refreshToken: string
}> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  let state = randomBytes(16).toString('hex')

  // Must use port 1455 — matches Codex CLI's registered redirect URI.
  // OpenAI validates the redirect URI exactly, so we cannot fall back
  // to a random free port.
  const port = DEFAULT_PORT
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`

  // Close any stale callback server from a previous /login attempt
  // in this process before trying to bind the port.
  _cleanupActiveServer()
  _forceCloseServersOnPort(port)

  // Start the callback server BEFORE opening the browser so the redirect
  // always has something to talk to. If the port is in use, the retry
  // logic below will try to free it automatically.
  const callbackReady = startCallbackServer(port, state)

  // Build authorization URL.
  //   - `id_token_add_organizations=true` + `codex_cli_simplified_flow=true`
  //     are required by OpenAI's Codex OAuth client — omitting either one
  //     triggers a blank response page in the browser.
  //   - `prompt=login` forces a fresh auth every time, which is how Codex
  //     CLI and CLIProxyAPI both call it. Without this, re-running /login
  //     can reuse a stale session cookie and dump the user on a broken
  //     "Continue with email / Google" screen.
  //   - No `originator` param — CLIProxyAPI doesn't send one, and adding
  //     it was correlated with the email/google redirection error users
  //     kept hitting.
  const authUrl = new URL(OPENAI_AUTH_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('prompt', 'login')
  authUrl.searchParams.set('state', state)

  // Wait until the server is actually listening before opening the browser.
  // If the port is in use, try to free it and retry once — this handles
  // stale listeners from crashed sessions or the real Codex CLI.
  let authCodePromise: Promise<string>
  try {
    ;({ authCodePromise } = await callbackReady)
  } catch (err: any) {
    if (err?.message?.includes('Port') && err?.message?.includes('in use')) {
      // Try to free the port and retry once
      const freed = await _tryFreePort(port)
      if (freed) {
        const retryState = randomBytes(16).toString('hex')
        // Update the state in the auth URL (we haven't opened the browser yet)
        state = retryState
        authUrl.searchParams.set('state', retryState)
        const retry = startCallbackServer(port, retryState)
        ;({ authCodePromise } = await retry)
      } else {
        throw err
      }
    } else {
      throw err
    }
  }

  const authUrlString = authUrl.toString()
  const opened = await openBrowser(authUrlString)
  if (!opened) {
    console.log(
      `\nOpen this URL in your browser to sign in with OpenAI:\n${authUrlString}\n`,
    )
  }

  // Wait for the callback.
  const authCode = await authCodePromise

  // Step 1 — exchange authorization code for id_token + access_token + refresh_token.
  const firstExchange = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  })

  if (!firstExchange.ok) {
    const errText = await firstExchange.text()
    throw new Error(`OpenAI token exchange failed: ${errText}`)
  }

  const firstTokens = (await firstExchange.json()) as OpenAIOAuthTokens

  // Step 2 — token-exchange the id_token for an API-key access token.
  // Matches Codex's `obtain_api_key()`. The first-exchange access_token
  // is only valid for the auth service; API calls need the token we get
  // from this second exchange.
  let apiAccessToken = firstTokens.access_token
  if (firstTokens.id_token) {
    try {
      const exchange = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: CLIENT_ID,
          requested_token: 'openai-api-key',
          subject_token: firstTokens.id_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        }),
      })
      if (exchange.ok) {
        const exchanged = (await exchange.json()) as OpenAIOAuthTokens
        if (exchanged.access_token) {
          apiAccessToken = exchanged.access_token
        }
      }
    } catch {
      // Fall back to first-exchange token.
    }
  }

  // Store tokens — keep both the API key AND the session token.
  // The session token (first-exchange) is used for chatgpt.com/backend-api
  // which is the endpoint that accepts the Responses API for Codex models.
  const stored: StoredOpenAITokens = {
    accessToken: apiAccessToken,
    sessionToken: firstTokens.access_token,
    refreshToken: firstTokens.refresh_token ?? '',
    expiresAt: Date.now() + firstTokens.expires_in * 1000,
  }
  saveProviderKey('openai_oauth', JSON.stringify(stored))

  return {
    accessToken: apiAccessToken,
    refreshToken: firstTokens.refresh_token ?? '',
  }
}

/**
 * Refresh an expired OpenAI OAuth access token.
 */
export async function refreshOpenAIToken(refreshToken: string): Promise<string> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI token refresh failed: ${errText}`)
  }

  const tokens = (await response.json()) as OpenAIOAuthTokens
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token ||
      !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
      (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== 'string')) {
    throw new Error('OpenAI token refresh returned invalid credentials')
  }

  // If the refresh response contains an id_token, do the second exchange
  // again so the stored token is always API-capable.
  let apiAccessToken = tokens.access_token
  if (tokens.id_token) {
    try {
      const exchange = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: CLIENT_ID,
          requested_token: 'openai-api-key',
          subject_token: tokens.id_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        }),
      })
      if (exchange.ok) {
        const exchanged = (await exchange.json()) as OpenAIOAuthTokens
        if (exchanged.access_token) {
          apiAccessToken = exchanged.access_token
        }
      }
    } catch {
      // Fall back to the refresh-response access token.
    }
  }

  // Update stored tokens — keep the session token (first-exchange access_token)
  // for chatgpt.com/backend-api access.
  const stored: StoredOpenAITokens = {
    accessToken: apiAccessToken,
    sessionToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  }
  saveProviderKey('openai_oauth', JSON.stringify(stored))

  return apiAccessToken
}

/**
 * Get the stored OpenAI session token (first-exchange access_token).
 * This is needed for the ChatGPT backend API (chatgpt.com/backend-api/codex)
 * which is the endpoint that accepts the Responses API for GPT-5 Codex models.
 * Returns null if no tokens are stored or expired.
 */
export function getOpenAISessionToken(): string | null {
  const stored = loadProviderKey('openai_oauth')
  if (!stored) return null
  try {
    const tokens = JSON.parse(stored) as StoredOpenAITokens
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) return null
    return tokens.sessionToken || null
  } catch {
    return null
  }
}

/**
 * Get a valid OpenAI OAuth access token, refreshing if expired.
 * Returns null if no OAuth tokens are stored.
 */
export async function getOpenAIOAuthToken(): Promise<string | null> {
  const stored = loadProviderKey('openai_oauth')
  if (!stored) return null

  try {
    const tokens = JSON.parse(stored) as StoredOpenAITokens

    // Check if token is expired (with 5 min buffer)
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      if (tokens.refreshToken) {
        return await refreshOpenAIToken(tokens.refreshToken)
      }
      return null // No refresh token, need full re-auth
    }

    return tokens.accessToken
  } catch {
    return null
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

let sessionRefresh: Promise<string> | undefined

/** ChatGPT backend credential for voice; never return the exchanged API key. */
export async function getValidOpenAISessionAccess(forceRefresh = false, signal?: AbortSignal): Promise<{ accessToken: string; accountId?: string }> {
  signal?.throwIfAborted()
  const loginHint = 'Run /login openai and choose ChatGPT OAuth, then /hey. No Codex CLI installation is required.'
  const stored = loadProviderKey('openai_oauth')
  if (!stored) throw new Error(loginHint)
  let tokens: StoredOpenAITokens
  try { tokens = JSON.parse(stored) } catch { throw new Error(loginHint) }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) ||
      (tokens.sessionToken !== undefined && typeof tokens.sessionToken !== 'string') ||
      (tokens.refreshToken !== undefined && typeof tokens.refreshToken !== 'string') ||
      !Number.isFinite(tokens.expiresAt)) throw new Error(loginHint)
  if (forceRefresh || !tokens.sessionToken || Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
    if (!tokens.refreshToken) throw new Error(loginHint)
    try {
      sessionRefresh ??= refreshOpenAIToken(tokens.refreshToken).finally(() => { sessionRefresh = undefined })
      await awaitSessionRefresh(sessionRefresh, signal)
      tokens = JSON.parse(loadProviderKey('openai_oauth') ?? '{}')
    } catch {
      signal?.throwIfAborted()
      throw new Error(`ChatGPT sign-in could not be refreshed. ${loginHint}`)
    }
  }
  signal?.throwIfAborted()
  if (!tokens || typeof tokens.sessionToken !== 'string' || !tokens.sessionToken) throw new Error(loginHint)
  let accountId: string | undefined
  try {
    const claims = JSON.parse(Buffer.from(tokens.sessionToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const id = claims['https://api.openai.com/auth']?.chatgpt_account_id
    if (typeof id === 'string') accountId = id
  } catch { /* Opaque tokens may omit the optional account header. */ }
  return { accessToken: tokens.sessionToken, ...(accountId ? { accountId } : {}) }
}

function awaitSessionRefresh<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

/**
 * Try to free a port by killing whatever process is listening on it.
 * Returns true if the port was successfully freed (or is now free).
 *
 * This handles the common case where a previous claudex session crashed
 * and left a stale callback server behind, or the real Codex CLI is
 * occupying the port.  Tau is a standalone tool and should not
 * require users to hunt down stale listeners manually.
 */
async function _tryFreePort(port: number): Promise<boolean> {
  try {
    // ── Step 1: Same-process stale server ──────────────────────────
    // The most common case: a previous /login in THIS claudex session
    // left a callback server alive. _cleanupActiveServer only works if
    // the module-level _activeServer was set, but after a hot-reload or
    // first run with new code the reference may be null even though an
    // old server is still bound.  We use a brute-force approach: try to
    // find the port owner's PID and compare with process.pid.  If it's
    // us, we know there's a dangling server inside our own event loop
    // that we can't reach via _activeServer.  In that case we create a
    // throw-away connection to the port, which lets us confirm it's
    // reachable, then we use the exclusive trick below.
    const ownPid = String(process.pid)
    let portOwnedBySelf = false

    if (process.platform === 'win32') {
      try {
        const out = execSync(
          `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
          { encoding: 'utf-8', timeout: 5000 },
        )
        const pids = new Set<string>()
        for (const line of out.trim().split('\n')) {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && pid !== '0' && /^\d+$/.test(pid)) pids.add(pid)
        }

        if (pids.has(ownPid)) {
          portOwnedBySelf = true
        }

        // Kill only external processes (never ourselves)
        for (const pid of pids) {
          if (pid === ownPid) continue
          try {
            execSync(`taskkill /F /PID ${pid}`, {
              encoding: 'utf-8',
              timeout: 5000,
              stdio: 'ignore',
            })
          } catch { /* process may already be gone */ }
        }
      } catch { /* netstat failed — port may already be free */ }
    } else {
      // macOS / Linux
      try {
        const pidOutput = execSync(`lsof -ti:${port} 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim()
        if (pidOutput) {
          const pids = pidOutput.split('\n').map(p => p.trim())
          if (pids.includes(ownPid)) {
            portOwnedBySelf = true
          }
          // Kill only external processes
          const externalPids = pids.filter(p => p !== ownPid).join(' ')
          if (externalPids) {
            execSync(`kill -9 ${externalPids}`, {
              encoding: 'utf-8',
              timeout: 5000,
              stdio: 'ignore',
            })
          }
        }
      } catch { /* nothing found */ }
    }

    // ── Step 2: Same-process — force-close the orphaned server ─────
    // When the stale server is in our own process, we can't taskkill
    // ourselves. Instead, enumerate all active Node handles and close
    // any TCP server bound to this port.
    if (portOwnedBySelf) {
      _forceCloseServersOnPort(port)
      // Small delay for the OS to process the close
      await new Promise(r => setTimeout(r, 300))
    }

    // Give the OS a moment to release the socket
    await new Promise(r => setTimeout(r, 600))
    return true
  } catch {
    return false
  }
}

/**
 * Start the local callback server and return a promise for the auth code.
 *
 * Resolves once the server is actually listening (so the caller can open
 * the browser safely). The returned `authCodePromise` resolves when the
 * browser hits /auth/callback, or rejects on timeout / error / mismatched
 * state / port-in-use.
 *
 * We bind to all interfaces (dual-stack) so `localhost` works regardless
 * of whether the browser resolves it to ::1 (IPv6) or 127.0.0.1 (IPv4).
 * Matches CLIProxyAPI's `:port` binding.
 */
function startCallbackServer(
  port: number,
  expectedState: string,
): Promise<{ authCodePromise: Promise<string> }> {
  return new Promise((resolveReady, rejectReady) => {
    let resolveCode: (code: string) => void = () => {}
    let rejectCode: (err: Error) => void = () => {}
    const authCodePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const timeout = setTimeout(
      () => {
        try {
          server.close()
        } catch {}
        rejectCode(new Error('OAuth callback timed out after 5 minutes'))
      },
      5 * 60 * 1000,
    )

    const closeServer = () => {
      try { server.close() } catch {}
      if (_activeServer === server) _activeServer = null
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://localhost:${port}`)

      if (url.pathname === REDIRECT_PATH) {
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        const state = url.searchParams.get('state')

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderErrorPage(`OpenAI returned: ${error}`))
          clearTimeout(timeout)
          setTimeout(closeServer, 1000)
          rejectCode(new Error(`OpenAI OAuth error: ${error}`))
          return
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderErrorPage('Invalid state parameter.'))
          clearTimeout(timeout)
          setTimeout(closeServer, 1000)
          rejectCode(new Error('OpenAI OAuth error: invalid state parameter'))
          return
        }

        if (code) {
          // 302 → /success so the browser lands on a clean confirmation
          // page instead of the inline HTML we'd otherwise return.
          res.writeHead(302, { Location: SUCCESS_PATH })
          res.end()
          clearTimeout(timeout)
          // Keep the server alive long enough to serve /success before
          // closing — otherwise the browser sees "connection refused".
          setTimeout(closeServer, 2000)
          resolveCode(code)
          return
        }
      }

      if (url.pathname === SUCCESS_PATH) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderSuccessPage())
        return
      }

      res.writeHead(404)
      res.end()
    })

    // Don't let the callback server keep the process alive if the user
    // cancels / Ctrl-C's out of the login flow.
    server.unref()

    server.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout)
      if (err.code === 'EADDRINUSE') {
        const msg =
          `Port ${port} is in use — attempting to free it automatically. ` +
          `If this keeps failing, check for stale node/codex processes ` +
          `on port ${port}.`
        rejectReady(new Error(msg))
        rejectCode(new Error(msg))
      } else {
        rejectReady(err)
        rejectCode(err)
      }
    })

    // Track the server so we can clean it up on repeat /login or process exit.
    _activeServer = server

    // Bind to all interfaces (dual-stack) so `localhost` reaches us
    // regardless of whether the browser resolves it to ::1 (IPv6) or
    // 127.0.0.1 (IPv4). Matches CLIProxyAPI's `:port` binding.
    server.listen(port, () => {
      resolveReady({ authCodePromise })
    })
  })
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Signed in - Tau</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #e2e8f0;
    }
    .card {
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 16px;
      padding: 48px 64px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      max-width: 420px;
    }
    h1 { margin: 0 0 12px; font-size: 26px; font-weight: 600; color: #f8fafc; }
    p { margin: 0; color: #94a3b8; font-size: 15px; line-height: 1.5; }
    .check {
      width: 56px; height: 56px; margin: 0 auto 24px;
      border-radius: 50%;
      background: #10b981;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; color: white; font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="check">&#10003;</div>
    <h1>Signed in</h1>
    <p>You can close this window and return to Tau.</p>
  </main>
  <script>setTimeout(function(){ try { window.close() } catch (_) {} }, 1500);</script>
</body>
</html>`
}

function renderErrorPage(msg: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authentication failed - Tau</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      padding: 40px; background: #1e293b; color: #fee2e2;
      min-height: 100vh; margin: 0;
    }
    h1 { color: #fca5a5; margin-bottom: 16px; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #e2e8f0; }
    p { line-height: 1.6; max-width: 540px; }
  </style>
</head>
<body>
  <h1>Authentication failed</h1>
  <p>${escapeHtml(msg)}</p>
  <p>Return to Tau and run <code>/login</code> to try again.</p>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return map[c] ?? c
  })
}
