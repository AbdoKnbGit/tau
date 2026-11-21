/**
 * Agent fields Claude Code reads (2.1.329) that every Tau loader parses the
 * same way: plugin and project Markdown files, --agents/SDK JSON and mods.
 * A leaf module with no imports, so each loader and test can use it.
 */

/** Smallest compaction window an agent may set; Claude Code ignores less. */
export const AGENT_AUTO_COMPACT_WINDOW_MIN = 100_000

/** Prompt-cache lifetimes an agent may ask for in `experimental.cacheTtl`. */
export type AgentCacheTtl = '5m' | '1h'

/**
 * Fields of Claude Code's observer agents (agents that watch other agents'
 * activity). Tau has no observer feature, so loaders only report them.
 */
export const AGENT_OBSERVER_FIELDS = [
  'observer',
  'observerMessage',
  'observeSubagents',
  'observeToolResults',
] as const

/**
 * `autoCompactWindow`: the token count at which this agent compacts its own
 * conversation when it runs as a subagent. A whole number of at least
 * 100,000, written as a number or a string of digits; anything else is
 * undefined (the caller reports it).
 */
export function parseAgentAutoCompactWindow(raw: unknown): number | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined
  const value = typeof raw === 'number' ? raw : parseInt(raw, 10)
  return Number.isSafeInteger(value) && value >= AGENT_AUTO_COMPACT_WINDOW_MIN
    ? value
    : undefined
}

/**
 * `experimental.cacheTtl`: exactly "5m" or "1h". Like Claude Code, the key is
 * matched ignoring case, '-' and '_' (cacheTtl, cache_ttl, CacheTTL).
 */
export function parseAgentCacheTtl(
  frontmatter: Record<string, unknown>,
): AgentCacheTtl | undefined {
  const experimental = frontmatter.experimental
  if (typeof experimental !== 'object' || experimental === null) return undefined
  const value = Object.entries(experimental).find(
    ([key]) => normalizeKey(key) === 'cachettl',
  )?.[1]
  return value === '5m' || value === '1h' ? value : undefined
}

/** A frontmatter value as log text; objects never reach String(). */
export function describeFrontmatterValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  return typeof value === 'object' ? 'a mapping' : typeof value
}

// Keys a plugin agent file may set: the ones Tau reads, and the ones it
// reads but deliberately ignores for plugin agents (each with its own note).
const PLUGIN_AGENT_KEYS = [
  'name',
  'description',
  'when_to_use',
  'when-to-use',
  'tools',
  'disallowedTools',
  'skills',
  'color',
  'model',
  'effort',
  'maxTurns',
  'autoCompactWindow',
  'background',
  'omitClaudeMd',
  'memory',
  'isolation',
  'experimental',
  'initialPrompt',
  'permissionMode',
  'hooks',
  'mcpServers',
  'provider',
  ...AGENT_OBSERVER_FIELDS,
]
const PLUGIN_AGENT_KEY_SET = new Set(PLUGIN_AGENT_KEYS)

/**
 * Plugin agent frontmatter keys no loader reads, each with a suggestion when
 * it differs from a known key only in case, '-' or '_' (e.g. max_turns).
 */
export function unknownPluginAgentKeys(
  frontmatter: Record<string, unknown>,
): string[] {
  return Object.keys(frontmatter)
    .filter(key => !PLUGIN_AGENT_KEY_SET.has(key))
    .map(key => {
      const known = PLUGIN_AGENT_KEYS.find(
        candidate => normalizeKey(candidate) === normalizeKey(key),
      )
      return known ? `${key} (did you mean "${known}"?)` : key
    })
}

function normalizeKey(key: string): string {
  return key.replace(/[-_]/g, '').toLowerCase()
}
