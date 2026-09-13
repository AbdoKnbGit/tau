/**
 * What models.dev says about Cline and Cline Pass models.
 *
 * Cline's own feeds (lanes/cline/catalog.ts) say which models exist and what
 * the API charges. They do not say which models think, which effort values
 * each one takes, or the window Cline Pass serves, and guessing those from the
 * id went wrong: every Cline Pass model got the same five-stop ladder, so
 * glm-5.3 (low/high/max, no off) was sent `enabled: false`, and upstream
 * windows overstated the Pass ones (glm-5.3 at 1,310,720 where Pass serves
 * 1,000,000).
 *
 * models.dev describes both, under two provider ids:
 *
 *   cline-pass   the Cline Pass subscription ids, as Cline documents them
 *   openrouter   the upstream ids the usage-billed Cline provider serves.
 *                Cline's SDK builds its own `cline` catalogue from this block
 *                (sdk/packages/llms/src/providers/builtins.ts, buildClineModels)
 *
 * `reasoning_options` is the thinking ladder, taken verbatim. Nothing here
 * names a model, so a model released tomorrow is described on the next
 * refresh without a Tau release.
 *
 * Same discipline as alibabaCatalog.ts: lookups are synchronous and read only
 * memory or the file on disk, the Cline lane refreshes that file (once a day,
 * backing off on failure), a failed refresh keeps the old file, and
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
const CACHE_VERSION = 1
/** Capabilities move on model releases, not on the hour. */
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000
const RETRY_BASE_MS = 5 * 60_000
const RETRY_CAP_MS = 60 * 60_000

/** The models.dev provider blocks this module reads. */
const SOURCES = ['cline-pass', 'openrouter'] as const
type ClineModelsDevSource = (typeof SOURCES)[number]

// Mirrors CLINE_EFFORT_VARIANT_SEPARATOR in clineThinking.ts, which imports
// this module and so cannot be imported back.
const EFFORT_VARIANT_SEPARATOR = '::cline-effort='

function cacheFile(): string {
  return process.env.TAU_CLINE_MODELS_DEV_CACHE
    || join(homedir(), '.config', 'claude-code', 'cline-models-dev.json')
}

export interface ClineModelMeta {
  /** The model reasons at all. False: no thinking field is ever sent. */
  reasoning: boolean
  /** Published effort values, least to most effort, without `none`. */
  efforts: readonly string[]
  /** Thinking can be switched off: a toggle, or `none` among the efforts. */
  canTurnOff: boolean
  /** A bare on/off switch is published. */
  toggle: boolean
  /** The prompt this host accepts: the input ceiling where one is stated. */
  contextWindow?: number
  maxOutputTokens?: number
}

/** Stored form with short keys: the openrouter block is a few hundred rows. */
export interface StoredRow {
  r: boolean
  e?: string[]
  n?: boolean
  t?: boolean
  c?: number
  o?: number
}

export interface CacheFile {
  version: number
  fetchedAt: number
  providers: Partial<Record<ClineModelsDevSource, Record<string, StoredRow>>>
}

// Order only. Which values a model has always comes from the catalogue; a
// value outside this list is not one Tau can send, so it is left out.
const EFFORT_RANK: Readonly<Record<string, number>> = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

/**
 * The prompt a host accepts. `context` is the whole window; `input`, where it
 * is stated below that, is the share a prompt may use once output is
 * reserved, and the host rejects a prompt past it (see usableContextWindow in
 * modelPricingCatalog.ts).
 */
function usableWindow(
  limit: { context?: unknown; input?: unknown } | undefined,
): number | undefined {
  const whole = positive(limit?.context)
  const input = positive(limit?.input)
  if (input !== undefined && (whole === undefined || input < whole)) return input
  return whole
}

/**
 * Reduce one models.dev provider block to stored rows, keyed by lowercase id.
 * Exported so the derivation is testable without a network.
 */
