import type { AnthropicMessage } from './base_provider.js'

type Counts = { input?: number; output?: number; read?: number; write?: number }
type RecordValue = Record<string, unknown>

/** Alpha emits per-step usage (including raw upstream fields), then totals
 * which may omit those fields. Keep both without counting a step twice. */
export class CommandCodeUsageAccumulator {
  private steps: Counts = {}

  addStep(usage: unknown): void {
    const counts = readUsage(usage)
    for (const key of ['input', 'output', 'read', 'write'] as const) {
      if (counts[key] !== undefined) {
        this.steps[key] = (this.steps[key] ?? 0) + counts[key]!
      }
    }
  }

  finish(...usage: unknown[]): AnthropicMessage['usage'] {
    const sources = [...usage.map(readUsage), this.steps]
    const input = firstCount(...sources.map(value => value.input)) ?? 0
    const output = firstCount(...sources.map(value => value.output)) ?? 0
    // A normalized zero must not mask an explicit upstream cache count.
    // These are alternate reports of the same tokens, not additive buckets.
    const read = maxCount(...sources.map(value => value.read)) ?? 0
    const write = maxCount(...sources.map(value => value.write)) ?? 0
    return {
      input_tokens: Math.max(0, input - read - write),
      output_tokens: output,
      ...(read > 0 ? { cache_read_input_tokens: read } : {}),
      ...(write > 0 ? { cache_creation_input_tokens: write } : {}),
    }
  }
}

function readUsage(value: unknown): Counts {
  if (!isRecord(value)) return {}
  const raw = isRecord(value.raw) ? value.raw : undefined
  const sources = [value, raw, raw?.usage, value.usageMetadata].filter(isRecord)
  const details = sources.flatMap(source => [
    source.inputTokenDetails, source.input_token_details,
    source.input_tokens_details, source.promptTokensDetails,
    source.prompt_tokens_details, source.inputTokens,
  ].filter(isRecord))
  const read = maxCount(
    ...details.flatMap(detail => [
      detail.cacheRead, detail.cacheReadTokens, detail.cacheReadInputTokens,
      detail.cacheHitTokens, detail.cache_read_tokens, detail.cache_read_input_tokens,
      detail.cache_hit_tokens, detail.cachedTokens, detail.cached_tokens,
    ]),
    ...sources.flatMap(source => [
      source.cacheReadTokens, source.cacheReadInputTokens,
      source.cacheHitTokens, source.cacheHitInputTokens,
      source.cache_read_input_tokens, source.cache_read_tokens,
      source.cache_hit_tokens, source.cache_hit_input_tokens,
      source.cachedInputTokens, source.cachedTokens,
      source.cached_input_tokens, source.cached_tokens,
      source.prompt_cache_hit_tokens, source.cachedContentTokenCount,
    ]),
  )
  const write = maxCount(
    ...details.flatMap(detail => [
      detail.cacheWrite, detail.cacheWriteTokens, detail.cacheWriteInputTokens,
      detail.cacheCreationTokens, detail.cacheCreationInputTokens,
      detail.cache_write_tokens, detail.cache_write_input_tokens,
      detail.cache_creation_tokens, detail.cache_creation_input_tokens,
    ]),
    ...sources.flatMap(source => [
      source.cacheWriteTokens, source.cacheWriteInputTokens,
      source.cacheCreationInputTokens, source.cacheCreationTokens,
      source.cache_write_tokens, source.cache_write_input_tokens,
      source.cache_creation_input_tokens, source.cache_creation_tokens,
    ]),
  )
  const input = firstCount(...sources.map(source => {
    const total = firstCount(
      source.inputTokens, isRecord(source.inputTokens) ? source.inputTokens.total : undefined,
      source.promptTokens, source.prompt_tokens, source.promptTokenCount,
    )
    if (total !== undefined) return total
    const inputTokens = firstCount(source.input_tokens)
    if (inputTokens === undefined) return undefined
    // Anthropic-native input_tokens excludes cache; OpenAI Responses includes it.
    const nativeRead = firstCount(source.cache_read_input_tokens)
    const nativeWrite = firstCount(source.cache_creation_input_tokens)
    return inputTokens + (nativeRead ?? 0) + (nativeWrite ?? 0)
  }))
  const fresh = firstCount(
    ...details.flatMap(detail => [detail.noCache, detail.noCacheTokens,
      detail.no_cache_tokens, detail.uncachedTokens, detail.uncached_tokens]),
    ...sources.flatMap(source => [source.noCacheTokens, source.no_cache_tokens,
      source.uncachedInputTokens, source.uncached_input_tokens, source.prompt_cache_miss_tokens]),
  )
  const output = firstCount(...sources.flatMap(source => {
    const candidates = firstCount(source.candidatesTokenCount)
    return [
      source.outputTokens, isRecord(source.outputTokens) ? source.outputTokens.total : undefined,
      source.output_tokens, source.completionTokens, source.completion_tokens,
      candidates === undefined ? undefined : candidates + (firstCount(source.thoughtsTokenCount) ?? 0),
    ]
  }))
  return {
    input: input ?? (fresh === undefined ? undefined : fresh + (read ?? 0) + (write ?? 0)),
    output, read, write,
  }
}

function count(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? number
    : undefined
}

function firstCount(...values: unknown[]): number | undefined {
  return values.map(count).find(value => value !== undefined)
}

function maxCount(...values: unknown[]): number | undefined {
  const numbers = values.map(count).filter((value): value is number => value !== undefined)
  return numbers.length ? Math.max(...numbers) : undefined
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
