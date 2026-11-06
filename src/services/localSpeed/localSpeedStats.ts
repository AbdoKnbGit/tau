/**
 * Generation speed for local model servers: Ollama and LM Studio only.
 *
 * claude.ts hands over one sample per successful streamed request on those
 * two providers, and /statistics prints a per-model summary. Ollama reports
 * its own generation figures, which its lane passes on and which take
 * precedence; LM Studio replies are timed with Tau's clock. Every other
 * provider is ignored here, so its /statistics output stays exactly as it was.
 *
 * Nothing in this module touches a request. Its only model-visible effect is
 * the extra /statistics text, which is added at the end of the conversation
 * like the rest of that command's output, so no cached prefix changes.
 *
 * The file has no app imports, so bun runs its tests directly.
 */

export type LocalSpeedProvider = 'ollama' | 'lmstudio'

const PROVIDER_LABELS: Record<LocalSpeedProvider, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
}

/**
 * Shortest stretch of streamed output that gives a usable rate. A reply that
 * arrives in one piece (a whole tool call, an instant error notice) falls
 * under it and is left out.
 */
export const MIN_GENERATION_MS = 200

/**
 * Characters per token for the estimate used when the server sends no token
 * counts. It is the same ratio /statistics uses for its own estimates.
 */
export const CHARS_PER_TOKEN = 4

/** Samples kept per provider and model, so a long session cannot grow this without bound. */
export const MAX_SAMPLES_PER_MODEL = 1000

export function isLocalSpeedProvider(provider: unknown): provider is LocalSpeedProvider {
  return provider === 'ollama' || provider === 'lmstudio'
}

/**
 * Requests someone waits on: the main chat (any output style), print mode and
 * SDK turns, and sub-agents. Background work on the same model (compaction,
 * titles, prompt suggestions, memory extraction, judges) has a different
 * shape and would skew the numbers.
 */
export function isTimedQuerySource(source: unknown): boolean {
  if (typeof source !== 'string') return false
  return (
    source.startsWith('repl_main_thread') ||
    source === 'sdk' ||
    source.startsWith('agent:')
  )
}

/**
 * Generation figures a local server measured itself. Ollama reports them on
 * the last chunk of a reply; they are exact, and they stay right when the
 * server keeps some output out of the stream Tau shows (for example a model's
 * separate thinking) or sends a tool call in one piece.
 */
export type LocalServerTimings = {
  outputTokens: number
  /** Time spent generating outputTokens. */
  generationMs: number
  /** Model loading plus prompt processing, before the first token. */
  waitMs: number
}

const NANOSECONDS_PER_MS = 1_000_000

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

/**
 * Reads Ollama's figures from the last /api/chat chunk (durations are in
 * nanoseconds). Returns undefined unless it carries a usable token count and
 * generation time.
 */
export function ollamaServerTimings(chunk: unknown): LocalServerTimings | undefined {
  if (!chunk || typeof chunk !== 'object') return undefined
  const fields = chunk as Record<string, unknown>
  const outputTokens = nonNegativeNumber(fields.eval_count)
  const evalDuration = nonNegativeNumber(fields.eval_duration)
  if (outputTokens === undefined || evalDuration === undefined) return undefined
  if (outputTokens < 1 || evalDuration <= 0) return undefined
  const promptDuration = nonNegativeNumber(fields.prompt_eval_duration) ?? 0
  const loadDuration = nonNegativeNumber(fields.load_duration) ?? 0
  return {
    outputTokens: Math.trunc(outputTokens),
    generationMs: evalDuration / NANOSECONDS_PER_MS,
    waitMs: (promptDuration + loadDuration) / NANOSECONDS_PER_MS,
  }
}

// Keyed by the message object a lane put on message_start, which reaches
// claude.ts as the same object. A WeakMap needs no cleanup for replies that
// never finish.
const serverTimingsByMessage = new WeakMap<object, LocalServerTimings>()

