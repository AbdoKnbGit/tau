/**
 * Gemini cache accounting adapter tests.
 *
 * Run: bun run src/services/api/adapters/gemini_to_anthropic_cache.test.ts
 */

import {
  geminiMessageToAnthropic,
  parseGeminiSSE,
  geminiStreamToAnthropicEvents,
  type GeminiStreamChunk,
} from './gemini_to_anthropic.js'
import type { AnthropicStreamEvent } from '../providers/base_provider.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

async function collect(stream: AsyncIterable<GeminiStreamChunk>): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = []
  for await (const event of geminiStreamToAnthropicEvents(stream, 'gemini-2.5-flash')) {
    events.push(event)
  }
  return events
}

function streamFromStrings(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

async function collectSSE(chunks: string[]): Promise<GeminiStreamChunk[]> {
  const parsed: GeminiStreamChunk[] = []
  for await (const chunk of parseGeminiSSE(streamFromStrings(chunks))) {
    parsed.push(chunk)
  }
  return parsed
}

async function main(): Promise<void> {
  console.log('gemini cache accounting:')

  await test('non-streaming usage separates uncached input from cache reads', () => {
    const message = geminiMessageToAnthropic({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 35862,
        cachedContentTokenCount: 15105,
        candidatesTokenCount: 90,
      },
    }, 'gemini-2.5-flash')

    assert(message.usage.input_tokens === 20757, `input_tokens=${message.usage.input_tokens}`)
    assert(message.usage.cache_read_input_tokens === 15105, `cache_read_input_tokens=${message.usage.cache_read_input_tokens}`)
    assert(message.usage.output_tokens === 90, `output_tokens=${message.usage.output_tokens}`)
  })

  await test('streaming final delta includes normalized cache usage', async () => {
    const events = await collect((async function* () {
      yield {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }
      yield {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 35862,
          cachedContentTokenCount: 15105,
          candidatesTokenCount: 90,
        },
      }
    })())

    const finalDelta = events.find(event => event.type === 'message_delta') as
      | Extract<AnthropicStreamEvent, { type: 'message_delta' }>
      | undefined

    assert(finalDelta !== undefined, 'missing final message_delta')
    assert(finalDelta.usage?.input_tokens === 20757, `input_tokens=${finalDelta.usage?.input_tokens}`)
    assert(finalDelta.usage?.cache_read_input_tokens === 15105, `cache_read_input_tokens=${finalDelta.usage?.cache_read_input_tokens}`)
    assert(finalDelta.usage?.output_tokens === 90, `output_tokens=${finalDelta.usage?.output_tokens}`)
  })

  await test('legacy API parser handles multi-line cache usage events', async () => {
    const chunks = await collectSSE([
      'data: {\n',
      'data: "usageMetadata":{\n',
      'data: "promptTokenCount":35862,\n',
      'data: "cachedContentTokenCount":15105,\n',
      'data: "candidatesTokenCount":90\n',
      'data: }}\n\n',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    assert(chunks[0]?.usageMetadata?.cachedContentTokenCount === 15105,
      `cachedContentTokenCount=${chunks[0]?.usageMetadata?.cachedContentTokenCount}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
