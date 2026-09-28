/**
 * What models.dev says about OpenCode Zen and OpenCode Go models.
 *
 * OpenCode's `/models` routes list ids and nothing else, so on their own they
 * cannot say which models think or which effort values each accepts. Guessing
 * from the id is what left most rows without a thinking chip (every Claude 5
 * and GPT-6 row, Kimi K3, Muse Spark, Hy3) and gave the rest one generic
 * Low/Medium/High ladder: DeepSeek V4 publishes low/high/max, GPT none..max,
 * GLM-5.3 low/high/max.
 *
 * models.dev describes both gateways, under two provider ids:
 *
 *   opencode      OpenCode Zen  (https://opencode.ai/zen/v1)
 *   opencode-go   OpenCode Go   (https://opencode.ai/zen/go/v1)
 *
 * and the official OpenCode client builds its thinking variants from exactly
 * these rows (packages/opencode/src/provider/transform.ts, reasoningVariants):
 * each value of a row's `effort` option is one variant, sent on the
 * chat-completions route as `reasoning_effort`. Two things are kept per row:
 *
 *   efforts                the published effort values, least to most
 *   replaysReasoningContent `interleaved.field === "reasoning_content"`: the
 *                          official client puts that field on every replayed
 *                          assistant message, whatever effort is picked
 *   sdk                    the row's `provider.npm` override, which decides
 *                          the gateway route: @ai-sdk/anthropic → /messages,
 *                          @ai-sdk/openai → /responses, @ai-sdk/google →
 *                          :streamGenerateContent; no override → chat
 *   imageInput             `modalities.input` includes images
 *
 * Nothing here names a model, so a row OpenCode adds tomorrow is described on
 * the next refresh without a Tau release.
 *
 * Same discipline as clineModelsDevCatalog.ts: lookups are synchronous and
 * read only memory or the file on disk, the picker refreshes that file (once
 * a day, backing off on failure), a failed refresh keeps the old file, and
 * CLAUDEX_DISABLE_MODEL_PRICING opts out of models.dev entirely.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isModelPricingDisabled } from '../modelPricingCatalog.js'

const CATALOG_URL = 'https://models.dev/api.json'
// 2: rows carry the SDK (route) and image input. A v1 file has neither, so
// it is discarded rather than read as though every row were chat-only.
const CACHE_VERSION = 2
/** Capabilities move on model releases, not on the hour. */
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000
const RETRY_BASE_MS = 5 * 60_000
const RETRY_CAP_MS = 60 * 60_000

/** Tau provider id to the models.dev block that describes it. */
const SOURCES = {
  opencode: 'opencode',
  opencodego: 'opencode-go',
} as const
type OpencodeProvider = keyof typeof SOURCES
type OpencodeModelsDevSource = (typeof SOURCES)[OpencodeProvider]

function cacheFile(): string {
  return process.env.TAU_OPENCODE_MODELS_DEV_CACHE
    || join(homedir(), '.config', 'claude-code', 'opencode-models-dev.json')
}

/** The AI SDK a row names in `provider.npm`, when it names a non-default one. */
export type OpencodeRowSdk = 'anthropic' | 'openai' | 'google'

export interface OpencodeModelMeta {
  /** The model reasons at all. */
  reasoning: boolean
  /** Published effort values, least to most effort (`none` included). */
  efforts: readonly string[]
  /** Replayed assistant messages carry `reasoning_content`. */
  replaysReasoningContent: boolean
  /** The row's SDK override; undefined means OpenAI-compatible chat. */
  sdk?: OpencodeRowSdk
  /** The model takes image input. */
  imageInput: boolean
}

/** Stored form with short keys. */
export interface StoredRow {
  r: boolean
  e?: string[]
  i?: boolean
  s?: OpencodeRowSdk
  v?: boolean
}

const SDK_BY_NPM: Readonly<Record<string, OpencodeRowSdk>> = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/google': 'google',
}

export interface CacheFile {
  version: number
  fetchedAt: number
  providers: Partial<Record<OpencodeModelsDevSource, Record<string, StoredRow>>>
}

