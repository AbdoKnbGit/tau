/**
 * Meta Model API (Muse) catalog: ids, context windows, output caps, reasoning
 * ladders and prices.
 *
 * Sources, most authoritative first:
 *
 *   1. models.dev's `meta` provider, refreshed at most once a day and
 *      persisted: each row's `reasoning_options` (the effort ladder), limits,
 *      modalities and prices. Stored as models.dev publishes it, so a later
 *      build re-derives from the source.
 *   2. The snapshot below: models.dev (2026-10-17) checked against
 *      dev.meta.ai/docs/models, /docs/reasoning and /docs/pricing-rate-limits.
 *
 * Meta's own `GET /v1/models` states ids only (id, created, owned_by), so it
 * decides which ids the key may call and nothing else.
 *
 * An id neither source describes gets no effort chip and no price: no
 * speculative field is ever sent, and nothing is billed at another model's
 * rate. Its window is the one Meta documents for every hosted Muse text model,
 * and only when the id is a Muse id.
 *
 * Dependency-light on purpose (fs/os/path and the pricing opt-out only):
 * contextWindows.ts and modelCost.ts read it synchronously on the cost path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isModelPricingDisabled } from '../modelPricingCatalog.js'

export const META_DEFAULT_BASE_URL = 'https://api.meta.ai/v1'

/** USD per million tokens. Meta charges nothing to write the cache. */
export interface MetaPrice {
  input: number
  cachedInput: number
  output: number
}

export interface MetaModelMeta {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning: boolean
  /** Values `reasoning.effort` accepts. Empty when none is known. */
  efforts: readonly string[]
  /** What Meta uses when the request names no effort, where it is known. */
  defaultEffort?: string
  toolCalling: boolean
  imageInput: boolean
  /** Accepts `input_file` parts (PDF). */
  fileInput: boolean
  /** Contributor mode: discounted, and Meta may train on the content. */
  contributor: boolean
  price?: MetaPrice
  /** YYYY-MM-DD. Orders the picker newest first. */
  released?: string
  /** False for a live id no catalog describes. */
  described: boolean
}

/** Every hosted Muse text model (dev.meta.ai/docs/models, /docs/coding-agents). */
const MUSE_CONTEXT_WINDOW = 1_048_576
const MUSE_MAX_OUTPUT_TOKENS = 131_072

const ALL_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** "max is not available with muse-spark-1.3-contributor" (/docs/reasoning). */
const NO_MAX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

const STANDARD_SPARK: MetaPrice = { input: 1.25, cachedInput: 0.15, output: 4.25 }
const CONTRIBUTOR_SPARK: MetaPrice = { input: 0.1, cachedInput: 0.002, output: 0.2 }

function muse(row: Omit<MetaModelMeta, 'contextWindow' | 'maxOutputTokens' | 'reasoning' | 'toolCalling' | 'imageInput' | 'fileInput' | 'described'>): MetaModelMeta {
  return {
    contextWindow: MUSE_CONTEXT_WINDOW,
    maxOutputTokens: MUSE_MAX_OUTPUT_TOKENS,
    reasoning: true,
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    described: true,
    ...row,
  }
}

/**
 * Text models that can drive an agent. Left out: Muse Image, Muse Voice
 * Transcribe and SAM 3.1, which return images, transcripts or masks.
 */
