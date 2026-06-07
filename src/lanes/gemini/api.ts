/**
 * Gemini Lane — Native REST API Client
 *
 * Direct HTTP client for Gemini's REST API. No SDK dependency.
 * Supports both API key and OAuth token auth.
 *
 * Endpoints:
 *   Streaming:     POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *   Non-streaming: POST /v1beta/models/{model}:generateContent
 *   Model list:    GET  /v1beta/models
 *
 * Auth:
 *   API key:  x-goog-api-key header
 *   OAuth:    Authorization: Bearer <token> (routed through Code Assist proxy)
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import {
  ANTIGRAVITY_MODELS,
  ensureCodeAssistReady,
  executorForModel,
  parseCodeAssistSSE,
  unwrapCodeAssistResponse,
  wrapForCodeAssist,
  wrapForGeminiCLI,
  geminiCLIApiHeaders,
  antigravityApiHeaders,
  codeAssistGenerationBases,
  clearCodeAssistCache,
  warmupCodeAssist,
} from '../../services/api/providers/gemini_code_assist.js'
import { resolveCliModelsForPicker } from '../../services/api/providers/gemini_provider.js'
import {
  classifyGeminiError,
  type ClassifiedGeminiError,
  type GeminiErrorKind,
} from './quota.js'
import {
  getAntigravityRotation,
  familyForAntigravityModel,
} from './rotation.js'
import { parseGeminiApiSSE as parseGeminiApiSSEEvent } from './api_sse.js'

// Duplicated from services/api/errors.ts to avoid pulling in its
// transitive import of utils/messages.ts (which has build-time-only
// module resolution that breaks bun-test). The string must stay
// identical so isPromptTooLongMessage() downstream matches.
const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

function antigravitySessionHeaders(wrappedBody: Record<string, unknown>): Record<string, string> {
  const request = wrappedBody.request as { sessionId?: unknown } | undefined
  return typeof request?.sessionId === 'string'
    ? { 'X-Machine-Session-Id': request.sessionId }
    : {}
}

export const TAU_STABLE_SESSION_ID_FIELD = '__tauStableSessionId'

function takeTauStableSessionId(body: Record<string, unknown>): string | undefined {
  const value = body[TAU_STABLE_SESSION_ID_FIELD]
  delete body[TAU_STABLE_SESSION_ID_FIELD]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function withTauStableSessionId(
  body: Record<string, unknown>,
  sessionId: string | undefined,
): Record<string, unknown> {
  return sessionId ? { ...body, sessionId } : body
}

// ─── Types ───────────────────────────────────────────────────────

export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role: string
      parts: Array<Record<string, unknown>>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
}

export async function* parseGeminiApiSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GeminiStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  const flushEvent = (): { done: boolean; chunks: GeminiStreamChunk[] } => {
    if (dataLines.length === 0) return { done: false, chunks: [] }

    const payload = dataLines.join('\n').trim()
    dataLines = []

    if (!payload) return { done: false, chunks: [] }
    if (payload === '[DONE]') return { done: true, chunks: [] }

    try {
      return { done: false, chunks: [JSON.parse(payload) as GeminiStreamChunk] }
    } catch {
      return { done: false, chunks: [] }
    }
  }

  const processLine = (rawLine: string): { done: boolean; chunks: GeminiStreamChunk[] } => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.trim() === '') {
      return flushEvent()
    }

    if (!line.startsWith('data:')) {
      return { done: false, chunks: [] }
    }

    const value = line.slice(5)
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    return { done: false, chunks: [] }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const event = processLine(rawLine)
        if (event.done) return
        for (const chunk of event.chunks) {
          yield chunk
        }
      }
    }

    buffer += decoder.decode()
    if (buffer) {
      for (const rawLine of buffer.split('\n')) {
        const event = processLine(rawLine)
        if (event.done) return
        for (const chunk of event.chunks) {
          yield chunk
        }
      }
    }

    const event = flushEvent()
    if (event.done) return
    for (const chunk of event.chunks) {
      yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── API Client ──────────────────────────────────────────────────

const AI_STUDIO_BASE = 'https://generativelanguage.googleapis.com/v1beta'

class GeminiApiClient {
  private apiKey: string | null = null
  /** OAuth token for the Gemini CLI executor (free-tier flash/lite models). */
  private cliOAuthToken: string | null = null
  /** OAuth token for the Antigravity executor (Gemini 3.x pro/flash models). */
  private antigravityOAuthToken: string | null = null

  /**
   * Configure auth. Call this before making requests.
   *
   * Semantics: only fields explicitly present on `opts` are updated. A
   * partial call like `configure({ cliOAuthToken: x })` must NOT wipe the
   * existing `apiKey` or `antigravityOAuthToken` — background token
   * refreshes come in one token at a time, and stomping the other tokens
   * leaves the lane with no credentials for half its models until the
   * next full `reloadGeminiLaneAuth` cycle (seen in the wild as a
   * multi-minute hang on Antigravity requests after a CLI token refresh).
   */
  configure(opts: {
    apiKey?: string
    oauthToken?: string
    cliOAuthToken?: string
    antigravityOAuthToken?: string
    oauthMode?: 'cli' | 'antigravity'
  }): void {
    if ('apiKey' in opts) this.apiKey = opts.apiKey ?? null
    if ('cliOAuthToken' in opts) this.cliOAuthToken = opts.cliOAuthToken ?? null
    if ('antigravityOAuthToken' in opts) this.antigravityOAuthToken = opts.antigravityOAuthToken ?? null
    // Legacy single-token path: route per oauthMode ('cli' default).
    if (opts.oauthToken) {
      if (opts.oauthMode === 'antigravity') {
        this.antigravityOAuthToken ??= opts.oauthToken
      } else {
        this.cliOAuthToken ??= opts.oauthToken
      }
    }
    // Pre-warm Code Assist onboarding to avoid a cold-start round trip on
    // the first real request. Non-blocking — fires in the background.
    if (this.cliOAuthToken || this.antigravityOAuthToken) {
      warmupCodeAssist(
        this.cliOAuthToken ?? undefined,
        this.antigravityOAuthToken ?? undefined,
      )
    }
  }

  /** Whether any auth is configured */
  get isConfigured(): boolean {
    return !!(this.apiKey || this.cliOAuthToken || this.antigravityOAuthToken)
  }

  /** Whether any OAuth token is configured (for routing decisions). */
  get hasOAuth(): boolean {
    return !!(this.cliOAuthToken || this.antigravityOAuthToken)
  }

  /** Get the current API key (if configured). For cache integration. */
  getApiKey(): string | null {
    return this.apiKey
  }

  /** Whether the current auth path supports Google's cachedContents API. */
  supportsServerCache(model?: string): boolean {
    // Google's cachedContents API is API-key-path only. The Code Assist
    // OAuth proxy doesn't expose it. Check the model route, not just
    // whether any OAuth token exists, so Antigravity can coexist with a
    // regular Gemini API key without disabling API-key caching.
    return !!this.apiKey && !this._tokenForModel(model ?? '')
  }

  /** Base URL for cache API calls. */
  readonly cacheBaseUrl = AI_STUDIO_BASE

  /**
   * Pick the OAuth token appropriate for a model. Antigravity models
   * route through the Antigravity executor (Gemini 3.x pro/flash pool),
   * everything else goes through the CLI executor (Code Assist free tier).
   *
   * Multi-account rotation: when the Antigravity rotation store has any
   * enrolled accounts, prefer the rotation's per-family best-pick over
   * the single `antigravityOAuthToken` that `configure()` set. This is
   * a drop-in upgrade — legacy single-token users (no accounts in the
   * rotation store) keep working unchanged.
   *
   * Returns { token, executor, accountEmail? } — `accountEmail` is set
   * when the token came from the rotation, so the caller can record
   * success/failure feedback against the right account.
   */
  private _tokenForModel(
    model: string,
  ): { token: string; executor: 'cli' | 'antigravity'; accountEmail?: string } | null {
    const executor = executorForModel(model)

    // Antigravity path: consult rotation first when available.
    if (executor === 'antigravity') {
      const rotation = getAntigravityRotation()
      if (rotation.hasAccounts()) {
        const account = rotation.pickForModel(model)
        if (account) {
          return {
            token: account.accessToken,
            executor: 'antigravity',
            accountEmail: account.email,
          }
        }
        // All accounts disabled/cooling — fall through to the single-token
        // Antigravity path. Do not borrow the Gemini CLI token: the CLI
        // Google account is allowed to be a different account, and it may
        // have no Antigravity enrollment.
      }
      const t = this.antigravityOAuthToken
      return t ? { token: t, executor: 'antigravity' } : null
    }

    const t = this.cliOAuthToken
    return t ? { token: t, executor: 'cli' } : null
  }

  /**
   * Refresh an expired OAuth access_token and update in-memory / disk state.
   *
   * Two paths:
   *  - Rotation-picked Antigravity account (accountEmail set): refresh the
   *    account's own refresh_token and write the new access_token back into
   *    the rotation store via `rotation.add()` (upsert semantics).
   *  - Single-token path (no accountEmail): delegate to `refreshGeminiOAuth`,
   *    which writes provider-keys.json and calls reloadGeminiLaneAuth so
   *    THIS client's in-memory token is updated too.
   *
   * Returns the new access token, or null if refresh is impossible (no
   * refresh_token stored, or the refresh endpoint rejected our creds).
   *
   * Called on 401 (access_token expired) and as a secondary remedy on 403
   * (Google occasionally returns 403 "does not have permission" for expired
   * tokens instead of 401, so we try both remedies there).
   */
  private async _refreshOAuthToken(
    executor: 'cli' | 'antigravity',
    accountEmail?: string,
  ): Promise<string | null> {
    try {
      if (accountEmail && executor === 'antigravity') {
        const rotation = getAntigravityRotation()
        const account = rotation.list().find(a => a.email === accountEmail)
        if (!account || !account.refreshToken) return null
        const { refreshAccessToken } = await import('../shared/antigravity_auth.js')
        const tokens = await refreshAccessToken(account.refreshToken)
        rotation.add({
          ...account,
          accessToken: tokens.access_token,
          expires: Date.now() + tokens.expires_in * 1000,
          refreshToken: tokens.refresh_token ?? account.refreshToken,
        })
        return tokens.access_token
      }
      const { refreshGeminiOAuth } = await import('../../services/api/auth/google_oauth.js')
      const { loadProviderKey } = await import('../../services/api/auth/api_key_manager.js')
      const storageKey = executor === 'cli' ? 'gemini_oauth_cli' : 'gemini_oauth_antigravity'
      const raw = loadProviderKey(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { refreshToken?: string }
      if (!parsed.refreshToken) return null
      // refreshGeminiOAuth saves the new blob AND reloads geminiApi in-memory.
      return await refreshGeminiOAuth(executor, parsed.refreshToken)
    } catch {
      return null
    }
  }

  /**
   * Strip thought-signature fields from every part in contents[].
   *
   * Google occasionally rejects requests with 400 "Corrupted thought
   * signature" when a previously-issued signature is stale (e.g. after
   * rotating to a different Antigravity account mid-conversation, or when
   * the legacy adapter emits the `skip_thought_signature_validator`
   * sentinel on Gemini 3.x pro, which has started refusing it). The
   * signatures are a latency/continuity hint — dropping them only costs
   * us a re-think on the next turn. Safer than failing the request.
   */
  private _stripThoughtSignaturesFromBody(body: any): void {
    if (!body || typeof body !== 'object') return
    const contents = body.contents
    if (!Array.isArray(contents)) return
    for (const content of contents) {
      if (!content || !Array.isArray(content.parts)) continue
      for (const part of content.parts) {
        if (part && typeof part === 'object') {
          delete part.thoughtSignature
          delete part.thought_signature
        }
      }
    }
  }

  /**
   * Stream a generateContent request. Returns an async iterable of chunks.
   * Uses Server-Sent Events (SSE) format.
   *
   * Retry behavior: the INITIAL request is retried on 429/5xx/network errors
   * with exponential backoff + jitter, mirroring gemini-cli's retry.ts.
   * Once the stream starts yielding chunks we can't rewind, so mid-stream
   * errors surface to the caller.
   */
  async *streamGenerateContent(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<GeminiStreamChunk> {
    const model = (request as any).model ?? 'gemini-2.5-pro'
    const body = { ...request }
    delete body.model
    const tauStableSessionId = takeTauStableSessionId(body)

    // OAuth path → Code Assist proxy (cloudcode-pa.googleapis.com). Uses the
    // same request envelopes and header sets that CLIProxyAPI emits so quota
    // routes to the right pool (free Code Assist vs Antigravity).
    const oauthRouting = this._tokenForModel(model)
    if (oauthRouting) {
      // Per-attempt state: re-resolve projectId each attempt so that a
      // stale-project 403 that clears the cache gets a fresh project on
      // the next attempt (before this fix, projectId was captured once
      // outside retryWithBackoff and the cleared cache was moot).
      let reonboardsLeft = 1
      let sigStripsLeft = 1
      const urlsForExecutor = (executor: 'cli' | 'antigravity') =>
        codeAssistGenerationBases(executor).map(base => `${base}:streamGenerateContent?alt=sse`)
      const rotation = getAntigravityRotation()

      const response = await retryWithBackoff(
        async () => {
          // Re-pick the token each attempt so rate-limit rotation applies
          // across retries — a 429 on account A gets the next call onto
          // account B. `_tokenForModel` consults rotation.pickForModel().
          const routing = this._tokenForModel(model)
          if (!routing) {
            throw new GeminiApiError(0, 'No OAuth credentials available', undefined, {
              kind: 'non-retryable',
              details: {},
            })
          }
          const { token, executor, accountEmail } = routing
          const projectId = await ensureCodeAssistReady(token, executor)
          const wrappedBody = executor === 'antigravity'
            ? wrapForCodeAssist(model, projectId, withTauStableSessionId(body, tauStableSessionId))
            : wrapForGeminiCLI(model, projectId, body)
          const headers = executor === 'antigravity'
            ? {
              ...antigravityApiHeaders(token),
              ...antigravitySessionHeaders(wrappedBody as unknown as Record<string, unknown>),
              'Accept': 'text/event-stream',
              'Connection': 'keep-alive',
            }
            : { ...geminiCLIApiHeaders(token, model), 'Connection': 'keep-alive' }
          // Code Assist uses proto-json snake_case — rename thoughtSignature
          // on the wire. One string replace on the outgoing payload; cheap.
          const serialized = JSON.stringify(wrappedBody)
            .replace(/"thoughtSignature"\s*:/g, '"thought_signature":')

          let resp: Response | null = null
          let errText = ''
          const urls = urlsForExecutor(executor)
          for (let i = 0; i < urls.length; i++) {
            resp = await fetch(urls[i]!, {
              method: 'POST',
              headers,
              body: serialized,
              signal,
            })
            if (resp.ok) break
            errText = await resp.text().catch(() => '')
            if (!(executor === 'antigravity' && resp.status === 404 && i < urls.length - 1)) break
          }
          if (!resp) {
            throw new GeminiApiError(0, 'No Code Assist endpoint attempted', undefined, {
              kind: 'non-retryable',
              details: {},
            })
          }
          if (!resp.ok) {
            const cls = classifyGeminiError(resp.status, errText)
            const retryAfterMs = cls.retryAfterMs
              ?? parseRetryAfter(resp.headers.get('retry-after'))

            // Record feedback against the rotation (no-op when the token
            // came from the legacy single-token path).
            if (accountEmail && executor === 'antigravity') {
              const account = rotation.list().find(a => a.email === accountEmail)
              if (account) {
                const family = familyForAntigravityModel(model)
                if (cls.kind === 'retryable-quota' || cls.kind === 'terminal-quota') {
                  rotation.recordRateLimit(account, family, retryAfterMs)
                } else if (
                  cls.kind === 'non-retryable'
                  || cls.kind === 'validation-required'
                  || cls.kind === 'auth-stale'
                ) {
                  // Auth-stale counts as a hard failure so subsequent
                  // requests rotate to a different enrolled account. If
                  // it was actually a transient cache issue, the retry
                  // succeeds and the follow-up recordSuccess mixes the
                  // score back up — no harm done.
                  rotation.recordHardFailure(account)
                }
              }
            }

            // Auth-stale recovery — fix side state + recurse once within
            // this retry attempt so the user doesn't pay a full backoff
            // wait for a case we can fix immediately. Budget: one
            // re-onboard per request — if it happens twice, something
            // else is wrong.
            //
            //   401 → expired access_token. Refresh it; project cache is
            //         fine and re-onboarding would be wasteful.
            //   403 "does not have permission" → usually stale project
            //         cache (re-onboard), but Google occasionally returns
            //         403 for silently-expired tokens, so refresh too.
            if (cls.kind === 'auth-stale' && reonboardsLeft > 0) {
              reonboardsLeft--
              if (resp.status === 401) {
                await this._refreshOAuthToken(executor, accountEmail)
              } else {
                clearCodeAssistCache(executor)
                await this._refreshOAuthToken(executor, accountEmail)
              }
              throw new GeminiApiError(resp.status, errText, 0, {
                kind: 'transient',
                details: cls.details,
                retryAfterMs: 0,
              })
            }

            // 400 "Corrupted thought signature" — strip all signatures
            // from contents[].parts[] and retry once. The signatures are
            // a continuity hint; dropping them trades a re-think for
            // the request not failing outright.
            if (
              resp.status === 400
              && /corrupted thought signature/i.test(errText)
              && sigStripsLeft > 0
            ) {
              sigStripsLeft--
              this._stripThoughtSignaturesFromBody(body)
              throw new GeminiApiError(resp.status, errText, 0, {
                kind: 'transient',
                details: cls.details,
                retryAfterMs: 0,
              })
            }

            throw new GeminiApiError(resp.status, errText, retryAfterMs, cls)
          }
          if (!resp.body) {
            throw new GeminiApiError(0, 'No response body', undefined, {
              kind: 'transient',
              details: {},
            })
          }

          // Success feedback (against the account that served this attempt).
          if (accountEmail && executor === 'antigravity') {
            const account = rotation.list().find(a => a.email === accountEmail)
            if (account) rotation.recordSuccess(account)
          }

          return resp
        },
        { signal },
      )

      // Code Assist SSE frames are wrapped as `{ response: <chunk> }`.
      for await (const chunk of parseCodeAssistSSE(response.body!)) {
        yield chunk as GeminiStreamChunk
      }
      return
    }

    // API-key path — generativelanguage.googleapis.com direct.
    const url = `${AI_STUDIO_BASE}/models/${model}:streamGenerateContent?alt=sse`
    const headers = this.getHeaders()

    const response = await retryWithBackoff(
      async () => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const cls = classifyGeminiError(resp.status, errText)
          const retryAfterMs = cls.retryAfterMs
            ?? parseRetryAfter(resp.headers.get('retry-after'))
          throw new GeminiApiError(resp.status, errText, retryAfterMs, cls)
        }
        if (!resp.body) {
          throw new GeminiApiError(0, 'No response body', undefined, {
            kind: 'transient',
            details: {},
          })
        }
        return resp
      },
      { signal },
    )

    for await (const chunk of parseGeminiApiSSEEvent<GeminiStreamChunk>(response.body!)) {
      yield chunk
    }
  }

  /**
   * Non-streaming generateContent request.
   */
  async generateContent(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GeminiStreamChunk> {
    const model = (request as any).model ?? 'gemini-2.5-pro'
    const body = { ...request }
    delete body.model
    const tauStableSessionId = takeTauStableSessionId(body)

    // OAuth → Code Assist (unwraps the `{ response: ... }` envelope).
    const oauthRouting = this._tokenForModel(model)
    if (oauthRouting) {
      let reonboardsLeft = 1
      let sigStripsLeft = 1
      const urlsForExecutor = (executor: 'cli' | 'antigravity') =>
        codeAssistGenerationBases(executor).map(base => `${base}:generateContent`)
      const rotation = getAntigravityRotation()

      const data = await retryWithBackoff(
        async () => {
          const routing = this._tokenForModel(model)
          if (!routing) {
            throw new GeminiApiError(0, 'No OAuth credentials available', undefined, {
              kind: 'non-retryable',
              details: {},
            })
          }
          const { token, executor, accountEmail } = routing
          const projectId = await ensureCodeAssistReady(token, executor)
          const wrappedBody = executor === 'antigravity'
            ? wrapForCodeAssist(model, projectId, withTauStableSessionId(body, tauStableSessionId))
            : wrapForGeminiCLI(model, projectId, body)
          const headers = executor === 'antigravity'
            ? {
              ...antigravityApiHeaders(token),
              ...antigravitySessionHeaders(wrappedBody as unknown as Record<string, unknown>),
              'Accept': 'application/json',
              'Connection': 'keep-alive',
            }
            : { ...geminiCLIApiHeaders(token, model), 'Connection': 'keep-alive' }
          const serialized = JSON.stringify(wrappedBody)
            .replace(/"thoughtSignature"\s*:/g, '"thought_signature":')

          let resp: Response | null = null
          let errText = ''
          const urls = urlsForExecutor(executor)
          for (let i = 0; i < urls.length; i++) {
            resp = await fetch(urls[i]!, {
              method: 'POST',
              headers,
              body: serialized,
              signal,
            })
            if (resp.ok) break
            errText = await resp.text().catch(() => '')
            if (!(executor === 'antigravity' && resp.status === 404 && i < urls.length - 1)) break
          }
          if (!resp) {
            throw new GeminiApiError(0, 'No Code Assist endpoint attempted', undefined, {
              kind: 'non-retryable',
              details: {},
            })
          }
          if (!resp.ok) {
            const cls = classifyGeminiError(resp.status, errText)
            const retryAfterMs = cls.retryAfterMs
              ?? parseRetryAfter(resp.headers.get('retry-after'))

            if (accountEmail && executor === 'antigravity') {
              const account = rotation.list().find(a => a.email === accountEmail)
              if (account) {
                const family = familyForAntigravityModel(model)
                if (cls.kind === 'retryable-quota' || cls.kind === 'terminal-quota') {
                  rotation.recordRateLimit(account, family, retryAfterMs)
                } else if (
                  cls.kind === 'non-retryable'
                  || cls.kind === 'validation-required'
                  || cls.kind === 'auth-stale'
                ) {
                  // Auth-stale counts as a hard failure so subsequent
                  // requests rotate to a different enrolled account. If
                  // it was actually a transient cache issue, the retry
                  // succeeds and the follow-up recordSuccess mixes the
                  // score back up — no harm done.
                  rotation.recordHardFailure(account)
                }
              }
            }

            if (cls.kind === 'auth-stale' && reonboardsLeft > 0) {
              reonboardsLeft--
              if (resp.status === 401) {
                await this._refreshOAuthToken(executor, accountEmail)
              } else {
                clearCodeAssistCache(executor)
                await this._refreshOAuthToken(executor, accountEmail)
              }
              throw new GeminiApiError(resp.status, errText, 0, {
                kind: 'transient',
                details: cls.details,
                retryAfterMs: 0,
              })
            }

            if (
              resp.status === 400
              && /corrupted thought signature/i.test(errText)
              && sigStripsLeft > 0
            ) {
              sigStripsLeft--
              this._stripThoughtSignaturesFromBody(body)
              throw new GeminiApiError(resp.status, errText, 0, {
                kind: 'transient',
                details: cls.details,
                retryAfterMs: 0,
              })
            }
            throw new GeminiApiError(resp.status, errText, retryAfterMs, cls)
          }

          if (accountEmail && executor === 'antigravity') {
            const account = rotation.list().find(a => a.email === accountEmail)
            if (account) rotation.recordSuccess(account)
          }

          return resp.json()
        },
        { signal },
      )
      return unwrapCodeAssistResponse(data) as GeminiStreamChunk
    }

    // API-key path — generativelanguage.googleapis.com direct.
    const url = `${AI_STUDIO_BASE}/models/${model}:generateContent`
    const headers = this.getHeaders()

    return retryWithBackoff(
      async () => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          const cls = classifyGeminiError(resp.status, errText)
          const retryAfterMs = cls.retryAfterMs
            ?? parseRetryAfter(resp.headers.get('retry-after'))
          throw new GeminiApiError(resp.status, errText, retryAfterMs, cls)
        }
        return resp.json()
      },
      { signal },
    )
  }

  /**
   * List available models. Returns a curated list for OAuth paths (Code
   * Assist doesn't expose /v1beta/models and cloud-platform tokens are
   * rejected as restricted_client), or the live API-key catalog otherwise.
   */
  async listModels(providerFilter?: string): Promise<ModelInfo[]> {
    const listApiKeyModels = async (): Promise<ModelInfo[]> => {
      if (!this.apiKey) return []

      const url = `${AI_STUDIO_BASE}/models?key=${encodeURIComponent(this.apiKey)}`
      const response = await fetch(url, {
        method: 'GET',
        headers: { Connection: 'keep-alive' },
      })

      if (!response.ok) return []

      const data = await response.json()
      return (data.models ?? [])
        .filter((m: any) => m.name?.includes('gemini'))
        .map((m: any) => ({
          id: m.name?.replace('models/', '') ?? m.name,
          name: m.displayName ?? m.name,
          contextWindow: m.inputTokenLimit,
          supportsToolCalling: m.supportedGenerationMethods?.includes('generateContent'),
        }))
    }

    if (providerFilter === 'gemini' && !this.cliOAuthToken) {
      return listApiKeyModels()
    }

    if (providerFilter === 'antigravity') {
      if (!this.antigravityOAuthToken) return []
      return [...ANTIGRAVITY_MODELS]
    }

    // `providerFilter` is how the UX split between the Gemini row and the
    // Antigravity row lands here: both routes go through this same lane
    // (Code Assist proxy), they differ only in which OAuth token + body
    // envelope gets used. When the caller is the dedicated Antigravity
    // provider we must return ONLY the pro/flash-3 ids (which the lane
    // routes to cloudcode-pa with userAgent=antigravity); when the caller
    // is plain Gemini we return ONLY the free-tier CLI models.
    if (this.hasOAuth) {
      const showCli = providerFilter !== 'antigravity'
      const showAntigravity = providerFilter !== 'gemini'
      const models: ModelInfo[] = []
      if (showCli && this.cliOAuthToken) {
        // The picker is often the FIRST thing the user opens after
        // /login, before any chat request has triggered onboarding —
        // force the round-trip here so the entitled-ids / tier caches
        // that resolveCliModelsForPicker reads are populated.
        // Without this, a freshly-logged-in Pro user would see flash
        // until the next session.
        try {
          await ensureCodeAssistReady(this.cliOAuthToken, 'cli')
        } catch {
          // Onboarding failed — the picker falls back to flash. The
          // user will hit a clearer error next time they try to chat.
        }
        // Strict tier filter: free accounts see flash, paid accounts
        // see Pro. No mixing — a free user with a Pro option in their
        // picker would 403 on first chat, and a Pro user with flash
        // mixed in would pick the slow option by accident.
        models.push(...resolveCliModelsForPicker())
      }
      if (showAntigravity && this.antigravityOAuthToken) {
        models.push(...ANTIGRAVITY_MODELS)
      }
      return models
    }

    const url = `${AI_STUDIO_BASE}/models`
    const headers = this.getHeaders()

    const response = await fetch(url, {
      method: 'GET',
      headers,
    })

    if (!response.ok) return []

    const data = await response.json()
    return (data.models ?? [])
      .filter((m: any) => m.name?.includes('gemini'))
      .map((m: any) => ({
        id: m.name?.replace('models/', '') ?? m.name,
        name: m.displayName ?? m.name,
        contextWindow: m.inputTokenLimit,
        supportsToolCalling: m.supportedGenerationMethods?.includes('generateContent'),
      }))
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Connection: 'keep-alive',
    }

    if (this.apiKey) {
      headers['x-goog-api-key'] = this.apiKey
    }
    // OAuth is never used on the direct AI Studio endpoint — it's routed
    // through Code Assist above. This header path only runs on API-key
    // listModels / cache calls.
    return headers
  }
}

