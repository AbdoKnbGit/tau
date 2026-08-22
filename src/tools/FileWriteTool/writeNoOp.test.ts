import {
  getFileWriteNoOpMessage,
  isFileWriteNoOp,
} from './writeNoOp.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(isFileWriteNoOp('same\n', false, 'same\n'), 'identical LF is a no-op')
assert(!isFileWriteNoOp('old\n', false, 'new\n'), 'content changes must write')
assert(
  !isFileWriteNoOp('same\n', true, 'same\n'),
  'CRLF must still write because Write intentionally normalizes to LF',
)
assert(
  !isFileWriteNoOp(
    `${'head\n'.repeat(1_000)}tail\n`,
    true,
    `${'head\n'.repeat(1_000)}tail\n`,
  ),
  'CRLF beyond the 4 KB line-ending sample must still force an exact replacement',
)

const message = getFileWriteNoOpMessage('/tmp/example')
assert(message.includes('Nothing changed'), 'message must state no write occurred')
assert(message.includes('do not retry'), 'message must stop retry loops')

console.log('5 passed, 0 failed')