const SNAPSHOT: readonly MetaModelMeta[] = [
  muse({
    id: 'muse-wonder-1.0',
    name: 'Muse Wonder',
    efforts: ALL_EFFORTS,
    contributor: false,
    price: { input: 4, cachedInput: 0.2, output: 20 },
    released: '2026-10-12',
  }),
  muse({
    id: 'muse-spark-1.3',
    name: 'Muse Spark 1.3',
    efforts: ALL_EFFORTS,
    // Recorded: a request naming no effort comes back `reasoning.effort: high`.
    defaultEffort: 'high',
    contributor: false,
    price: STANDARD_SPARK,
    released: '2026-09-02',
  }),
  muse({
    id: 'muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    efforts: NO_MAX_EFFORTS,
    contributor: true,
    price: CONTRIBUTOR_SPARK,
    released: '2026-09-02',
  }),
  muse({
    id: 'muse-spark-1.2',
    name: 'Muse Spark 1.2',
    efforts: NO_MAX_EFFORTS,
    contributor: false,
    price: STANDARD_SPARK,
    released: '2026-08-05',
  }),
  muse({
    id: 'muse-spark-1.2-contributor',
    name: 'Muse Spark 1.2 Contributor',
    efforts: NO_MAX_EFFORTS,
    contributor: true,
    price: CONTRIBUTOR_SPARK,
    released: '2026-08-05',
  }),
  muse({
    id: 'muse-spark-1.1',
    name: 'Muse Spark 1.1',
    efforts: NO_MAX_EFFORTS,
    contributor: false,
    price: STANDARD_SPARK,
    released: '2026-04-08',
  }),
]

const SNAPSHOT_BY_ID = new Map(SNAPSHOT.map(model => [model.id, model]))

/** Canonical lookup key: lowercased, without a `meta/` prefix or effort tag. */
export function normalizeMetaModelId(model: string): string {
  let id = model.trim().toLowerCase()
  const effortTag = id.lastIndexOf('::effort=')
  if (effortTag >= 0) id = id.slice(0, effortTag)
  return id.replace(/^meta\//, '')
}

export function isMuseModelId(model: string): boolean {
  return normalizeMetaModelId(model).startsWith('muse-')
}

/**
 * Ids Meta serves that are not chat models: image generation, transcription
 * and segmentation. A new text id passes straight through.
 */
const NON_CHAT_ID = /(?:^|-)(?:image|voice|transcribe|tts|asr|embed|embedding)(?:-|\d|$)|^sam-/i

// ─── models.dev rows ─────────────────────────────────────────────────

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * One models.dev row in this catalog's terms, or undefined for a row that
 * cannot hold a text conversation. Exported so the derivation is testable
 * without a network.
 */
export function metaMetaFromModelsDev(id: string, raw: unknown): MetaModelMeta | undefined {
  const model = raw as Record<string, unknown> | null
  const key = normalizeMetaModelId(id)
  if (!model || typeof model !== 'object' || !key) return undefined
  const modalities = model.modalities as { input?: unknown; output?: unknown } | undefined
  const input = Array.isArray(modalities?.input) ? modalities.input : []
  const output = Array.isArray(modalities?.output) ? modalities.output : []
  if (input.length > 0 && !input.includes('text')) return undefined
  if (output.length > 0 && !output.includes('text')) return undefined
  if (NON_CHAT_ID.test(key)) return undefined

  const known = SNAPSHOT_BY_ID.get(key)
  const reasoning = typeof model.reasoning === 'boolean' ? model.reasoning : known?.reasoning ?? false
  const efforts: string[] = []
  for (const option of Array.isArray(model.reasoning_options) ? model.reasoning_options : []) {
    const entry = option as { type?: unknown; values?: unknown } | null
    if (entry?.type !== 'effort' || !Array.isArray(entry.values)) continue
    for (const value of entry.values) {
      if (typeof value !== 'string') continue
      const level = value.trim().toLowerCase()
      // Meta answers `none` with a 400 on every Muse model (/docs/reasoning).
      if (level && level !== 'none' && !efforts.includes(level)) efforts.push(level)
    }
  }
  // A row that states no ladder keeps the documented one rather than losing
  // its chip; a row that states one is taken as published.
  const ladder = efforts.length > 0 ? efforts : [...(known?.efforts ?? [])]
  const limit = model.limit as { context?: unknown; output?: unknown } | undefined
  const cost = model.cost as { input?: unknown; output?: unknown; cache_read?: unknown } | undefined
  const inputRate = nonNegative(cost?.input)
  const outputRate = nonNegative(cost?.output)
  const price = inputRate !== undefined && outputRate !== undefined
    ? { input: inputRate, output: outputRate, cachedInput: nonNegative(cost?.cache_read) ?? inputRate }
    : known?.price

  return {
    id: key,
    name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : known?.name ?? key,
    contextWindow: positive(limit?.context) ?? known?.contextWindow,
    maxOutputTokens: positive(limit?.output) ?? known?.maxOutputTokens,
    reasoning,
    efforts: reasoning ? ladder : [],
    ...(reasoning && known?.defaultEffort && ladder.includes(known.defaultEffort) && { defaultEffort: known.defaultEffort }),
    toolCalling: model.tool_call !== false,
    imageInput: input.length > 0 ? input.includes('image') : known?.imageInput ?? false,
    fileInput: input.length > 0 ? input.includes('pdf') : known?.fileInput ?? false,
    contributor: key.endsWith('-contributor'),
    ...(price && { price }),
    released: typeof model.release_date === 'string' ? model.release_date : known?.released,
    described: true,
  }
}

// ─── Persisted models.dev block ──────────────────────────────────────

const CATALOG_URL = 'https://models.dev/api.json'
const STORE_VERSION = 1
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

interface StoreFile {
  version: number
  fetchedAt: number
  /** models.dev's `meta.models`, verbatim. */
  models: Record<string, unknown>
}

function storePath(): string {
  return process.env.TAU_META_MODEL_CATALOG_STORE || join(homedir(), '.claude', 'meta-models.json')
}

let store: StoreFile | null = null
let rows: Map<string, MetaModelMeta> | null = null
let loadedFrom: string | null = null

function indexStore(next: StoreFile | null): Map<string, MetaModelMeta> {
  const out = new Map<string, MetaModelMeta>()
  for (const [id, raw] of Object.entries(next?.models ?? {})) {
    const meta = metaMetaFromModelsDev(id, raw)
    if (meta) out.set(meta.id, meta)
  }
  return out
}

function loadRows(): Map<string, MetaModelMeta> {
  const path = storePath()
  if (rows && loadedFrom === path) return rows
  loadedFrom = path
  store = null
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile
      if (parsed?.version === STORE_VERSION && parsed.models && typeof parsed.models === 'object') store = parsed
    }
  } catch {
    // An unreadable store is no store; the next refresh rewrites it.
  }
  rows = indexStore(store)
  return rows
}

