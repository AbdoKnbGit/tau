/** Run: bun run src/lanes/gemini/antigravity_retry_lane.test.ts */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { markAntigravityRetryHandled } from './antigravity_retry.js'

delete process.env.TAU_CACHE_DEBUG
const streamApi = { supportsServerCache: () => false, streamGenerateContent: async function* (): AsyncGenerator<any> {} }
mock.module('./api.js', () => ({
  geminiApi: streamApi,
  isGeminiRetryableNetworkError: () => true,
  TAU_QUERY_SOURCE_FIELD: '__tauQuerySource',
  TAU_STABLE_SESSION_ID_FIELD: '__tauStableSessionId',
}))
const { GeminiLane } = await import('./loop.js')
let passed = 0
try {
  for (const output of [undefined, 'text', 'thought', 'tool']) {
    const failure = new TypeError('fetch failed')
    markAntigravityRetryHandled(failure)
    let calls = 0
    streamApi.streamGenerateContent = async function* () {
      calls++
      if (output) {
        const part = output === 'tool'
          ? { functionCall: { name: 'lookup', args: { key: 'one' } } }
          : { text: 'partial', ...(output === 'thought' ? { thought: true } : {}) }
        yield { candidates: [{ content: { role: 'model', parts: [part] } }] }
      }
      throw failure
    }
    const events: any[] = []
    await assert.rejects(async () => {
      for await (const event of new GeminiLane().streamAsProvider({
        model: 'gemini-3.8-flash-low', providerHint: 'antigravity', sessionId: '-retry-guard',
        messages: [{ role: 'user', content: 'Reply OK.' }], system: 'Be concise.', tools: [],
        max_tokens: 128, thinking: { type: 'disabled' }, signal: new AbortController().signal,
      })) events.push(event)
    }, error => error === failure)
    assert.equal(calls, 1, 'lane restarted an exhausted native request')
    if (!output) assert.deepEqual(events, [], 'setup failure became an assistant event')
    assert.equal(events.some(event => String(event.delta?.text ?? '').includes('fetch failed')), false,
      'terminal error leaked into generated text')
    passed++
  }
  console.log(`Antigravity lane retry propagation: ${passed} cases passed`)
} finally {
  mock.restore()
}