// ─── Error Type ──────────────────────────────────────────────────

export class GeminiApiError extends Error {
  /**
   * Google error-details classification. Set by the constructor (lazy) or
   * passed explicitly when the caller already ran the classifier.
   */
  private _classified?: ClassifiedGeminiError

  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
    classified?: ClassifiedGeminiError,
  ) {
    // Prompt-too-long errors must expose the Claude-Code signal prefix so
    // query.ts reactive compact fires — the downstream check text-matches
    // against PROMPT_TOO_LONG_ERROR_MESSAGE. The raw body is preserved in
    // .body so callers can still inspect the upstream detail.
    const cls = classified ?? classifyGeminiError(status, body)
    const head = cls.kind === 'prompt-too-long'
      ? `${PROMPT_TOO_LONG_ERROR_MESSAGE} (Gemini ${status})`
      : `Gemini API error ${status}`
    super(`${head}: ${body.slice(0, 200)}`)
    this.name = 'GeminiApiError'
    this._classified = cls
  }

  get classification(): ClassifiedGeminiError {
    if (!this._classified) {
      this._classified = classifyGeminiError(this.status, this.body)
    }
    return this._classified
  }

  get kind(): GeminiErrorKind {
    return this.classification.kind
  }

  get isRateLimited(): boolean {
    return this.status === 429
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }

  get isPromptTooLong(): boolean {
    return this.classification.kind === 'prompt-too-long'
  }

  /**
   * Whether the outer retryWithBackoff loop should back off and retry
   * without operator intervention. Auth-stale and retryable-quota are
   * retried HERE (via the fetch closure) with a bounded counter rather
   * than through isRetryable, because they need side effects between
   * attempts (cache clear / credential rotate).
   */
  get isRetryable(): boolean {
    switch (this.kind) {
      case 'transient':
        return true
      case 'retryable-quota':
        // Rotation happens inline; backoff loop also retries so that a
        // single-account setup still gets exponential wait.
        return true
      case 'prompt-too-long':
      case 'validation-required':
      case 'terminal-quota':
      case 'non-retryable':
        return false
      case 'auth-stale':
        // Handled by the reonboard counter inside the request closure,
        // not by retryWithBackoff. Return false so we don't double-retry.
        return false
    }
    // Fallback: legacy status-based heuristic.
    if (this.status === 400) return false
    return this.status === 429 || this.status === 499 || (this.status >= 500 && this.status < 600)
  }
}