// Order only. Which values a model has always comes from the catalogue; a
// value outside this list is not one Tau can send, so it is left out.
const EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/**
 * Reduce one models.dev provider block to stored rows, keyed by lowercase id.
 * Exported so the derivation is testable without a network.
 */
export function deriveOpencodeModelsDevRows(provider: unknown): Record<string, StoredRow> {
  const out: Record<string, StoredRow> = {}
  const models = (provider as { models?: unknown } | null)?.models
  if (!models || typeof models !== 'object') return out

  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    const model = raw as Record<string, unknown> | null
    const key = id.trim().toLowerCase()
    if (!model || typeof model !== 'object' || !key || key in out) continue

    const reasoning = model.reasoning === true
    const efforts: string[] = []
    if (reasoning && Array.isArray(model.reasoning_options)) {
      for (const option of model.reasoning_options as Array<Record<string, unknown> | null>) {
        if (option?.type !== 'effort' || !Array.isArray(option.values)) continue
        for (const value of option.values) {
          if (
            typeof value === 'string'
            && EFFORT_RANK[value] !== undefined
            && !efforts.includes(value)
          ) {
            efforts.push(value)
          }
        }
      }
    }
    efforts.sort((left, right) => EFFORT_RANK[left]! - EFFORT_RANK[right]!)

    const interleaved = model.interleaved as { field?: unknown } | undefined
    const npm = (model.provider as { npm?: unknown } | undefined)?.npm
    const sdk = typeof npm === 'string' ? SDK_BY_NPM[npm] : undefined
    const inputs = (model.modalities as { input?: unknown } | undefined)?.input
    out[key] = {
      r: reasoning,
      ...(efforts.length > 0 && { e: efforts }),
      ...(interleaved?.field === 'reasoning_content' && { i: true }),
      ...(sdk && { s: sdk }),
      ...(Array.isArray(inputs) && inputs.includes('image') && { v: true }),
    }
  }
  return out
}

/** Reduce a whole api.json payload to the two blocks this module reads. */
export function deriveOpencodeModelsDevCache(payload: unknown, fetchedAt: number): CacheFile {
  const providers: CacheFile['providers'] = {}
  if (payload && typeof payload === 'object') {
    for (const source of Object.values(SOURCES)) {
      const rows = deriveOpencodeModelsDevRows((payload as Record<string, unknown>)[source])
      if (Object.keys(rows).length > 0) providers[source] = rows
    }
  }
  return { version: CACHE_VERSION, fetchedAt, providers }
}

// ─── In-memory state ─────────────────────────────────────────────────

let cache: CacheFile | null = null
let loadedFrom: string | null = null

function loadCache(): CacheFile | null {
  const path = cacheFile()
  if (loadedFrom === path) return cache
  loadedFrom = path
  cache = null
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile
    if (parsed?.version !== CACHE_VERSION) return null
    if (!parsed.providers || typeof parsed.providers !== 'object') return null
    cache = parsed
  } catch {
    // An unreadable file is simply no file; the next refresh rewrites it.
    cache = null
  }
  return cache
}

/**
 * What models.dev says about a model on OpenCode Zen (`opencode`) or OpenCode
 * Go (`opencodego`), or undefined when it says nothing or models.dev is
 * switched off. Undefined sends every caller back to the id-based rules that
 * predate this catalogue.
 */
export function getOpencodeModelMeta(
  provider: string,
  modelId: string,
): OpencodeModelMeta | undefined {
  if (isModelPricingDisabled()) return undefined
  const source = SOURCES[provider as OpencodeProvider]
  const id = modelId.trim().toLowerCase()
  if (!source || !id) return undefined
  const row = loadCache()?.providers[source]?.[id]
  return row ? toMeta(row) : undefined
}

function toMeta(row: StoredRow): OpencodeModelMeta {
  const reasoning = row.r === true
  return {
    reasoning,
    efforts: reasoning ? row.e ?? [] : [],
    replaysReasoningContent: row.i === true,
    ...(row.s && { sdk: row.s }),
    imageInput: row.v === true,
  }
}

