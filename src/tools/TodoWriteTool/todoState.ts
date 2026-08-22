import type { TodoList } from '../../utils/todo/types.js'

/** Enforce task progress without making the model repair/retry invalid state. */
export function normalizeTodoProgress(todos: TodoList): {
  todos: TodoList
  normalized: boolean
} {
  const unfinished = todos
    .map((todo, index) => ({ todo, index }))
    .filter(({ todo }) => todo.status !== 'completed')
  if (unfinished.length === 0) return { todos, normalized: false }

  const activeIndex =
    unfinished.find(({ todo }) => todo.status === 'in_progress')?.index ??
    unfinished[0]!.index
  let normalized = false
  const result = todos.map((todo, index) => {
    if (todo.status === 'completed') return todo
    const status = index === activeIndex ? 'in_progress' : 'pending'
    if (todo.status === status) return todo
    normalized = true
    return { ...todo, status }
  })
  return { todos: result, normalized }
}

export function todoListsEqual(left: TodoList, right: TodoList): boolean {
  return (
    left.length === right.length &&
    left.every(
      (todo, index) =>
        todo.content === right[index]?.content &&
        todo.activeForm === right[index]?.activeForm &&
        todo.status === right[index]?.status,
    )
  )
}

export function prepareTodoUpdate(oldTodos: TodoList, incoming: TodoList) {
  const normalizedResult = normalizeTodoProgress(incoming)
  const normalizedTodos = normalizedResult.todos
  const allDone = normalizedTodos.every(todo => todo.status === 'completed')
  const storedTodos: TodoList = allDone ? [] : normalizedTodos
  return {
    normalizedTodos,
    storedTodos,
    allDone,
    normalized: normalizedResult.normalized,
    unchanged: todoListsEqual(oldTodos, storedTodos),
  }
}

export function getTodoUpdateMessage({
  newTodos,
  unchanged,
  normalized,
}: {
  newTodos: TodoList
  unchanged?: boolean
  normalized?: boolean
}): string {
  const allDone =
    newTodos.length > 0 && newTodos.every(todo => todo.status === 'completed')
  if (unchanged) {
    return 'Todo list is unchanged. Do not repeat this call until an item or status changes.'
  }
  if (allDone) {
    return 'All todos are completed and the session list is cleared. Do not call TodoWrite again unless new work is discovered.'
  }
  if (newTodos.length === 0) {
    return 'Todo list cleared. Do not call TodoWrite again unless new work is discovered.'
  }
  if (normalized) {
    return 'Todo list updated. Statuses were normalized to exactly one in-progress item; continue with that item.'
  }
  return 'Todo list updated. Continue with the in-progress item.'
}
