import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import instances from '../../ink/instances.js'
import { wrapForMultiplexer } from '../../ink/termio/osc.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getPlatform } from '../platform.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'
import { getHookGitBashPath } from './shellResolution.js'

// Per-event facts from the hooks reference, kept in one place so the runners
// read tables instead of naming events.

// Matchers on these events keep the narrow literal syntax: letters, digits,
// _ and |, with | alone separating alternatives.
const NARROW_MATCHER_EVENTS: ReadonlySet<string> = new Set([
  'FileChanged',
  'StopFailure',
])

/** The literal names a matcher lists, or undefined when it is a regular expression. */
export function literalHookMatcherParts(
  matcher: string,
  event?: HookEvent,
): string[] | undefined {
  const narrow = event !== undefined && NARROW_MATCHER_EVENTS.has(event)
  if (!(narrow ? /^[a-zA-Z0-9_|]+$/ : /^[a-zA-Z0-9_\- ,|]+$/).test(matcher)) {
    return undefined
  }
  return matcher.split(narrow ? '|' : /[|,]/).map(part => part.trim())
}

/** Events whose input describes a tool call. Only these evaluate a hook's `if` rule. */
export const TOOL_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
])

const DEFAULT_HOOK_TIMEOUT_MS = 10 * 60 * 1000
// Events that lower the command, http and mcp_tool default.
const EVENT_DEFAULT_TIMEOUT_MS: Readonly<Record<string, number>> = {
  UserPromptSubmit: 30_000,
  PreModelSwitch: 30_000,
  PostModelSwitch: 30_000,
  MessageDisplay: 10_000,
}

/** Timeout for a command, http or mcp_tool hook on `event` that sets none. */
export function defaultHookTimeoutMs(event: string): number {
  return EVENT_DEFAULT_TIMEOUT_MS[event] ?? DEFAULT_HOOK_TIMEOUT_MS
}

function isGitBashMissing(): boolean {
  return getPlatform() === 'windows' && !getHookGitBashPath()
}

/** Shell for a shell-form command hook: its own, else bash, else PowerShell on Windows without Git Bash. */
export function hookShell(hook: { shell?: 'bash' | 'powershell' }) {
  return hook.shell ?? (isGitBashMissing() ? 'powershell' : DEFAULT_HOOK_SHELL)
}

// Exit code 2 on these sends Claude back to work, which a hook that cannot
// run cannot repair, so a failure never blocks them.
const FAILURE_NEVER_BLOCKS: ReadonlySet<string> = new Set([
  'Stop',
  'SubagentStop',
  'TaskCompleted',
  'TeammateIdle',
])
// A shell-form hook that fell back to PowerShell still gates these: only exit
// code 0 or 2 counts as its verdict.
const GIT_BASH_GATED_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PermissionRequest',
])

type FailureRuleHook = {
  type: string
  onFailure?: string
  async?: boolean
  asyncRewake?: boolean
  args?: unknown
  shell?: string
}

/**
 * Why a failed or timed-out run of `hook` blocks the action on `event`, or
 * undefined when the action goes ahead. A failure is a hook that cannot start,
 * exits with a code other than 0 or 2, gets an HTTP error, times out, or
 * prints output that is not valid hook JSON.
 */
export function hookFailureBlockReason(
  hook: FailureRuleHook,
  event: string,
  timedOut: boolean,
): string | undefined {
  if (event === 'Setup' || event === 'SessionEnd') return undefined
  // Unlike ordinary failures, a model-switch timeout always keeps the
  // current model, even when the hook explicitly sets onFailure to ignore.
  if (event === 'PreModelSwitch' && timedOut) return 'timed out; keeping the current model'
  if (hook.type !== 'command' && hook.type !== 'http') return undefined
  if (hook.async || hook.asyncRewake || FAILURE_NEVER_BLOCKS.has(event)) {
    return undefined
  }
  const outcome = timedOut ? 'timed out' : 'failed'
  if (hook.onFailure === 'block') {
    return `${outcome}; blocking because onFailure is "block"`
  }
  if (
    hook.onFailure === undefined &&
    hook.type === 'command' &&
    hook.args === undefined &&
    hook.shell === undefined &&
    GIT_BASH_GATED_EVENTS.has(event) &&
    isGitBashMissing()
  ) {
    return `${outcome}; blocking because Git Bash wasn't found and this hook doesn't set "shell" to "powershell", so only exit code 0 or 2 counts as its verdict.`
  }
  return undefined
}

// An exit code other than 0 or 2 normally lets valid JSON on stdout decide.
// On these events it fails the run whatever the JSON says (worktrees), or
// the JSON is ignored (elicitations).
const NONZERO_EXIT_IGNORES_JSON: ReadonlySet<string> = new Set([
  'WorktreeCreate',
  'WorktreeRemove',
  'Elicitation',
  'ElicitationResult',
])

export function nonZeroExitIgnoresJson(event: string): boolean {
  return NONZERO_EXIT_IGNORES_JSON.has(event)
}

// Events whose plain-text stdout on exit 0 reaches Claude as context.
const PLAIN_STDOUT_CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'PostModelSwitch',
])

export function isPlainStdoutContextEvent(event: string): boolean {
  return PLAIN_STDOUT_CONTEXT_EVENTS.has(event)
}

// Events where a hook can block the action or change its result. An mcp_tool
// hook on them waits for a server that is still connecting.
const DECIDING_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'SubagentStop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'ConfigChange',
  'PreCompact',
  'PreModelSwitch',
  'Elicitation',
  'ElicitationResult',
  'WorktreeCreate',
  'WorktreeRemove',
  'MessageDisplay',
])

export function isDecidingHookEvent(event: string): boolean {
  return DECIDING_EVENTS.has(event)
}

// OSC 0/1/2 titles, 9 (including 9;4 progress), 99 and 777 notifications,
// each ended by BEL or ST, and bare BEL.
const ALLOWED_OSC = /^\x1b\](?:0|1|2|9|99|777);[^\x00-\x1f\x7f-\x9f]*(?:\x07|\x1b\\)/

/** Whether every part of `value` is an allowlisted terminal sequence. */
export function isAllowedTerminalSequence(value: string): boolean {
  if (value === '') return false
  let rest = value
  while (rest !== '') {
    if (rest[0] === '\x07') {
      rest = rest.slice(1)
      continue
    }
    const match = ALLOWED_OSC.exec(rest)
    if (!match) return false
    rest = rest.slice(match[0].length)
  }
  return true
}

/**
 * Writes a hook's `terminalSequence` for it, since hooks have no terminal of
 * their own. Only an interactive session with its interface on screen writes
 * it, and a value with anything outside the allowlist is ignored whole.
 */
export function emitHookTerminalSequence(value: unknown): void {
  if (typeof value !== 'string' || !isAllowedTerminalSequence(value)) return
  if (getIsNonInteractiveSession()) return
  // Windows may mount Ink on a reopened console stream or stderr when stdout
  // is a pipe. Send the sequence to the mounted terminal, not that pipe.
  const output = instances.has(process.stdout)
    ? process.stdout
    : [...instances.keys()].find(stream => stream.isTTY)
  output?.write(wrapForMultiplexer(value))
}