export function deriveClineModelsDevRows(provider: unknown): Record<string, StoredRow> {
  const out: Record<string, StoredRow> = {}
  const models = (provider as { models?: unknown } | null)?.models
  if (!models || typeof models !== 'object') return out

  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    const model = raw as Record<string, unknown> | null
    const key = id.trim().toLowerCase()
    if (!model || typeof model !== 'object' || !key || key in out) continue

    const reasoning = model.reasoning === true
    let toggle = false
    let none = false
    const efforts: string[] = []
    if (reasoning && Array.isArray(model.reasoning_options)) {
      for (const option of model.reasoning_options as Array<Record<string, unknown> | null>) {
        if (option?.type === 'toggle') toggle = true
        if (option?.type !== 'effort' || !Array.isArray(option.values)) continue
        for (const value of option.values) {
          if (value === 'none') none = true
          else if (
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

    const limit = model.limit as
      | { context?: unknown; input?: unknown; output?: unknown }
      | undefined
    const window = usableWindow(limit)
    const output = positive(limit?.output)
    out[key] = {
      r: reasoning,
      ...(efforts.length > 0 && { e: efforts }),
      ...(none && { n: true }),
      ...(toggle && { t: true }),
      ...(window !== undefined && { c: window }),
      ...(output !== undefined && { o: output }),
    }
  }
  return out
}

/** Reduce a whole api.json payload to the two blocks this module reads. */
export function deriveClineModelsDevCache(payload: unknown, fetchedAt: number): CacheFile {
  const providers: CacheFile['providers'] = {}
  if (payload && typeof payload === 'object') {
    for (const source of SOURCES) {
      const rows = deriveClineModelsDevRows((payload as Record<string, unknown>)[source])
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

function toMeta(row: StoredRow): ClineModelMeta {
  const reasoning = row.r === true
  return {
    reasoning,
    efforts: reasoning ? row.e ?? [] : [],
    canTurnOff: reasoning && (row.t === true || row.n === true),
    toggle: reasoning && row.t === true,
    ...(row.c !== undefined && { contextWindow: row.c }),
    ...(row.o !== undefined && { maxOutputTokens: row.o }),
  }
}

/**
 * What models.dev says about a Cline or Cline Pass model id, or undefined when
 * it says nothing or models.dev is switched off. Undefined sends every caller
 * back to what it did before this catalogue existed.
 */
export function getClineModelMeta(modelId: string): ClineModelMeta | undefined {
  if (isModelPricingDisabled()) return undefined
  let id = modelId.trim().toLowerCase()
  const variant = id.lastIndexOf(EFFORT_VARIANT_SEPARATOR)
  if (variant >= 0) id = id.slice(0, variant)
  if (!id) return undefined

  const source: ClineModelsDevSource = id.startsWith('cline-pass/') ? 'cline-pass' : 'openrouter'
  const rows = loadCache()?.providers[source]
  if (!rows) return undefined
  // A route variant such as `:batch` is the same model.
  const row = rows[id] ?? rows[id.replace(/:[a-z0-9-]+$/, '')]
  return row ? toMeta(row) : undefined
}

/** Whether any description is available, fresh or stale. */
export function hasClineModelsDev(): boolean {
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
export function ensureClineModelsDevFresh(): Promise<void> | null {
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
      const derived = deriveClineModelsDevCache(await response.json(), Date.now())
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
export async function waitForClineModelsDev(ms: number, signal?: AbortSignal): Promise<void> {
  const pending = ensureClineModelsDevFresh()
  if (!pending || hasClineModelsDev()) return

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const giveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
    if (!signal) return
    if (signal.aborted) {
      resolve()
      return
    }
    onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([pending, giveUp])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Test seam: install a known table (or none) and skip the network. */
export function _resetClineModelsDevForTests(next?: CacheFile | null): void {
  cache = next ?? null
  loadedFrom = next === undefined ? null : cacheFile()
  refresh = null
  refreshFailures = 0
  lastRefreshFailureAt = 0
}
