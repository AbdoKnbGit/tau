/**
 * Read-history refusal unit tests.
 *
 * Run: bun run src/utils/readHistory.test.ts
 */

import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import {
  isUnreadFileRefusal,
  recordFileRead,
  refuseWithCurrentContent,
  resetReadHistory,
  unreadFileRefusal,
} from './readHistory.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  resetReadHistory()
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

const FILE = '/repo/src/app.ts'
const REDO = 'Base old_string on the current content below and edit again'

function context(agentId?: string) {
  return { readFileState: createFileStateCacheWithSizeLimit(10), agentId }
}

console.log('read-history refusals:')

test('asks for a Read when nobody read the file', () => {
  const message = unreadFileRefusal(FILE, undefined, {
    neverRead: 'Read it first.',
    action: 'before editing it',
  })
  assert(message === 'File has not been read yet. Read it first.', message)
  assert(isUnreadFileRefusal(message), 'recognized as a read refusal')
})

test('says the read is off record when this agent read it before', () => {
  recordFileRead(FILE, undefined)
  const message = unreadFileRefusal(FILE, undefined, {
    neverRead: 'Read it first.',
    action: 'before editing it',
  })
  assert(message.startsWith('You read this file earlier'), message)
})

test('names another agent as the reader', () => {
  recordFileRead(FILE, 'agent-a')
  const message = unreadFileRefusal(FILE, undefined, {
    neverRead: 'Read it first.',
    action: 'before editing it',
  })
  assert(message.startsWith('This file was read by another agent'), message)
})

test('shows the file with line numbers and records a full read', () => {
  const ctx = context()
  const message = refuseWithCurrentContent(
    FILE,
    ctx,
    { content: 'one\ntwo', timestamp: 42 },
    REDO,
  )
  assert(message?.startsWith('File has not been read yet, so nothing was changed.'), String(message))
  assert(message?.includes('Tau read it for you now, which counts as your Read.'), 'says it counts as a read')
  assert(message?.includes('(the line-number prefixes are not part of the file):\n'), 'explains the prefixes')
  assert(message?.includes('1\tone') && message.includes('2\ttwo'), 'shows numbered lines')
  const state = ctx.readFileState.get(FILE)
  assert(state?.content === 'one\ntwo' && state.timestamp === 42, 'records the content and mtime')
  assert(!state?.isPartialView, 'a whole file is a full read')
  assert(isUnreadFileRefusal(message!), 'recognized as a read refusal')
})

test('the next refusal knows this agent has now read the file', () => {
  refuseWithCurrentContent(FILE, context(), { content: 'x', timestamp: 1 }, REDO)
  const message = refuseWithCurrentContent(FILE, context(), { content: 'x', timestamp: 1 }, REDO)
  assert(message?.startsWith('Your earlier read of this file is no longer on record'), String(message))
})

test('a subagent is told another agent read the file', () => {
  recordFileRead(FILE, undefined)
  const message = refuseWithCurrentContent(FILE, context('agent-b'), { content: 'x', timestamp: 1 }, REDO)
  assert(message?.startsWith('This file was read by another agent'), String(message))
})

test('a large file shows only the window, recorded as a partial view', () => {
  const ctx = context()
  const content = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n')
  const message = refuseWithCurrentContent(FILE, ctx, { content, timestamp: 7 }, REDO, {
    window: () => ({ lines: ['line 10', 'line 11'], startLine: 10 }),
  })
  assert(message?.includes('(only lines 10-11, the part closest to your change'), String(message))
  assert(!message?.includes('line 12'), 'shows only the window')
  const state = ctx.readFileState.get(FILE)
  assert(state?.isPartialView === true, 'recorded as a partial view')
  assert(state?.content === content, 'records the whole content for the edit check')
})

test('a large file with no window asks for a Read and records nothing', () => {
  const ctx = context()
  const content = 'x'.repeat(70_000)
  const message = refuseWithCurrentContent(FILE, ctx, { content, timestamp: 7 }, REDO, {
    window: () => null,
  })
  assert(message === undefined, 'nothing shown')
  assert(ctx.readFileState.get(FILE) === undefined, 'no read recorded')
})

test('binary content is never shown', () => {
  const ctx = context()
  const message = refuseWithCurrentContent(FILE, ctx, { content: 'PK\u0000\u0003', timestamp: 1 }, REDO)
  assert(message === undefined, 'nothing shown')
  assert(ctx.readFileState.get(FILE) === undefined, 'no read recorded')
  const image = refuseWithCurrentContent('/repo/logo.png', ctx, { content: 'abc', timestamp: 1 }, REDO)
  assert(image === undefined, 'binary extension not shown')
})

test('a display replaces the numbered file', () => {
  const ctx = context()
  const message = refuseWithCurrentContent(
    '/repo/n.ipynb',
    ctx,
    { content: '[{"cell_id":"a"}]', timestamp: 3 },
    'Edit again with a cell_id from its current cells below',
    { display: '<cell id="a">print(1)</cell id="a">' },
  )
  assert(message?.endsWith('below:\n<cell id="a">print(1)</cell id="a">'), String(message))
  assert(!message?.includes('line-number prefixes'), 'no line-number note')
  assert(ctx.readFileState.get('/repo/n.ipynb')?.content === '[{"cell_id":"a"}]', 'records the given content')
})

test('another error that quotes a refusal is not taken for one', () => {
  const message =
    'String to replace not found in file.\nCurrent file content:\nFile has not been read yet.'
  assert(!isUnreadFileRefusal(message), 'only the start counts')
})

test('a partial view says only part was read', () => {
  const message = refuseWithCurrentContent(FILE, context(), { content: 'x', timestamp: 1 }, REDO, {
    partialView: true,
  })
  assert(message?.startsWith('Only part of this file has been read'), String(message))
  assert(message?.includes('so nothing was changed.'), 'says nothing changed')
  assert(isUnreadFileRefusal(message!), 'recognized as a read refusal')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
