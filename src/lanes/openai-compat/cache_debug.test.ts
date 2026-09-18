/**
 * Run: bun run src/lanes/openai-compat/cache_debug.test.ts
 */

import {
  compatCacheDebugKey,
  compatCacheDebugStream,
  firstDivergingSegment,
} from './cache_debug.js'

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

const seg = (hash: string) => ({ label: 'x', hash, bytes: hash.length })

console.log('compat cache debug — firstDivergingSegment:')

test('clean prefix extension returns -1', () => {
  const prev = ['a', 'b', 'c'].map(seg)
  const next = ['a', 'b', 'c', 'd'].map(seg)
  assert(firstDivergingSegment(prev, next) === -1, String(firstDivergingSegment(prev, next)))
})

test('identical requests return -1', () => {
  const prev = ['a', 'b'].map(seg)
  const next = ['a', 'b'].map(seg)
  assert(firstDivergingSegment(prev, next) === -1, String(firstDivergingSegment(prev, next)))
})

test('a changed middle segment is reported at its index', () => {
  const prev = ['a', 'b', 'c', 'd'].map(seg)
  const next = ['a', 'B', 'c', 'd'].map(seg)
  assert(firstDivergingSegment(prev, next) === 1, String(firstDivergingSegment(prev, next)))
})

test('a changed FIRST segment (e.g. a tool) is reported at 0', () => {
  const prev = ['tool1', 'b', 'c'].map(seg)
  const next = ['TOOL1x', 'b', 'c'].map(seg)
  assert(firstDivergingSegment(prev, next) === 0, String(firstDivergingSegment(prev, next)))
})

test('a truncated tail (compaction/history rewrite) breaks at the new length', () => {
  const prev = ['a', 'b', 'c', 'd'].map(seg)
  const next = ['a', 'b'].map(seg)
  assert(firstDivergingSegment(prev, next) === 2, String(firstDivergingSegment(prev, next)))
})

test('debug key separates model switches inside one session', () => {
  const qwen = compatCacheDebugKey('openrouter', 'qwen/qwen3.7-max', 'sess', { tools: [] })
  const kimi = compatCacheDebugKey('openrouter', 'moonshotai/kimi-k2.7-code', 'sess', { tools: [] })
  assert(qwen !== kimi, `${qwen} should not equal ${kimi}`)
})

test('debug key separates side no-tool requests from toolful main-loop requests', () => {
  const noTools = compatCacheDebugKey('openrouter', 'moonshotai/kimi-k2.7-code', 'sess', { tools: [] })
  const tools = compatCacheDebugKey('openrouter', 'moonshotai/kimi-k2.7-code', 'sess', {
    tools: [{ type: 'function', function: { name: 'Bash', description: '', parameters: {} } }],
  } as any)
  assert(noTools !== tools, `${noTools} should not equal ${tools}`)
})

const body = (...messages: Array<{ role: string; content: string }>) => ({ messages }) as any

test('main-thread query sources share one stream', () => {
  const history = body({ role: 'system', content: 's' }, { role: 'user', content: 'hi' })
  const a = compatCacheDebugStream('repl_main_thread', history)
  const b = compatCacheDebugStream('repl_main_thread:outputStyle:x', history)
  const c = compatCacheDebugStream(undefined, history)
  assert(a === b && b === c && a.startsWith('main#'), `${a} / ${b} / ${c}`)
})

test('parallel agents of one type are separate streams', () => {
  const alpha = compatCacheDebugStream('agent:builtin:general-purpose', body({ role: 'user', content: 'read a' }))
  const beta = compatCacheDebugStream('agent:builtin:general-purpose', body({ role: 'user', content: 'read b' }))
  assert(alpha !== beta, `${alpha} should not equal ${beta}`)
})

test('a resumed agent stays on its stream', () => {
  const first = body({ role: 'user', content: 'read a' }, { role: 'assistant', content: 'A' })
  const resumed = body(
    { role: 'user', content: 'read a' },
    { role: 'assistant', content: 'A' },
    { role: 'user', content: 'now read c' },
  )
  const s1 = compatCacheDebugStream('agent:builtin:general-purpose', first)
  const s2 = compatCacheDebugStream('agent:builtin:general-purpose', resumed)
  assert(s1 === s2, `${s1} should equal ${s2}`)
})

test('a side query is its own stream but anchored to the same conversation', () => {
  const history = body({ role: 'user', content: 'hi' })
  const main = compatCacheDebugStream('repl_main_thread', history)
  const side = compatCacheDebugStream('prompt_suggestion', history)
  assert(main !== side, 'side query must not overwrite the main baseline')
  assert(main.split('#')[1] === side.split('#')[1], `${main} / ${side}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
