/**
 * Failed-tool-result marking tests.
 *
 * Run: bun run src/lanes/shared/tool_error_text.test.ts
 */

import type { ProviderMessage } from '../../services/api/providers/base_provider.js'
import { markFailedToolResults } from './tool_error_text.js'

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

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

const history = (): ProviderMessage[] => [
  { role: 'user', content: 'read the pdf' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.pdf' } }] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'pdftotext crashed (Windows error 0xC0000005).' },
      { type: 'text', text: 'note' },
    ],
  },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'a.pdf' }] },
]

console.log('failed tool result marking:')

test('a thrown error is wrapped, a success is untouched', () => {
  const out = markFailedToolResults(history())
  const err = (out[2]!.content as any[])[0]
  assert(err.content === '<tool_use_error>pdftotext crashed (Windows error 0xC0000005).</tool_use_error>', err.content)
  assert(err.is_error === true, 'keeps the flag')
  assert((out[4]!.content as any[])[0].content === 'a.pdf', 'success untouched')
  assert((out[2]!.content as any[])[1].text === 'note', 'other blocks untouched')
})

test('the stored history is never changed', () => {
  const input = history()
  const before = JSON.stringify(input)
  markFailedToolResults(input)
  assert(JSON.stringify(input) === before, 'input mutated')
})

test('same history, same bytes on every turn (cache-stable)', () => {
  const a = JSON.stringify(markFailedToolResults(history()))
  const b = JSON.stringify(markFailedToolResults(history()))
  assert(a === b, 'serialization differs between turns')
})

test('an already wrapped error is not wrapped twice', () => {
  const input: ProviderMessage[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: '<tool_use_error>InputValidationError: bad</tool_use_error>' }] },
  ]
  assert(markFailedToolResults(input) === input, 'returned a new array')
})

test('text-block content is wrapped at its ends, other blocks kept', () => {
  const input: ProviderMessage[] = [
    {
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'x', is_error: true,
        content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
      }],
    },
  ]
  const blocks = ((markFailedToolResults(input)[0]!.content as any[])[0].content) as any[]
  assert(blocks[0].text === '<tool_use_error>first', blocks[0].text)
  assert(blocks[1].text === 'second</tool_use_error>', blocks[1].text)
})

test('an empty error still reads as an error', () => {
  const input: ProviderMessage[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: '' }] },
  ]
  const block = (markFailedToolResults(input)[0]!.content as any[])[0]
  assert(block.content === '<tool_use_error></tool_use_error>', block.content)
})

test('no failed results: the same array comes back', () => {
  const input = history().filter((_, i) => i !== 2)
  assert(markFailedToolResults(input) === input, 'returned a new array')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
