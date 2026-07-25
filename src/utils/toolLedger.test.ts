/**
 * Tool ledger + thrash detection checks.
 *
 * Run via: bun run src/utils/toolLedger.test.ts
 */

import {
  buildLoopBreakerGuidance,
  collectToolCalls,
  detectToolLoop,
  toolInputKey,
} from './toolLedger.js'

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

function assert(cond: unknown, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg)
}

function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
  if (actual !== expected) {
    throw new Error(msg ?? `expected ${String(expected)}, got ${String(actual)}`)
  }
}

// --- fixtures ---------------------------------------------------------------

let nextId = 0

function toolUse(name: string, input: unknown): any {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${nextId++}`, name, input }],
    },
  }
}

function toolResult(id: string, content: string, isError: boolean): any {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
          is_error: isError,
        },
      ],
    },
  }
}

/** One call plus its result, as the pair actually appears in history. */
function callAndResult(
  name: string,
  input: unknown,
  outcome: 'ok' | 'fail',
  text = 'boom',
): any[] {
  const call = toolUse(name, input)
  const id = call.message.content[0].id
  return [call, toolResult(id, text, outcome === 'fail')]
}

function failRun(name: string, input: unknown, times: number): any[] {
  const out: any[] = []
  for (let i = 0; i < times; i++) {
    out.push(...callAndResult(name, input, 'fail', 'command not found: py'))
  }
  return out
}

// --- input keys -------------------------------------------------------------

test('input key ignores object key order', () => {
  assertEqual(
    toolInputKey({ a: 1, b: 2 }),
    toolInputKey({ b: 2, a: 1 }),
    'reordered keys should share a key',
  )
})

test('input key respects array order', () => {
  assert(
    toolInputKey({ a: [1, 2] }) !== toolInputKey({ a: [2, 1] }),
    'array order is meaningful',
  )
})

test('input key separates different values', () => {
  assert(toolInputKey({ cmd: 'ls' }) !== toolInputKey({ cmd: 'lsx' }))
})

test('input key separates long inputs that share a prefix', () => {
  // Truncating instead of hashing would collapse these into one key and report
  // a loop that is not happening.
  const a = { body: `${'x'.repeat(5000)}A` }
  const b = { body: `${'x'.repeat(5000)}B` }
  assert(toolInputKey(a) !== toolInputKey(b), 'long inputs must stay distinct')
})

test('input key survives cyclic input without throwing', () => {
  const cyclic: any = { name: 'loop' }
  cyclic.self = cyclic
  const key = toolInputKey(cyclic)
  assert(typeof key === 'string' && key.length > 0)
})

// --- ledger construction ----------------------------------------------------

test('pairs tool calls with their results', () => {
  const calls = collectToolCalls([
    ...callAndResult('Bash', { command: 'ls' }, 'ok', 'file.txt'),
    ...callAndResult('Bash', { command: 'nope' }, 'fail', 'not found'),
  ])
  assertEqual(calls.length, 2)
  assertEqual(calls[0]!.ok, true)
  assertEqual(calls[1]!.ok, false)
  assertEqual(calls[1]!.errorText, 'not found')
})

test('a call with no result yet stays in flight', () => {
  const calls = collectToolCalls([toolUse('Bash', { command: 'sleep 10' })])
  assertEqual(calls.length, 1)
  assertEqual(calls[0]!.ok, undefined)
})

test('a result whose call was compacted away is ignored', () => {
  const calls = collectToolCalls([toolResult('gone', 'orphan', true)])
  assertEqual(calls.length, 0)
})

test('replayed duplicate tool_use ids are not double counted', () => {
  const call = toolUse('Bash', { command: 'ls' })
  const calls = collectToolCalls([call, call])
  assertEqual(calls.length, 1)
})

test('reads error text out of block-array results', () => {
  const call = toolUse('Grep', { pattern: '(' })
  const id = call.message.content[0].id
  const calls = collectToolCalls([
    call,
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            is_error: true,
            content: [{ type: 'text', text: 'regex parse error' }],
          },
        ],
      },
    },
  ])
  assertEqual(calls[0]!.errorText, 'regex parse error')
})

test('ignores non-tool messages', () => {
  const calls = collectToolCalls([
    { type: 'user', message: { role: 'user', content: 'hello' } },
    { type: 'progress' },
    ...callAndResult('Bash', { command: 'ls' }, 'ok'),
  ])
  assertEqual(calls.length, 1)
})

// --- loop detection ---------------------------------------------------------

test('three identical failures trip the threshold', () => {
  const detection = detectToolLoop(
    collectToolCalls(failRun('Bash', { command: 'py x.py' }, 3)),
  )
  assert(detection, 'expected a detection')
  assertEqual(detection!.count, 3)
  assertEqual(detection!.name, 'Bash')
  assert(detection!.errorText.includes('command not found'))
})

test('two identical failures do not', () => {
  const detection = detectToolLoop(
    collectToolCalls(failRun('Bash', { command: 'py x.py' }, 2)),
  )
  assertEqual(detection, null)
})

test('a success in between clears the run', () => {
  const messages = [
    ...failRun('Bash', { command: 'py x.py' }, 2),
    ...callAndResult('Bash', { command: 'ls' }, 'ok'),
    ...failRun('Bash', { command: 'py x.py' }, 2),
  ]
  assertEqual(detectToolLoop(collectToolCalls(messages)), null)
})

test('different arguments break the run', () => {
  const messages = [
    ...callAndResult('Bash', { command: 'a' }, 'fail'),
    ...callAndResult('Bash', { command: 'b' }, 'fail'),
    ...callAndResult('Bash', { command: 'c' }, 'fail'),
  ]
  assertEqual(
    detectToolLoop(collectToolCalls(messages)),
    null,
    'three different failing commands are progress, not thrash',
  )
})

test('same arguments on a different tool break the run', () => {
  const messages = [
    ...callAndResult('Bash', { command: 'x' }, 'fail'),
    ...callAndResult('Bash', { command: 'x' }, 'fail'),
    ...callAndResult('PowerShell', { command: 'x' }, 'fail'),
  ]
  assertEqual(detectToolLoop(collectToolCalls(messages)), null)
})

test('a trailing success suppresses detection', () => {
  const messages = [
    ...failRun('Bash', { command: 'py x.py' }, 3),
    ...callAndResult('Bash', { command: 'ls' }, 'ok'),
  ]
  assertEqual(
    detectToolLoop(collectToolCalls(messages)),
    null,
    'the model recovered; nothing to interrupt',
  )
})

test('an in-flight call does not break the run', () => {
  const messages = [
    ...failRun('Bash', { command: 'py x.py' }, 3),
    toolUse('Bash', { command: 'py x.py' }),
  ]
  const detection = detectToolLoop(collectToolCalls(messages))
  assert(detection, 'pending call should be skipped, not treated as a break')
  assertEqual(detection!.count, 3)
})

test('a parallel identical failing batch counts', () => {
  // One assistant message firing the same broken call three times at once.
  const ids = ['p1', 'p2', 'p3']
  const messages: any[] = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: ids.map(id => ({
          type: 'tool_use',
          id,
          name: 'Bash',
          input: { command: 'py x.py' },
        })),
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: ids.map(id => ({
          type: 'tool_result',
          tool_use_id: id,
          is_error: true,
          content: 'not found',
        })),
      },
    },
  ]
  const detection = detectToolLoop(collectToolCalls(messages))
  assert(detection, 'a parallel identical failing batch is still thrash')
  assertEqual(detection!.count, 3)
})

test('detection survives microcompacted tool results', () => {
  // microCompact replaces `content` and spreads the rest, so is_error is still
  // there. Detection must key off the flag, not the text, or compaction would
  // silently switch thrash detection off mid-session.
  const messages = failRun('Bash', { command: 'py x.py' }, 3).map(m => {
    const block = m.message.content[0]
    if (block.type !== 'tool_result') return m
    return {
      ...m,
      message: {
        ...m.message,
        content: [{ ...block, content: '[Old tool result content cleared]' }],
      },
    }
  })
  const detection = detectToolLoop(collectToolCalls(messages))
  assert(detection, 'cleared content must not hide the failure')
  assertEqual(detection!.count, 3)
})

test('a scan window keeps the tail answer identical', () => {
  const noise: any[] = []
  for (let i = 0; i < 200; i++) {
    noise.push(...callAndResult('Bash', { command: `echo ${i}` }, 'ok'))
  }
  const messages = [...noise, ...failRun('Bash', { command: 'py x.py' }, 3)]
  const full = detectToolLoop(collectToolCalls(messages))
  const windowed = detectToolLoop(
    collectToolCalls(messages, { scanLastMessages: 40 }),
  )
  assert(full && windowed, 'both scans should detect the tail run')
  assertEqual(windowed!.count, full!.count)
  assertEqual(windowed!.inputKey, full!.inputKey)
})

test('a window smaller than the history does not invent a run', () => {
  const messages = [
    ...failRun('Bash', { command: 'x' }, 2),
    ...callAndResult('Bash', { command: 'ok' }, 'ok'),
  ]
  assertEqual(
    detectToolLoop(collectToolCalls(messages, { scanLastMessages: 4 })),
    null,
  )
})

test('threshold is configurable', () => {
  const calls = collectToolCalls(failRun('Bash', { command: 'x' }, 2))
  assert(detectToolLoop(calls, { threshold: 2 }))
  assertEqual(detectToolLoop(calls, { threshold: 4 }), null)
})

test('a threshold below 2 is refused', () => {
  const calls = collectToolCalls(failRun('Bash', { command: 'x' }, 3))
  assertEqual(
    detectToolLoop(calls, { threshold: 1 }),
    null,
    'threshold 1 would fire on every single failure',
  )
})

test('empty history detects nothing', () => {
  assertEqual(detectToolLoop(collectToolCalls([])), null)
})

// --- guidance ---------------------------------------------------------------

test('guidance names the tool, the count, and the failure', () => {
  const detection = detectToolLoop(
    collectToolCalls(failRun('Bash', { command: 'py x.py' }, 4)),
  )!
  const text = buildLoopBreakerGuidance(detection)
  assert(text.includes('Bash'), text)
  assert(text.includes('4 times'), text)
  assert(text.includes('command not found'), text)
  assert(text.includes('py x.py'), text)
})

test('guidance omits the failure section when there is no error text', () => {
  const call = toolUse('Bash', { command: 'x' })
  const id = call.message.content[0].id
  const messages = [
    call,
    toolResult(id, '', true),
    ...callAndResult('Bash', { command: 'x' }, 'fail', ''),
    ...callAndResult('Bash', { command: 'x' }, 'fail', ''),
  ]
  const detection = detectToolLoop(collectToolCalls(messages))!
  const text = buildLoopBreakerGuidance(detection)
  assert(!text.includes('Latest failure:'), text)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
