/**
 * Claude models that Antigravity serves as one wire id per effort level:
 * `claude-opus-5-5-low|medium|high` and the same three for Sonnet 5.5. The
 * level in the id is the model's only effort control (the catalog reports it
 * as `thinkingLevel` 1/2/3), so the picker shows one row per model and cycles
 * the level, and every request carries a level id.
 *
 * Measured on a Google AI Pro account (2026-10-04): the daily host lists all
 * six with maxTokens 1,000,000 and maxOutputTokens 128,000 (128,001 is a 400
 * from Vertex), the three levels of one model read one prompt cache, and the
 * six share one quota pool. Production cloudcode-pa does not serve them
 * (it answers 429), and a Starter-plan account gets 404 from the daily host.
 *
 * Leaf module: no imports, so the registry, the lane and the shared model
 * utilities can all read it without pulling each other in.
 */

export type AntigravityClaudeEffort = 'low' | 'medium' | 'high'

/** Picker order: left lowers the level, right raises it. */
export const ANTIGRAVITY_CLAUDE_EFFORTS: readonly AntigravityClaudeEffort[] = [
  'low',
  'medium',
  'high',
]

/** Level a picker row lands on before the user moves it. */
export const ANTIGRAVITY_CLAUDE_DEFAULT_EFFORT: AntigravityClaudeEffort = 'high'

export interface AntigravityClaudeTierModel {
  /** Picker row id. Not routable by itself: requests name a level id. */
  id: string
  name: string
  /** Name used in the system prompt's model line. */
  marketingName: string
  /** Null where Anthropic has not published one. */
  knowledgeCutoff: string | null
  contextWindow: number
  maxOutputTokens: { default: number; upperLimit: number }
}

export const ANTIGRAVITY_CLAUDE_TIER_MODELS: readonly AntigravityClaudeTierModel[] = [
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    marketingName: 'Opus 5.5',
    knowledgeCutoff: 'June 2026',
    contextWindow: 1_000_000,
    maxOutputTokens: { default: 64_000, upperLimit: 128_000 },
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    marketingName: 'Sonnet 5.5',
    knowledgeCutoff: null,
    contextWindow: 1_000_000,
    maxOutputTokens: { default: 32_000, upperLimit: 128_000 },
  },
]

const EFFORT_LABELS: Record<AntigravityClaudeEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export function antigravityClaudeEffortLabel(effort: AntigravityClaudeEffort): string {
  return EFFORT_LABELS[effort]
}

/** The routable id for one level of a tier model, e.g. `claude-opus-5-5-high`. */
export function antigravityClaudeTierModelId(
  model: AntigravityClaudeTierModel,
  effort: AntigravityClaudeEffort,
): string {
  return `${model.id}-${effort}`
}

/**
 * What `/effort` does on Antigravity, where no effort parameter is sent: on a
 * Claude 5.5 id it switches the level (the levels share one prompt cache, so
 * a switch costs nothing), anywhere else it says why there is nothing to set.
 * `model` is the id to switch to, when there is one.
 */
export function antigravityEffortCommand(
  currentModel: string,
  args: string,
): { message: string; model?: string } {
  const tier = parseAntigravityClaudeTier(currentModel)
  if (!tier) {
    return {
      message: 'Antigravity takes no effort setting. Models with levels, such as Gemini 3.8 Flash (High), list each level as its own model in /models.',
    }
  }
  const current = `${tier.model.name} is on ${EFFORT_LABELS[tier.effort]} effort`
  const requested = args.trim().toLowerCase()
  if (!requested || requested === 'current' || requested === 'status') {
    return { message: `${current}. Change it with /effort low, medium or high.` }
  }
  // Antigravity's top level for these models is High.
  const target = ['xhigh', 'max', 'ultracode'].includes(requested) ? 'high' : requested
  if (!(ANTIGRAVITY_CLAUDE_EFFORTS as readonly string[]).includes(target)) {
    return { message: `${current}. Antigravity offers low, medium and high for it.` }
  }
  const effort = target as AntigravityClaudeEffort
  if (effort === tier.effort) return { message: `${current} already.` }
  const model = antigravityClaudeTierModelId(tier.model, effort)
  return {
    message: `Set ${tier.model.name} to ${EFFORT_LABELS[effort]} effort (${model})`,
    model,
  }
}

/**
 * Which tier model and level an id names, or null for anything else.
 * Accepts the `models/` prefix and any case, like the Antigravity registry.
 */
export function parseAntigravityClaudeTier(
  modelId: string,
): { model: AntigravityClaudeTierModel; effort: AntigravityClaudeEffort } | null {
  const normalized = modelId.trim().toLowerCase().replace(/^models\//, '')
  for (const model of ANTIGRAVITY_CLAUDE_TIER_MODELS) {
    if (!normalized.startsWith(`${model.id}-`)) continue
    const effort = normalized.slice(model.id.length + 1)
    if ((ANTIGRAVITY_CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
      return { model, effort: effort as AntigravityClaudeEffort }
    }
  }
  return null
}
