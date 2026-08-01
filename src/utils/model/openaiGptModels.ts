import type { APIProvider } from './providers.js'

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
