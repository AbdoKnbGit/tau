import { APIConnectionError } from '@anthropic-ai/sdk'

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

/** Throw a retryable pre-response HTTP failure without creating an assistant turn. */
export function throwRetryableProviderHttpError(
  provider: string,
  response: Pick<Response, 'status' | 'headers'>,
  body: string,
): void {
  if (!isRetryableProviderHttpStatus(response.status)) return
  throw new ProviderHttpError(provider, response.status, body, response.headers)
}
