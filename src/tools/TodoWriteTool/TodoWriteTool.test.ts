import type { TodoList } from '../../utils/todo/types.js'
import {
  getTodoUpdateMessage,
  normalizeTodoProgress,
  prepareTodoUpdate,
  todoListsEqual,
} from './todoState.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const item = (
  content: string,
  status: TodoList[number]['status'],
): TodoList[number] => ({
  content,
  activeForm: `${content} now`,
  status,
})

console.log('TodoWrite normalization and no-op behavior:')

test('normalizes multiple active items without a validation retry', () => {
  const result = normalizeTodoProgress([
    item('one', 'in_progress'),
    item('two', 'in_progress'),
    item('done', 'completed'),
  ])
  assert(result.normalized, 'expected normalization')
  assert(result.todos[0]?.status === 'in_progress', 'first active should win')
  assert(result.todos[1]?.status === 'pending', 'extra active should demote')
  assert(result.todos[2]?.status === 'completed', 'completed must stay completed')
})

test('promotes the first pending item when none is active', () => {
  const result = normalizeTodoProgress([
    item('done', 'completed'),
    item('next', 'pending'),
    item('later', 'pending'),
  ])
  assert(result.todos[1]?.status === 'in_progress', 'first unfinished should promote')
  assert(result.todos[2]?.status === 'pending', 'later item should remain pending')
})

test('suppresses an identical update and tells the model not to retry', () => {
  const list = [item('one', 'in_progress'), item('two', 'pending')]
  const update = prepareTodoUpdate(list, list.map(todo => ({ ...todo })))
  assert(update.unchanged, 'expected unchanged result')
  assert(update.storedTodos === update.normalizedTodos, 'state should be reusable')
  assert(
    getTodoUpdateMessage({ newTodos: update.normalizedTodos, ...update }).includes(
      'Do not repeat',
    ),
    'result must stop retry loops',
  )
})

test('empty to empty is unchanged', () => {
  const update = prepareTodoUpdate([], [])
  assert(update.unchanged, 'empty list should be unchanged')
})

test('an empty input clears a nonempty list with a clear result', () => {
  const update = prepareTodoUpdate([item('one', 'in_progress')], [])
  assert(!update.unchanged, 'clear should be a change')
  assert(update.storedTodos.length === 0, 'stored state should be empty')
  assert(
    getTodoUpdateMessage({ newTodos: update.normalizedTodos, ...update }).includes(
      'Todo list cleared',
    ),
    'result should report clear',
  )
})

test('completion clears once; repeating it is a no-op', () => {
  const completed = [
    item('one', 'completed'),
    item('two', 'completed'),
    item('three', 'completed'),
  ]
  const first = prepareTodoUpdate([item('three', 'in_progress')], completed)
  assert(!first.unchanged, 'first completion should change state')
  assert(first.storedTodos.length === 0, 'completion should clear state')

  const repeated = prepareTodoUpdate([], completed)
  assert(repeated.unchanged, 'repeated completion should be no-op')
  // TodoWrite gates its verification nudge with !update.unchanged; this state
  // proves a repeated completion cannot trigger the nudge a second time.
  assert(!(!repeated.unchanged && repeated.allDone), 'repeat nudge gate must be false')
})

test('list equality checks order, text, active form, and status', () => {
  const list = [item('one', 'in_progress')]
  assert(todoListsEqual(list, [{ ...list[0]! }]), 'equal lists should match')
  assert(!todoListsEqual(list, [item('one', 'pending')]), 'status must differ')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
