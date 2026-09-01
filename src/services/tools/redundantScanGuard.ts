import { EVAL_TOOL_NAME } from '../../tools/EvalTool/constants.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '../../tools/TodoWriteTool/constants.js'

/**
 * Redundant-scan guard.
 *
 * Observed in a live session, answering "how many .tsx files are here":
 *
 *     Glob for every .tsx     -> 1,737 paths into context
 *     Eval  os.walk('.')      -> walked the tree again, ignored the paths
 *
 * The search was not a stepping stone. Its output was paid for in context and
 * then discarded, because the cell did the same work itself. Either half alone
 * is fine; doing both is pure waste, and nothing in the loop noticed.
 *
 * This guard notices. Same contract as `repeatToolGuard`: it NEVER blocks,
 * delays or rewrites a call, it returns an advisory string that is appended to
 * that call's own tool_result, and it costs exactly zero tokens on every turn
 * where the pattern does not occur — including the cached request prefix,
 * which it never touches.
 *
 * Deliberately narrow, because a false positive is a wasted nudge:
 *
 *   - Only a search IMMEDIATELY followed by a self-scanning cell fires. A cell
 *     that consumes the search result (reads the paths it found, greps within
 *     them) does not self-scan and is left alone.
 *   - Any other tool call in between clears the pending search — the model
 *     evidently did something with it.
 *   - Bookkeeping tools are transparent, matching `repeatToolGuard`, so
 *     interleaving a TodoWrite cannot launder the pattern.
 *   - Fires at most once per pending search.
 */

/**
 * Search tools whose ENTIRE output is a path or match list a cell can
 * regenerate for free. That is the principle; it is not a list of the tools
 * that happened to appear in one transcript.
 *
 * Deliberately excluded, because a cell cannot reproduce them and the earlier
 * call was therefore not wasted: CodebaseRetrieval (semantic), AFTAstSearch
 * (AST-aware), GitHistorySearch, TestSearch.
 */
const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
])

/**
 * Bookkeeping calls that neither arm nor clear the pending search. Mirrors
 * `repeatToolGuard`'s set on purpose: if one guard treats a call as
 * transparent and the other does not, interleaving it launders one pattern but
 * not the other. The test file asserts the two stay in step.
 */
const TRANSPARENT_TOOLS: ReadonlySet<string> = new Set([TODO_WRITE_TOOL_NAME])

/** Bound on tracked agents, mirroring repeatToolGuard. */
const MAX_TRACKED_AGENTS = 100

/**
 * Cell code that goes looking for files on its own. If a cell does any of
 * this, whatever the preceding search returned was not needed.
 *
 * Matched on the METHOD rather than the receiver, so every spelling of the
 * same idea is covered: `glob.glob(...)`, `Path(x).glob(...)`,
 * `Path(x).rglob(...)` and `p.iglob(...)` all trip the same branch. The first
 * version of this listed `glob.glob` and `.rglob` explicitly and silently
 * missed `Path(x).glob(...)` — the most common spelling of all — because it
 * was written from one transcript instead of from the idea.
 *
 * Not matched, on purpose: `fnmatch` and comprehensions filter a list that
 * already exists rather than scanning, and `tool.Bash("find ...")` is too
 * often legitimate shell work to warn about.
 */
const SELF_SCAN =
  /\b(?:os\.walk|os\.listdir|os\.scandir)\s*\(|\.(?:r?glob|iglob|iterdir|walk)\s*\(|\btool\.(?:Glob|Grep)\s*\(/

const pending = new Map<string, string>()

function remember(agentKey: string, toolName: string): void {
  if (!pending.has(agentKey) && pending.size >= MAX_TRACKED_AGENTS) {
    // Map preserves insertion order; drop the oldest tracked agent.
    const oldest = pending.keys().next()
    if (!oldest.done) pending.delete(oldest.value)
  }
  pending.set(agentKey, toolName)
}

function reminderFor(searchTool: string): string {
  return [
    `<system-reminder>`,
    `You called ${searchTool} and then re-scanned the filesystem inside the cell, so the ${searchTool} output was paid for in context and thrown away.`,
    `Pick one: search inside the cell (tool.${searchTool}, os.walk, Path.rglob) and skip the separate call, or use the result you already have.`,
    `Do not scope a task with a broad search before a cell — the cell can scope it for free.`,
    `</system-reminder>`,
  ].join(' ')
}

/**
 * Record a tool call and return an advisory reminder when the redundant
 * search-then-rescan pattern completes. Returns null the rest of the time,
 * which is the overwhelmingly common case.
 *
 * @param agentKey  Per-agent chain key; subagents share one tool pipeline.
 * @param toolName  Name of the tool being invoked.
 * @param input     Its raw input; only `code` is read, and only for Eval.
 */
export function noteToolCallForScanGuard(
  agentKey: string,
  toolName: string,
  input: unknown,
): string | null {
  if (TRANSPARENT_TOOLS.has(toolName)) return null

  if (SEARCH_TOOLS.has(toolName)) {
    remember(agentKey, toolName)
    return null
  }

  const searchTool = pending.get(agentKey)
  pending.delete(agentKey)

  if (toolName !== EVAL_TOOL_NAME || searchTool === undefined) return null

  const code =
    input && typeof input === 'object'
      ? (input as { code?: unknown }).code
      : undefined
  if (typeof code !== 'string' || !SELF_SCAN.test(code)) return null

  return reminderFor(searchTool)
}

/** Clear an agent's pending search. A user interjection changes the context. */
export function resetScanGuard(agentKey: string): void {
  pending.delete(agentKey)
}

/** Test-only: drop all tracked state. */
export function __resetAllScanGuards(): void {
  pending.clear()
}
