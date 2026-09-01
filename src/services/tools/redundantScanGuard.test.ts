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

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

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

test('catches every spelling of "scan the filesystem myself"', () => {
  // Written from the idea, not from one transcript. The first version of the
  // pattern was built around the `os.walk` it happened to see and silently
  // missed `Path(x).glob(...)`, which is the most common spelling of all.
  for (const code of [
    'paths = tool.Glob(pattern="**/*.ts")',
    'hits = tool.Grep(pattern="TODO", path="src")',
    'from pathlib import Path\nfiles = list(Path("src").glob("*.tsx"))',
    'from pathlib import Path\nfiles = list(Path("src").rglob("*.tsx"))',
    'import glob\nfiles = glob.glob("**/*.ts", recursive=True)',
    'import glob\nfor f in glob.iglob("**/*.ts"): pass',
    'import os\nnames = os.listdir("src")',
    'import os\nfor e in os.scandir("src"): pass',
    'from pathlib import Path\nfor p in Path(".").iterdir(): pass',
    'import os\nfor r, d, f in os.walk("."): pass',
    'for r, d, f in os.walk( "." ): pass',
  ]) {
    __resetAllScanGuards()
    noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
    assert(
      noteToolCallForScanGuard(A, 'Eval', { code }) !== null,
      `self-scan not detected: ${code.split('\n').pop()}`,
    )
  }
})

test('does not fire on work that only filters an existing list', () => {
  // fnmatch and comprehensions operate on paths the model already has, so the
  // earlier search was used, not wasted.
  for (const code of [
    'import fnmatch\nkeep = fnmatch.filter(paths, "*.tsx")',
    'keep = [p for p in paths if p.endswith(".tsx")]',
    'total = sum(len(tool.Read(file_path=p)) for p in paths)',
    'import json\nlock = json.load(open("package-lock.json"))',
    'df = pandas.read_csv("data.csv")',
  ]) {
    __resetAllScanGuards()
    noteToolCallForScanGuard(A, 'Glob', { pattern: '**/*' })
    assert(
      noteToolCallForScanGuard(A, 'Eval', { code }) === null,
      `false positive on: ${code.split('\n').pop()}`,
    )
  }
})

test('tool names come from the real constants, not string literals', () => {
  // A rename would otherwise silently disable the guard: the strings would
  // stop matching and nothing would fail.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'redundantScanGuard.ts'), 'utf8')
  for (const constant of [
    'GLOB_TOOL_NAME',
    'GREP_TOOL_NAME',
    'TODO_WRITE_TOOL_NAME',
    'EVAL_TOOL_NAME',
  ]) {
    assert(source.includes(constant), `${constant} is not imported`)
  }
  assert(
    !/new Set\(\[\s*'Glob'/.test(source),
    'tool names are hardcoded as string literals again',
  )
})

test('transparency stays in step with repeatToolGuard', () => {
  // If one guard treats a call as transparent and the other does not,
  // interleaving it launders one pattern but not the other.
  const here = dirname(fileURLToPath(import.meta.url))
  const sibling = readFileSync(join(here, 'repeatToolGuard.ts'), 'utf8')
  const at = sibling.indexOf('TRANSPARENT_TOOLS')
  assert(at !== -1, 'repeatToolGuard no longer has a transparent set')
  const line = sibling.slice(at, sibling.indexOf('\n', at))
  assert(
    line.includes('TodoWrite'),
    `repeatToolGuard's transparent set changed; mirror it here: ${line}`,
  )
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
