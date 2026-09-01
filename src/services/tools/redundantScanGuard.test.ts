/**
 * Redundant-scan guard tests.
 *
 * Run via: bun run src/services/tools/redundantScanGuard.test.ts
 *
 * The guard must fire on the exact waste observed in a live session — a broad
 * Glob whose 1,737 paths went into context, immediately followed by a cell
 * that ran `os.walk('.')` and ignored them — and stay silent otherwise. A
 * false positive costs a wasted nudge on every turn it misfires, so the
 * silence cases matter as much as the firing one.
 */

import {
  __resetAllScanGuards,
  noteToolCallForScanGuard,
  resetScanGuard,
} from './redundantScanGuard.js'

let passed = 0
let failed = 0
const failures: string[] = []

// Declared as an assertion function so a passing check narrows the value —
// otherwise every `assert(reminder !== null)` is followed by a possibly-null
// dereference.
function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

function test(name: string, fn: () => void): void {
  __resetAllScanGuards()
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    const message = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${message}`)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

const A = 'agent-a'
const walkCell = { code: "import os\nfor root, dirs, files in os.walk('.'):\n    pass" }

console.log('\nredundant-scan guard')

test('fires on the exact observed pattern: Glob then a self-scanning cell', () => {
  assert(noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*.tsx' }) === null,
    'the search itself must not warn')
  const reminder = noteToolCallForScanGuard(A, 'Eval', walkCell)
  assert(reminder !== null, 'the guard stayed silent on the redundant rescan')
  assert(reminder.includes('Glob'), 'the reminder should name the wasted search')
  assert(
    reminder.includes('<system-reminder>'),
    'the reminder should be wrapped so it reads as guidance, not tool output',
  )
})

test('fires for Grep too', () => {
  noteToolCallForScanGuard(A, 'Grep', { pattern: 'TODO' })
  const reminder = noteToolCallForScanGuard(A, 'Eval', {
    code: "import glob\nfiles = glob.glob('**/*.ts', recursive=True)",
  })
  assert(reminder !== null, 'glob.glob after Grep should fire')
  assert(reminder.includes('Grep'), 'the reminder should name Grep')
})

test('catches the bridged forms of the same waste', () => {
  for (const code of [
    'paths = tool.Glob(pattern="**/*.ts")',
    'hits = tool.Grep(pattern="TODO", path="src")',
    'from pathlib import Path\nfiles = list(Path("src").rglob("*.tsx"))',
    'import os\nnames = os.listdir("src")',
  ]) {
    __resetAllScanGuards()
    noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
    assert(
      noteToolCallForScanGuard(A, 'Eval', { code }) !== null,
      `self-scan not detected: ${code.split('\n').pop()}`,
    )
  }
})

test('stays silent when the cell consumes the search result', () => {
  // The legitimate flow: Glob finds paths, the cell reads those paths. No
  // rescan, so nothing was wasted.
  noteToolCallForScanGuard(A, 'Glob', { pattern: 'src/**/*.tsx' })
  const reminder = noteToolCallForScanGuard(A, 'Eval', {
    code: 'total = sum(len(tool.Read(file_path=p)) for p in paths)',
  })
  assert(reminder === null, 'a cell that uses the result must not be warned')
})

test('stays silent for a cell with no preceding search', () => {
  assert(
    noteToolCallForScanGuard(A, 'Eval', walkCell) === null,
    'scanning inside a cell is the encouraged path, not a warning',
  )
})

test('stays silent for a search that is never followed by a cell', () => {
  assert(noteToolCallForScanGuard(A, 'Glob', { pattern: '*' }) === null, 'search')
  assert(
    noteToolCallForScanGuard(A, 'Read', { file_path: 'a.ts' }) === null,
    'an ordinary follow-up must not warn',
  )
})

test('an intervening tool call clears the pending search', () => {
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  noteToolCallForScanGuard(A, 'Read', { file_path: 'a.ts' })
  assert(
    noteToolCallForScanGuard(A, 'Eval', walkCell) === null,
    'the search was evidently used; the cell is a separate step',
  )
})

test('bookkeeping calls do not launder the pattern', () => {
  // Matches repeatToolGuard's transparency rule: interleaving a TodoWrite
  // must not hide the waste.
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  noteToolCallForScanGuard(A, 'TodoWrite', { todos: [] })
  assert(
    noteToolCallForScanGuard(A, 'Eval', walkCell) !== null,
    'a TodoWrite between the search and the cell hid the pattern',
  )
})

test('fires at most once per pending search', () => {
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  assert(noteToolCallForScanGuard(A, 'Eval', walkCell) !== null, 'first should fire')
  assert(
    noteToolCallForScanGuard(A, 'Eval', walkCell) === null,
    'the guard repeated itself on the next cell',
  )
})

test('chains are per agent', () => {
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  assert(
    noteToolCallForScanGuard('agent-b', 'Eval', walkCell) === null,
    "one agent's search must not warn another agent's cell",
  )
  assert(
    noteToolCallForScanGuard(A, 'Eval', walkCell) !== null,
    "the original agent's pending search was lost",
  )
})

test('resetScanGuard drops the pending search', () => {
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  resetScanGuard(A)
  assert(
    noteToolCallForScanGuard(A, 'Eval', walkCell) === null,
    'reset did not clear the pending search',
  )
})

test('malformed input never throws', () => {
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  assert(noteToolCallForScanGuard(A, 'Eval', null) === null, 'null input')
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  assert(noteToolCallForScanGuard(A, 'Eval', { code: 42 }) === null, 'non-string code')
  noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
  assert(noteToolCallForScanGuard(A, 'Eval', 'not an object') === null, 'string input')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
if (failed > 0) process.exit(1)
