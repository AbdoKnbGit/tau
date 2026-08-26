/**
 * DeepSeek thinking-mode history replay tests.
 *
 * Run: bun run src/lanes/openai-compat/deepseek_history.test.ts
 */

import assert from 'node:assert/strict'
import type { ProviderMessage } from '../../services/api/providers/base_provider.js'
import { _convertHistoryToOpenAIForTest } from './loop.js'
import { sanitizeDeepSeekToolCallAdjacency } from './transformers/deepseek.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

console.log('deepseek history conversion:')

test('attaches pending thinking as reasoning_content on DeepSeek tool calls', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'check the date' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'I need the current date.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me check that.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_date', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '2026-04-24' }] },
  ]

  const out = _convertHistoryToOpenAIForTest(messages, '', 'deepseek', 'deepseek-v4-pro')
  const toolCallMessage = out.find(m => m.role === 'assistant' && m.tool_calls)

  assert.equal(toolCallMessage?.reasoning_content, 'I need the current date.')
  assert.equal(toolCallMessage?.content, 'Let me check that.')
})

test('adds empty reasoning_content for old DeepSeek tool-call history without thinking', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'read package json' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'package.json' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{}' }] },
  ]

  const out = _convertHistoryToOpenAIForTest(messages, '', 'deepseek', 'deepseek-v4-pro')
  const toolCallMessage = out.find(m => m.role === 'assistant' && m.tool_calls)

  assert.equal(toolCallMessage?.reasoning_content, '')
})

test('keeps non-DeepSeek history conversion unchanged', () => {
  const messages: ProviderMessage[] = [
    { role: 'user', content: 'read package json' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'package.json' } }] },
  ]

  const out = _convertHistoryToOpenAIForTest(messages, '', 'openrouter', 'anthropic/claude-sonnet-4.5')
  const toolCallMessage = out.find(m => m.role === 'assistant' && m.tool_calls)

  assert.equal('reasoning_content' in (toolCallMessage ?? {}), false)
})

// ─── tool-result adjacency ──────────────────────────────────────────
//
// A tool result answers the previous assistant turn. If any text from the
// same user message is emitted ahead of it -- a system-reminder, an
// attachment, the user typing while the result lands -- the wire order puts
// a user turn between the tool_call and its answer.
//
// For DeepSeek that is not a cosmetic issue: sanitizeDeepSeekToolCallAdjacency
// then drops the tool_call AND the orphaned result, so the model sees its own
// narration with no evidence it ever called anything, says the same thing
// again, and loops silently. Guard the ordering, not just the symptom.

function mixedResultHistory(): ProviderMessage[] {
  return [
    { role: 'user', content: 'run the tests' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll load the deferred project tools." },
        { type: 'tool_use', id: 'call_1', name: 'ToolSearch', input: { query: 'select:Foo' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'Tool loaded.' },
        { type: 'text', text: '<system-reminder>budget note</system-reminder>' },
      ],
    },
  ]
}

function assertAdjacent(out: ReturnType<typeof _convertHistoryToOpenAIForTest>, label: string): void {
  const callIndex = out.findIndex(m => m.role === 'assistant' && m.tool_calls?.length)
  const resultIndex = out.findIndex(m => m.role === 'tool')
  assert.ok(callIndex >= 0, label + ': tool_call missing')
  assert.equal(resultIndex, callIndex + 1, label + ': result must immediately follow its call')
}

test('a tool result stays adjacent to its call when text rides along (deepseek)', () => {
  assertAdjacent(
    _convertHistoryToOpenAIForTest(mixedResultHistory(), '', 'deepseek', 'deepseek-v4-flash'),
    'deepseek',
  )
})

test('the same adjacency holds on the generic openai-compat path', () => {
  for (const provider of ['openrouter', 'groq', 'glm', 'mistral', 'generic'] as const) {
    assertAdjacent(
      _convertHistoryToOpenAIForTest(mixedResultHistory(), '', provider, 'some-model'),
      provider,
    )
  }
})

test('the deepseek sanitizer keeps the pair instead of erasing both', () => {
  const converted = _convertHistoryToOpenAIForTest(
    mixedResultHistory(), '', 'deepseek', 'deepseek-v4-flash',
  )
  const sanitized = sanitizeDeepSeekToolCallAdjacency(converted)

  const call = sanitized.find(m => m.role === 'assistant' && m.tool_calls?.length)
  assert.ok(call, 'tool_call was erased -- the model would re-narrate and loop')
  assert.equal(call?.tool_calls?.[0]?.id, 'call_1')
  assert.ok(
    sanitized.some(m => m.role === 'tool' && m.tool_call_id === 'call_1'),
    'tool result was erased alongside its call',
  )
  assert.ok(
    sanitized.some(m => m.role === 'user' && String(m.content).includes('budget note')),
    'the trailing user text should survive, just behind the result',
  )
})

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\n${passed} passed`)
