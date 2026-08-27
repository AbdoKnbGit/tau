import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { recordUnpricedModel } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_7_CONFIG,
  CLAUDE_OPUS_4_8_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_OPUS_5_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  type ModelShortName,
} from './model/model.js'
import { getAPIProvider } from './model/providers.js'
import {
  ensureModelPricesFresh,
  lookupCatalogPrice,
} from './modelPricingCatalog.js'
import { getProviderModelSet } from './model/configs.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

// Standard pricing tier for Sonnet models: $3 input / $15 output per Mtok
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4/4.1: $15 input / $75 output per Mtok
export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4.5: $5 input / $25 output per Mtok
export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Fast mode pricing for Opus 4.6: $30 input / $150 output per Mtok
export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 3.5: $0.80 input / $4 output per Mtok
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 4.5: $1 input / $5 output per Mtok
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// ─── Gemini cost tiers ──────────────────────────────────────────────
// Google Gemini pricing (per Mtok). Cache reads are 25% of input cost,
// cache writes are the same as input cost. Web search not applicable.

/** Gemini 2.5 Flash / 3.x Flash: cheapest tier. */
const COST_GEMINI_FLASH: ModelCosts = {
  inputTokens: 0.15,
  outputTokens: 0.6,
  promptCacheWriteTokens: 0.15,
  promptCacheReadTokens: 0.0375,
  webSearchRequests: 0,
}

/** Gemini 2.5 Flash Lite / 3.x Flash Lite: ultra-cheap. */
const COST_GEMINI_FLASH_LITE: ModelCosts = {
  inputTokens: 0.075,
  outputTokens: 0.3,
  promptCacheWriteTokens: 0.075,
  promptCacheReadTokens: 0.01875,
  webSearchRequests: 0,
}

/** Gemini 2.5 Pro / 3.x Pro: premium tier. */
const COST_GEMINI_PRO: ModelCosts = {
  inputTokens: 1.25,
  outputTokens: 10,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.3125,
  webSearchRequests: 0,
}

/** Free OAuth tier — cost is zero (quota-limited instead). */
const COST_GEMINI_FREE: ModelCosts = {
  inputTokens: 0,
  outputTokens: 0,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
}

/**
 * Resolve Gemini model cost by prefix matching. Handles two cases:
 *   1. Model is already a Gemini name (e.g. "gemini-2.5-flash")
 *   2. Model is a Claude name (e.g. "claude-opus-4-6") but the active
 *      provider is Gemini — resolve to the mapped Gemini model first
 *
 * Returns null if neither case applies.
 */
function getGeminiModelCosts(model: string): ModelCosts | null {
  let m = model.toLowerCase()

  // If the model is a Claude name but we're using Gemini provider,
  // resolve it to the actual Gemini model name for cost lookup.
  if (!m.startsWith('gemini-')) {
    try {
      const provider = getAPIProvider()
      if (provider !== 'gemini') return null
      const models = getProviderModelSet('gemini')
      if (m.includes('opus'))       m = models.opus.toLowerCase()
      else if (m.includes('haiku')) m = models.haiku.toLowerCase()
      else                          m = models.sonnet.toLowerCase()
    } catch {
      return null
    }
  }

  if (!m.startsWith('gemini-')) return null

  // Flash Lite variants (cheapest)
  if (m.includes('flash-lite') || m.includes('flash_lite')) {
    return COST_GEMINI_FLASH_LITE
  }
  // Flash variants
  if (m.includes('flash')) {
    return COST_GEMINI_FLASH
  }
  // Pro variants
  if (m.includes('pro')) {
    return COST_GEMINI_PRO
  }
  // Fallback for unrecognized Gemini models → flash pricing (conservative)
  return COST_GEMINI_FLASH
}

/**
 * Get the cost tier for Opus 4.6 based on fast mode.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

// @[MODEL LAUNCH]: Add a pricing entry for the new model below.
// Costs from https://platform.claude.com/docs/en/about-claude/pricing
// Web search cost: $10 per 1000 requests = $0.01 per request
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(CLAUDE_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonical(CLAUDE_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_7_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_8_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_5_CONFIG.firstParty)]: COST_TIER_5_25,
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

/**
 * Published per-token prices for a model, or null when none are known.
 *
 * Null is deliberate and load-bearing. This table covers Claude and Gemini;
 * a third-party model such as `deepseek-v4-flash` or `glm-4` appears in
 * neither, and this previously returned the DEFAULT MODEL's prices for those -
 * quietly billing DeepSeek tokens at Claude rates, off by an order of
 * magnitude in the direction that alarms people. A missing price is not a
 * reason to substitute someone else's.
 */
export function getModelCosts(model: string, usage: Usage): ModelCosts | null {
  // Check Gemini models first — they use prefix matching, not canonical names.
  const geminiCosts = getGeminiModelCosts(model)
  if (geminiCosts) return geminiCosts

  const shortName = getCanonicalName(model)

  // Check if this is a current Opus model with fast mode active.
  if (
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_8_CONFIG.firstParty)
    || shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_7_CONFIG.firstParty)
    || shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)
  ) {
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  const costs = MODEL_COSTS[shortName]
  if (costs) return costs

  // Not a model this build ships prices for. The models.dev catalogue keys
  // entries by provider and by the provider's own model id, so a hit here is
  // an exact match for what this session is actually running.
  // Which long-context tier applies is decided by the whole prompt the
  // provider metered. Tau's buckets are additive - input_tokens excludes the
  // cached ones - so the context this request occupied is their sum.
  const contextTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const published = lookupCatalogPrice(getAPIProvider(), model, contextTokens)
  if (published) return published

  trackUnknownModelCost(model, shortName, usage)
  return null
}

/** Every token that went unpriced, so the note can quantify the shortfall. */
function totalTokens(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

function trackUnknownModelCost(
  model: string,
  shortName: ModelShortName,
  usage: Usage,
): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  recordUnpricedModel(model, totalTokens(usage))
  // Meeting a model we cannot price is the only reason to want the catalogue,
  // so the download is triggered here rather than at startup. A session that
  // only runs models we already price never fetches anything.
  ensureModelPricesFresh()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  // Unpriced usage contributes nothing, so the running total is a floor made
  // only of usage we can actually price. getUnpricedModels() names what was
  // left out - a total presented without that is the misleading half.
  if (!modelCosts) return 0
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
