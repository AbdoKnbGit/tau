import { createHmac, randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const MAX_SESSIONS = 32
const MAX_INPUT_ITEMS = 2048
const ITEM_TYPES = new Set([
  'message', 'function_call', 'function_call_output', 'custom_tool_call',
  'custom_tool_call_output', 'reasoning', 'item_reference', 'configuration_update',
])
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

type ItemDigest = { hash: string; type: string }
type ConfigDigests = { instructions: string; tools: string; reasoning: string; options: string }
type PrefixComparison = {
  status: 'first' | 'identical' | 'append_only' | 'mutated' | 'shortened' | 'unknown'
  previousInvocation: number | null
  previousItemCount: number | null
  commonItems: number | null
  firstChanged?: { index: number; previousType: string | null; currentType: string | null }
}
type Snapshot = {
  invocation: number
  conversation: string | null
  modelHash: string
  effort: string | null
  configHash: string
  configParts: ConfigDigests
  configChanged: boolean | null
  changedConfig: Array<keyof ConfigDigests>
  inputHash: string
  inputItems: number
  retainedInputItems: number
  prefix: PrefixComparison
}
type History = { snapshot: Snapshot; items: ItemDigest[] }

/** Opaque, invocation-local handle. It retains hashes, never request contents. */
export type CodexCacheCapture = {
  readonly file: string
  readonly snapshot: Snapshot
  /** Bounded comparison baseline, not serialized and without recursive history. */
  readonly previousHistory?: History
  readonly historyKey?: string
  completed: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function tokenCount(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

function comparePrefix(previous: History | undefined, current: History): PrefixComparison {
  if (!previous) {
    return { status: 'first', previousInvocation: null, previousItemCount: null, commonItems: null }
  }
  const prefix = {
    previousInvocation: previous.snapshot.invocation,
    previousItemCount: previous.snapshot.inputItems,
  }
  if (previous.snapshot.inputHash === current.snapshot.inputHash) {
    return { ...prefix, status: 'identical', commonItems: previous.snapshot.inputItems }
  }
  let commonItems = 0
  const comparedItems = Math.min(previous.items.length, current.items.length)
  while (commonItems < comparedItems && previous.items[commonItems]!.hash === current.items[commonItems]!.hash) {
    commonItems++
  }
  if (commonItems < comparedItems) {
    return {
      ...prefix, status: 'mutated', commonItems,
      firstChanged: {
        index: commonItems,
        previousType: previous.items[commonItems]!.type,
        currentType: current.items[commonItems]!.type,
      },
    }
  }
  if (commonItems === previous.snapshot.inputItems) {
    return { ...prefix, status: 'append_only', commonItems }
  }
  if (commonItems === current.snapshot.inputItems) {
    return {
      ...prefix, status: 'shortened', commonItems,
      firstChanged: { index: commonItems, previousType: previous.items[commonItems]?.type ?? null, currentType: null },
    }
  }
  // Only a bounded prefix is retained. A difference beyond it must not be
  // described as append-only or stable.
  return { ...prefix, status: 'unknown', commonItems }
}

/**
 * Opt-in cache diagnostics. HMAC keys are random per instance and never logged,
 * so low-entropy prompt contents cannot be recovered by hashing guesses.
 * Comparisons describe outbound requests, not a guarantee of server cache reuse.
 */
export class CodexCacheDiagnostics {
  private key: Buffer | undefined
  private runId: string | undefined
  private invocation = 0
  private histories: Map<string, History> | undefined

  capture(
    request: object,
    replaceCapture?: CodexCacheCapture,
    resolvedSessionId?: string,
  ): CodexCacheCapture | undefined {
    const file = process.env.TAU_CODEX_CACHE_LOG
    if (!file) return undefined
    try {
      this.key ??= randomBytes(32)
      this.runId ??= randomBytes(12).toString('hex')
      this.histories ??= new Map()
      const body = request as Record<string, unknown>
      if (!Array.isArray(body.input)) return undefined
      const { input, prompt_cache_key: cacheKey, instructions, tools, reasoning, ...options } = body
      const conversationKey = typeof cacheKey === 'string' && cacheKey.length ? cacheKey : resolvedSessionId
      const conversation = conversationKey ? this.hash(conversationKey) : null
      const modelHash = this.hash(body.model)
      const historyKey = conversation ? `${conversation}:${modelHash}` : undefined
      // A failed WebSocket upgrade never sent its body. HTTP fallback can
      // replace that snapshot without comparing against the failed attempt.
      const replacing = replaceCapture && !replaceCapture.completed && replaceCapture.historyKey === historyKey
      const previous = replacing ? replaceCapture.previousHistory : historyKey ? this.histories.get(historyKey) : undefined
      const configParts = {
        instructions: this.hash(instructions),
        tools: this.hash(tools),
        reasoning: this.hash(reasoning),
        options: this.hash(options),
      }
      const { input: _input, prompt_cache_key: _cacheKey, ...config } = body
      const configHash = this.hash(config)
      const effort = record(reasoning).effort
      const items: ItemDigest[] = input.slice(0, MAX_INPUT_ITEMS).map(item => {
        const value = record(item)
        return {
          hash: this.hash(item),
          type: typeof value.type === 'string' && ITEM_TYPES.has(value.type) ? value.type : 'unknown',
        }
      })
      const snapshot: Snapshot = {
        invocation: replacing ? replaceCapture.snapshot.invocation : ++this.invocation,
        conversation,
        modelHash,
        effort: typeof effort === 'string' && EFFORTS.has(effort) ? effort : null,
        configHash,
        configParts,
        configChanged: previous ? previous.snapshot.configHash !== configHash : null,
        changedConfig: previous
          ? (Object.keys(configParts) as Array<keyof ConfigDigests>).filter(part => previous.snapshot.configParts[part] !== configParts[part])
          : [],
        inputHash: this.hash(input),
        inputItems: input.length,
        retainedInputItems: items.length,
        prefix: { status: 'first', previousInvocation: null, previousItemCount: null, commonItems: null },
      }
      const current = { snapshot, items }
      snapshot.prefix = comparePrefix(previous, current)
      if (historyKey && (!replacing || this.histories.get(historyKey)?.snapshot.invocation === snapshot.invocation)) {
        // Refresh insertion order for bounded LRU retention.
        this.histories.delete(historyKey)
        this.histories.set(historyKey, current)
        while (this.histories.size > MAX_SESSIONS) this.histories.delete(this.histories.keys().next().value!)
      }
      if (replacing) replaceCapture.completed = true
      return { file, snapshot, previousHistory: previous, historyKey, completed: false }
    } catch {
      // Serialization and debug I/O must never affect the actual API request.
      return undefined
    }
  }

  /** Call once a response has completed; the same capture can span WS fallback. */
  logCompletion(
    capture: CodexCacheCapture | undefined,
    transport: 'websocket' | 'http',
    usage: unknown,
    connection?: number,
  ): void {
    if (!capture || capture.completed || !process.env.TAU_CODEX_CACHE_LOG) return
    capture.completed = true
    try {
      const counts = record(usage)
      const inputDetails = record(counts.input_tokens_details)
      const promptDetails = record(counts.prompt_tokens_details)
      appendFileSync(capture.file, `${JSON.stringify({
        at: new Date().toISOString(),
        transport,
        ...(connection !== undefined ? { connection } : {}),
        prompt: tokenCount(counts.input_tokens, counts.prompt_tokens),
        cached: tokenCount(
          inputDetails.cached_tokens, promptDetails.cached_tokens,
          counts.cached_tokens, counts.cached_input_tokens, counts.prompt_cache_hit_tokens,
          counts.cache_read_input_tokens, counts.cache_read_tokens, counts.cache_hit_tokens,
        ),
        processId: process.pid,
        diagnostics: { version: 1, runId: this.runId, ...capture.snapshot },
      })}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // A debug log must never fail a request, including unwritable log paths.
    }
  }

  private hash(value: unknown): string {
    return createHmac('sha256', this.key!).update(JSON.stringify(value) ?? 'undefined').digest('hex')
  }
}
