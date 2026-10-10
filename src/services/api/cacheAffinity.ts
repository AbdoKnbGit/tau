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
  'glm',
  'minimax',
  'mistral',
  'fireworks',
  'cloudflare',
  // Cline's own clients tag every request of a task with X-Task-ID; the
  // Cline lane sends this id there so the gateway sees one task per session.
  'cline',
  'clinepass',
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
    querySource === FORK_AGENT_QUERY_SOURCE
  )
}

/**
 * Helpers forked from a conversation (runForkedAgent: prompt suggestions,
 * compaction, memory extraction, /btw, agent summaries) run under a new
 * agentId but resend that conversation's prefix to read its prompt cache.
 * While a fork runs, this maps its agentId to the agentId of the conversation
 * it forked (undefined for the main thread).
 */
const forkedAgentParents = new Map<AgentId, {
  agentId: AgentId | undefined
  querySource?: QuerySource
}>()

/** Records a running fork; call the returned function when it ends. */
export function registerForkedAgent(
  forkAgentId: AgentId | undefined,
  parentAgentId: AgentId | undefined,
  parentQuerySource?: QuerySource,
): () => void {
  if (!forkAgentId || forkAgentId === parentAgentId) return () => {}
  forkedAgentParents.set(forkAgentId, { agentId: parentAgentId, querySource: parentQuerySource })
  return () => {
    forkedAgentParents.delete(forkAgentId)
  }
}

/** The agent whose conversation a request resends: a fork resolves to what it forked. */
function forkedConversationAgentId(agentId: AgentId, honorParentRootPolicy = false): AgentId | undefined {
  let current: AgentId | undefined = agentId
  for (let hop = 0; current && forkedAgentParents.has(current) && hop < 16; hop++) {
    const parent = forkedAgentParents.get(current)!
    // Synthetic Agent-tool forks use the root session even though they have
    // an agent id. Their progress summaries must follow that same policy.
    // Only Mistral opts into this metadata; other provider routing is unchanged.
    if (honorParentRootPolicy && parent.querySource && usesRootProviderSession(parent.querySource)) return undefined
    current = parent.agentId
  }
  return current
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

/** Only an independent worker owns a Mistral snapshot that its compaction
 * may reset. Helpers share an owner's prefix; compacting a private helper
 * branch must not reset that owner. Missing identity preserves snapshots. */
export function getMistralCompactionSessionId(
  rootSessionId: string,
  agentId: AgentId | undefined,
  querySource: QuerySource | undefined,
): string | undefined {
  const root = rootSessionId.trim()
  if (!root || !agentId || !querySource?.startsWith('agent:') ||
      usesRootProviderSession(querySource) || forkedAgentParents.has(agentId)) return undefined
  return derivedProviderSessionId(root, 'agent', agentId)
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

  // Root-policy calls are continuations or read-only views of the live
  // conversation. Apply this before provider-specific branching so no
  // special provider can accidentally derive a cold side-session for one.
  if (usesRootProviderSession(querySource)) return root

  // Antigravity uses the upstream session id for request deduplication and
  // quota routing. A derived report session can be treated as a cold lane and
  // receive 429s even while the live conversation remains healthy. Its prompt
  // cache is content-addressed rather than session-keyed, so keeping a bounded
  // report on the root session does not merge or overwrite prompt contents.
  // Other providers keep a stable side-session because their affinity/cache
  // behavior is independent and report isolation remains the safer default.
  if (querySource === 'report') {
    if (provider === 'antigravity') return root
    return derivedProviderSessionId(root, 'query', querySource)
  }

  // OpenRouter sends this id as session_id / prompt_cache_key and pins the
  // upstream provider per session. Agents and side queries get sessions of
  // their own; a forked helper takes the session of the conversation it
  // forked, or it lands on a cold upstream with a cold cache key every run.
  if (provider === 'openrouter') {
    if (agentId) {
      const owner = forkedConversationAgentId(agentId)
      return owner === undefined
        ? root
        : derivedProviderSessionId(root, 'agent', owner)
    }
    return derivedProviderSessionId(root, 'query', querySource)
  }

  // Mistral freezes system/tools by request session, model, and query source.
  // Independent agents of the same type otherwise share the first agent's
  // frozen system prompt. Give ordinary agents stable conversation identities;
  // a registered helper must still read the conversation it actually forked.
  // Unregistered side queries retain their existing root-session policy.
  if (provider === 'mistral' && agentId) {
    const owner = forkedConversationAgentId(agentId, true)
    if (owner === undefined) return root
    if (owner !== agentId || querySource.startsWith('agent:')) {
      return derivedProviderSessionId(root, 'agent', owner)
    }
  }

  // The Codex lane (openai) keys its prompt_cache_key, its session headers and
  // the env/git block it freezes at the start of the input by this id. An
  // agent (Agent tool, a skill or command run as an agent, a teammate) on the
  // parent's id was served the parent's frozen block (the parent's working
  // directory, for a worktree agent too) or left its own for the next agent
  // on the same model. Its own id, stable for the agent's life and kept by a
  // SendMessage resume, gives it its own block and cache routing.
  // A forked helper takes the id of the conversation it forked instead of
  // its own: an id per run would start every run cold and re-bill the whole
  // context. Anything else with an agentId (hook agents) keeps the root.
  if (provider === 'openai' && agentId) {
    const owner = forkedConversationAgentId(agentId)
    if (owner === undefined) return root
    if (owner !== agentId || querySource.startsWith('agent:')) {
      return derivedProviderSessionId(root, 'agent', owner)
    }
  }

  // Other cache-aware providers use the root Tau session as their stable
  // affinity/cache key. Antigravity, like openai above, is the exception:
  // fresh subagents need distinct derived sessions. Root-policy calls
  // returned above already reuse the live conversation even if their context
  // carries an agentId.
  if (provider !== 'antigravity') return root

  if (!agentId) {
    return root
  }

  return derivedProviderSessionId(root, 'agent', agentId)
}
