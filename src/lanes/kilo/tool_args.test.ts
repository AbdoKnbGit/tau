/**
 * Regression tests for KiloCode-only tool argument repair.
 *
 * Run: bun run src/lanes/kilo/tool_args.test.ts
 */

import {
  normalizeKiloToolCallArguments,
  normalizeKiloToolCallArgumentString,
} from './tool_args.js'

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

function main(): void {
  console.log('kilo tool args:')

  test('parses AskUserQuestion.questions when Kilo emits a JSON string', () => {
    const rawQuestions = JSON.stringify([
      {
        question: 'Which fix should I apply?',
        header: 'Fix',
        options: [
          { label: 'Narrow', description: 'Scope only KiloCode.' },
          { label: 'Broad', description: 'Apply globally.' },
        ],
      },
    ])
    const normalized = normalizeKiloToolCallArguments('AskUserQuestion', {
      questions: rawQuestions,
    })
    const questions = normalized.questions as Array<Record<string, unknown>>
    assert(Array.isArray(questions), 'questions should be an array')
    assert(questions[0]?.question === 'Which fix should I apply?', 'question text lost')
    assert(Array.isArray(questions[0]?.options), 'options should be an array')
  })

  test('normalizes AskUserQuestion shorthand into a valid questions array', () => {
    const normalized = normalizeKiloToolCallArguments('AskUserQuestion', {
      question: 'Proceed with Kilo-only scope?',
      type: 'yesno',
    })
    const questions = normalized.questions as Array<Record<string, any>>
    assert(Array.isArray(questions), 'questions should be an array')
    assert(questions[0]?.header === 'Proceed with', `unexpected header ${questions[0]?.header}`)
    assert(questions[0]?.options?.[0]?.label === 'Yes', 'yes/no fallback missing')
    assert(questions[0]?.multiSelect === false, 'multiSelect should default false')
  })

  test('maps Edit path aliases to file_path without leaking extra keys', () => {
    const normalized = normalizeKiloToolCallArguments('Edit', {
      path: '/repo/src/a.ts',
      old_str: 'old',
      new_str: 'new',
    })
    assert(normalized.file_path === '/repo/src/a.ts', 'file_path missing')
    assert(normalized.old_string === 'old', 'old_string missing')
    assert(normalized.new_string === 'new', 'new_string missing')
    assert(!('path' in normalized), 'path alias should not be forwarded')
  })

  test('repairs a complete streamed argument string', () => {
    const raw = JSON.stringify({
      path: '/repo/src/a.ts',
      old_text: 'left',
      new_text: 'right',
    })
    const normalized = JSON.parse(normalizeKiloToolCallArgumentString('Edit', raw))
    assert(normalized.file_path === '/repo/src/a.ts', 'file_path missing')
    assert(normalized.old_string === 'left', 'old_string missing')
    assert(normalized.new_string === 'right', 'new_string missing')
  })

  test('maps TaskGet id aliases to taskId', () => {
    const normalized = normalizeKiloToolCallArguments('TaskGet', { id: '7' })
    assert(normalized.taskId === '7', 'taskId missing')
  })

  test('keeps the optional arguments the alias map does not name', () => {
    // A rebuilt input used to drop them: a PDF page range read the whole file.
    const read = normalizeKiloToolCallArguments('Read', {
      path: '/repo/doc.pdf',
      pages: '1-3',
      skeleton: false,
      offset: 10,
    })
    assert(read.file_path === '/repo/doc.pdf', 'file_path missing')
    assert(read.pages === '1-3', 'pages dropped')
    assert(read.skeleton === false, 'skeleton dropped')
    assert(read.offset === 10, 'offset dropped')
    assert(!('path' in read), 'path alias should not be forwarded')

    const edit = normalizeKiloToolCallArguments('Edit', {
      file_path: '/repo/a.ts',
      search: 'a',
      replace: 'b',
      allow_multiple: true,
    })
    assert(edit.replace_all === true, 'replace_all alias lost')
    assert(!('allow_multiple' in edit) && !('search' in edit) && !('replace' in edit), 'alias forwarded')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
