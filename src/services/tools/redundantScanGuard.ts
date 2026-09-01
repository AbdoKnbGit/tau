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

/** Search tools whose whole output is a file list the cell can reproduce. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Glob', 'Grep'])

/** Bookkeeping calls that neither arm nor clear the pending search. */
const TRANSPARENT_TOOLS: ReadonlySet<string> = new Set(['TodoWrite'])

const EVAL_TOOL = 'Eval'

/** Bound on tracked agents, mirroring repeatToolGuard. */
const MAX_TRACKED_AGENTS = 100

/**
 * Cell code that goes looking for files on its own. If a cell does any of
 * this, whatever the preceding search returned was not needed.
 */
const SELF_SCAN =
  /\bos\.walk\s*\(|\bos\.listdir\s*\(|\bos\.scandir\s*\(|\bglob\.glob\s*\(|\bglob\.iglob\s*\(|\.rglob\s*\(|\.iterdir\s*\(|\btool\.Glob\s*\(|\btool\.Grep\s*\(/

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

  if (toolName !== EVAL_TOOL || searchTool === undefined) return null

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
