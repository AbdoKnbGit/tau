/**
 * Bidirectional tool name mapping between Tau (Anthropic-format)
 * tool names and Kiro's native tool names.
 *
 * Kiro models are post-trained on their native tool names (shell, read,
 * write, grep, glob, web_search, web_fetch, etc.). Tau uses
 * Anthropic-format names (Bash, Read, Write, Grep, Glob, WebSearch,
 * WebFetch, etc.). This module maps between the two so:
 *
 *   1. Tools sent to the CodeWhisperer API use Kiro-native names.
 *   2. Tool calls returned by Kiro are mapped back to Tau names
 *      before passing to context.executeTool().
 *
 * NOTE: Only 1:1 mappings are listed here. Tools that would create
 * duplicates (e.g. PowerShell → shell when Bash → shell already exists)
 * are excluded — the dedup logic in _buildToolSpecs handles those.
 * Edit is kept as-is because Kiro has no equivalent (Kiro's "write"
 * covers both create and edit, but Tau separates them).
 */

/** Tau tool name → Kiro native tool name */
const CLAUDEX_TO_KIRO: Record<string, string> = {
  // Shell — Bash on Unix, PowerShell on Windows; only one is active
  Bash:        'shell',
  PowerShell:  'shell',
  // File operations
  Read:        'read',
  Write:       'write',
  // Edit has NO direct Kiro equivalent — keep as 'Edit'
  // Search
  Grep:        'grep',
  Glob:        'glob',
  // Web
  WebSearch:   'web_search',
  WebFetch:    'web_fetch',
  // Productivity
  TodoWrite:   'todo_list',
  // Agents
  Agent:       'subagent',
}

const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/** Kiro native tool name → Tau tool name (reverse map) */
const KIRO_TO_CLAUDEX: Record<string, string> = {}
for (const [claudex, kiro] of Object.entries(CLAUDEX_TO_KIRO)) {
  // First Tau name wins (Bash beats PowerShell for 'shell')
  if (!(kiro in KIRO_TO_CLAUDEX)) {
    KIRO_TO_CLAUDEX[kiro] = claudex
  }
}

const KIRO_TOOL_NAME_MAX_LENGTH = 64

function djb2Hash(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/**
 * Coerce a name into Kiro/CodeWhisperer's allowed tool-name shape. The Bedrock
 * `toolSpecification.name` validator accepts `^[a-zA-Z0-9_-]{1,64}$` and 400s
 * ("Improperly formed request") on anything else. MCP tool names
 * (`mcp__server__tool`) can carry dots, slashes, spaces, or exceed 64 chars, so
 * map any out-of-set character to `_` and cap the length with a stable hash
 * suffix so distinct long names don't collide. No-op for the built-in mapped
 * names (read, shell, …) and for already-valid names — so normal MCP tools like
 * `mcp__context7__resolve-library-id` pass through unchanged.
 */
export function sanitizeKiroToolName(name: string): string {
  let safe = name.replace(/[^A-Za-z0-9_-]/g, '_')
  if (safe.length > KIRO_TOOL_NAME_MAX_LENGTH) {
    const suffix = `_${djb2Hash(name)}`
    safe = safe.slice(0, KIRO_TOOL_NAME_MAX_LENGTH - suffix.length) + suffix
  }
  return safe || 'tool'
}

/**
 * Map a Tau tool name to the Kiro-native name the model was trained
 * on, sanitized to Kiro's allowed shape. Returns the (sanitized) original
 * name if no mapping exists (e.g. MCP tools, Edit which has no Kiro equivalent).
 */
export function toKiroToolName(claudexName: string): string {
  return sanitizeKiroToolName(CLAUDEX_TO_KIRO[claudexName] ?? claudexName)
}

/**
 * Build a session reverse map (Kiro-sanitized name → Tau name) from the live
 * tool list, so tool calls Kiro returns map back exactly even when the outgoing
 * name was sanitized. First Tau name wins on collision (mirrors the spec-build
 * dedup in request.ts).
 */
export function buildKiroToolNameReverseMap(
  claudexToolNames: readonly string[],
): Map<string, string> {
  const reverse = new Map<string, string>()
  for (const name of claudexToolNames) {
    const kiroName = toKiroToolName(name)
    if (!reverse.has(kiroName)) reverse.set(kiroName, name)
  }
  return reverse
}

/**
 * Choose which local shell tool should back Kiro's single native `shell`
 * capability for this session.
 *
 * On Windows, prefer PowerShell when available so native Kiro shell calls
 * can execute cmdlets like `Get-ChildItem` instead of being forced through
 * the Bash executor. Elsewhere, Bash remains the natural default.
 */
export function resolvePreferredKiroShellToolName(
  toolNames: readonly string[],
): 'Bash' | 'PowerShell' | null {
  const hasBash = toolNames.includes('Bash')
  const hasPowerShell = toolNames.includes('PowerShell')

  if (process.platform === 'win32') {
    if (hasPowerShell) return 'PowerShell'
    if (hasBash) return 'Bash'
  } else {
    if (hasBash) return 'Bash'
    if (hasPowerShell) return 'PowerShell'
  }

  return null
}

export function isKiroShellCandidate(claudexName: string): boolean {
  return SHELL_TOOL_NAMES.has(claudexName)
}

/**
 * Map a Kiro-native tool name back to the Tau tool name for
 * execution. Returns the original name if no mapping exists.
 */
export function toClaudexToolName(
  kiroName: string,
  preferredShellToolName?: string | null,
  reverseMap?: Map<string, string>,
): string {
  if (kiroName === 'shell' && preferredShellToolName) {
    return preferredShellToolName
  }
  return reverseMap?.get(kiroName) ?? KIRO_TO_CLAUDEX[kiroName] ?? kiroName
}
