/**
 * Provider-wide pre-response network retry regressions.
 *
 * Run: bun run src/lanes/openai-compat/network_retry.test.ts
 */

import assert from 'node:assert/strict'
import { APIConnectionError } from '@anthropic-ai/sdk'
import type {
  AnthropicStreamEvent,
  BaseProvider,
} from '../../services/api/providers/base_provider.js'
import { CommandCodeProvider } from '../../services/api/providers/commandcode_provider.js'
import { OpenAIProvider } from '../../services/api/providers/openai_provider.js'
import { isRetryableNetworkError } from '../../services/api/transport_error.js'
import { OpenAICompatLane } from './loop.js'
import { TRANSFORMERS, type ProviderId } from './transformers/index.js'

type CapturedPost = {
  url: string
  headers: HeadersInit | undefined
  rawBody: string
}

async function runFailedAttempt(
  lane: OpenAICompatLane,
  provider: ProviderId,
): Promise<{ error: unknown; events: AnthropicStreamEvent[] }> {
  const events: AnthropicStreamEvent[] = []
  let error: unknown
  try {
    const stream = lane.streamAsProvider({
      model: provider === 'opencode' || provider === 'opencodego'
        ? 'glm-5.2'
        : 'test-model',
      messages: [{ role: 'user', content: 'keep this prompt prefix stable' }],
      system: 'You are a coding agent.',
      tools: [],
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: provider,
    })
    for await (const event of stream) events.push(event)
  } catch (caught) {
    error = caught
  }
  return { error, events }
}

async function verifyLegacyProviderRetryBoundary(
  provider: BaseProvider,
  model: string,
): Promise<void> {
  const posts: CapturedPost[] = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    posts.push({
      url: String(url),
      headers: init?.headers,
      rawBody: String(init?.body ?? ''),
    })
    throw new TypeError('fetch failed')
  }) as typeof fetch

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let error: unknown
    try {
      await provider.stream({
        model,
        messages: [{ role: 'user', content: 'keep this prompt prefix stable' }],
        system: 'You are a coding agent.',
        tools: [],
        max_tokens: 1024,
        thinking: { type: 'disabled' },
        sessionId: 'session-fixed',
      })
    } catch (caught) {
      error = caught
    }
    assert(isRetryableNetworkError(error), `${provider.name}: raw fetch failure was not retryable`)
  }

  assert.equal(posts.length, 2, `${provider.name}: expected one POST per attempt`)
  assert.equal(posts[1]!.url, posts[0]!.url, `${provider.name}: retry changed the endpoint`)
  assert.equal(
    posts[1]!.rawBody,
    posts[0]!.rawBody,
    `${provider.name}: retry changed serialized prompt bytes`,
  )
}

async function main(): Promise<void> {
  const oldFetch = globalThis.fetch
  const oldOpenCodeClient = process.env.OPENCODE_CLIENT
  process.env.OPENCODE_CLIENT = 'opencode-tau/test'

  try {
    for (const provider of Object.keys(TRANSFORMERS) as ProviderId[]) {
      const lane = new OpenAICompatLane()
      lane.registerProvider(provider, 'test-key', `https://${provider}.example/v1`)
      const posts: CapturedPost[] = []

      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          posts.push({
            url: String(url),
            headers: init?.headers,
            rawBody: String(init?.body ?? ''),
          })
        }
        throw new TypeError('fetch failed')
      }) as typeof fetch

      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await runFailedAttempt(lane, provider)
          assert(
            result.error instanceof APIConnectionError,
            `${provider}: connection failure was not retryable (${String(result.error)})`,
          )
          assert.match(
            result.error.message,
            new RegExp(`${provider} API connection error: fetch failed`, 'i'),
          )
          assert.equal(
            result.events.length,
            0,
            `${provider}: failed attempt leaked an assistant event`,
          )
        }

        assert.equal(posts.length, 2, `${provider}: expected one POST per attempt`)
        assert.equal(posts[1]!.url, posts[0]!.url, `${provider}: retry changed the endpoint`)
        assert.equal(
          posts[1]!.rawBody,
          posts[0]!.rawBody,
          `${provider}: retry changed serialized prompt bytes`,
        )
      } finally {
        lane.unregisterProvider(provider)
      }
    }

    const abortLane = new OpenAICompatLane()
    abortLane.registerProvider('fireworks', 'test-key', 'https://fireworks.example/v1')
    globalThis.fetch = (async (): Promise<Response> => {
      throw new DOMException('The operation was aborted', 'AbortError')
    }) as unknown as typeof fetch
    const aborted = await runFailedAttempt(abortLane, 'fireworks')
    assert(aborted.error instanceof DOMException)
    assert.equal(aborted.error.name, 'AbortError')
    assert(!(aborted.error instanceof APIConnectionError), 'abort must not become retryable')
    assert.equal(aborted.events.length, 0, 'abort leaked an assistant event')
    abortLane.unregisterProvider('fireworks')

    // Native lanes are the default, but the central retry controller must also
    // cover raw-fetch legacy paths and providers with no lane (Command Code).
    await verifyLegacyProviderRetryBoundary(
      new OpenAIProvider({ apiKey: 'test-key', baseUrl: 'https://openai.example/v1' }),
      'gpt-4.1',
    )
    await verifyLegacyProviderRetryBoundary(
      new CommandCodeProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
      }),
      'moonshotai/Kimi-K2.6',
    )

    console.log('OpenAI-compatible network retry tests passed')
  } finally {
    globalThis.fetch = oldFetch
    if (oldOpenCodeClient === undefined) delete process.env.OPENCODE_CLIENT
    else process.env.OPENCODE_CLIENT = oldOpenCodeClient
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
