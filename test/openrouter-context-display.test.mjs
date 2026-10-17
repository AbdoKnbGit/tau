import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const r = await loadMcpRuntime({
  paths: ['src/utils/sessionContextUsage.ts', 'src/utils/contextBaseline.ts', 'src/utils/forcedProvider.ts'],
  exports: ['getSessionContextUsage', 'setContextBaselineTokens', 'runWithForcedProvider'],
})
const model = 'openrouter-display-fixture'
const response = (id, input, read = 0, write = 0) => ({ type: 'assistant', uuid: id,
  message: { id, model, content: [{ type: 'text', text: 'Response' }],
    usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write } } })
const usage = (messages, provider = 'openrouter') => r.runWithForcedProvider({ provider },
  () => r.getSessionContextUsage(messages, model))
r.setContextBaselineTokens(model, 71_000)

test('OpenRouter retains measured 54k/55k usage while each next response has provisional zero usage', () => {
  const messages = [response('completed', 54_000)]
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.push(response('thinking', 0))
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.push(response('tool', 0))
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.at(-1).message.usage.input_tokens = 55_000
  assert.equal(usage(messages).usedTokens, 55_000)
  messages.push(response('next-thinking', 0))
  assert.equal(usage(messages).usedTokens, 55_000)
})

test('OpenRouter accepts an entirely cached real measurement and respects compaction', () => {
  const messages = [response('cached', 0, 54_000), response('pending', 0)]
  assert.equal(usage(messages).usedTokens, 54_000)
  messages.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
  assert.equal(usage(messages).usedTokens, 71_000, 'pre-compaction measurements must not leak')
  messages.push(response('after-compact', 15_000))
  assert.equal(usage(messages).usedTokens, 15_000, 'real smaller measurements must remain visible')
})

test('Codex (openai) keeps the measured context while the next response streams', () => {
  // The Responses API reports usage only with response.completed, so every
  // streamed block of the next response starts at zero, exactly like OpenRouter.
  const messages = [response('completed', 1_075, 68_000)]
  assert.equal(usage(messages, 'openai').usedTokens, 69_075)
  messages.push(response('thinking', 0))
  assert.equal(usage(messages, 'openai').usedTokens, 69_075, 'a streaming block must not drop the meter to the baseline')
  messages.push(response('tool', 0))
  messages.at(-1).message.usage.input_tokens = 900
  messages.at(-1).message.usage.cache_read_input_tokens = 69_000
  assert.equal(usage(messages, 'openai').usedTokens, 69_900)
})

test('Mistral keeps the last measured prompt through thinking and tool blocks, then accepts new usage', () => {
  const messages = [response('completed', 552, 63_980)]
  assert.equal(usage(messages, 'mistral').usedTokens, 64_532)
  messages.push(response('thinking', 0), response('tool', 0))
  assert.equal(usage(messages, 'mistral').usedTokens, 64_532,
    'provisional zero usage must not replace a measured prompt with the rough baseline')
  messages.at(-1).message.usage.input_tokens = 65_023
  assert.equal(usage(messages, 'mistral').usedTokens, 65_023,
    'a fully uncached measurement must replace the preceding cached measurement')
  messages.push(response('smaller-prompt', 0, 40_000), response('next-thinking', 0))
  assert.equal(usage(messages, 'mistral').usedTokens, 40_000,
    'fully cached and genuinely smaller prompts are valid new measurements')
})

test('Mistral clears old usage at compaction and accepts the first post-compaction measurement', () => {
  const messages = [response('before-compact', 68_000)]
  messages.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
  assert.equal(usage(messages, 'mistral').usedTokens, 71_000,
    'pre-compaction usage must not leak into the new context')
  messages.push(response('after-compact-thinking', 0))
  assert.ok(usage(messages, 'mistral').usedTokens >= 71_000,
    'initial context estimation remains available while the first response streams')
  messages.push(response('after-compact', 15_000), response('pending', 0))
  assert.equal(usage(messages, 'mistral').usedTokens, 15_000)
})

test('Mistral uses the initial context baseline only until its first measured response', () => {
  assert.equal(usage([], 'mistral').usedTokens, 71_000)
  const messages = [response('first-thinking', 0)]
  assert.ok(usage(messages, 'mistral').usedTokens >= 71_000)
  messages.push(response('first-completed', 54_000))
  assert.equal(usage(messages, 'mistral').usedTokens, 54_000)
})

for (const provider of ['firstParty', 'bedrock', 'vertex', 'foundry', 'gemini', 'antigravity']) {
  test(`${provider} keeps its existing pending-usage display policy`, () => {
    const messages = [response('completed', 54_000), response('pending', 0)]
    assert.ok(usage(messages, provider).usedTokens >= 71_000)
  })
}