function writeStore(next: StoreFile): void {
  try {
    const path = storePath()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const staged = `${path}.${process.pid}.tmp`
    const body = JSON.stringify(next)
    writeFileSync(staged, body, 'utf8')
    try {
      renameSync(staged, path)
    } catch {
      // Windows can refuse a rename over an open file.
      writeFileSync(path, body, 'utf8')
    }
  } catch {
    // The in-memory catalog still serves this session.
  }
}

/** Fold a models.dev payload's `meta` block in and persist it. */
export function recordMetaModelsDev(payload: unknown, fetchedAt = Date.now()): boolean {
  const models = ((payload as Record<string, unknown> | null)?.meta as { models?: unknown } | undefined)?.models
  if (!models || typeof models !== 'object') return false
  const next: StoreFile = { version: STORE_VERSION, fetchedAt, models: models as Record<string, unknown> }
  const indexed = indexStore(next)
  if (indexed.size === 0) return false
  store = next
  rows = indexed
  loadedFrom = storePath()
  writeStore(next)
  return true
}

let refreshInFlight = false
let refreshFailures = 0
let lastRefreshFailureAt = 0
const RETRY_BASE_MS = 5 * 60_000
const RETRY_CAP_MS = 60 * 60_000

/**
 * Refresh the models.dev block when it is missing or a day old.
 * Fire-and-forget: never throws, and a failed fetch keeps what is stored.
 * Honours CLAUDEX_DISABLE_MODEL_PRICING, which opts out of models.dev.
 */
export function ensureMetaCatalogFresh(): void {
  if (isModelPricingDisabled() || refreshInFlight) return
  const now = Date.now()
  const sinceFailure = now - lastRefreshFailureAt
  const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, refreshFailures - 1))
  if (refreshFailures > 0 && sinceFailure >= 0 && sinceFailure < backoff) return
  loadRows()
  const age = store ? now - store.fetchedAt : -1
  if (store && age >= 0 && age < TTL_MS) return

  refreshInFlight = true
  void (async () => {
    try {
      const response = await fetch(CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (response.ok && recordMetaModelsDev(await response.json())) {
        refreshFailures = 0
        return
      }
      refreshFailures += 1
      lastRefreshFailureAt = Date.now()
    } catch {
      refreshFailures += 1
      lastRefreshFailureAt = Date.now()
    } finally {
      refreshInFlight = false
    }
  })()
}

