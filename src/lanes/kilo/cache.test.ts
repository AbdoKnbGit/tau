/**
 * Regression tests for KiloCode-only prompt-cache breakpoint placement.
 *
 * Run: bun run src/lanes/kilo/cache.test.ts
 */

import type { OpenAIMessage } from '../../services/api/adapters/anthropic_to_openai.js'
import { applyKiloCacheBreakpoints } from './cache.js'

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

function hasTrailingCacheControl(m: OpenAIMessage): boolean {
  if (!Array.isArray(m.content) || m.content.length === 0) return false
  return m.content[m.content.length - 1]?.cache_control?.type === 'ephemeral'
}

function main(): void {
  console.log('kilo cache:')

  test('stamps the system prompt and last two user messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'first user turn' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second user turn' },
      { role: 'assistant', content: 'second answer' },
      { role: 'user', content: 'third user turn' },
    ]

    applyKiloCacheBreakpoints(messages)

    assert(hasTrailingCacheControl(messages[0]!), 'system breakpoint missing')
    assert(Array.isArray(messages[1]!.content) && messages[1]!.content[0]?.text === 'first user turn', 'old user turn keeps text-part encoding')
    assert(!hasTrailingCacheControl(messages[1]!), 'old user turn has no rolling breakpoint')
    assert(hasTrailingCacheControl(messages[3]!), 'second-to-last user breakpoint missing')
    assert(hasTrailingCacheControl(messages[5]!), 'last user breakpoint missing')
  })

  test('does not place cache markers on Kilo tool-result messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'run the tool test' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'call_2', content: '' },
    ]

    applyKiloCacheBreakpoints(messages)

    assert(hasTrailingCacheControl(messages[0]!), 'system breakpoint missing')
    assert(hasTrailingCacheControl(messages[1]!), 'user breakpoint missing')
    assert(messages[3]!.content === '{"ok":true}', 'tool result should stay a plain string')
    assert(messages[4]!.content === '', 'empty tool result should stay unchanged')
  })

  test('keeps existing structured markers and only adds missing user markers', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'text', text: 'and answer' },
        ],
      },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool output' },
    ]

    applyKiloCacheBreakpoints(messages)

    assert(hasTrailingCacheControl(messages[0]!), 'existing system marker lost')
    assert(hasTrailingCacheControl(messages[1]!), 'structured user marker missing')
    assert(messages[3]!.content === 'tool output', 'tool output should not be promoted')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
