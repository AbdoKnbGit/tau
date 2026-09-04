import { APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk'

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 499])

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

const TERMINAL_QUOTA_PATTERN =
  /quota (?:exhausted|exceeded)|exceeded (?:its|your) (?:usage |current )?quota|insufficient_quota|exhausted your capacity|quota will reset after \d+h|FreeUsageLimitError/i

export const MAX_TYPED_PROVIDER_RETRY_AFTER_MS = 32_000

function getNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined
    if ('code' in current && typeof current.code === 'string') return current.code
    if (!('cause' in current)) return undefined
    current = current.cause
  }
  return undefined
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError')
}

/** Normalize setup-time cancellation to the error the query loop suppresses. */
export function getAPIUserAbortError(
  error: unknown,
  signal?: AbortSignal,
): APIUserAbortError | null {
  if (error instanceof APIUserAbortError) return error
  return signal?.aborted ? new APIUserAbortError() : null
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true
  const code = getNetworkErrorCode(error)
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return message.includes('fetch failed') || message.includes('failed to fetch')
}

export function createRetryableConnectionError(
  messagePrefix: string,
  error: unknown,
): APIConnectionError {
  if (error instanceof APIConnectionError) return error
  const cause = error instanceof Error ? error : new Error(String(error))
  return new APIConnectionError({
    message: `${messagePrefix}: ${cause.message}`,
    cause,
  })
}

/**
 * HTTP failure raised by a non-Anthropic provider before it produced model
 * output. Keeping the numeric status and response headers on the error lets
 * the shared retry controller honor Retry-After without parsing display text.
 */
export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    public readonly body: string,
    public readonly headers?: Headers,
    message?: string,
  ) {
    super(message ?? `${provider} API error ${status}${body ? `: ${body.slice(0, 500)}` : ''}`)
    this.name = 'ProviderHttpError'
  }
}

export function getProviderHttpStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const status = (error as Error & { status?: unknown }).status
  if (typeof status === 'number' && Number.isInteger(status)) return status

  const match = error.message.match(/API error\s+(\d{3})/i)
  return match ? Number.parseInt(match[1]!, 10) : null
}

export function isRetryableProviderHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || (status >= 500 && status < 600)
}

/**
 * Provider SDK errors (GeminiApiError, QwenApiError, CodexApiError) expose an
 * isRetryable getter. Prefer that classification so terminal quota failures
 * are not retried merely because they use HTTP 429.
 */
export function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const classified = (error as Error & { isRetryable?: unknown }).isRetryable
  const status = getProviderHttpStatus(error)
  if (classified === false) return false
  return status !== null && isRetryableProviderHttpStatus(status)
}

/**
 * Detect long-lived account/project quota exhaustion without overriding a
 * provider that exposes a more specific transient quota classification.
 */
export function isTerminalProviderQuotaError(error: unknown): boolean {
  if (!(error instanceof Error) || !TERMINAL_QUOTA_PATTERN.test(error.message)) {
    return false
  }
  const classified = (error as Error & { isRetryable?: unknown }).isRetryable
  const kind = (error as Error & { kind?: unknown }).kind
  return !(
    classified === true && (kind === 'retryable-quota' || kind === 'transient')
  )
}

/**
 * Keep native RetryInfo from turning a bounded outer retry into a long hang.
 *
 * A zero (or negative) hint is deliberately reported as "no hint". Lanes use
 * `retryAfterMs: 0` to mean "retry immediately in the INNER loop after a side
 * effect" (Gemini's re-onboard and thought-signature strip both do), and
 * `Retry-After` parses to 0 for a header of `0` or an already-past date. If
 * that reached the outer controller it would answer a 429 with a 0 ms delay
 * and hammer the provider for the whole retry budget; falling through to
 * exponential backoff is the only safe reading.
 */
export function getBoundedProviderRetryAfterMs(
  error: unknown,
  maxMs = MAX_TYPED_PROVIDER_RETRY_AFTER_MS,
): number | null {
  const retryAfterMs = (error as { retryAfterMs?: unknown } | null)
    ?.retryAfterMs
  if (
    typeof retryAfterMs !== 'number' ||
    !Number.isFinite(retryAfterMs) ||
    retryAfterMs <= 0
  ) {
    return null
  }
  return Math.min(retryAfterMs, maxMs)
}

/** Throw a retryable pre-response HTTP failure without creating an assistant turn. */
export function throwRetryableProviderHttpError(
  provider: string,
  response: Pick<Response, 'status' | 'headers'>,
  body: string,
): void {
  if (!isRetryableProviderHttpStatus(response.status)) return
  throw new ProviderHttpError(provider, response.status, body, response.headers)
}
