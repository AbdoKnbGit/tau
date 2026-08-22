const NIM_FAST_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Shell / filesystem / search / web.
  'Bash', 'PowerShell',
  'Read', 'Write', 'Edit',
  'Grep', 'Glob',
  'WebSearch', 'WebFetch',
  // Planning / delegation / discovery.
  'TodoWrite', 'Agent', 'Task', 'Skill', 'ToolSearch', 'Rust',
  // OpenAI-compat lane native names.
  'execute_command', 'read_file', 'write_file',
  'str_replace', 'edit_block', 'edit_file',
  'find_files', 'search_text', 'web_search',
])

function envFlag(name: string): boolean {
  const value = process.env[name]
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export function areNimOptimizationsDisabled(): boolean {
  return envFlag('NIM_NO_OPTIMIZE') || envFlag('CLAUDEX_NIM_NO_OPTIMIZE')
}

/** Whether the transformer will prune the request to its fast tool subset. */
export function isNimFastToolFilterActive(): boolean {
  return !(
    areNimOptimizationsDisabled() ||
    envFlag('NIM_FULL_TOOLS') ||
    envFlag('CLAUDEX_NIM_FULL_TOOLS')
  )
}

/** Exact companion to nimTransformer.filterTools. */
export function isToolKeptByNimFastFilter(toolName: string): boolean {
  if (!isNimFastToolFilterActive()) return true
  if (NIM_FAST_TOOL_ALLOWLIST.has(toolName)) return true
  return (
    toolName.startsWith('mcp__') &&
    (envFlag('NIM_KEEP_MCP_TOOLS') ||
      envFlag('CLAUDEX_NIM_KEEP_MCP_TOOLS'))
  )
}
