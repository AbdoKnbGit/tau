import { z } from 'zod/v4'
import type { AppState } from '../../state/AppState.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { StopTaskError, stopTask } from '../../tasks/stopTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  describeTaskOutcome,
  findEndedTask,
  noTaskFoundMessage,
  outcomeOfTask,
  type TaskOutcome,
} from '../../utils/task/taskOutcomes.js'
import { DESCRIPTION, TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z
      .string()
      .optional()
      .describe('Background task ID'),
    // shell_id is accepted for backward compatibility with the deprecated KillShell tool
    shell_id: z.string().optional().describe('Deprecated alias for task_id'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Status message about the operation'),
    task_id: z.string().describe('The ID of the task that was stopped'),
    task_type: z.string().describe('The type of the task that was stopped'),
    // Optional: tool outputs are persisted to transcripts and replayed on --resume
    // without re-validation, so sessions from before this field was added lack it.
    command: z
      .string()
      .optional()
      .describe('The command or description of the stopped task'),
    not_stopped: z
      .string()
      .optional()
      .describe('Why nothing was stopped: the task was no longer running'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// A task that already finished is NOT an error: the end state the model wants
// ("task not running") already holds, and erroring sent models into
// stop→error→retry loops. Answered the same way while the task is still in
// AppState and after it was evicted, restarted away or resumed from.
async function notRunningOutput(
  id: string,
  appState: AppState,
): Promise<Output | null> {
  const live = appState.tasks?.[id]
  if (live) {
    const outcome = outcomeOfTask(live)
    return outcome ? alreadyFinished(outcome) : null
  }
  const ended = await findEndedTask(id)
  if (!ended) return null
  if (ended.kind === 'recorded') return alreadyFinished(ended.outcome)
  return {
    message: `Task ${id} is not running in this Tau process (it ran before a restart or in another session); nothing to stop here. Output file: ${ended.outputFile}`,
    task_id: id,
    task_type: 'unknown',
    not_stopped: 'not running in this Tau process',
  }
}

function alreadyFinished(outcome: TaskOutcome): Output {
  const detail = describeTaskOutcome(outcome)
  return {
    message: `Task ${outcome.id} is already finished (${detail}); nothing to stop. Output file: ${outcome.outputFile}`,
    task_id: outcome.id,
    task_type: outcome.type,
    command:
      outcome.type === 'local_bash' ? outcome.command : outcome.description,
    not_stopped: `already finished (${detail})`,
  }
}

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  searchHint: 'kill a running background task',
  // KillShell is the deprecated name - kept as alias for backward compatibility
  // with existing transcripts and SDK users
  aliases: ['KillShell'],
  maxResultSizeChars: 100_000,
  userFacingName: () => (process.env.USER_TYPE === 'ant' ? '' : 'Stop Task'),
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task_id ?? input.shell_id ?? ''
  },
  async validateInput({ task_id, shell_id }, { getAppState }) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      return {
        result: false,
        message: 'Missing required parameter: task_id',
        errorCode: 1,
      }
    }

    const appState = getAppState()
    if (appState.tasks?.[id] || (await findEndedTask(id))) {
      return { result: true }
    }
    return {
      result: false,
      message: noTaskFoundMessage(id, appState.tasks),
      errorCode: 1,
    }
  },
  async description() {
    return `Stop a running background task by ID`
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(
    { task_id, shell_id },
    { getAppState, setAppState, abortController },
  ) {
    // Support both task_id and shell_id (deprecated KillShell compat)
    const id = task_id ?? shell_id
    if (!id) {
      throw new Error('Missing required parameter: task_id')
    }

    const notRunning = await notRunningOutput(id, getAppState())
    if (notRunning) {
      return { data: notRunning }
    }

    let result
    try {
      result = await stopTask(id, {
        getAppState,
        setAppState,
      })
    } catch (error) {
      // Finished between the check above and the stop.
      if (error instanceof StopTaskError && error.code === 'not_running') {
        const finished = await notRunningOutput(id, getAppState())
        if (finished) return { data: finished }
      }
      throw error
    }

    return {
      data: {
        message: `Successfully stopped task: ${result.taskId} (${result.command})`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
