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
 * Tools the kernel may call through `tool.<name>(...)`.
 *
 * Deliberately an allowlist, not a denylist. The bridge runs a tool without
 * the main loop's PreToolUse/PostToolUse hooks (the cell as a whole passes
 * through them as one `Eval` call), so anything reachable from here must be
 * safe under permission checks alone. Interactive tools, plan-mode
 * transitions, worktree switches, checkpointing and Eval itself are excluded
 * because a bridged call would either deadlock on a prompt or silently fail
 * to take effect.
 *
 * Names are string literals rather than imports on purpose: this module is a
 * leaf so it stays importable from tests and from `tools.ts` without dragging
 * the tool registry into a cycle.
 */
export const EVAL_BRIDGE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  'Write',
  'Edit',
  'WebFetch',
  'WebSearch',
  'LSP',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'FileDiff',
  'TestSearch',
  'CodebaseRetrieval',
  'GitHistorySearch',
  'NativeGitSummary',
  'NativeSysInfo',
  'AFTOutline',
  'AFTZoom',
  'AFTAstSearch',
  'AFTNavigate',
  'AFTDiagnostics',
])

/**
 * Never bridgeable, even if an allowlist entry above ever collides with one.
 * Recursion (Eval calling Eval) would deadlock: the tool is exclusive, so the
 * inner call could never be scheduled while the outer one holds the slot.
 */
export const EVAL_BRIDGE_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  EVAL_TOOL_NAME,
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'Snapshot',
])
