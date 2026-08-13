/**
 * Antigravity exhausted-network-retry regressions.
 *
 * Run: bun run src/lanes/gemini/antigravity_network_retry.test.ts
 */

import assert from 'node:assert/strict'
import { APIConnectionError } from '@anthropic-ai/sdk'
import { ANTIGRAVITY_MODEL_IDS } from '../../services/api/providers/gemini_code_assist.js'
import { geminiApi, TAU_STABLE_SESSION_ID_FIELD } from './api.js'
import { GeminiLane } from './loop.js'

async function main(): Promise<void> {
  const originalStream = geminiApi.streamGenerateContent
  const captured: string[] = []
  const stableSessionIds: unknown[] = []

  geminiApi.streamGenerateContent = (async function* (request: Record<string, unknown>) {
    captured.push(JSON.stringify(request))
    stableSessionIds.push(request[TAU_STABLE_SESSION_ID_FIELD])
    throw new TypeError('fetch failed')
  }) as typeof geminiApi.streamGenerateContent

  try {
    for (const model of ANTIGRAVITY_MODEL_IDS) {
      captured.length = 0
      stableSessionIds.length = 0

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const events = []
        let failure: unknown
        try {
          const stream = new GeminiLane().streamAsProvider({
            model,
            messages: [{ role: 'user', content: 'keep this cache prefix stable' }],
            system: 'You are a coding agent.',
            tools: [],
            max_tokens: 1024,
            thinking: { type: 'disabled' },
            signal: new AbortController().signal,
            sessionId: 'session-fixed',
            providerHint: 'antigravity',
          })
          for await (const event of stream) events.push(event)
        } catch (error) {
          failure = error
        }

        assert(failure instanceof APIConnectionError, `${model}: network failure was not retryable`)
        assert.match(failure.message, /Antigravity API connection error .*fetch failed/)
        assert.equal(events.length, 0, `${model}: failed attempt leaked an assistant event`)
      }

      assert.equal(captured.length, 2, `${model}: expected two attempts`)
      assert.equal(captured[1], captured[0], `${model}: retry changed serialized prompt bytes`)
      assert.equal(stableSessionIds[0], stableSessionIds[1], `${model}: retry changed session affinity`)
      assert.equal(typeof stableSessionIds[0], 'string', `${model}: stable session affinity missing`)
    }

    console.log('Antigravity network retry tests passed')
  } finally {
    geminiApi.streamGenerateContent = originalStream
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
