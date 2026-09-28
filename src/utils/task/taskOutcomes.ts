import { randomBytes } from 'crypto'
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { open, readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { isTerminalTaskStatus, type TaskType } from '../../Task.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { isBackgroundTask, type TaskState } from '../../tasks/types.js'
import { logForDebugging } from '../debug.js'
import { getProjectTempDir } from '../permissions/filesystem.js'
import { getTaskOutputDir } from './diskOutput.js'

// A finished task leaves AppState soon after its notification is queued,
// often before the model has read that notification. Without a record, a
// TaskStop or TaskOutput for it answered "No task found". Each outcome is kept
// in memory for this process and in `<id>.outcome.json` next to the task's
// output file, so the answer stays right after a restart or --resume too.

export type FinishedTaskStatus = 'completed' | 'failed' | 'killed'

export type TaskOutcome = {
  id: string
  type: TaskType
  status: FinishedTaskStatus
  description: string
  outputFile: string
  command?: string
  exitCode?: number
  error?: string
  endTime?: number
}

export type EndedTask =
  | { kind: 'recorded'; outcome: TaskOutcome }
  // An output file with no recorded outcome: a task of an earlier run or
  // another session, or one that finished before outcomes were recorded.
  | { kind: 'untracked'; id: string; outputFile: string }

const OUTCOME_SUFFIX = '.outcome.json'
const MAX_REMEMBERED = 1_000
// TaskOutput's own result cap.
const MAX_RESULT_CHARS = 100_000
const MAX_OUTCOME_FILE_BYTES = 1_000_000
const MAX_ERROR_CHARS = 200
// Task and agent ids are file names in the tasks folder; anything else never
// reaches the file system.
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const TASK_TYPES = new Set<string>([
  'local_bash',
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow',
  'monitor_mcp',
  'dream',
])
const FINISHED_STATUSES = new Set<string>(['completed', 'failed', 'killed'])

const remembered = new Map<string, TaskOutcome>()

/** The outcome of a task in a terminal status; null while it still runs. */
export function outcomeOfTask(task: TaskState): TaskOutcome | null {
  if (!isTerminalTaskStatus(task.status)) return null
  const outcome: TaskOutcome = {
    id: task.id,
    type: task.type,
    status: task.status as FinishedTaskStatus,
    description: task.description,
    outputFile: task.outputFile,
  }
  if ('command' in task && typeof task.command === 'string') {
    outcome.command = task.command
  }
  if (isLocalShellTask(task) && task.result) {
    outcome.exitCode = task.result.code
  }
  if ('error' in task && typeof task.error === 'string' && task.error) {
    outcome.error = task.error
  }
  if (task.endTime !== undefined) outcome.endTime = task.endTime
  return outcome
}

/**
 * Record every task that reached a terminal status or left AppState between
 * two snapshots of `tasks`. Called from onChangeAppState, which every tasks
 * change passes through (framework eviction, eager eviction, /clear, ...).
 */
export function recordTaskOutcomes(
  prev: Record<string, TaskState>,
  next: Record<string, TaskState>,
): void {
  for (const id in next) {
    const task = next[id]!
    const before = prev[id]
    if (task === before || !isTerminalTaskStatus(task.status)) continue
    // Later updates of an already finished task (notified, evictAfter).
    if (before && isTerminalTaskStatus(before.status)) continue
    remember(task)
  }
  for (const id in prev) {
    if (id in next) continue
    const task = prev[id]!
    // Finished and removed in the same update.
    if (
      isTerminalTaskStatus(task.status) &&
      remembered.get(id)?.status !== task.status
    ) {
      remember(task)
    }
  }
}

function remember(task: TaskState): void {
  const outcome = outcomeOfTask(task)
  if (!outcome) return
  rememberInMemory(outcome)
  persist(outcome, finalTextOf(task))
}

function rememberInMemory(outcome: TaskOutcome): void {
  remembered.delete(outcome.id)
  remembered.set(outcome.id, outcome)
  if (remembered.size > MAX_REMEMBERED) {
    remembered.delete(remembered.keys().next().value!)
  }
}

// A sub-agent's final answer: TaskOutput returns it instead of the raw
// transcript the agent's output file links to.
function finalTextOf(task: TaskState): string | undefined {
  if (task.type !== 'local_agent' || !('result' in task)) return undefined
  const content = task.result?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  return text ? text.slice(0, MAX_RESULT_CHARS) : undefined
}

// Synchronous so the record survives an exit right after the task ends (Tau
// stops running tasks on exit). Written to a fresh file and renamed into
// place: never through a symlink someone left in the folder, and a task that
// finishes again after a resume replaces its old record.
function persist(outcome: TaskOutcome, result: string | undefined): void {
  if (!SAFE_TASK_ID.test(outcome.id)) return
  const dir = getTaskOutputDir()
  const target = join(dir, `${outcome.id}${OUTCOME_SUFFIX}`)
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const { outputFile: _, ...record } = outcome
  try {
    mkdirSync(dir, { recursive: true })
    const fd = openSync(
      temp,
      process.platform === 'win32'
        ? 'wx'
        : fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(fd, JSON.stringify(result ? { ...record, result } : record))
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
  } catch (error) {
    logForDebugging(`Task outcome for ${outcome.id} not saved: ${error}`)
    try {
      unlinkSync(temp)
    } catch {
      // Never created.
    }
  }
}

/**
 * A task that is no longer in AppState: its recorded outcome, or its output
 * file when no outcome was recorded. Looks in this process's tasks folder,
 * then in the other sessions of this project (task ids are random, so an id
 * names one task). Null for an id no task ever had.
 */
export async function findEndedTask(taskId: string): Promise<EndedTask | null> {
  const known = remembered.get(taskId)
  if (known) return { kind: 'recorded', outcome: known }
  if (!SAFE_TASK_ID.test(taskId)) return null

  const ownDir = getTaskOutputDir()
  const own = await readTaskFolder(ownDir, taskId)
  if (own) return own.ended

  const projectDir = getProjectTempDir()
  let sessions: string[]
  try {
    sessions = await readdir(projectDir)
  } catch {
    return null
  }
  let best: { ended: EndedTask; mtimeMs: number } | null = null
  for (const session of sessions) {
    const dir = join(projectDir, session, 'tasks')
    if (dir === ownDir) continue
    const found = await readTaskFolder(dir, taskId)
    if (found && (!best || found.mtimeMs > best.mtimeMs)) best = found
  }
  return best?.ended ?? null
}

async function readTaskFolder(
  dir: string,
  taskId: string,
): Promise<{ ended: EndedTask; mtimeMs: number } | null> {
  const outputFile = join(dir, `${taskId}.output`)
  const record = await readOutcomeFile(join(dir, `${taskId}${OUTCOME_SUFFIX}`))
  if (record && record.id === taskId) {
    const { result: _, ...outcome } = record
    const recorded = { ...outcome, outputFile }
    rememberInMemory(recorded)
    return {
      ended: { kind: 'recorded', outcome: recorded },
      mtimeMs: record.mtimeMs,
    }
  }
  try {
    const output = await stat(outputFile)
    if (!output.isFile()) return null
    return {
      ended: { kind: 'untracked', id: taskId, outputFile },
      mtimeMs: output.mtimeMs,
    }
  } catch {
    return null
  }
}

async function readOutcomeFile(
  path: string,
): Promise<
  (Omit<TaskOutcome, 'outputFile'> & { result?: string; mtimeMs: number }) | null
> {
  let text: string
  let mtimeMs: number
  try {
    const handle = await open(
      path,
      process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | O_NOFOLLOW,
    )
    try {
      const info = await handle.stat()
      // Never more than a record plus a capped result.
      if (!info.isFile() || info.size > MAX_OUTCOME_FILE_BYTES) return null
      mtimeMs = info.mtimeMs
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (
    typeof data?.id !== 'string' ||
    typeof data.type !== 'string' ||
    !TASK_TYPES.has(data.type) ||
    typeof data.status !== 'string' ||
    !FINISHED_STATUSES.has(data.status) ||
    typeof data.description !== 'string'
  ) {
    return null
  }
  return {
    id: data.id,
    type: data.type as TaskType,
    status: data.status as FinishedTaskStatus,
    description: data.description,
    ...(typeof data.command === 'string' ? { command: data.command } : {}),
    ...(typeof data.exitCode === 'number' ? { exitCode: data.exitCode } : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(typeof data.endTime === 'number' ? { endTime: data.endTime } : {}),
    ...(typeof data.result === 'string' ? { result: data.result } : {}),
    mtimeMs,
  }
}

/** A finished sub-agent's final answer, when its outcome recorded one. */
export async function readRecordedResult(
  outcome: TaskOutcome,
): Promise<string | undefined> {
  const record = await readOutcomeFile(
    join(dirname(outcome.outputFile), `${outcome.id}${OUTCOME_SUFFIX}`),
  )
  return record?.id === outcome.id ? record.result : undefined
}

/** "status: failed, exit code 127" */
export function describeTaskOutcome(outcome: TaskOutcome): string {
  if (outcome.exitCode !== undefined) {
    return `status: ${outcome.status}, exit code ${outcome.exitCode}`
  }
  if (outcome.error) {
    const error =
      outcome.error.length > MAX_ERROR_CHARS
        ? `${outcome.error.slice(0, MAX_ERROR_CHARS)}…`
        : outcome.error
    return `status: ${outcome.status}, error: ${error}`
  }
  return `status: ${outcome.status}`
}

/** "No task found" plus what is running, so a wrong id can be corrected. */
export function noTaskFoundMessage(
  taskId: string,
  tasks: Record<string, TaskState> | undefined,
): string {
  const running = Object.values(tasks ?? {}).filter(isBackgroundTask)
  if (running.length === 0) {
    return `No task found with ID: ${taskId}. No background task is running.`
  }
  const listed = running
    .slice(0, 10)
    .map(task => `${task.id} (${task.description.slice(0, 60)})`)
    .join(', ')
  const more = running.length > 10 ? `, and ${running.length - 10} more` : ''
  return `No task found with ID: ${taskId}. Running tasks: ${listed}${more}.`
}

export function _resetTaskOutcomesForTest(): void {
  remembered.clear()
}
