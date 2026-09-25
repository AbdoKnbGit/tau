import { isGeminiOnOpenRouter } from './or_gemini_cache.js'

/** Anthropic-shaped usage is additive. Gemini's OpenRouter cache read/write
 * counters overlap, so assign their shared tokens to the write bucket once.
 * The raw upstream counters remain available to the lane's usage return value.
 */
export function openRouterInputUsage(
  model: string, promptTokens: number, cachedTokens: number, writtenTokens: number,
): { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  const count = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0
  const total = count(promptTokens)
  const write = Math.min(total, count(writtenTokens))
  const cached = Math.min(total, count(cachedTokens))
  const read = Math.min(total - write,
    isGeminiOnOpenRouter(model) ? Math.max(0, cached - write) : cached)
  return { input_tokens: total - write - read,
    cache_read_input_tokens: read, cache_creation_input_tokens: write }
}
