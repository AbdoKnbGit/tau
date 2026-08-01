/**
 * Provider policy for spawned-agent tier aliases.
 *
 * Built-in and configured agents may ask for a tier (`haiku`, `sonnet`,
 * `opus`, ...), but a tier name is not itself a model that every provider can
 * serve. Resolve those automatic aliases from the active route, not from a
 * generic cross-provider fallback:
 *
 *  - direct OpenAI/Codex GPT-5.2/5.4/5.5/5.6 sessions use GPT-5.4 mini;
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
import type { APIProvider } from './providers.js'

export const OPENAI_FAST_AGENT_MODEL = 'gpt-5.4-mini'
export const OPENROUTER_AGENT_MODEL =
  'nvidia/nemotron-3-ultra-550b-a55b:free'

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/** Whether a direct OpenAI/Codex parent is one of the requested GPT families. */
export function isDirectOpenAIFastAgentParent(parentModel: string): boolean {
  const normalized = normalize(parentModel)
    .replace(/^models\//, '')
    .replace(/^openai\//, '')
    .replace(/\[1m\]$/, '')

  return /^gpt-5\.(?:2|4|5|6)(?:$|[-.])/.test(normalized)
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
    if (isDirectOpenAIFastAgentParent(parentModel)) {
      return OPENAI_FAST_AGENT_MODEL
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
