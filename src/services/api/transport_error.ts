import { APIConnectionError } from '@anthropic-ai/sdk'

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