/** Called by the Ollama lane before it ends a reply. Never throws. */
export function noteLocalServerTimings(
  message: unknown,
  timings: LocalServerTimings | undefined,
): void {
  try {
    if (timings && message && typeof message === 'object') {
      serverTimingsByMessage.set(message, timings)
    }
  } catch {
    // Display extra only.
  }
}

/** Returns, and forgets, the figures a lane noted for this message. */
export function takeLocalServerTimings(
  message: unknown,
): LocalServerTimings | undefined {
  if (!message || typeof message !== 'object') return undefined
  const timings = serverTimingsByMessage.get(message)
  serverTimingsByMessage.delete(message)
  return timings
}

export type LocalSpeedSampleInput = {
  provider: unknown
  model: string
  querySource: unknown
  /** performance.now() when the successful attempt started. */
  attemptStartMs: number
  /** performance.now() at the first streamed content (thinking, text or tool input), or null when none arrived. */
  firstContentMs: number | null
  /** performance.now() when the stream ended, or null when it never did. */
  endMs: number | null
  /** Output tokens the server reported. 0 or missing when it sent no usage. */
  reportedOutputTokens: number | null | undefined
  /** Characters of generated content (text, thinking, tool input), for the estimate. */
  generatedChars: number
  /** The reply came from a non-streaming retry, so there is no stream to time. */
  nonStreaming: boolean
  /** The server's own figures for this reply, when it reported them (Ollama). They take precedence over Tau's clock. */
  serverTimings?: LocalServerTimings
}

export type LocalSpeedSample = {
  provider: LocalSpeedProvider
  model: string
  /** From the start of the request to the first token: prompt processing, plus model loading when the server had to load it. */
  waitMs: number
  /** Generation time the rate is measured over. */
  generationMs: number
  tokens: number
  /** Tokens generated within generationMs: every token for server figures, the ones after the first for Tau's clock. */
  countedTokens: number
  /** True when the token count is estimated from the text length. */
  estimated: boolean
}

function usableServerTimings(
  timings: LocalServerTimings | undefined,
): LocalServerTimings | undefined {
  if (!timings) return undefined
  const { outputTokens, generationMs, waitMs } = timings
  if (!Number.isFinite(outputTokens) || outputTokens < 2) return undefined
  if (!Number.isFinite(generationMs) || generationMs <= 0) return undefined
  if (!Number.isFinite(waitMs) || waitMs < 0) return undefined
  return timings
}

/** Turns one request into a sample, or returns null when it should not count. */
export function toLocalSpeedSample(input: LocalSpeedSampleInput): LocalSpeedSample | null {
  if (!isLocalSpeedProvider(input.provider)) return null
  if (!isTimedQuerySource(input.querySource)) return null
  if (input.nonStreaming) return null
  if (typeof input.model !== 'string' || input.model.length === 0) return null

  const server = usableServerTimings(input.serverTimings)
  if (server) {
    return {
      provider: input.provider,
      model: input.model,
      waitMs: server.waitMs,
      generationMs: server.generationMs,
      tokens: server.outputTokens,
      countedTokens: server.outputTokens,
      estimated: false,
    }
  }

  const { attemptStartMs, firstContentMs, endMs } = input
  if (firstContentMs === null || endMs === null) return null
  if (
    !Number.isFinite(attemptStartMs) ||
    !Number.isFinite(firstContentMs) ||
    !Number.isFinite(endMs)
  ) {
    return null
  }
  const waitMs = firstContentMs - attemptStartMs
  const generationMs = endMs - firstContentMs
  if (waitMs < 0 || generationMs < MIN_GENERATION_MS) return null

  const reported =
    typeof input.reportedOutputTokens === 'number' &&
    Number.isFinite(input.reportedOutputTokens)
      ? Math.trunc(input.reportedOutputTokens)
      : 0
  const estimated = reported <= 0
  const chars = Number.isFinite(input.generatedChars)
    ? Math.max(0, input.generatedChars)
    : 0
  const tokens = estimated ? Math.ceil(chars / CHARS_PER_TOKEN) : reported
  // The rate counts the tokens after the first one, because the first one
  // marks the start of the window. A single token says nothing.
  if (tokens < 2) return null

  return {
    provider: input.provider,
    model: input.model,
    waitMs,
    generationMs,
    tokens,
    countedTokens: tokens - 1,
    estimated,
  }
}