// ─── Live `/v1/models` ids ───────────────────────────────────────────

/** Ids the logged-in key may call, once a listing has landed. */
let liveIds: string[] | null = null

/** Record which chat ids Meta's `GET /v1/models` lists for the active key. */
export function recordMetaLiveModels(ids: readonly unknown[]): void {
  const kept: string[] = []
  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = normalizeMetaModelId(raw)
    if (!id || kept.includes(id)) continue
    if (!getMetaModelMeta(id) && NON_CHAT_ID.test(id)) continue
    kept.push(id)
  }
  if (kept.length > 0) liveIds = kept
}

/** A listed id no catalog describes yet: usable, with no field guessed. */
function undescribed(id: string): MetaModelMeta {
  const museId = isMuseModelId(id)
  return {
    id,
    name: id,
    ...(museId && { contextWindow: MUSE_CONTEXT_WINDOW, maxOutputTokens: MUSE_MAX_OUTPUT_TOKENS }),
    // Every Muse model reasons and none can be told not to.
    reasoning: museId,
    efforts: [],
    toolCalling: true,
    imageInput: false,
    fileInput: false,
    contributor: id.endsWith('-contributor'),
    described: false,
  }
}

/** What the catalogs say about a model id, or undefined when they say nothing. */
export function getMetaModelMeta(model: string): MetaModelMeta | undefined {
  const id = normalizeMetaModelId(model)
  if (!id) return undefined
  return loadRows().get(id) ?? SNAPSHOT_BY_ID.get(id)
}

/**
 * Every agent-capable model, newest first: exactly the key's live listing
 * once one has landed, else everything the catalogs describe.
 */
export function listMetaModelMeta(): MetaModelMeta[] {
  const described = new Map<string, MetaModelMeta>(SNAPSHOT_BY_ID)
  for (const [id, meta] of loadRows()) described.set(id, meta)
  const source = liveIds
    ? liveIds.map(id => described.get(id) ?? undescribed(id))
    : [...described.values()]
  return source
    .filter(meta => meta.toolCalling)
    .sort((a, b) => {
      if (a.described !== b.described) return a.described ? -1 : 1
      const byDate = (b.released ?? '').localeCompare(a.released ?? '')
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id)
    })
}

/** Effort values the model accepts, in Meta's order. */
export function metaEffortsFor(model: string): readonly string[] {
  return getMetaModelMeta(model)?.efforts ?? []
}

export function getMetaContextWindow(model: string): number | undefined {
  return getMetaModelMeta(model)?.contextWindow ?? (isMuseModelId(model) ? MUSE_CONTEXT_WINDOW : undefined)
}

/** Output cap to send as `max_output_tokens`, or undefined when unknown. */
export function metaMaxOutputTokens(model: string): number | undefined {
  return getMetaModelMeta(model)?.maxOutputTokens ?? (isMuseModelId(model) ? MUSE_MAX_OUTPUT_TOKENS : undefined)
}

/** Per-million prices for a model, or undefined for an unpriced id. */
export function getMetaCatalogPrice(model: string): MetaPrice | undefined {
  return getMetaModelMeta(model)?.price
}

/** Test seam: forget the stored and live catalogs (optionally seed a payload). */
export function _resetMetaCatalogForTests(payload?: unknown): void {
  store = null
  rows = new Map()
  loadedFrom = storePath()
  liveIds = null
  refreshInFlight = false
  refreshFailures = 0
  lastRefreshFailureAt = 0
  if (payload !== undefined) {
    const models = ((payload as Record<string, unknown> | null)?.meta as { models?: unknown } | undefined)?.models
    if (models && typeof models === 'object') {
      store = { version: STORE_VERSION, fetchedAt: Date.now(), models: models as Record<string, unknown> }
      rows = indexStore(store)
    }
  }
}
