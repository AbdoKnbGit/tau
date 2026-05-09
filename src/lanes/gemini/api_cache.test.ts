/**
 * Gemini API-key cache parser tests.
 *
 * Run: bun run src/lanes/gemini/api_cache.test.ts
 */

import { parseGeminiApiSSE } from './api_sse.js'

type GeminiStreamChunk = {
  candidates?: Array<{
    content?: {
      role: string
      parts: Array<Record<string, unknown>>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
}

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

async function collect(chunks: string[]): Promise<GeminiStreamChunk[]> {
  const parsed: GeminiStreamChunk[] = []
  for await (const chunk of parseGeminiApiSSE<GeminiStreamChunk>(streamFromStrings(chunks))) {
    parsed.push(chunk)
  }
  return parsed
}

async function main(): Promise<void> {
  console.log('gemini api cache parser:')

  await test('parses multi-line final usage event with cache reads', async () => {
    const chunks = await collect([
      'data: {\n',
      'data: "usageMetadata":{\n',
      'data: "promptTokenCount":35862,\n',
      'data: "cachedContentTokenCount":15105,\n',
      'data: "candidatesTokenCount":90\n',
      'data: }}\n\n',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    const usage = chunks[0]?.usageMetadata
    assert(usage?.promptTokenCount === 35862, `promptTokenCount=${usage?.promptTokenCount}`)
    assert(usage?.cachedContentTokenCount === 15105, `cachedContentTokenCount=${usage?.cachedContentTokenCount}`)
    assert(usage?.candidatesTokenCount === 90, `candidatesTokenCount=${usage?.candidatesTokenCount}`)
  })

  await test('stops at done and keeps single-line chunks intact', async () => {
    const chunks = await collect([
      'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"usageMetadata":{"promptTokenCount":1}}\n\n',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    const text = (chunks[0]?.candidates?.[0]?.content?.parts?.[0] as { text?: string } | undefined)?.text
    assert(text === 'ok', `text=${text}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
