import { getCursorModelDisplayName } from '../../lanes/cursor/catalog.js'
import { getAntigravityModelDisplayName } from '../../services/api/providers/gemini_code_assist.js'
import type { APIProvider } from './providers.js'

export function getProviderModelDisplayName(
  provider: APIProvider,
  modelId: string,
): string | null {
  switch (provider) {
    case 'firstParty':
      return getAnthropicModelDisplayName(modelId)
    case 'cursor':
      return getCursorModelDisplayName(modelId)
    case 'antigravity':
      return getAntigravityModelDisplayName(modelId)
    default:
      return null
  }
}

function getAnthropicModelDisplayName(modelId: string): string | null {
  const baseModelId = modelId.split('::effort=')[0]?.toLowerCase()
  switch (baseModelId) {
    case 'claude-opus-4-8':
      return 'Claude Opus 4.8'
    case 'claude-opus-4-7':
      return 'Claude Opus 4.7'
    case 'claude-opus-4-6':
      return 'Claude Opus 4.6'
    case 'claude-sonnet-4-6':
      return 'Claude Sonnet 4.6'
    case 'claude-haiku-4-5':
    case 'claude-haiku-4-5-20251001':
      return 'Claude Haiku 4.5'
    default:
      return null
  }
}
