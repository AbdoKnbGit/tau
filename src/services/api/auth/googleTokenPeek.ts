/**
 * Read a stored Google OAuth token without refreshing or persisting it.
 *
 * getGeminiOAuthToken renews a token that is close to expiry and writes the
 * result back. That is right for a request that must succeed and wrong for
 * anything a repaint can trigger, so a reader needs its own way in.
 *
 * Deliberately dependency-free: google_oauth.ts reaches the network and the
 * key store, and a caller that only wants to inspect a blob should not have to
 * load either.
 */

/** Mirrors StoredGoogleTokens in google_oauth.ts. */
type StoredGoogleTokens = {
  accessToken?: unknown
  refreshToken?: unknown
  expiresAt?: unknown
}

/** The same margin getGeminiOAuthToken treats a token as spent within. */
export const GOOGLE_TOKEN_MARGIN_MS = 5 * 60 * 1000

export type GoogleTokenPeek =
  /** A token good for long enough to make a request with. */
  | { kind: 'ready'; accessToken: string }
  /**
   * A credential exists but its token is spent, or the blob is unreadable.
   * Recoverable either way - the request path rewrites it - and crucially
   * distinct from 'none', because reporting a connected account as missing
   * is what turns a momentary gap into a settled "no quota".
   */
  | { kind: 'stale' }
  /** No credential of this kind is stored at all. */
  | { kind: 'none' }

export function readStoredGoogleToken(
  raw: string | null | undefined,
  now: number = Date.now(),
): GoogleTokenPeek {
  if (raw === null || raw === undefined || raw === '') return { kind: 'none' }

  let parsed: StoredGoogleTokens
  try {
    parsed = JSON.parse(raw) as StoredGoogleTokens
  } catch {
    // A corrupt blob is not proof that nothing is connected.
    return { kind: 'stale' }
  }

  const accessToken = parsed?.accessToken
  const expiresAt = parsed?.expiresAt
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { kind: 'stale' }
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { kind: 'stale' }
  }
  if (now > expiresAt - GOOGLE_TOKEN_MARGIN_MS) return { kind: 'stale' }

  return { kind: 'ready', accessToken }
}
