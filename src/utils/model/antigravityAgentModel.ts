import type { APIProvider } from './providers.js'
import { isModelAlias } from './aliases.js'

export const ANTIGRAVITY_OPUS_46_MODEL = 'claude-opus-4-6-thinking'
export const ANTIGRAVITY_SONNET_46_MODEL = 'claude-sonnet-4-6'
// Cache stability over raw cost: 3.5-flash-low resolves to the
// `gemini-3.5-flash-extra-low` wire model, whose serving channel commits the
// implicit cache slowly and misses replicas often. 3.6-flash-medium rides
// `gemini-3.6-flash-tiered`, live-measured at 80-94% cache reads across a
// multi-turn session. Side-queries and alias-spawned agents re-send a full
// system+tools prefix every call, so a cold channel is paid on every one.
export const ANTIGRAVITY_FAST_AGENT_MODEL = 'gemini-3.6-flash-medium'

function normalizedModelId(model: string): string {
  return model.toLowerCase().replace(/^models\//, '').replace(/\[1m\]$/i, '').trim()
}

function resolveProvider(provider: APIProvider | undefined): APIProvider {
  if (provider !== undefined) return provider
  // Lazy require keeps lightweight tests from loading the full provider/config graph.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const providers = require('./providers.js') as typeof import('./providers.js')
  return providers.getAPIProvider()
}

/**
 * Antigravity's automatic agent model policy. The historical export name is
 * retained for compatibility, but the policy now applies to both Claude and
 * Gemini parent sessions rather than only Opus 4.6.
 */
export function resolveAntigravityOpus46AgentModel(
  modelSpec: string | undefined,
  parentModel: string,
  provider?: APIProvider,
): string | null {
  if (resolveProvider(provider) !== 'antigravity') return null

  const model = normalizedModelId(modelSpec ?? 'inherit')
  if (model === 'inherit') return parentModel
  if (isModelAlias(model)) return ANTIGRAVITY_FAST_AGENT_MODEL
  return null
}