/** Every row described for this host, as [id, meta]. Empty when none. */
export function listOpencodeModelMeta(
  provider: string,
): Array<[string, OpencodeModelMeta]> {
  if (isModelPricingDisabled()) return []
  const source = SOURCES[provider as OpencodeProvider]
  const rows = source ? loadCache()?.providers[source] : undefined
  return rows ? Object.entries(rows).map(([id, row]) => [id, toMeta(row)]) : []
}

/** Whether any description is available, fresh or stale. */
export function hasOpencodeModelsDev(): boolean {
  const providers = loadCache()?.providers
  return !!providers && Object.keys(providers).length > 0
}

// ─── Refresh ─────────────────────────────────────────────────────────

let refresh: Promise<void> | null = null
let refreshFailures = 0
let lastRefreshFailureAt = 0

function refreshRetryDelay(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1))
}

function noteRefreshFailure(): void {
  refreshFailures += 1
  lastRefreshFailureAt = Date.now()
}

function writeCacheAtomically(next: CacheFile): void {
  const path = cacheFile()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const staged = `${path}.${process.pid}.tmp`
    const body = JSON.stringify(next)
    try {
      writeFileSync(staged, body, 'utf8')
      renameSync(staged, path)
    } catch {
      // Windows can refuse a rename over an open file. A direct write is the
      // lesser evil: the file holds nothing secret or unrecoverable.
      writeFileSync(path, body, 'utf8')
      try {
        if (existsSync(staged)) unlinkSync(staged)
      } catch {
        // A stray staging file is harmless.
      }
    }
  } catch {
    // Best-effort; the in-memory table still serves this session.
  }
}

/**
 * Refresh the stored descriptions when they are missing or a day old, and
 * return the refresh in flight, or null when there is nothing to do. Never
 * throws; a failed fetch leaves the previous file in place, since a stale
 * ladder still describes a model and a missing one drops it back to guessing.
 */
export function ensureOpencodeModelsDevFresh(): Promise<void> | null {
  if (isModelPricingDisabled()) return null
  if (refresh) return refresh

  const now = Date.now()
  const sinceFailure = now - lastRefreshFailureAt
  if (
    refreshFailures > 0
    && sinceFailure >= 0
    && sinceFailure < refreshRetryDelay(refreshFailures)
  ) {
    return null
  }

  let current = loadCache()
  if (!current) {
    // Another session may have written the file since this one first looked.
    loadedFrom = null
    current = loadCache()
  }
  const age = current ? now - current.fetchedAt : -1
  if (current && age >= 0 && age < TTL_MS) return null

  refresh = (async () => {
    try {
      const response = await fetch(CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        noteRefreshFailure()
        return
      }
      const derived = deriveOpencodeModelsDevCache(await response.json(), Date.now())
      if (Object.keys(derived.providers).length === 0) {
        noteRefreshFailure()
        return
      }
      refreshFailures = 0
      cache = derived
      loadedFrom = cacheFile()
      writeCacheAtomically(derived)
    } catch {
      noteRefreshFailure()
    } finally {
      refresh = null
    }
  })()
  return refresh
}

/**
 * Start a refresh when one is due and, only when no description is on disk
 * at all, wait up to `ms` for it. A stale table still describes every model it
 * knew, so it never holds anything up.
 */
export async function waitForOpencodeModelsDev(ms: number): Promise<void> {
  const pending = ensureOpencodeModelsDevFresh()
  if (!pending || hasOpencodeModelsDev()) return

  let timer: ReturnType<typeof setTimeout> | undefined
  const giveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  try {
    await Promise.race([pending, giveUp])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Test seam: install a known table (or none) and skip the network. */
export function _resetOpencodeModelsDevForTests(next?: CacheFile | null): void {
  cache = next ?? null
  loadedFrom = next === undefined ? null : cacheFile()
  refresh = null
  refreshFailures = 0
  lastRefreshFailureAt = 0
}
