/**
 * Run: bun run src/utils/toolResultCompression.test.ts
 */

import {
  buildCompressedToolResultPreview,
  isToolResultCompressionEnabled,
  selectToolResultPreview,
} from './toolResultCompression.js'

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

function eq<T>(actual: T, expected: T, hint?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${hint ?? 'assertion failed'}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`,
    )
  }
}

function resetEnv(): void {
  delete process.env.TAU_TOOL_RESULT_COMPRESSION
  delete process.env.CLAUDE_CODE_TOOL_RESULT_COMPRESSION
}

function largeLog(): string {
  const lines = Array.from({ length: 140 }, (_, i) =>
    `noise line ${i} ${'x'.repeat(48)}`,
  )
  lines[72] = 'src/example.ts:12:7 TypeError: cannot read property of undefined'
  lines[73] = '    at runExample (src/example.ts:12:7)'
  lines[120] = 'warning: retry timeout after 5000ms'
  return lines.join('\n')
}

console.log('tool result compression:')

test('disabled mode returns the existing preview byte-identically', () => {
  resetEnv()
  const preview = 'legacy first preview'
  const selected = selectToolResultPreview(preview, largeLog(), 2000)

  eq(selected, preview)
  assert(!isToolResultCompressionEnabled(), 'compression should be off')
})

test('enabled mode builds a diagnostic preview for large plain text', () => {
  resetEnv()
  process.env.TAU_TOOL_RESULT_COMPRESSION = '1'

  const preview = selectToolResultPreview(
    'legacy first preview',
    largeLog(),
    2000,
  )

  assert(preview.includes('--- diagnostic lines ---'), 'missing diagnostics')
  assert(preview.includes('TypeError'), 'missing error line')
  assert(preview.includes('src/example.ts:12:7'), 'missing file location')
  assert(preview.includes('--- last lines ---'), 'missing tail section')
  assert(!preview.includes('legacy first preview'), 'fallback should be replaced')
})

test('structured content keeps the existing preview even when enabled', () => {
  resetEnv()
  process.env.CLAUDE_CODE_TOOL_RESULT_COMPRESSION = 'true'

  const preview = 'legacy first preview'
  const selected = selectToolResultPreview(preview, [
    { type: 'text', text: largeLog() },
  ], 2000)

  eq(selected, preview)
})

test('small content is not compressed', () => {
  resetEnv()
  process.env.TAU_TOOL_RESULT_COMPRESSION = '1'

  eq(buildCompressedToolResultPreview('short\ncontent', 1000), null)
})

resetEnv()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
