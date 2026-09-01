/**
 * Eval tool — a persistent Python kernel with a loopback bridge back into
 * Tau's own tools.
 *
 * Naming: this is deliberately NOT called "REPL". `src/bridge/replBridge.ts`,
 * `src/replLauncher.tsx` and `src/screens/REPL.tsx` already use "REPL" to mean
 * the interactive terminal loop, and `src/tools/REPLTool/` is a dead ant-only
 * JS VM whose implementation file does not exist. A third meaning would be a
 * permanent reading trap.
 *
 * CACHE CONTRACT (read before editing anything in this directory):
 *
 *   1. The tool description and prompt are CONSTANTS. They must never
 *      interpolate the interpreter path, a Python version, the bridged tool
 *      list, MCP state, or settings. `promptCacheBreakDetection.ts` hashes
 *      every tool schema per turn (`perToolHashes`); a description that moves
 *      breaks the whole ~50-70K prefix. AgentTool/SkillTool are the existing
 *      offenders — do not become the third.
 *   2. Availability is LATCHED once per process (see `isEvalToolEnabled`).
 *      A tool that appears on turn 3 because Python was found late is a
 *      `+1 tools` cache break. Same discipline as `should1hCacheTTL` and
 *      `freezeSessionVolatileText`.
 *   3. The tool registers LAST in `getAllBaseTools()`. Tool order is the
 *      cache prefix; see `lanes/gemini/lazy_tools.test.ts`.
 */

export const EVAL_TOOL_NAME = 'Eval'

/** Opt out entirely: TAU_EVAL_DISABLE=1. */
export const EVAL_DISABLE_ENV = 'TAU_EVAL_DISABLE'
/** Force a specific interpreter instead of auto-discovery. */
export const EVAL_PYTHON_ENV = 'TAU_EVAL_PYTHON'
/** Skip the startup interpreter probe (assume available). Testing aid. */
export const EVAL_SKIP_PROBE_ENV = 'TAU_EVAL_SKIP_PROBE'
/** Log every NDJSON frame exchanged with the kernel. */
export const EVAL_TRACE_ENV = 'TAU_EVAL_TRACE'

/** Default per-cell wall clock, in seconds. */
export const DEFAULT_CELL_TIMEOUT_SEC = 60
/** Ceiling for an explicit `timeout`, in seconds. */
export const MAX_CELL_TIMEOUT_SEC = 3600

/** Grace period after a cancel before the kernel is terminated outright. */
export const INTERRUPT_ESCALATION_MS = 5_000
/** Grace period for a clean `exit` before SIGTERM/taskkill. */
export const SHUTDOWN_GRACE_MS = 2_000
/** Ceiling on the startup interpreter probe. */
export const PROBE_TIMEOUT_MS = 4_000

/** Model-facing text budget for one cell's captured output. */
export const MAX_RESULT_CHARS = 30_000
/** Bridge-call lines echoed into the model-facing result before aggregating. */
export const MAX_BRIDGE_LINES = 12

/**
 * Tools the kernel may NOT call through `tool.<name>(...)`.
 *
 * This started as an allowlist of 28 hand-picked names, which was the wrong
 * shape: it silently refused `ArtifactCanvas`, every MCP tool, and anything
 * added later, for no reason other than that I had not thought of them. The
 * bridge is not a security boundary — every bridged call still goes through
 * `canUseTool`, so deny rules and prompts apply exactly as they do to a direct
 * call. It is a *correctness* boundary, so the only entries that belong here
 * are tools that genuinely cannot work through it.
 *
 * The principle: a tool whose effect is on the SESSION rather than the
 * workspace is applied by the main loop when it sees the tool result. Bridged,
 * it would report success and do nothing. Everything else is fair game.
 *
 * Interactive tools are excluded separately and generically, via each tool's
 * own `requiresUserInteraction()` — no names needed, so a new interactive tool
 * is covered the day it is written.
 *
 * Snapshot is deliberately NOT here: it manages a shadow git repo, which is
 * workspace state, so it works fine from a cell.
 *
 * Names stay string literals so this module remains a zero-import leaf,
 * importable from `tools.ts`, `cheapModeTools.ts` and the guards without
 * dragging in the tool registry. `evalTool.test.ts` asserts each literal still
 * equals the real constant, so a rename fails the build rather than silently
 * unblocking a tool.
 */
export const EVAL_BRIDGE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  // Recursion would deadlock: Eval is exclusive, so an inner call could never
  // be scheduled while the outer one holds the slot.
  EVAL_TOOL_NAME,
  // Session mode and session cwd. Applied by the loop from the tool result.
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
])
