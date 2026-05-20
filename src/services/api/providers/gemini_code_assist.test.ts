/**
 * Code Assist SSE parser tests.
 *
 * Run: bun run src/services/api/providers/gemini_code_assist.test.ts
 */

import {
  ANTIGRAVITY_MODELS,
  codeAssistGenerationBases,
  executorForModel,
  getAntigravityModelDisplayName,
  parseCodeAssistSSE,
  resolveAntigravityWireModel,
  wrapForCodeAssist,
} from './gemini_code_assist.js'
import type { GeminiStreamChunk } from '../adapters/gemini_to_anthropic.js'

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
  for await (const chunk of parseCodeAssistSSE(streamFromStrings(chunks))) {
    parsed.push(chunk)
  }
  return parsed
}

async function main(): Promise<void> {
  console.log('gemini code assist sse parser:')

  await test('parses multi-line usage event with cache reads', async () => {
    const chunks = await collect([
      'data: {"response":{\n',
      'data: "usageMetadata":{\n',
      'data: "promptTokenCount":35862,\n',
      'data: "cachedContentTokenCount":15105,\n',
      'data: "candidatesTokenCount":90\n',
      'data: }}}\n\n',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    const usage = chunks[0]?.usageMetadata
    assert(usage?.promptTokenCount === 35862, `promptTokenCount=${usage?.promptTokenCount}`)
    assert(usage?.cachedContentTokenCount === 15105, `cachedContentTokenCount=${usage?.cachedContentTokenCount}`)
    assert(usage?.candidatesTokenCount === 90, `candidatesTokenCount=${usage?.candidatesTokenCount}`)
  })

  await test('keeps single-line event and done handling intact', async () => {
    const chunks = await collect([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"o',
      'k"}]}}]}}\n\n',
      'data: [DONE]\n\n',
      'data: {"response":{"usageMetadata":{"promptTokenCount":1}}}\n\n',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    const text = chunks[0]?.candidates?.[0]?.content?.parts?.[0]?.text
    assert(text === 'ok', `text=${text}`)
  })

  await test('flushes final unterminated event', async () => {
    const chunks = await collect([
      'data: {"response":{"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":4}}}',
    ])

    assert(chunks.length === 1, `expected 1 chunk, got ${chunks.length}`)
    assert(chunks[0]?.usageMetadata?.cachedContentTokenCount === 4, 'cache read tokens missing')
  })

  await test('routes Gemini 3.5 Flash variants through Antigravity', async () => {
    assert(
      ANTIGRAVITY_MODELS.some(model => model.id === 'gemini-3.5-flash-high'),
      'missing Gemini 3.5 Flash High from Antigravity catalog',
    )
    assert(
      ANTIGRAVITY_MODELS.some(model => model.id === 'gemini-3.5-flash-medium'),
      'missing Gemini 3.5 Flash Medium from Antigravity catalog',
    )
    assert(executorForModel('gemini-3.5-flash-high') === 'antigravity', 'high variant must use Antigravity')
    assert(executorForModel('gemini-3.5-flash-medium') === 'antigravity', 'medium variant must use Antigravity')
    assert(executorForModel('gemini-3-flash') === 'antigravity', 'Gemini 3 Flash must use Antigravity')
    assert(executorForModel('gemini-3-flash-agent') === 'cli', 'backend wire key must not be exposed as a public model id')
    assert(executorForModel('gemini-3.5-flash-low') === 'cli', 'backend wire key must not be exposed as a public model id')
    assert(
      getAntigravityModelDisplayName('claude-opus-4-6-thinking') === 'Claude Opus 4.6',
      'Claude Opus label should not include thinking/via suffix',
    )
  })

  await test('wraps Gemini 3.5 Flash variants with the Antigravity wire model', async () => {
    assert(
      resolveAntigravityWireModel('gemini-3.5-flash-medium') === 'gemini-3.5-flash-low',
      'medium variant must resolve to the Antigravity backend Flash model',
    )
    assert(
      resolveAntigravityWireModel('gemini-3.5-flash-high') === 'gemini-3-flash-agent',
      'high variant must resolve to the Antigravity backend Flash model',
    )

    const wrapped = wrapForCodeAssist('gemini-3.5-flash-medium', 'project-id', {
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true },
        maxOutputTokens: 100,
      },
      safetySettings: [],
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })

    assert(wrapped.model === 'gemini-3.5-flash-low', `wire model=${wrapped.model}`)
    assert(wrapped.userAgent === 'antigravity', 'missing Antigravity userAgent')
    assert(wrapped.requestType === 'agent', 'Flash variants should use agent requestType')
    const request = wrapped.request as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string }; maxOutputTokens?: number }
      safetySettings?: unknown
    }
    assert(request.generationConfig?.thinkingConfig?.thinkingLevel === 'medium', 'thinking level was not preserved')
    assert(!('safetySettings' in request), 'safety settings should be stripped')
    assert(request.generationConfig?.maxOutputTokens === undefined, 'maxOutputTokens should be stripped for Gemini')
  })

  await test('keeps Antigravity generation endpoint fallbacks scoped to Antigravity', async () => {
    const antigravityBases = codeAssistGenerationBases('antigravity')
    assert(antigravityBases.length === 3, `antigravity bases=${antigravityBases.length}`)
    assert(
      antigravityBases[0] === 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal',
      `primary Antigravity base=${antigravityBases[0]}`,
    )
    assert(
      antigravityBases[2] === 'https://cloudcode-pa.googleapis.com/v1internal',
      `fallback Antigravity base=${antigravityBases[2]}`,
    )
    const cliBases = codeAssistGenerationBases('cli')
    assert(cliBases.length === 1, `cli bases=${cliBases.length}`)
    assert(cliBases[0] === 'https://cloudcode-pa.googleapis.com/v1internal', `cli base=${cliBases[0]}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