// ─── Retry / Backoff ─────────────────────────────────────────────
//
// Ported from gemini-cli packages/core/src/utils/retry.ts. Handles:
//   - 429, 499, 5xx HTTP errors
//   - Transient network errors (ECONNRESET, ETIMEDOUT, EPIPE, ENOTFOUND,
//     EAI_AGAIN, ECONNREFUSED, EPROTO, SSL-alert errors)
//   - Retry-After header (with +20% jitter to avoid thundering herd)
//   - Exponential backoff with ±30% jitter for non-quota errors
//   - AbortSignal propagation

const DEFAULT_MAX_ATTEMPTS = 5
const INITIAL_DELAY_MS = 2000
const MAX_DELAY_MS = 30_000

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPROTO',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_BAD_RECORD_MAC',
])

function getNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) return undefined
    if ('code' in current && typeof (current as any).code === 'string') {
      return (current as any).code
    }
    if (!('cause' in current)) return undefined
    current = (current as any).cause
  }
  return undefined
}

function isRetryableTransport(error: unknown): boolean {
  if (error instanceof GeminiApiError) return error.isRetryable
  const code = getNetworkErrorCode(error)
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true
  if (error instanceof Error && error.message.toLowerCase().includes('fetch failed')) return true
  return false
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  // Retry-After is either seconds or an HTTP date.
  const asSec = Number(value)
  if (!isNaN(asSec)) return Math.max(0, asSec * 1000)
  const asDate = Date.parse(value)
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now())
  return undefined
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = opts
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  let attempt = 0
  let currentDelay = INITIAL_DELAY_MS

  while (attempt < DEFAULT_MAX_ATTEMPTS) {
    attempt++
    try {
      return await fn()
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err

      if (!isRetryableTransport(err) || attempt >= DEFAULT_MAX_ATTEMPTS) throw err

      // Server-specified Retry-After wins if present.
      const retryAfter = err instanceof GeminiApiError ? err.retryAfterMs : undefined
      let waitMs: number
      if (retryAfter != null && retryAfter > 0) {
        const jitter = retryAfter * 0.2 * Math.random() // 0 to +20%
        waitMs = retryAfter + jitter
      } else {
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1) // ±30%
        waitMs = Math.max(0, currentDelay + jitter)
      }

      await delayWithAbort(waitMs, signal)
      currentDelay = Math.min(MAX_DELAY_MS, currentDelay * 2)
    }
  }

  throw new Error('Retry attempts exhausted')
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ─── Singleton ───────────────────────────────────────────────────

export const geminiApi = new GeminiApiClient()
