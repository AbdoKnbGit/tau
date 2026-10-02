/**
 * Run: bun run src/utils/toolResultCompression.test.ts
 */

import {
  buildCompressedToolResultPreview,
  isToolResultCompressionEnabled,
  selectToolResultPreview,
} from './toolResultCompression.js'
import { isWellFormedText } from './wellFormedText.js'

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

test('explicitly disabled mode returns the existing preview byte-identically', () => {
  resetEnv()
  process.env.TAU_TOOL_RESULT_COMPRESSION = '0'
  const preview = 'legacy first preview'
  const selected = selectToolResultPreview(preview, largeLog(), 2000)

  eq(selected, preview)
  assert(!isToolResultCompressionEnabled(), 'compression should be off')
})

test('default (no env) is enabled and builds a diagnostic preview', () => {
  resetEnv()
  assert(isToolResultCompressionEnabled(), 'compression should default on')

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

/** Shaped like a persisted web search: a few short lines, then huge ones. */
function searchLikeOutput(): string {
  const lines = ['Web search results for query: "gta 6 pc requirements"', '']
  for (let i = 1; i <= 8; i++) {
    lines.push(
      `Result ${i}:`,
      `Title: Result title number ${i}`,
      `URL: https://example.com/page-${i}`,
      'Content excerpt:',
      `Published: 2026 Highlights: ${'content words for this hit '.repeat(150)}`,
      '',
    )
  }
  lines.push('REMINDER: You MUST include the sources above in your response.')
  return lines.join('\n')
}

test('long lines no longer crowd out the last lines', () => {
  resetEnv()
  const content = searchLikeOutput()
  const preview = buildCompressedToolResultPreview(content, 2000)!
  assert(preview !== null, 'expected a preview')
  assert(preview.length <= 2000, `too long: ${preview.length}`)
  assert(preview.includes('--- first lines ---'), 'missing head section')
  assert(preview.includes('--- last lines ---'), 'missing tail section')
  assert(preview.includes('REMINDER: You MUST include the sources'), 'missing final line')
  assert(!preview.includes('preview trimmed to budget'), 'sections should fit by construction')
  for (const line of preview.split('\n')) {
    assert(line.length <= 300, `line not capped: ${line.length}`)
  }
  assert(preview.includes(' chars]'), 'capped lines must say how much was dropped')
})

test('fits the 512-char aggregate preview budget', () => {
  resetEnv()
  const preview = buildCompressedToolResultPreview(largeLog(), 512)!
  assert(preview !== null, 'expected a preview')
  assert(preview.length <= 512, `too long: ${preview.length}`)
  assert(preview.includes('--- first lines ---'), 'missing head')
  assert(preview.includes('--- last lines ---'), 'missing tail')
})

test('a diagnostic already shown in the first lines is not repeated', () => {
  resetEnv()
  const lines = largeLog().split('\n')
  lines[2] = 'Error: failed to start'
  const preview = buildCompressedToolResultPreview(lines.join('\n'), 2000)!
  const count = preview.split('Error: failed to start').length - 1
  eq(count, 1, 'diagnostic should appear once')
})

test('capped lines never split a surrogate pair', () => {
  resetEnv()
  const rocket = String.fromCodePoint(0x1f680)
  const lines = Array.from({ length: 60 }, (_, i) => `${i} ${rocket.repeat(400)}`)
  const preview = buildCompressedToolResultPreview(lines.join('\n'), 2000)!
  assert(preview !== null, 'expected a preview')
  assert(isWellFormedText(preview), 'preview has a lone surrogate')
})

test('is deterministic', () => {
  resetEnv()
  const content = searchLikeOutput()
  eq(
    buildCompressedToolResultPreview(content, 2000),
    buildCompressedToolResultPreview(content, 2000),
  )
})

resetEnv()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
