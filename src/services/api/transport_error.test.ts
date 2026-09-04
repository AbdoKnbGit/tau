/** Run: bun run src/services/api/transport_error.test.ts */

import assert from 'node:assert/strict'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import {
  getAPIUserAbortError,
  getBoundedProviderRetryAfterMs,
  getProviderHttpStatus,
  isRetryableProviderError,
  isRetryableProviderHttpStatus,
  isTerminalProviderQuotaError,
  ProviderHttpError,
  throwRetryableProviderHttpError,
} from './transport_error.js'

const response = new Response('throttled', {
  status: 429,
  headers: { 'retry-after': '3' },
})

let failure: unknown
try {
  throwRetryableProviderHttpError('Gemini', response, 'Resource has been exhausted')
} catch (error) {
  failure = error
}

assert(failure instanceof ProviderHttpError)
assert.equal(failure.status, 429)
assert.equal(failure.headers?.get('retry-after'), '3')
assert.equal(getProviderHttpStatus(failure), 429)
assert(isRetryableProviderError(failure))

const classifiedTerminal = Object.assign(new Error('Gemini API error 429: credits exhausted'), {
  status: 429,
  isRetryable: false,
})
assert.equal(isRetryableProviderError(classifiedTerminal), false)

const classifiedTransientQuota = Object.assign(
  new Error('Gemini API error 429: quota exceeded; RESOURCE_EXHAUSTED'),
  {
    status: 429,
    isRetryable: true,
    retryAfterMs: 2_000,
    kind: 'retryable-quota',
  },
)
assert.equal(isRetryableProviderError(classifiedTransientQuota), true)
assert.equal(isTerminalProviderQuotaError(classifiedTransientQuota), false)

const genericTerminalQuota = Object.assign(
  new Error('OpenAI API error 429: insufficient_quota'),
  { status: 429, isRetryable: true },
)
assert.equal(isTerminalProviderQuotaError(genericTerminalQuota), true)

assert.equal(getBoundedProviderRetryAfterMs({ retryAfterMs: 2_500 }), 2_500)
assert.equal(getBoundedProviderRetryAfterMs({ retryAfterMs: 86_400_000 }), 32_000)
// A 0 ms hint means "the lane retried this inline", not "retry with no delay".
// Reporting it would answer a 429 with delay 0 and burn the whole retry budget
// in a hot loop, so it must fall through to exponential backoff.
assert.equal(getBoundedProviderRetryAfterMs({ retryAfterMs: 0 }), null)
assert.equal(getBoundedProviderRetryAfterMs({ retryAfterMs: -1 }), null)
assert.equal(getBoundedProviderRetryAfterMs({}), null)
assert.equal(getBoundedProviderRetryAfterMs(new Error('no hint')), null)

assert(isRetryableProviderHttpStatus(408))
assert(isRetryableProviderHttpStatus(429))
assert(isRetryableProviderHttpStatus(500))
assert(isRetryableProviderHttpStatus(529))
assert.equal(isRetryableProviderHttpStatus(401), false)
assert.equal(isRetryableProviderHttpStatus(413), false)

const abortController = new AbortController()
abortController.abort()
assert(
  getAPIUserAbortError(
    new DOMException('Aborted', 'AbortError'),
    abortController.signal,
  ) instanceof APIUserAbortError,
)

console.log('Provider transport error tests passed')
