export const TASK_STOP_TOOL_NAME = 'TaskStop'

export const DESCRIPTION =
  'Stop a running background task by task_id. Repeating a stop on an already-finished task is a no-op. task_id comes from a Bash run_in_background result or /tasks — never a TaskCreate item number.'