const samplesByModel = new Map<string, LocalSpeedSample[]>()

function keyOf(sample: { provider: string; model: string }): string {
  return `${sample.provider} ${sample.model}`
}

/**
 * Records one request. It never throws: it runs after every local reply, and
 * a fault here must not reach the reply.
 */
export function recordLocalSpeedSample(input: LocalSpeedSampleInput): boolean {
  try {
    const sample = toLocalSpeedSample(input)
    if (!sample) return false
    const key = keyOf(sample)
    const list = samplesByModel.get(key) ?? []
    list.push(sample)
    if (list.length > MAX_SAMPLES_PER_MODEL) {
      list.splice(0, list.length - MAX_SAMPLES_PER_MODEL)
    }
    samplesByModel.set(key, list)
    return true
  } catch {
    return false
  }
}

/** Clears every sample. Called where the session's token totals reset (switching session with /resume, /login). */
export function resetLocalSpeedStats(): void {
  samplesByModel.clear()
}

export type LocalSpeedRow = {
  provider: LocalSpeedProvider
  model: string
  replies: number
  medianWaitMs: number
  tokensPerSecond: number
  estimated: boolean
}

/** One row per provider and model. The same model name on Ollama and on LM Studio stays two rows. */
export function summarizeLocalSpeed(
  samples: readonly LocalSpeedSample[],
): LocalSpeedRow[] {
  const groups = new Map<string, LocalSpeedSample[]>()
  for (const sample of samples) {
    const key = keyOf(sample)
    const group = groups.get(key)
    if (group) group.push(sample)
    else groups.set(key, [sample])
  }

  const rows: LocalSpeedRow[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    let countedTokens = 0
    let generationMs = 0
    for (const sample of group) {
      countedTokens += sample.countedTokens
      generationMs += sample.generationMs
    }
    rows.push({
      provider: first.provider,
      model: first.model,
      replies: group.length,
      medianWaitMs: median(group.map(sample => sample.waitMs)),
      tokensPerSecond:
        generationMs > 0 ? countedTokens / (generationMs / 1000) : 0,
      estimated: group.some(sample => sample.estimated),
    })
  }

  return rows.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      PROVIDER_LABELS[a.provider].localeCompare(PROVIDER_LABELS[b.provider]),
  )
}

/** The rows for everything recorded in this run. */
export function getLocalSpeedRows(): LocalSpeedRow[] {
  return summarizeLocalSpeed([...samplesByModel.values()].flat())
}

/** Lines for /statistics, without indentation or colour. Empty when nothing local was timed. */
export function formatLocalSpeedLines(rows: readonly LocalSpeedRow[]): string[] {
  if (rows.length === 0) return []
  const lines = rows.map(row => {
    const label = compactLabel(row.model, 38)
    const rate = `${row.estimated ? '~' : ''}${formatRate(row.tokensPerSecond)} tok/s`
    const replies = `${row.replies} ${row.replies === 1 ? 'reply' : 'replies'}`
    return `${label} (${PROVIDER_LABELS[row.provider]}): ${rate} | first token ${formatSeconds(row.medianWaitMs)} | ${replies}`
  })
  if (rows.some(row => row.estimated)) {
    lines.push('~ estimated from text length: the server sent no token counts')
  }
  return lines
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0'
  return rate < 10 ? rate.toFixed(1) : String(Math.round(rate))
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  return `${seconds < 1 ? seconds.toFixed(2) : seconds.toFixed(1)} s`
}

function compactLabel(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3))}...`
}
