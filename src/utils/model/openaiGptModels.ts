import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import type { APIProvider } from './providers.js'

/**
 * The OpenAI (Codex) model catalog, shared by the Codex lane and the legacy
 * OpenAI provider. Ids and windows are models.dev's (2026-09-26): every
 * GPT-6 and GPT-5.6 model has a 1,050,000-token window whose prompt ceiling
 * is 922,000 tokens; contextWindows.ts holds compaction to that ceiling from
 * the same catalog.
 */
export const OPENAI_CODEX_MODELS: readonly ModelInfo[] = [
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', contextWindow: 1050000, supportsToolCalling: true, tags: ['recommended', 'reasoning'] },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1050000, supportsToolCalling: true, tags: ['reasoning'] },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 1050000, supportsToolCalling: true, tags: ['fast', 'reasoning'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 1050000, supportsToolCalling: true, tags: ['reasoning'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 1050000, supportsToolCalling: true, tags: ['reasoning'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 1050000, supportsToolCalling: true, tags: ['fast', 'reasoning'] },
]

/**
 * What a tier alias (`haiku`, `sonnet`, `opus`) resolves to on the OpenAI
 * provider: subagents and helper queries. A model ChatGPT accounts can use
 * (`gpt-5.4-mini` is refused there), and one fixed model whatever the parent
 * runs, so a resumed subagent keeps the model, and with it the prompt cache,
 * it started on.
 */
export const OPENAI_AGENT_MODEL = 'gpt-5.6-luna'

export function isConcreteOpenAIGptModelForProvider(
  value: unknown,
  provider: APIProvider | string,
): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.toLowerCase()
  if (provider === 'openai') {
    return normalized.startsWith('gpt-')
  }
  if (provider === 'openrouter') {
    return normalized.startsWith('openai/gpt-') || normalized.startsWith('gpt-')
  }
  return false
}

export function selectFreshOpenAIGptModelForProvider({
  fallback,
  selected,
  provider,
  renderedMainLoopModel,
}: {
  fallback: string
  selected: unknown
  provider: APIProvider
  renderedMainLoopModel?: string
}): string {
  if (provider !== 'openai' && provider !== 'openrouter') return fallback
  if (renderedMainLoopModel !== undefined && fallback !== renderedMainLoopModel) {
    return fallback
  }
  return isConcreteOpenAIGptModelForProvider(selected, provider)
    ? selected
    : fallback
}
