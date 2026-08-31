import { createHash } from 'crypto'
import type { APIProvider } from '../../utils/model/providers.js'
import type { AgentId } from '../../types/ids.js'
import type { QuerySource } from '../../constants/querySource.js'

const FORK_AGENT_QUERY_SOURCE = 'agent:builtin:fork'

const STABLE_REQUEST_SESSION_PROVIDERS = new Set<string>([
  'antigravity',
  'openai',
  'copilot',
  'openrouter',
  'agentrouter',
  'opencode',
  'opencodego',
  // LXD relays to a pool of upstream replicas. Without a stable per-session
  // key the request can land on a different replica each turn and the
  // implicit prefix cache never warms.
  'lxd',
  // DeepSeek's automatic prefix cache needs no session header, but the lane
  // keys its session-frozen volatile context block (and the TAU_CACHE_DEBUG
  // prefix diff) off this id. Without it both fall back to hashing the first
  // user message, which a leading context reminder can rewrite.
  'deepseek',
  'moonshot',
  'mistral',
  'fireworks',
  'cloudflare',
])

/**
 * Providers whose request shaping depends on a stable conversation/session
 * identifier for prompt-cache affinity, gateway stickiness, or both.
 *
 * Keep this as the single source of truth: claude.ts, the provider bridge, and
 * provider lanes all use it so a provider cannot silently lose its session ID
 * between layers.
 */
export function providerUsesStableRequestSession(provider: string): boolean {
  return STABLE_REQUEST_SESSION_PROVIDERS.has(provider)
}

function usesRootProviderSession(querySource: QuerySource): boolean {
  return (
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk' ||
    // /report is a read-only suffix on the live conversation and explicitly
    // skips writing its suffix into the shared cache. Keep it on the root
    // provider session so sticky gateways (especially OpenRouter) land on the
    // same cache shard as the chat request they are summarizing.
    querySource === 'report' ||
    querySource === FORK_AGENT_QUERY_SOURCE
  )
}

function derivedProviderSessionId(
  rootSessionId: string,
  kind: 'agent' | 'query',
  value: string,
): string {
  const digest = createHash('sha256')
    .update(rootSessionId)
    .update(`\0${kind}\0`)
    .update(value)
    .digest('hex')
    .slice(0, 32)

  return `tau-${kind}-${digest}`
}

export function resolveProviderRequestSessionId({
  provider,
  rootSessionId,
  agentId,
  querySource,
}: {
  provider: APIProvider
  rootSessionId: string
  agentId?: AgentId
  querySource: QuerySource
}): string | undefined {
  if (!providerUsesStableRequestSession(provider)) return undefined

  const root = rootSessionId.trim()
  if (!root) return undefined

  if (provider === 'openrouter') {
    if (usesRootProviderSession(querySource)) return root
    if (agentId) return derivedProviderSessionId(root, 'agent', agentId)
    return derivedProviderSessionId(root, 'query', querySource)
  }

  // Other cache-aware providers use the root Tau session as their stable
  // affinity/cache key. Antigravity is the exception: fresh subagents need
  // distinct derived sessions, while forks intentionally reuse the root.
  if (provider !== 'antigravity') return root

  if (!agentId || querySource === FORK_AGENT_QUERY_SOURCE) {
    return root
  }

  return derivedProviderSessionId(root, 'agent', agentId)
}
