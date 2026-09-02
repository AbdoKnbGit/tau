/**
 * Gemini output-cap truncation regressions.
 *
 * Companion to ../shared/truncation.test.ts, which covers the rest of the
 * lanes. Gemini gets its own file because importing this lane pulls in
 * entrypoints/agentSdkTypes, whose `./sdk/runtimeTypes.js` does not resolve
 * standalone (the same pre-existing breakage that stops
 * antigravity_network_retry.test.ts from running); keeping it here means that
 * blocker takes down one file instead of the whole suite.
 *
 * Run:  bun run src/lanes/gemini/truncation.test.ts
 */

import assert from 'node:assert/strict'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { geminiApi } from './api.js'
import { GeminiLane } from './loop.js'

function geminiChunk(parts: unknown[], finishReason?: string): unknown {
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 8192 },
  }
}

async function runGeminiLane(chunks: unknown[]): Promise<AnthropicStreamEvent[]> {
  const original = geminiApi.streamGenerateContent
  geminiApi.streamGenerateContent = (async function* () {
    for (const c of chunks) yield c as any
  }) as typeof geminiApi.streamGenerateContent
  try {
    const events: AnthropicStreamEvent[] = []
    const stream = new GeminiLane().streamAsProvider({
      model: 'gemini-3-pro-preview',
      messages: [{ role: 'user', content: 'scaffold the project' }],
      system: 'You are a coding agent.',
      tools: [],
      max_tokens: 8192,
      thinking: { type: 'disabled' },
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: 'antigravity',
    })
    for await (const ev of stream) events.push(ev)
    return events
  } finally {
    geminiApi.streamGenerateContent = original
  }
}

function toolUseStarts(events: AnthropicStreamEvent[]): number {
  return events.filter(
    e =>
      e.type === 'content_block_start' &&
      (e as any).content_block?.type === 'tool_use',
  ).length
}

function stopReasonOf(events: AnthropicStreamEvent[]): string | undefined {
  const delta = events.find(e => e.type === 'message_delta') as any
  return delta?.delta?.stop_reason
}

let passed = 0
let failed = 0
const pending: Array<[string, () => Promise<void>]> = []

function test(name: string, fn: () => Promise<void>): void {
  pending.push([name, fn])
}

test('drops the call left uncommitted at MAX_TOKENS', async () => {
  const events = await runGeminiLane([
    geminiChunk([
      { functionCall: { name: 'Write', args: { file_path: 'a.py', content: 'done' } } },
    ]),
    geminiChunk(
      [{ functionCall: { name: 'Write', args: { content: 'half a file' } } }],
      'MAX_TOKENS',
    ),
  ])

  assert.equal(toolUseStarts(events), 1, 'the uncommitted call was emitted anyway')
  assert.equal(
    stopReasonOf(events),
    'max_tokens',
    'the legacy gemini_to_anthropic adapter mapped MAX_TOKENS; the lane must too',
  )
})

test('leaves a normal tool-call turn intact', async () => {
  const events = await runGeminiLane([
    geminiChunk([
      { functionCall: { name: 'Write', args: { file_path: 'a.py', content: 'done' } } },
    ]),
    geminiChunk(
      [{ functionCall: { name: 'Write', args: { file_path: 'b.py', content: 'also' } } }],
      'STOP',
    ),
  ])

  assert.equal(toolUseStarts(events), 2, 'a complete turn lost a tool call')
  assert.equal(stopReasonOf(events), 'tool_use')
})

async function main(): Promise<void> {
  console.log('gemini output-cap truncation:')
  for (const [name, fn] of pending) {
    try {
      await fn()
      passed++
      console.log(`  ok  ${name}`)
    } catch (e: any) {
      failed++
      console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
