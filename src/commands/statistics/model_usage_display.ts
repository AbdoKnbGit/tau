import { isAntigravityGeminiModel } from '../../services/api/providers/gemini_code_assist.js'

export type StatisticsModelStats = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export function modelUsageForStatisticsDisplay<T extends StatisticsModelStats>(
  model: string,
  usage: T,
  provider: string,
): T {
  // Antigravity normalizes promptTokenCount to uncached input at the provider
  // boundary. Cache reads can be smaller OR larger than uncached input; their
  // relative sizes cannot identify legacy inclusive counts. Subtracting again
  // inflates reuse, especially for cold subagents, and is unsafe to repeat.
  if (provider === 'antigravity') return usage

  // Preserve the existing display behavior for other providers. Model ids can
  // overlap, so an Antigravity model-name match alone cannot scope this fix.
  if (
    !isAntigravityGeminiModel(model) ||
    usage.cacheReadInputTokens <= 0 ||
    usage.cacheReadInputTokens >= usage.inputTokens
  ) {
    return usage
  }
  return {
    ...usage,
    inputTokens: Math.max(0, usage.inputTokens - usage.cacheReadInputTokens),
  }
}