for (const provider of ['opencode', 'opencodego']) {
  test(`${provider} keeps measured context through streaming, then accepts genuine shrinkage`, () => {
    const messages = [response('measured', 10_000, 80_000)]
    assert.equal(usage(messages, provider).usedTokens, 90_000)
    messages.push(response('thinking', 0), response('tool', 0))
    assert.equal(usage(messages, provider).usedTokens, 90_000)
    messages.at(-1).message.usage = { input_tokens: 12_000, cache_read_input_tokens: 88_000, output_tokens: 20 }
    assert.equal(usage(messages, provider).usedTokens, 100_000)
    messages.push(response('pending', 0))
    assert.equal(usage(messages, provider).usedTokens, 100_000)
    messages.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary' })
    messages.push(response('after-compact', 0, 40_000), response('pending-again', 0))
    assert.equal(usage(messages, provider).usedTokens, 40_000)
  })
}

function freezeTree(value) {
  if (!value || typeof value !== 'object') return
  for (const child of Object.values(value)) freezeTree(child)
  Object.freeze(value)
}

function readFrozenUsage(messages, provider) {
  const snapshot = structuredClone(messages)
  freezeTree(messages)
  const result = usage(messages, provider)
  assert.deepEqual(messages, snapshot, 'reading context must not rewrite transcript or billing usage')
  return result
}

const additionalStreamingProviders = [
  'commandcode', 'deepseek', 'glm', 'moonshot', 'minimax', 'alibaba', 'groq', 'nim',
  'xai', 'meta', 'mimo', 'lxd', 'fireworks', 'cloudflare', 'vercel', 'requesty',
  'modelrouter', 'agentrouter', 'ollama', 'lmstudio', 'cline', 'clinepass', 'copilot',
  'cursor', 'iflow', 'kilocode', 'kiro',
]

for (const provider of additionalStreamingProviders) {
  test(`${provider} holds measured usage through pending blocks and replaces every cache bucket on new measurements`, () => {
    const completed = response('completed', 1_000, 30_000)
    let messages = [completed]
    const check = (expected, tokens) => {
      const actual = readFrozenUsage(messages, provider)
      assert.equal(actual.usedTokens, tokens)
      assert.deepEqual(actual.currentUsage, expected.message.usage,
        'use the latest measured response as a whole; do not merge stale cache counters')
    }
    check(completed, 31_000)
    messages = [...messages, response('thinking', 0), response('tool', 0)]
    check(completed, 31_000)

    // The trailing usage frame replaces the pending record for this response.
    const measured = response('tool', 2_000, 33_000)
    messages = [...messages.slice(0, -1), measured]
    check(measured, 35_000)
    messages = [...messages, response('next-thinking', 0)]
    check(measured, 35_000)

    for (const [next, tokens] of [
      [response('read-only', 0, 29_000), 29_000],
      [response('write-only', 0, 0, 28_000), 28_000],
      [response('uncached', 12_000), 12_000],
    ]) {
      messages = [...messages, next, response(`${next.uuid}-pending`, 0)]
      check(next, tokens)
    }
  })

  test(`${provider} uses the initial estimate until fresh usage, including after compaction with retained history`, () => {
    assert.equal(readFrozenUsage([], provider).usedTokens, 71_000)
    const pending = response('pending', 0)
    const initial = readFrozenUsage([pending], provider)
    assert.ok(initial.usedTokens >= 71_000)
    assert.equal(readFrozenUsage([response('first-real', 54_000), pending], provider).usedTokens, 54_000)

    const before = response('before-compact', 90_000)
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary' }
    assert.equal(readFrozenUsage([before, boundary], provider).usedTokens, 71_000)
    assert.deepEqual(readFrozenUsage([before, boundary, pending], provider), initial,
      'zero-usage blocks after compaction must not revive pre-compaction measurements')

    const retained = response('retained', 55_000)
    const summary = { type: 'user', uuid: 'summary', message: { content: 'Summary' } }
    const result = { type: 'user', uuid: 'result', message: { content: 'Retained tool result' } }
    const preservedBoundary = { ...boundary, compactMetadata: { preservedSegment: {
      headUuid: retained.uuid, tailUuid: result.uuid, anchorUuid: summary.uuid,
    } } }
    const compacted = [before, preservedBoundary, summary, retained, result, pending]
    const estimated = readFrozenUsage(compacted, provider)
    assert.ok(estimated.usedTokens >= 71_000,
      'retained responses still describe the old prompt and must not count as fresh measurements')
    assert.deepEqual(estimated, readFrozenUsage([
      preservedBoundary, summary, response('retained', 0), result, pending,
    ], provider), 'retained billing counters must not affect the post-compaction estimate')
    assert.equal(readFrozenUsage([
      ...compacted, response('after-compact', 15_000), response('next-pending', 0),
    ], provider).usedTokens, 15_000)
  })
}
