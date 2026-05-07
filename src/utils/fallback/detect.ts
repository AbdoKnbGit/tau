import { APIError } from '@anthropic-ai/sdk'
import type { AssistantMessage } from '../../types/message.js'

/**
 * Detection for "this error is the kind that fallback models can fix".
 *
 * /fallback recovers from provider-side API/auth/quota/usage/status failures
 * where retrying the same prompt against a different provider/model has a real
 * chance of succeeding.
 *
 * Intentionally excluded:
 *   - tool/Read/Write failures
 *   - MCP server failures
 *   - fetch/connection/timeout/abort errors
 *   - 400 invalid_request cases like prompt-too-long, PDFs, images, and
 *     tool_use mismatches
 *   - 404 model-not-found
 *   - max_output_tokens
 */

const FALLBACK_ELIGIBLE_API_ERRORS = new Set<string>([
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'server_error',
])

const FALLBACK_ELIGIBLE_STATUSES = new Set<number>([
  401,
  402,
  403,
  429,
  529,
])

function isFallbackStatus(status: number): boolean {
  return (
    FALLBACK_ELIGIBLE_STATUSES.has(status) ||
    (status >= 500 && status < 600)
  )
}

function hasOperationalFailureText(text: string): boolean {
  return (
    /\b(?:fetch failed|failed to fetch)\b/i.test(text) ||
    /\b(?:network|connection|timeout|timed out|abort(?:ed|error)?)\b/i.test(
      text,
    ) ||
    /\b(?:ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/i.test(text) ||
    /\bMCP\b/i.test(text) ||
    /\b(?:operation failed|failed operation)\b/i.test(text) ||
    /\btool[_\s-]?(?:use|result)\b/i.test(text) ||
    /\b(?:prompt is too long|request too large|image|pdf)\b/i.test(text)
  )
}

function hasProviderAuthContext(text: string): boolean {
  return /\b(?:api|provider|model|credential|credentials|token|api key|account|organization|project|workspace)\b/i.test(
    text,
  )
}

function extractFallbackStatusFromText(text: string): number | null {
  const patterns = [
    /\bAPI\s+(?:error|Error)\s*(?:[:#]|\s)\s*(\d{3})\b/i,
    /\bHTTP\s+(?:status\s*)?(?:code\s*)?(?:[:#]|\s)\s*(\d{3})\b/i,
    /\bstatus\s*(?:code\s*)?(?:[:#=]|\s)\s*(\d{3})\b/i,
    /\brequest failed\s*\((\d{3})\)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return Number.parseInt(match[1], 10)
    }
  }
  return null
}

function hasProviderLimitOrAuthText(text: string): boolean {
  return (
    /\brate[-_\s]?limit(?:ed|s)?\b/i.test(text) ||
    /\bratelimit(?:ed|s)?\b/i.test(text) ||
    /\bquota\b/i.test(text) ||
    /\busage[-_\s]?(?:quota|limit|limits|cap)\b/i.test(text) ||
    /\bextra usage\b/i.test(text) ||
    /\bbilling\b/i.test(text) ||
    /\bcredit balance\b/i.test(text) ||
    /\bresource package\b/i.test(text) ||
    /\binsufficient[_\s-]?(?:quota|balance|credits?)\b/i.test(text) ||
    /余额不足|无可用资源包|请充值/.test(text) ||
    /\bpayment required\b/i.test(text) ||
    /\binvalid api key\b/i.test(text) ||
    /\bapi key\b.*\b(?:invalid|expired)\b/i.test(text) ||
    /\boauth token\b.*\b(?:revoked|expired|invalid)\b/i.test(text) ||
    (hasProviderAuthContext(text) &&
      /\b(?:auth(?:entication|orization)? failed|unauthorized|permission denied)\b/i.test(
        text,
      ))
  )
}

/**
 * Match provider-side overload / 5xx / account-limit patterns in surfaced
 * error text. This covers third-party providers that throw plain Error objects
 * and later become synthetic AssistantMessages with `error: 'unknown'`.
 */
function hasFallbackEligibleProviderText(text: string): boolean {
  if (!text || hasOperationalFailureText(text)) {
    return false
  }
  const status = extractFallbackStatusFromText(text)
  if (status !== null && isFallbackStatus(status)) {
    return true
  }
  return (
    /\boverloaded_error\b/i.test(text) ||
    /\binternal_server_error\b/i.test(text) ||
    /\bRepeated\s+529\b/i.test(text) ||
    /\bcapacity[-_\s]?off[-_\s]?switch\b/i.test(text) ||
    hasProviderLimitOrAuthText(text)
  )
}

function hasLaneProviderErrorPrefix(text: string): boolean {
  return /^(?:openrouter|ollama|cline|kilo|kiro|iflow|kilocode|deepseek|glm|groq|mistral|nim|copilot|generic)\s+API\s+error\s+\d{3}\b/i.test(
    text.trim(),
  )
}

function hasKnownLaneAccountLimitText(text: string): boolean {
  const normalized = text.trim()
  const compact = normalized.replace(/\s+/g, ' ')
  return (
    /^GitHub Copilot rejected this request because the current account has no quota left\b/i.test(
      normalized,
    ) ||
    /^Error:\s*Named models unavailable\s+Free plans can only use Auto\./i.test(
      compact,
    ) ||
    /^You've hit your usage limit\b.*\bGet Cursor Pro\b.*\bAgent usage\b/i.test(
      compact,
    ) ||
    (/^Cursor request failed\s*\(\d{3}\)\.?$/i.test(normalized) &&
      hasFallbackEligibleProviderText(normalized))
  )
}

function getAssistantErrorText(message: AssistantMessage): string {
  const content = message.message?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Native third-party lanes emit provider HTTP failures as ordinary assistant
 * text blocks, not createAssistantAPIErrorMessage(). Keep this narrow: only
 * lane-owned error prefixes and known account-limit messages may enter the
 * fallback path.
 */
export function isFallbackEligibleLaneProviderErrorMessage(
  message: AssistantMessage,
): boolean {
  if (!message || message.isApiErrorMessage === true) {
    return false
  }
  const text = getAssistantErrorText(message)
  if (!text) {
    return false
  }
  if (hasLaneProviderErrorPrefix(text)) {
    return hasFallbackEligibleProviderText(text)
  }
  return hasKnownLaneAccountLimitText(text)
}

/**
 * Should this assistant API error message trigger the configured fallback chain?
 */
export function isFallbackEligibleAPIErrorMessage(
  message: AssistantMessage,
): boolean {
  if (!message || message.isApiErrorMessage !== true) {
    return false
  }
  const errorKind = String(message.error ?? '')
  if (FALLBACK_ELIGIBLE_API_ERRORS.has(errorKind)) {
    return true
  }
  if (errorKind === 'unknown') {
    const text = getAssistantErrorText(message) || message.errorDetails || ''
    return hasFallbackEligibleProviderText(text)
  }
  return false
}

/**
 * Should this thrown error trigger the configured fallback chain? Used in the
 * outer try/catch when a provider-side error escapes streaming as a thrown
 * exception.
 */
export function isFallbackEligibleThrownError(error: unknown): boolean {
  if (error instanceof APIError) {
    const status = error.status
    if (typeof status === 'number' && isFallbackStatus(status)) {
      return true
    }
    return hasFallbackEligibleProviderText(String(error.message ?? ''))
  }
  if (error instanceof Error) {
    return hasFallbackEligibleProviderText(error.message)
  }
  return false
}

/**
 * Truncate surfaced error text so fallback system messages stay compact.
 */
export function truncateFallbackErrorMessage(message: string): string {
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= 300) return normalized
  return `${normalized.slice(0, 297)}...`
}

export function getAssistantAPIErrorText(message: AssistantMessage): string {
  const text = getAssistantErrorText(message).trim()
  return text || String(message.errorDetails ?? message.error ?? 'Model request failed')
}
