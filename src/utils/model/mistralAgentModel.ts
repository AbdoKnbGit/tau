import { isModelAlias } from './aliases.js'

// Pin the dated ID: a moving `latest` alias can change the model and its cache.
export const MISTRAL_AGENT_MODEL = 'mistral-large-2512'

/** Select a model specification on the Mistral lane. `inherit` is resolved by
 * getAgentModel against the parent's runtime model, never sent to the API. */
export function resolveMistralAgentModelSpec({
  agentModel,
  toolModel,
  defaultModel,
}: {
  agentModel?: string
  toolModel?: string
  defaultModel?: string
}): string {
  const agent = agentModel?.trim() || undefined
  const tool = toolModel?.trim() || undefined
  const fallback = defaultModel?.trim() || undefined
  const isTier = (spec: string) => isModelAlias(spec.toLowerCase())

  // Explicit caller intent wins. A guessed tier must not erase a concrete
  // model (or explicit inheritance) in a built-in or user agent definition.
  const selected = tool && !isTier(tool)
    ? tool
    : agent && !isTier(agent)
      ? agent
      : fallback ?? tool ?? agent

  if (!selected || isTier(selected)) return MISTRAL_AGENT_MODEL
  return selected.toLowerCase() === 'inherit' ? 'inherit' : selected
}
