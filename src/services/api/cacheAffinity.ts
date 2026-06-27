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

  // Other cache-aware providers use the root Tau session as their stable
  // affinity/cache key. Antigravity is the exception: fresh subagents need
  // distinct derived sessions, while forks intentionally reuse the root.
  if (provider !== 'antigravity') return root

  if (!agentId || querySource === FORK_AGENT_QUERY_SOURCE) {
    return root
  }

  const digest = createHash('sha256')
    .update(root)
    .update('\0agent\0')
    .update(agentId)
    .digest('hex')
    .slice(0, 32)

  return `tau-agent-${digest}`
}
