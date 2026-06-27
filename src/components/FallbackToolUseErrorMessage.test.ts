/**
 * Fallback tool validation error rendering.
 *
 * Run: bun run src/components/FallbackToolUseErrorMessage.test.ts
 */

import { normalizeToolError } from './fallbackToolError.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

function assert(condition: unknown, hint: string): void {
  if (!condition) throw new Error(hint)
}

function main(): void {
  console.log('fallback tool validation UI:')

  test('shows tool name and missing field without schema dump', () => {
    const rendered = normalizeToolError([
      'InputValidationError: Read failed due to the following issue:',
      'The required parameter `file_path` is missing',
      'Expected input schema:',
      '{',
      '  "type": "object",',
      '  "required": ["file_path"]',
      '}',
      'Received input:',
      '{}',
    ].join('\n'))

    assert(rendered.includes('Read'), `missing tool name: ${rendered}`)
    assert(rendered.includes('`file_path`'), `missing field name: ${rendered}`)
    assert(rendered.includes('Received {}'), `missing compact received input: ${rendered}`)
    assert(!rendered.includes('Expected input schema'), `schema leaked: ${rendered}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
