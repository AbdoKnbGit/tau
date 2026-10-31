/** Run: bun run src/lanes/shared/provider_failure.test.ts */
import assert from 'node:assert/strict'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { ProviderFailureError, isRetryableNetworkError } from '../../services/api/transport_error.js'
import { isFallbackEligibleAPIErrorMessage } from '../../utils/fallback/detect.js'
import { LaneBackedProvider } from '../provider-bridge.js'
import type { Lane } from '../types.js'
import { isProviderFailureBlock, providerFailureEvents } from './provider_failure.js'

function laneOf(events: AnthropicStreamEvent[]): Lane {
  return {
    name: 'kiro',
    displayName: 'Fixture',
    resolveModel: (model: string) => model,
    async *streamAsProvider() {
      for (const event of events) yield event
      return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0 }
    },
  } as unknown as Lane
}

const start: AnthropicStreamEvent = {
  type: 'message_start',
  message: { id: 'fixture', type: 'message', role: 'assistant', content: [], model: 'fixture', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
}
const end: AnthropicStreamEvent[] = [
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
  { type: 'message_stop' },
]
const text = (index: number, value: string): AnthropicStreamEvent[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } },
  { type: 'content_block_stop', index },
]
const params = { model: 'fixture', messages: [], system: '', max_tokens: 10 } as never

// The failure streams like any text, so a terminal still shows it as it arrives.
const [opening, delta, closing] = providerFailureEvents(3, 'kiro API error 403: refused')
assert.equal(opening!.type, 'content_block_start')
assert.equal(opening!.index, 3)
assert.equal(isProviderFailureBlock(opening!.content_block), true)
assert.equal(delta!.delta?.text, 'kiro API error 403: refused')
assert.equal(closing!.type, 'content_block_stop')

assert.equal(isProviderFailureBlock({ type: 'text', text: 'kiro API error 403: quoted by the model' }), false,
  'the words alone do not make a failure')
assert.equal(isProviderFailureBlock(null), false)
assert.equal(isProviderFailureBlock(undefined), false)

// Asked for one finished message, a failure must not read as the model's answer.
const failing = new LaneBackedProvider(laneOf([start, ...providerFailureEvents(0, '\n\nkiro API error 403: refused'), ...end]), 'kiro')
await assert.rejects(failing.create(params), (error: Error) => {
  assert(error instanceof ProviderFailureError)
  assert.equal(error.message, 'kiro API error 403: refused')
  return true
})

const answering = new LaneBackedProvider(laneOf([start, ...text(0, 'kiro API error 403: quoted by the model'), ...end]), 'kiro')
const answer = await answering.create(params)
assert.equal(answer.content[0]?.text, 'kiro API error 403: quoted by the model')

// No layer may send a failed request again, even when its words look like a network error.
const failure = new ProviderFailureError('kiro API error 500: fetch failed')
assert.equal(failure.isRetryable, false)
assert.equal(isRetryableNetworkError(failure), false)

// A configured /fallback chain goes by the flag, on any provider, and never by the words alone.
const failureMessage = (value: string, isApiErrorMessage = true) => ({
  isApiErrorMessage,
  error: 'unknown',
  message: { content: [{ type: 'text', text: value }] },
}) as never
assert.equal(isFallbackEligibleAPIErrorMessage(failureMessage(
  'Codex API error: OpenAI Responses API error 429: The usage limit has been reached. Resets in 2h 14m.',
)), true)
assert.equal(isFallbackEligibleAPIErrorMessage(failureMessage(
  'glm API error 429: BigModel balance is insufficient or no resource package is available.',
)), true)
assert.equal(isFallbackEligibleAPIErrorMessage(failureMessage(
  'Cursor rejected the request: named Claude models are not available on the free plan',
)), true)
assert.equal(isFallbackEligibleAPIErrorMessage(failureMessage('kiro API error 429: quota exceeded', false)), false,
  'a reply that quotes an error is a reply')

console.log('provider failure checks passed')
