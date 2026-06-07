import { createHash } from 'crypto'
import type { APIProvider } from '../../utils/model/providers.js'
import type { AgentId } from '../../types/ids.js'
import type { QuerySource } from '../../constants/querySource.js'

const FORK_AGENT_QUERY_SOURCE = 'agent:builtin:fork'

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
  if (provider !== 'antigravity') return undefined

  const root = rootSessionId.trim()
  if (!root) return undefined

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
