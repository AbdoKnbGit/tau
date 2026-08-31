/** Run: bun run src/services/api/transport_error.test.ts */

import assert from 'node:assert/strict'
import {
  getProviderHttpStatus,
  isRetryableProviderError,
  isRetryableProviderHttpStatus,
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

assert(isRetryableProviderHttpStatus(408))
assert(isRetryableProviderHttpStatus(429))
assert(isRetryableProviderHttpStatus(500))
assert(isRetryableProviderHttpStatus(529))
assert.equal(isRetryableProviderHttpStatus(401), false)
assert.equal(isRetryableProviderHttpStatus(413), false)

console.log('Provider transport error tests passed')
