/** Run: bun run src/services/api/antigravityReplayGuard.test.ts */
import assert from 'node:assert/strict'
import { markAntigravityRetryHandled } from '../../lanes/gemini/antigravity_retry.js'
import { shouldSuppressAntigravityReplay } from './antigravityReplayGuard.js'

const exhausted = new Error('Gemini API error 429: RESOURCE_EXHAUSTED')
markAntigravityRetryHandled(exhausted)
let passed = 0
for (const provider of ['antigravity', 'gemini', 'openai', 'firstParty']) {
  for (const receivedEvent of [false, true]) {
    assert.equal(shouldSuppressAntigravityReplay(exhausted, provider, receivedEvent), true)
    passed++
  }
}
for (const error of [new TypeError('fetch failed'), new Error('Stream ended without receiving any events')]) {
  // Any event is conservative: a message_start can precede streamed thought,
  // text or tool data that the provider has already generated and charged.
  assert.equal(shouldSuppressAntigravityReplay(error, 'antigravity', true), true)
  assert.equal(shouldSuppressAntigravityReplay(error, 'antigravity', false), false)
  assert.equal(shouldSuppressAntigravityReplay(error, 'openai', true), false)
  passed += 3
}
console.log(`Antigravity replay guard: ${passed} cases passed`)
