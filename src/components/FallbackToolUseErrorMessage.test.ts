/**
 * Fallback tool validation error rendering.
 *
 * Run: bun run src/components/FallbackToolUseErrorMessage.test.ts
 */

import {
  normalizeToolError,
  redactToolErrorForNormalView,
} from './fallbackToolError.js'

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

  test('hides stack frames from the normal view and says how many', () => {
    const shown = redactToolErrorForNormalView(
      [
        'Error: the server rejected the call',
        '    at handler (/app/src/server.js:41:17)',
        '    at process.processTicksAndRejections (node:internal/process:95:5)',
      ].join('\n'),
    )

    assert(shown.includes('rejected the call'), `explanation lost: ${shown}`)
    assert(!shown.includes('server.js:41'), `stack frame leaked: ${shown}`)
    assert(shown.includes('2 technical lines hidden'), `no honest count: ${shown}`)
  })

  test('hides a raw JSON body but keeps the sentence above it', () => {
    const shown = redactToolErrorForNormalView(
      ['Error: upload failed', '{', '  "code": 500,', '  "trace": "abc"', '}'].join('\n'),
    )

    assert(shown.includes('upload failed'), `explanation lost: ${shown}`)
    assert(!shown.includes('"trace"'), `payload leaked: ${shown}`)
  })

  test('hides a base64 blob', () => {
    const blob = 'A'.repeat(200)
    const shown = redactToolErrorForNormalView(`Error: bad image\n${blob}`)

    assert(shown.includes('bad image'), `explanation lost: ${shown}`)
    assert(!shown.includes(blob), `blob leaked: ${shown}`)
  })

  test('an ordinary one-line error is returned untouched', () => {
    // The guard against over-correction: redaction must not rewrite a plain
    // failure, or every error grows a confusing "hidden" footer.
    const plain = 'Error: file not found'
    assert(
      redactToolErrorForNormalView(plain) === plain,
      'a plain error must be identical, not merely equivalent',
    )
  })

  test('a multi-line explanation with no machinery is untouched', () => {
    const prose = [
      'Error: the request was refused',
      'The server said the ref field is required.',
      'Supply it and try again.',
    ].join('\n')
    assert(
      redactToolErrorForNormalView(prose) === prose,
      'prose must survive intact',
    )
  })


  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
