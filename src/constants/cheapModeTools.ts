import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../tools/EnterPlanModeTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/constants.js'
import { WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'
import { SNAPSHOT_TOOL_NAME } from '../tools/SnapshotTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { TOOL_OUTPUT_RETRIEVE_TOOL_NAME } from '../tools/ToolOutputRetrieveTool/constants.js'
import { EVAL_TOOL_NAME } from '../tools/EvalTool/constants.js'

/**
 * Core tool names kept in cheap power mode. Everything else — optional
 * prebuilt tools, agents, skills, MCP, and the auxiliary built-ins — is
 * dropped so the request stays minimal. Conditional availability (embedded
 * search, todo v2, PowerShell platform gate) is handled upstream by
 * getAllBaseTools(); this set only needs to name the allowed core.
 *
 * Shared by getTools() (tools.ts) and mergeAndFilterTools() (toolPool.ts) so
 * stale initialTools merged from an earlier mode can never leak non-core
 * tools into a cheap-mode request.
 *
 * Lives in its own leaf module (constants only — no tool implementations)
 * so it stays importable under bun test and keeps a single unambiguous
 * symbol in the bundle.
 */
export const CHEAP_MODE_CORE_TOOL_NAME_SET: ReadonlySet<string> = new Set([
  ...SHELL_TOOL_NAMES,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  SNAPSHOT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  TOOL_OUTPUT_RETRIEVE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  // Cheap mode is about spending fewer tokens, and this is the tool that
  // spends the fewest: a scan that costs six turns and 190K tokens of file
  // bodies through Read/Grep costs one turn and a printed table through a
  // cell, because the intermediate data never enters the conversation. Its
  // ~1K-token prompt is a single cache write at session start, repaid by the
  // first multi-file question. Subagents are off in cheap mode, so this is
  // also the only remaining way to keep bulk output out of context.
  EVAL_TOOL_NAME,
])
