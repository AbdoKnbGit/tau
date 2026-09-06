/**
 * Run: bun run src/commands/statistics/statistics_response_usage.test.ts
 * Exercise the real transcript collector without bootstrapping the CLI.
 */

import assert from 'node:assert/strict'
import { mock } from 'bun:test'

// Isolate command state and token estimation: these tests supply provider usage
// directly and do not need a configured account, terminal, tools, or sandbox.
mock.module('../../bootstrap/state.js', () => ({
  getSessionId: () => 'statistics-test',
  getOriginalCwd: () => '.',
}))
mock.module('../../cost-tracker.js', () => ({ getModelUsage: () => ({}) }))
mock.module('../../utils/model/providers.js', () => ({
  getAPIProvider: () => 'antigravity',
}))
mock.module('../../utils/tokens.js', () => ({
  getTokenUsage: (message: any) => message.message?.usage,
  getTokenCountFromUsage: (usage: any) =>
    usage.input_tokens + usage.output_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0),
  getAssistantMessageContentLength: () => 40,
  tokenCountWithEstimation: () => 100_000,
}))

const { collectResponseModelStats } = await import('./statistics.js')

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}: ${(error as Error).message}`)
  }
}

function response({
  id = 'gemini-1',
  model = 'gemini-3.8-flash-low',
  input = 23_231,
  read,
  output = 0,
  final = false,
  estimated = false,
}: {
  id?: string
  model?: string
  input?: number
  read?: number
  output?: number
  final?: boolean
  estimated?: boolean
} = {}): any {
  return {
    type: 'assistant',
    uuid: `${id}-${final ? 'final' : 'partial'}`,
    message: {
      id,
      model,
      stop_reason: final ? 'end_turn' : null,
      content: [{ type: 'text', text: 'Test response content.' }],
      ...(estimated ? {} : {
        usage: {
          input_tokens: input,
          output_tokens: output,
          ...(read === undefined ? {} : {
            cache_read_input_tokens: read,
            cache_creation_input_tokens: 0,
          }),
        },
      }),
    },
  }
}

const final = response({ input: 2_916, read: 20_315, output: 21, final: true })
const expected = {
  inputTokens: 2_916,
  outputTokens: 21,
  cacheReadInputTokens: 20_315,
  cacheCreationInputTokens: 0,
}

console.log('statistics Antigravity response usage:')

test('final normalized tuple replaces total-input streaming snapshots', () => {
  const stats = collectResponseModelStats([response(), response(), final])
  assert.equal(stats.length, 1)
  assert.deepEqual(stats[0]!.stats, expected)
  assert.equal(stats[0]!.finalUsage, true)
  const total = stats[0]!.stats.inputTokens + stats[0]!.stats.cacheReadInputTokens
  assert.equal(total, 23_231, 'cached input was counted twice')
})

test('final usage survives reordered provisional or estimated records', () => {
  for (const later of [response(), response({ estimated: true })]) {
    assert.deepEqual(collectResponseModelStats([final, later])[0]!.stats, expected)
  }
})

test('provider usage replaces earlier estimates without inflating output', () => {
  const stats = collectResponseModelStats([response({ estimated: true }), final])
  assert.deepEqual(stats[0]!.stats, expected)
  assert.equal(stats[0]!.estimated, false)
})

test('all provisional estimates remain estimates until measured usage arrives', () => {
  const stats = collectResponseModelStats([
    response({ estimated: true }),
    response({ estimated: true }),
  ])
  assert.equal(stats[0]!.estimated, true)
  assert.equal(stats[0]!.stats.outputTokens, 20)
})

test('zero final cache reads replace an earlier provisional hit', () => {
  const stats = collectResponseModelStats([
    response({ input: 8_000, read: 12_000, output: 1 }),
    response({ input: 20_000, read: 0, output: 25, final: true }),
  ])
  assert.deepEqual(stats[0]!.stats, {
    inputTokens: 20_000,
    outputTokens: 25,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  })
})

test('duplicate final tool blocks count each response once', () => {
  const stats = collectResponseModelStats([final, final, final])
  assert.equal(stats.length, 1)
  assert.deepEqual(stats[0]!.stats, expected)
})

test('a new cold response remains a separately charged request', () => {
  const stats = collectResponseModelStats([
    final,
    response({ id: 'gemini-2', input: 11_352, read: 0, output: 25, final: true }),
  ])
  assert.equal(stats.length, 2)
  assert.equal(stats.reduce((n, item) => n + item.stats.inputTokens, 0), 14_268)
  assert.equal(stats.reduce((n, item) => n + item.stats.cacheReadInputTokens, 0), 20_315)
})

test('other providers keep their existing response merge behavior', () => {
  for (const provider of ['gemini', 'openrouter', 'openai', 'firstParty']) {
    const stats = collectResponseModelStats([response(), final], provider)
    assert.equal(stats[0]!.stats.inputTokens, 23_231, provider)
    assert.equal(stats[0]!.stats.cacheReadInputTokens, 20_315, provider)
    assert.equal(stats[0]!.finalUsage, undefined, provider)
  }
})

test('Claude on Antigravity keeps its existing response merge behavior', () => {
  const stats = collectResponseModelStats([
    response({ model: 'claude-sonnet-4-6', input: 20_000 }),
    response({ model: 'claude-sonnet-4-6', input: 2_000, read: 18_000, output: 25, final: true }),
  ])
  assert.equal(stats[0]!.stats.inputTokens, 20_000)
  assert.equal(stats[0]!.finalUsage, undefined)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
