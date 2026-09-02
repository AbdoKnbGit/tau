/**
 * Schema-validation tool errors are recognised, and only those.
 *
 * The UI renders these as an amber "retrying" line instead of a red failure
 * row (UserToolErrorMessage), because such a call never ran — the arguments
 * never matched the schema, so nothing was written and nothing was executed.
 * Misclassifying here is what makes that dangerous in either direction: a
 * false positive hides a real failure the user needs to see, a false negative
 * puts the old misleading red row back.
 *
 * Run: bun run src/utils/toolInputValidationError.test.ts
 */

import {
  isToolInputValidationError,
  TOOL_INPUT_VALIDATION_ERROR_PREFIX,
} from './toolValidationError.js'

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

/** Exactly the shape toolExecution.ts puts on the wire. */
function asToolExecutionWrites(errorContent: string): string {
  return `<tool_use_error>${TOOL_INPUT_VALIDATION_ERROR_PREFIX}${errorContent}</tool_use_error>`
}

const WRITE_FAILURE = `Write failed due to the following issue:
The required parameter \`file_path\` is missing
Expected input schema:
{ "type": "object" }
Received input:
{ "content": "\\"\\"\\"CLI: run detection" }`

function main(): void {
  console.log('tool input validation error detection:')

  test('recognises what toolExecution.ts actually emits', () => {
    assert(
      isToolInputValidationError(asToolExecutionWrites(WRITE_FAILURE)),
      'the real wire shape was not recognised',
    )
  })

  test('recognises the TaskCreate shape too', () => {
    const content = asToolExecutionWrites(
      'TaskCreate failed due to the following issue:\nThe required parameter `subject` is missing',
    )
    assert(isToolInputValidationError(content), 'missing-subject error was not recognised')
  })

  test('recognises the unwrapped form', () => {
    assert(
      isToolInputValidationError(`${TOOL_INPUT_VALIDATION_ERROR_PREFIX}Write failed`),
      'bare prefix was not recognised',
    )
  })

  test('recognises text blocks, not just string content', () => {
    assert(
      isToolInputValidationError([
        { type: 'text', text: asToolExecutionWrites(WRITE_FAILURE) },
      ]),
      'block-array content was not recognised',
    )
  })

  test('leaves a real tool failure alone', () => {
    for (const content of [
      '<tool_use_error>Error: ENOENT: no such file or directory</tool_use_error>',
      '<tool_use_error>Error: Exit code 1</tool_use_error>',
      'File has not been read yet. Read it first before writing to it.',
      '<tool_use_error>Cancelled: user rejected the edit</tool_use_error>',
    ]) {
      assert(
        !isToolInputValidationError(content),
        `a genuine failure would be hidden behind "retrying": ${content}`,
      )
    }
  })

  test('a tool that merely quotes the phrase still shows as a failure', () => {
    const content =
      '<tool_use_error>Error: grep found InputValidationError: in 3 files</tool_use_error>'
    assert(
      !isToolInputValidationError(content),
      'matched the phrase mid-output instead of at the start',
    )
  })

  test('handles empty and non-text content without matching', () => {
    assert(!isToolInputValidationError(''), 'empty string matched')
    assert(!isToolInputValidationError(undefined), 'undefined matched')
    assert(!isToolInputValidationError([]), 'empty block array matched')
    assert(
      !isToolInputValidationError([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      ] as never),
      'an image-only result matched',
    )
  })

  test('the prefix constant is the string the display layer parses', () => {
    // fallbackToolError.ts strips this exact prefix when summarising, and
    // toolExecution.ts writes it. A change here silently breaks both.
    assert(
      TOOL_INPUT_VALIDATION_ERROR_PREFIX === 'InputValidationError: ',
      `prefix drifted: ${JSON.stringify(TOOL_INPUT_VALIDATION_ERROR_PREFIX)}`,
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
