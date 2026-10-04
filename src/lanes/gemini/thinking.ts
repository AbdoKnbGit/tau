import type { LaneProviderCallParams } from '../types.js'
import { isAntigravityGeminiModel } from '../../services/api/providers/gemini_code_assist.js'
import { parseAntigravityClaudeTier } from '../../utils/model/antigravityClaudeTiers.js'

export function resolveThinkingBudget(
  thinking: LaneProviderCallParams['thinking'] | undefined,
): number {
  // -1 = dynamic (Gemini picks per-turn). 0 = off. positive integer = cap.
  if (!thinking || thinking.type === 'adaptive') return -1
  if (thinking.type === 'disabled') return 0
  if (thinking.type === 'enabled') return thinking.budget_tokens ?? -1
  return -1
}

/**
 * Build the right shape of `thinkingConfig` for the target model.
 *
 * Gemini 3.x Antigravity models advertise LEVEL-based thinking ("low",
 * "medium", "high") via the model registry. For those models, keep the
 * reasoning level but do not stream visible thoughts by default; visible
 * thoughts are slow and made simple turns feel like high-effort reasoning.
 */
export function resolveThinkingConfig(
  model: string,
  thinkingBudget: number,
  thinking?: LaneProviderCallParams['thinking'],
): Record<string, unknown> {
  // Antigravity's Claude 5.5 ids carry their effort in the id. The bridge
  // accepted budgets -1, 0 and 8192 alike (2026-10-04), but the model itself
  // rejects a budget or disabled thinking, so every request sends the one
  // shape tau already sends by default, whatever /thinking says.
  if (parseAntigravityClaudeTier(model)) {
    return { thinkingBudget: -1, includeThoughts: true }
  }

  const lower = model.toLowerCase()
  let level: 'low' | 'medium' | 'high' | null = null
  const levelMatch = lower.match(/^gemini-\d+(?:\.\d+)?-(?:pro|flash)-(high|medium|low)$/)
  if (levelMatch) level = levelMatch[1] as 'low' | 'medium' | 'high'
  else if (/^gemini-3(?:\.\d+)?-flash$/.test(lower)) level = 'low'

  if (level && isAntigravityGeminiModel(model)) {
    const override = process.env.TAU_GEMINI_THINKING?.toLowerCase()
    if (override === 'low' || override === 'medium' || override === 'high') {
      level = override
    } else if (override === 'off' || override === 'none' || override === 'minimal') {
      level = 'low'
    }
  }

  if (level) {
    return {
      thinkingLevel: level,
      includeThoughts: shouldIncludeGeminiThoughts(model, thinking, thinkingBudget),
    }
  }

  return {
    thinkingBudget,
    includeThoughts: thinkingBudget !== 0,
  }
}

function shouldIncludeGeminiThoughts(
  model: string,
  thinking: LaneProviderCallParams['thinking'] | undefined,
  thinkingBudget: number,
): boolean {
  if (thinkingBudget === 0) return false
  if (!isAntigravityGeminiModel(model)) return true

  const override = process.env.TAU_GEMINI_INCLUDE_THOUGHTS?.toLowerCase()
  if (override === '1' || override === 'true' || override === 'yes') return true
  if (override === '0' || override === 'false' || override === 'no') return false

  return thinking?.type === 'enabled'
}
