/**
 * Whether Groq applies its curated small-tier tool filter for this model.
 *
 * Keep this predicate dependency-free and shared by both the transformer and
 * upstream lazy-tool classification. The curated set intentionally omits
 * ToolSearch, so a matching model must receive every surviving schema eagerly.
 */
export function isSmallTierGroqModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return normalized.startsWith('llama-') || normalized.includes('gpt-oss')
}

const GROQ_SMALL_TIER_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'Bash',
  'Read', 'Write', 'Edit',
  'Grep', 'Glob',
  'WebSearch', 'WebFetch',
  'Agent', 'Skill', 'Rust',
])

/** Exact companion to groqTransformer.filterTools. MCP remains eager/allowed. */
export function isToolKeptByGroqSmallTierFilter(
  model: string,
  toolName: string,
): boolean {
  if (!isSmallTierGroqModel(model)) return true
  return (
    GROQ_SMALL_TIER_TOOL_ALLOWLIST.has(toolName) ||
    toolName.startsWith('mcp__')
  )
}
