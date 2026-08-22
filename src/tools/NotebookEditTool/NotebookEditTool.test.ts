import {
  getNotebookNoOpMessage,
  isNotebookReplaceNoOp,
  notebookChangedSinceRead,
} from './notebookNoOp.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

console.log('NotebookEdit no-op behavior:')

test('recognizes string and array sources already applied', () => {
  assert(
    isNotebookReplaceNoOp(
      { source: 'print(1)\n', cell_type: 'code' },
      'print(1)\n',
    ),
    'string source should match',
  )
  assert(
    isNotebookReplaceNoOp(
      { source: ['print(1)', '\n'], cell_type: 'code' },
      'print(1)\n',
      'code',
    ),
    'array source should match joined text',
  )
})

test('does not suppress source or requested type changes', () => {
  assert(
    !isNotebookReplaceNoOp(
      { source: 'old', cell_type: 'code' },
      'new',
    ),
    'source change must run',
  )
  assert(
    !isNotebookReplaceNoOp(
      { source: 'same', cell_type: 'code' },
      'same',
      'markdown',
    ),
    'type change must run',
  )
})

test('no-op result explicitly stops retry loops', () => {
  const message = getNotebookNoOpMessage('cell-a')
  assert(message.includes('Nothing changed'), 'must state no write occurred')
  assert(message.includes('do not retry'), 'must tell the model not to retry')
})

test('post-hook revalidation rejects a concurrent same-cell edit', () => {
  const readState = {
    timestamp: 100,
    content: '{"cells":[{"id":"cell-a","source":"old"}]}',
  }
  assert(
    notebookChangedSinceRead(
      '{"cells":[{"id":"cell-a","source":"external edit"}]}',
      101,
      readState,
      readState.content,
    ),
    'a concurrent edit after history tracking must abort the write',
  )
  assert(
    notebookChangedSinceRead(
      '{"cells":[{"id":"cell-a","source":"external edit"}]}',
      100,
      readState,
      readState.content,
    ),
    'full-read content comparison must catch coarse same-timestamp edits',
  )
  assert(
    !notebookChangedSinceRead(readState.content, 100, readState, readState.content),
    'unchanged bytes and timestamp are safe',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
