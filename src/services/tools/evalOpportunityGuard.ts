import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { EVAL_TOOL_NAME } from '../../tools/EvalTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../../tools/TodoWriteTool/constants.js'

/**
 * Eval-opportunity guard.
 *
 * Two patterns where the work was computation but a read-shaped tool did it.
 * Same contract as `repeatToolGuard` and `redundantScanGuard`: NEVER blocks,
 * delays or rewrites a call; returns an advisory appended to that call's own
 * tool_result; costs exactly zero tokens on every turn where the pattern does
 * not occur, and never touches the cached prefix.
 *
 * WHY A GUARD RATHER THAN MORE PROMPT TEXT. Prompt text is paid on every
 * request of every session forever; an advisory is paid only on the turns
 * where the mistake actually happens. Conditional injection is the cheap
 * shape — but only when the trigger is the behaviour itself. A trigger the
 * user has to type is just a slower way of being asked.
 *
 * DETECTION IS SHAPE-BASED. Nothing here references a path, a filename, a
 * working directory, a repo layout or a project setting. The pipeline
 * detector matches POSIX shell verbs; the repetition detector counts calls.
 * Both work unchanged in any repository. This is the lesson `redundantScanGuard`
 * learned the hard way when its first version was fitted to the one transcript
 * that prompted it and silently missed the most common spelling.
 */

/**
 * Stages that enumerate MANY files. Deliberately excludes `cat`, and excludes
 * non-recursive `grep`: `cat f | grep x | wc -l` is one file being read, not
 * an aggregation over a tree, and warning about it would be a wasted nudge.
 */
const ENUMERATES_FILES =
  /\b(?:find|ls|rg)\b|\bgit\s+ls-files\b|\bgrep\b[^|]*\s-{1,2}(?:r|R|recursive)\b/

/**
 * Stages that AGGREGATE or RANK. Bare `head`/`tail` are deliberately absent:
 * `ls | head` is "show me a few filenames", which is reading. `sort | head`
 * still fires, because `sort` is the ranking step.
 */
const REDUCES = /\b(?:wc|sort|uniq|awk)\b/

/** Consecutive same-shaped mutations before the advisory fires. */
const EDIT_RUN_THRESHOLD = 3

/**
 * Mutating tools whose repetition across DIFFERENT files is the bulk-edit
 * signal. Read is deliberately absent: reading several files in a row is
 * ordinary work far more often than it is a missed aggregation.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * Bookkeeping calls that neither advance nor break a run. Mirrors the set in
 * `repeatToolGuard` and `redundantScanGuard` on purpose: if one guard treats a
 * call as transparent and another does not, interleaving it launders one
 * pattern but not the others. The test file asserts the three stay in step.
 */
const TRANSPARENT_TOOLS: ReadonlySet<string> = new Set([TODO_WRITE_TOOL_NAME])

/** Bound on tracked agents, mirroring the other two guards. */
const MAX_TRACKED_AGENTS = 100

interface AgentState {
  /** Tool name of the current mutation run, or null when no run is open. */
  runTool: string | null
  /** Distinct targets seen in the current run. */
  runTargets: Set<string>
  /** The pipeline advisory fires once per agent; a repeated nudge is noise. */
  pipelineFired: boolean
  /** Likewise for the bulk-edit advisory. */
  editRunFired: boolean
}

const agents = new Map<string, AgentState>()

function stateFor(agentKey: string): AgentState {
  const existing = agents.get(agentKey)
  if (existing) return existing
  if (agents.size >= MAX_TRACKED_AGENTS) {
    // Map preserves insertion order; drop the oldest tracked agent.
    const oldest = agents.keys().next()
    if (!oldest.done) agents.delete(oldest.value)
  }
  const fresh: AgentState = {
    runTool: null,
    runTargets: new Set(),
    pipelineFired: false,
    editRunFired: false,
  }
  agents.set(agentKey, fresh)
  return fresh
}

/**
 * True when a command enumerates files in one stage and aggregates them in a
 * later one. `||` is masked first so a logical-or is never read as a pipe.
 */
export function isAggregatingPipeline(command: string): boolean {
  const stages = command.replace(/\|\|/g, ' ').split('|')
  if (stages.length < 2) return false
  for (let i = 0; i < stages.length - 1; i++) {
    if (!ENUMERATES_FILES.test(stages[i]!)) continue
    for (let j = i + 1; j < stages.length; j++) {
      if (REDUCES.test(stages[j]!)) return true
    }
  }
  return false
}

function pipelineReminder(): string {
  return [
    `<system-reminder>`,
    `That shell pipeline enumerated files and then aggregated them, so the whole intermediate list was paid for in context and the result cannot be refined without re-running it.`,
    `Aggregating over many files is computing, not running a command: do it in ${EVAL_TOOL_NAME}, where the list stays in a variable and xargs batching cannot corrupt the totals.`,
    `</system-reminder>`,
  ].join(' ')
}

function editRunReminder(toolName: string, count: number): string {
  return [
    `<system-reminder>`,
    `That is ${count} consecutive ${toolName} calls on different files.`,
    `If this change repeats across the codebase, one ${EVAL_TOOL_NAME} cell looping tool.${toolName}(...) applies it everywhere in a single turn and can verify every site landed.`,
    `</system-reminder>`,
  ].join(' ')
}

function targetOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const path = (input as { file_path?: unknown }).file_path
  return typeof path === 'string' ? path : null
}

function commandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : null
}

/**
 * Record a tool call and return an advisory when either pattern completes.
 * Returns null the rest of the time, which is the overwhelmingly common case.
 *
 * @param agentKey  Per-agent chain key; subagents share one tool pipeline.
 * @param toolName  Name of the tool being invoked.
 * @param input     Its raw input; only `command` and `file_path` are read.
 */
export function noteToolCallForEvalGuard(
  agentKey: string,
  toolName: string,
  input: unknown,
): string | null {
  if (TRANSPARENT_TOOLS.has(toolName)) return null

  const state = stateFor(agentKey)

  if (MUTATING_TOOLS.has(toolName)) {
    const target = targetOf(input)
    if (state.runTool !== toolName) {
      state.runTool = toolName
      state.runTargets = new Set()
    }
    if (target !== null) state.runTargets.add(target)
    if (
      !state.editRunFired &&
      state.runTargets.size >= EDIT_RUN_THRESHOLD
    ) {
      state.editRunFired = true
      return editRunReminder(toolName, state.runTargets.size)
    }
    return null
  }

  // Any non-mutating, non-transparent call ends an open run.
  state.runTool = null
  state.runTargets = new Set()

  if (toolName !== BASH_TOOL_NAME || state.pipelineFired) return null
  const command = commandOf(input)
  if (command === null || !isAggregatingPipeline(command)) return null

  state.pipelineFired = true
  return pipelineReminder()
}

/** Clear an agent's state. A user interjection changes the context. */
export function resetEvalGuard(agentKey: string): void {
  agents.delete(agentKey)
}

/** Test-only: drop all tracked state. */
export function __resetAllEvalGuards(): void {
  agents.clear()
}
