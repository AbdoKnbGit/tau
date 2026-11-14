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

// Antigravity's Claude 4.6 rows. The bridge gives them thinking only for a
// positive thinkingBudget: -1 (Gemini's "dynamic") and a thinkingLevel both
// left Claude without any thinking (live, 2026-11-14).
const ANTIGRAVITY_CLAUDE_BUDGET_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-6-thinking'])
// Tau's default budget for third-party thinking (see claude.ts).
const ANTIGRAVITY_CLAUDE_DEFAULT_BUDGET = 8192
// Anthropic's smallest accepted thinking budget.
const CLAUDE_MIN_THINKING_BUDGET = 1024

export function isAntigravityClaudeBudgetModel(model: string): boolean {
  return ANTIGRAVITY_CLAUDE_BUDGET_MODELS.has(model.trim().toLowerCase().replace(/^models\//, ''))
}

/**
 * The thinking budget for an Antigravity Claude 4.6 turn that asked for
 * adaptive thinking, or null to leave the request as it was. The budget must
 * stay below the output cap, so a cap too small for Claude's minimum budget
 * keeps the old request. TAU_ANTIGRAVITY_CLAUDE_THINKING=0 turns this off;
 * MAX_THINKING_TOKENS sets the budget.
 */
function antigravityClaudeThinkingBudget(maxOutputTokens: number | undefined): number | null {
  const toggle = process.env.TAU_ANTIGRAVITY_CLAUDE_THINKING?.trim().toLowerCase()
  if (toggle === '0' || toggle === 'false' || toggle === 'no' || toggle === 'off') return null
  if (typeof maxOutputTokens !== 'number' || !Number.isFinite(maxOutputTokens)) return null
  const requested = Number.parseInt(process.env.MAX_THINKING_TOKENS ?? '', 10)
  const wanted = Number.isFinite(requested) && requested > 0
    ? Math.max(requested, CLAUDE_MIN_THINKING_BUDGET)
    : ANTIGRAVITY_CLAUDE_DEFAULT_BUDGET
  const budget = Math.min(wanted, Math.floor(maxOutputTokens) - 1)
  return budget >= CLAUDE_MIN_THINKING_BUDGET ? budget : null
}

/**
 * Build the right shape of `thinkingConfig` for the target model.
 *
 * Gemini 3.x and Gemini 4 Antigravity models use LEVEL-based thinking ("low",
 * "medium", "high") via the model registry. For those models, keep the
 * reasoning level and stream the thought summaries (see
 * shouldIncludeGeminiThoughts).
 */
export function resolveThinkingConfig(
  model: string,
  thinkingBudget: number,
  _thinking?: LaneProviderCallParams['thinking'],
  maxOutputTokens?: number,
): Record<string, unknown> {
  // Antigravity's Claude 5.5 ids carry their effort in the id. The bridge
  // accepted budgets -1, 0 and 8192 alike (2026-10-04), but the model itself
  // rejects a budget or disabled thinking, so every request sends the one
  // shape tau already sends by default, whatever /thinking says.
  if (parseAntigravityClaudeTier(model)) {
    return { thinkingBudget: -1, includeThoughts: true }
  }

  // Claude 4.6 asks for adaptive thinking, which Tau sends as -1. Give the
  // bridge a real budget so Claude thinks, as the native client does.
  if (thinkingBudget === -1 && isAntigravityClaudeBudgetModel(model)) {
    const budget = antigravityClaudeThinkingBudget(maxOutputTokens)
    if (budget !== null) return { thinkingBudget: budget, includeThoughts: true }
  }

  const lower = model.toLowerCase()
  let level: 'low' | 'medium' | 'high' | null = null
  const levelMatch = lower.match(/^gemini-(?:\d+(?:\.\d+)?-(?:pro|flash)|4-(?:argon|carbon|hydrogen))-(high|medium|low)$/)
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
      includeThoughts: shouldIncludeGeminiThoughts(model, thinkingBudget),
    }
  }

  return {
    thinkingBudget,
    includeThoughts: thinkingBudget !== 0,
  }
}

/**
 * Antigravity Gemini streams its thought summaries unless
 * TAU_GEMINI_INCLUDE_THOUGHTS=0. They were once off for speed, but on
 * 3.8 Flash High they added no wait (2026-11-14), and replayed in later
 * turns they kept the cached prefix intact. Thinking turned off sends none.
 */
function shouldIncludeGeminiThoughts(model: string, thinkingBudget: number): boolean {
  if (thinkingBudget === 0) return false
  if (!isAntigravityGeminiModel(model)) return true
  const override = process.env.TAU_GEMINI_INCLUDE_THOUGHTS?.trim().toLowerCase()
  return !(override === '0' || override === 'false' || override === 'no' || override === 'off')
}
