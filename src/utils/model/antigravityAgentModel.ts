import type { APIProvider } from './providers.js'
import { isModelAlias } from './aliases.js'
import { parseAntigravityClaudeTier } from './antigravityClaudeTiers.js'
import {
  getGeminiTier,
  isPaidGeminiTier,
} from '../../services/api/providers/gemini_code_assist.js'

export const ANTIGRAVITY_OPUS_46_MODEL = 'claude-opus-4-6-thinking'
export const ANTIGRAVITY_SONNET_46_MODEL = 'claude-sonnet-4-6'
// Cache stability over raw cost: 3.5-flash-low resolves to the
// `gemini-3.5-flash-extra-low` wire model, whose serving channel commits the
// implicit cache slowly and misses replicas often. 3.7 Flash rides
// `gemini-3.7-flash-tiered` and was live-measured with 2 cold replies in 85
// follow-ups (3.8 Flash: ~13% cold, 3.6 Flash Medium: 80-94% reads). Low is
// the cheapest level on that same wire id. Subagents re-send a full
// system+tools prefix every call, so a cold channel is paid on every one.
export const ANTIGRAVITY_FAST_AGENT_MODEL = 'gemini-3.7-flash-low'
// Aliases spawned from a Claude parent stay on Claude. Paid Google AI Pro and
// Ultra plans get Sonnet 5.5 at its lowest level; the free plan has only 4.6.
export const ANTIGRAVITY_PAID_CLAUDE_AGENT_MODEL = 'claude-sonnet-5-5-low'
export const ANTIGRAVITY_FREE_CLAUDE_AGENT_MODEL = ANTIGRAVITY_SONNET_46_MODEL

function claudeAgentModel(parentModel: string, plan: string | null): string {
  const paid = plan
    ? isPaidGeminiTier(plan)
    // Plan not discovered yet: a Claude 5.5 parent only runs on a paid plan.
    : parseAntigravityClaudeTier(parentModel) !== null
  return paid ? ANTIGRAVITY_PAID_CLAUDE_AGENT_MODEL : ANTIGRAVITY_FREE_CLAUDE_AGENT_MODEL
}

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
  plan: string | null = getGeminiTier('antigravity'),
): string | null {
  if (resolveProvider(provider) !== 'antigravity') return null

  const model = normalizedModelId(modelSpec ?? 'inherit')
  // A subagent that names no model of its own (inherit, or a tier alias such
  // as an Explore agent's `haiku`) runs on the provider's agent model for the
  // parent's family: Claude parents on the plan's Sonnet, Gemini parents on
  // 3.7 Flash Low. Inheriting an Opus 5.5 or Gemini High parent would spend
  // quota at its rates on work the user wants cheap. Concrete ids, from an
  // agent file or the Agent tool's model_id, are explicit and pass through.
  if (model === 'inherit' || isModelAlias(model)) {
    return normalizedModelId(parentModel).includes('claude')
      ? claudeAgentModel(parentModel, plan)
      : ANTIGRAVITY_FAST_AGENT_MODEL
  }
  return null
}
