/**
 * Provider policy for spawned-agent tier aliases.
 *
 * Built-in and configured agents may ask for a tier (`haiku`, `sonnet`,
 * `opus`, ...), but a tier name is not itself a model that every provider can
 * serve. Resolve those automatic aliases from the active route, not from a
 * generic cross-provider fallback:
 *
 *  - direct OpenAI/Codex sessions on GPT-5 or later (GPT-5.6, GPT-6, ...)
 *    use GPT-5.6 Luna for every tier;
 *  - Antigravity uses its provider-specific Gemini Flash-low model;
 *  - OpenRouter uses the requested free Nemotron agent model;
 *  - Anthropic-native routes keep their existing tier resolution;
 *  - every other provider inherits the exact live session model.
 *
 * Concrete model IDs and `inherit` are deliberately outside this policy. A
 * concrete ID is explicit caller intent, while `inherit` already has precise
 * runtime semantics in getAgentModel().
 *
 * This module is pure. Provider and parent model are supplied for every call,
 * so changing /provider or /model affects the very next spawn without a cache.
 */

import { isModelAlias } from './aliases.js'
import { resolveAntigravityOpus46AgentModel } from './antigravityAgentModel.js'
import { OPENAI_AGENT_MODEL } from './openaiGptModels.js'
import type { APIProvider } from './providers.js'

export { OPENAI_AGENT_MODEL }
export const OPENROUTER_AGENT_MODEL =
  'nvidia/nemotron-3-ultra-550b-a55b:free'

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Whether a direct OpenAI/Codex parent is an OpenAI GPT model from GPT-5 on
 * (every model the Codex catalog has offered). Anything else on the openai
 * provider (o-series, gpt-4.x, a custom deployment name behind
 * OPENAI_BASE_URL) may sit where the agent model is not served, so it keeps
 * inheriting the parent.
 */
export function isOpenAIAgentAliasParent(parentModel: string): boolean {
  const normalized = normalize(parentModel)
    .replace(/^models\//, '')
    .replace(/^openai\//, '')
    .replace(/\[1m\]$/, '')

  const version = /^gpt-(\d+)(?:$|[-.])/.exec(normalized)
  return version !== null && Number(version[1]) >= 5
}

/**
 * Resolve a tier alias according to the active provider policy.
 *
 * `undefined` means "use the provider's normal alias resolver". That is used
 * only by Anthropic-native routes, where the existing resolver also applies
 * Bedrock region prefixes correctly. All third-party routes return a concrete
 * model when a parent model is available.
 */
export function resolveAgentAliasPolicy(
  spec: string,
  parentModel: string,
  provider: APIProvider,
): string | undefined {
  if (!isModelAlias(normalize(spec))) return undefined

  if (provider === 'openrouter') return OPENROUTER_AGENT_MODEL
  if (provider === 'antigravity') {
    return resolveAntigravityOpus46AgentModel(spec, parentModel, provider) ?? undefined
  }

  if (provider === 'openai') {
    // One fixed model for every tier, whatever the parent runs: a resumed
    // subagent resolves its alias again, and a model that followed the parent
    // would move it to another model (and a cold prompt cache) mid-task.
    if (isOpenAIAgentAliasParent(parentModel)) {
      return OPENAI_AGENT_MODEL
    }
    return parentModel || undefined
  }

  if (
    provider === 'firstParty' ||
    provider === 'bedrock' ||
    provider === 'vertex' ||
    provider === 'foundry'
  ) {
    return undefined
  }

  return parentModel || undefined
}

/**
 * Whether a pinned agent's own model outranks a tier alias passed at spawn.
 *
 * An agent that names a provider also names a concrete model for that lane —
 * loadAgentsDir enforces the pairing, and already refuses `provider:` plus a
 * tier alias on every provider that cannot resolve a tier by itself. The same
 * reasoning applies to an alias that arrives at spawn time instead of in the
 * frontmatter: the spawning model picks `haiku` off the Agent tool schema
 * without being told the agent is pinned, and a tier says nothing about which
 * model on that lane to run. Resolving it anyway either sends the parent
 * session's model id down a lane that never served it (a 404) or substitutes
 * the provider's own fixed agent model. Both drop the pin, so the pin wins.
 *
 * Only tier aliases lose. A concrete model id from the caller — what
 * /team-mode sends — is deliberate and still overrides the agent file.
 */
export function pinnedAgentModelOutranksAlias(
  toolSpecifiedModel: string | undefined,
  agentModel: string | undefined,
  agentProvider: APIProvider | undefined,
): boolean {
  if (agentProvider === undefined) return false
  if (toolSpecifiedModel === undefined) return false
  // `inherit` is not a pin; loadAgentsDir already rejects it alongside a
  // provider, but a programmatically built definition could still carry it.
  if (agentModel === undefined || normalize(agentModel) === 'inherit') {
    return false
  }
  return isModelAlias(normalize(toolSpecifiedModel))
}

/**
 * Whether a tier alias resolves to a fixed model for this provider, without
 * consulting the session's model.
 *
 * For every other provider `resolveAgentAliasPolicy` falls back to the parent
 * model. That is fine when the agent is running on the session's own provider,
 * but meaningless once an agent pins a different one: the fallback would ship
 * the session's model id to a provider that never served it (e.g. `sonnet` +
 * `provider: fireworks` sending `gemini-3-flash` to Fireworks). Agent loading
 * uses this to reject that pairing instead of resolving it wrongly.
 */
export function resolvesAgentAliasIndependently(provider: APIProvider): boolean {
  return (
    // Anthropic-native routes run the real tier resolver.
    provider === 'firstParty' ||
    provider === 'bedrock' ||
    provider === 'vertex' ||
    provider === 'foundry' ||
    // These two map every alias to a fixed model of their own.
    provider === 'antigravity' ||
    provider === 'openrouter'
  )
}
