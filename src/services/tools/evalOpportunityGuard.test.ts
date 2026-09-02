/**
 * Eval-opportunity guard tests.
 *
 * Run via: bun run src/services/tools/evalOpportunityGuard.test.ts
 *
 * The guard must fire on the exact miss observed in a live test — asked for
 * the ten largest files in src/, the model ran
 * `find … | xargs wc -l | sort -rn | head`, needed three attempts because
 * xargs batching injected `total` rows into the sort, and silently ranked by
 * lines rather than bytes — and stay silent otherwise.
 *
 * A false positive costs a wasted nudge every time it misfires, and enough of
 * them train the model to ignore the channel entirely. So the silence cases
 * carry as much weight here as the firing ones.
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import {
  __resetAllEvalGuards,
  isAggregatingPipeline,
  noteToolCallForEvalGuard,
  resetEvalGuard,
} from './evalOpportunityGuard.js'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

function test(name: string, fn: () => void): void {
  __resetAllEvalGuards()
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
const B = 'agent-b'

console.log('\neval-opportunity guard: aggregating pipeline')

test('fires on the exact observed command', () => {
  const reminder = noteToolCallForEvalGuard(A, 'Bash', {
    command:
      'find src -type f \\( -name "*.ts" -o -name "*.tsx" \\) | xargs wc -l | sort -rn | head -10',
  })
  assert(reminder !== null, 'the guard stayed silent on the observed miss')
  assert(
    reminder.includes('<system-reminder>'),
    'the reminder must be wrapped so it reads as guidance, not tool output',
  )
  assert(reminder.includes('Eval'), 'the reminder should name the tool to use')
})

test('fires on grep -r piped into wc', () => {
  assert(
    noteToolCallForEvalGuard(A, 'Bash', {
      command: 'grep -r TODO src | wc -l',
    }) !== null,
    'a recursive grep aggregated by wc is computing',
  )
})

test('fires on ls piped into sort', () => {
  assert(
    noteToolCallForEvalGuard(A, 'Bash', { command: 'ls -la src | sort -k5 -n' }) !==
      null,
    'enumerate then rank is computing',
  )
})

console.log('\neval-opportunity guard: silence cases')

test('a plain command never fires', () => {
  assert(
    noteToolCallForEvalGuard(A, 'Bash', { command: 'npm run build' }) === null,
    'running a build is reading its output',
  )
})

test('a single-file pipeline never fires', () => {
  assert(
    isAggregatingPipeline('cat package.json | grep name | head -1') === false,
    'one file through grep is reading, not aggregating over a tree',
  )
})

test('ls piped into head never fires', () => {
  assert(
    isAggregatingPipeline('ls src | head -20') === false,
    'showing a few filenames is reading; only ranking or aggregating counts',
  )
})

test('git log piped into head never fires', () => {
  assert(
    isAggregatingPipeline('git log --oneline | head -20') === false,
    'git log does not enumerate files',
  )
})

test('a logical or is not read as a pipe', () => {
  assert(
    isAggregatingPipeline('find . -name x || wc -l foo') === false,
    '|| is control flow, not a pipeline stage',
  )
})

test('reduce before enumerate does not fire', () => {
  assert(
    isAggregatingPipeline('sort file.txt | find') === false,
    'the aggregation must be downstream of the enumeration',
  )
})

test('fires at most once per agent', () => {
  const cmd = { command: 'find . -type f | wc -l' }
  assert(noteToolCallForEvalGuard(A, 'Bash', cmd) !== null, 'first should fire')
  assert(
    noteToolCallForEvalGuard(A, 'Bash', cmd) === null,
    'a repeated nudge is noise, not teaching',
  )
})

test('agents are tracked independently', () => {
  const cmd = { command: 'find . -type f | wc -l' }
  assert(noteToolCallForEvalGuard(A, 'Bash', cmd) !== null, 'agent A fires')
  assert(
    noteToolCallForEvalGuard(B, 'Bash', cmd) !== null,
    "agent A's nudge must not silence agent B",
  )
})

console.log('\neval-opportunity guard: repeated mutation')

test('fires on the third edit across different files', () => {
  assert(
    noteToolCallForEvalGuard(A, 'Edit', { file_path: '/a.ts' }) === null,
    'one edit is ordinary work',
  )
  assert(
    noteToolCallForEvalGuard(A, 'Edit', { file_path: '/b.ts' }) === null,
    'two edits are ordinary work',
  )
  const reminder = noteToolCallForEvalGuard(A, 'Edit', { file_path: '/c.ts' })
  assert(reminder !== null, 'three edits across files is a bulk change')
  assert(reminder.includes('Edit'), 'the reminder should name the repeated tool')
})

test('does not fire when the same file is edited repeatedly', () => {
  for (let i = 0; i < 5; i++) {
    assert(
      noteToolCallForEvalGuard(A, 'Edit', { file_path: '/same.ts' }) === null,
      'refining one file is not a bulk change; repeatToolGuard owns that case',
    )
  }
})

test('an unrelated call breaks the run', () => {
  noteToolCallForEvalGuard(A, 'Edit', { file_path: '/a.ts' })
  noteToolCallForEvalGuard(A, 'Edit', { file_path: '/b.ts' })
  noteToolCallForEvalGuard(A, 'Grep', { pattern: 'x' })
  assert(
    noteToolCallForEvalGuard(A, 'Edit', { file_path: '/c.ts' }) === null,
    'the model evidently did something else in between',
  )
})

test('a bookkeeping call cannot launder the run', () => {
  noteToolCallForEvalGuard(A, 'Edit', { file_path: '/a.ts' })
  noteToolCallForEvalGuard(A, 'TodoWrite', { todos: [] })
  noteToolCallForEvalGuard(A, 'Edit', { file_path: '/b.ts' })
  assert(
    noteToolCallForEvalGuard(A, 'Edit', { file_path: '/c.ts' }) !== null,
    'interleaving TodoWrite must not hide a bulk edit',
  )
})

test('Write counts too', () => {
  noteToolCallForEvalGuard(A, 'Write', { file_path: '/a.ts', content: '' })
  noteToolCallForEvalGuard(A, 'Write', { file_path: '/b.ts', content: '' })
  assert(
    noteToolCallForEvalGuard(A, 'Write', { file_path: '/c.ts', content: '' }) !==
      null,
    'three writes across files is a bulk change',
  )
})

test('Read is deliberately not tracked', () => {
  for (const p of ['/a.ts', '/b.ts', '/c.ts', '/d.ts', '/e.ts']) {
    assert(
      noteToolCallForEvalGuard(A, 'Read', { file_path: p }) === null,
      'reading several files in a row is ordinary work far more often than not',
    )
  }
})

console.log('\neval-opportunity guard: hygiene')

test('resetEvalGuard drops the agent state', () => {
  noteToolCallForEvalGuard(A, 'Edit', { file_path: '/a.ts' })
  noteToolCallForEvalGuard(A, 'Edit', { file_path: '/b.ts' })
  resetEvalGuard(A)
  assert(
    noteToolCallForEvalGuard(A, 'Edit', { file_path: '/c.ts' }) === null,
    'a user interjection should clear the run',
  )
})

test('malformed input never throws', () => {
  for (const bad of [undefined, null, 'str', 42, [], { command: 7 }, { file_path: 1 }]) {
    noteToolCallForEvalGuard(A, 'Bash', bad)
    noteToolCallForEvalGuard(A, 'Edit', bad)
  }
})

test('tool names are imported constants, not string literals', () => {
  // A rename would otherwise silently disable the guard. Same discipline as
  // redundantScanGuard, which learned it the same way.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'evalOpportunityGuard.ts'), 'utf8')
  for (const literal of ["'Bash'", "'Edit'", "'Write'", "'TodoWrite'", "'Eval'"]) {
    assert(
      !source.includes(literal),
      `${literal} is a string literal; import the constant instead`,
    )
  }
})

test('the transparent-tool set stays in step with the other two guards', () => {
  // If one guard treats a call as transparent and another does not,
  // interleaving it launders one pattern but not the others.
  const here = dirname(fileURLToPath(import.meta.url))
  const mine = readFileSync(join(here, 'evalOpportunityGuard.ts'), 'utf8')
  const scan = readFileSync(join(here, 'redundantScanGuard.ts'), 'utf8')
  const repeat = readFileSync(join(here, 'repeatToolGuard.ts'), 'utf8')
  assert(
    mine.includes('TRANSPARENT_TOOLS') &&
      scan.includes('TRANSPARENT_TOOLS') &&
      repeat.includes('TRANSPARENT_TOOLS'),
    'all three guards must keep a transparent-tool set',
  )
  assert(
    mine.includes('TODO_WRITE_TOOL_NAME') && scan.includes('TODO_WRITE_TOOL_NAME'),
    'the transparent set drifted between guards',
  )
})

test('the guard is wired into the tool execution path', () => {
  // A guard nobody calls is a guard that does nothing.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'toolExecution.ts'), 'utf8')
  assert(
    source.includes('noteToolCallForEvalGuard'),
    'toolExecution.ts no longer calls the guard',
  )
  assert(
    source.includes('evalOpportunityGuard.js'),
    'toolExecution.ts no longer imports the guard',
  )
})

console.log(
  `\n${passed} passed, ${failed} failed` + (failures.length ? '\n\nfailures:\n  - ' + failures.join('\n  - ') : ''),
)
if (failed > 0) process.exit(1)
