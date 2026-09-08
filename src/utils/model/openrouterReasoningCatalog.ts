/**
 * OpenRouter per-model reasoning descriptor.
 *
 * OpenRouter does not have one thinking knob either. `/api/v1/models` answers
 * a `reasoning` object per model, and what it says differs per row:
 *
 *   {
 *     "mandatory": true,
 *     "supported_efforts": ["max","xhigh","high","medium","low","minimal"],
 *     "default_effort": "medium"
 *   }
 *
 * So the ladder cannot be a fixed low/medium/high set, and it cannot be
 * guessed from the model id either:
 *
 *   meta/muse-spark-1.3      minimal / low / medium / high / xhigh / max
 *   x-ai/grok-4.20           low / high / max
 *   deepseek/deepseek-v3.2   reasons, but publishes no effort ladder at all
 *   openai/gpt-5.5-chat      does not reason — no chip
 *
 * Sending an effort a model has not published is a 400 from the upstream, and
 * `low/medium/high` — the only values Tau's own thinking budget speaks — is not
 * even a subset of every ladder (`["max","high","low"]` has no `medium`). So
 * the ladder is read per model out of OpenRouter's own catalogue and rendered
 * verbatim, the same way alibabaCatalog.ts reads models.dev.
 *
 * OpenRouter is the authority on its own routing, so it is the source rather
 * than models.dev: a model listed this morning is described this morning, on
 * the same document `listModels()` already fetches for the picker.
 *
 * Nothing here is model-specific. A model OpenRouter has not described gets
 * `undefined`, and every caller treats that as "say nothing about reasoning"
 * rather than guessing a field the upstream may reject.
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
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')
const CACHE_FILE = join(CONFIG_DIR, 'openrouter-reasoning.json')
const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_VERSION = 1
/** Reasoning ladders move on model releases, not on the hour. */
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

/** What OpenRouter says about one model's reasoning surface. */
export interface OpenRouterReasoningMeta {
  /** Reasoning cannot be turned off — `reasoning: { enabled: false }` is a 400. */
  mandatory: boolean
  /** Reasoning runs unless asked otherwise. `null` when the row is silent. */
  defaultEnabled: boolean | null
  /** The effort values THIS model publishes, ordered least → most effort. */
  efforts: readonly string[]
  /** The effort OpenRouter applies when the request names none. */
  defaultEffort: string | null
  /** The row accepts a `reasoning.max_tokens` budget instead of an effort. */
  supportsMaxTokens: boolean
}

/** Stored form — short keys, since this file holds the whole catalogue. */
interface StoredRow {
  m: boolean
  de?: boolean
  e?: string[]
  d?: string
  mt?: boolean
}

interface CacheFile {
  version: number
  fetchedAt: number
  models: Record<string, StoredRow>
}

/**
 * Display order for the effort ladder, least → most effort.
 *
 * Only the ORDER is stated here — never which values a model has. OpenRouter
 * publishes its own lists strongest-first, and a value this table has never
 * heard of still rides along (appended in the order OpenRouter listed it), so
 * a new rung appears on the chip without a Tau release.
 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

function sortEfforts(values: readonly string[]): string[] {
  return [...values].sort((left, right) => {
    const leftRank = EFFORT_RANK[left]
    const rightRank = EFFORT_RANK[right]
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank
    // An unranked value keeps OpenRouter's own placement relative to the
    // ranked ones rather than being reordered on a guess.
    if (leftRank !== undefined) return -1
    if (rightRank !== undefined) return 1
    return 0
  })
}

// ─── In-memory state ─────────────────────────────────────────────────

let cache: CacheFile | null = null
let loadAttempted = false

function loadCache(): CacheFile | null {
  if (loadAttempted) return cache
  loadAttempted = true
  try {
    if (!existsSync(CACHE_FILE)) return null
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CacheFile
    if (parsed?.version !== CACHE_VERSION) return null
    if (!parsed.models || typeof parsed.models !== 'object') return null
    cache = parsed
  } catch {
    // An unreadable cache is simply no cache; the next refresh rewrites it.
    cache = null
  }
  return cache
}

function toMeta(row: StoredRow): OpenRouterReasoningMeta {
  return {
    mandatory: row.m === true,
    defaultEnabled: typeof row.de === 'boolean' ? row.de : null,
    efforts: row.e ?? [],
    defaultEffort: row.d ?? null,
    supportsMaxTokens: row.mt === true,
  }
}

/**
 * OpenRouter appends routing variants to an id with a colon (`:free`,
 * `:nitro`, `:floor`, `:online`, `:exacto`). They select an endpoint, not a
 * different model, so the base row describes them.
 */
function baseModelId(model: string): string {
  const id = model.trim().toLowerCase()
  const colon = id.indexOf(':')
  return colon > 0 ? id.slice(0, colon) : id
}

/**
 * What OpenRouter says about this model's reasoning, or undefined when it has
 * said nothing.
 *
 * Undefined is the honest answer and every caller depends on it: the picker
 * shows no chip and the transformer sends no reasoning field, rather than
 * guessing a ladder the upstream may reject.
 */
export function getOpenRouterReasoningMeta(
  model: string,
): OpenRouterReasoningMeta | undefined {
  ensureOpenRouterReasoningCatalogFresh()
  const rows = loadCache()?.models
  if (!rows) return undefined
  const id = model.trim().toLowerCase()
  const row = rows[id] ?? rows[baseModelId(id)]
  return row ? toMeta(row) : undefined
}

/** True when OpenRouter describes this model as reasoning-capable at all. */
export function openRouterModelReasons(model: string): boolean {
  return getOpenRouterReasoningMeta(model) !== undefined
}

// ─── Derivation ──────────────────────────────────────────────────────

/**
 * Reduce a `/api/v1/models` payload to the rows above.
 *
 * Exported so the derivation is testable without a network: hand it the shape
 * OpenRouter publishes and check the ladder that comes out.
 */
export function deriveOpenRouterReasoningRows(
  payload: unknown,
): Record<string, StoredRow> {
  const out: Record<string, StoredRow> = {}
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return out

  for (const raw of data) {
    const model = raw as Record<string, unknown> | null
    const id = typeof model?.id === 'string' ? model.id.trim().toLowerCase() : ''
    if (!id) continue

    const reasoning = model?.reasoning
    // A row without the object does not reason. Recording it as such would be
    // a claim; leaving it out lets the caller fall back to whatever it knew.
    if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
      continue
    }

    const bag = reasoning as Record<string, unknown>
    const efforts = Array.isArray(bag.supported_efforts)
      ? sortEfforts(
          bag.supported_efforts.filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          ),
        )
      : []
    const row: StoredRow = { m: bag.mandatory === true }
    if (typeof bag.default_enabled === 'boolean') row.de = bag.default_enabled
    if (efforts.length > 0) row.e = efforts
    if (typeof bag.default_effort === 'string' && bag.default_effort.length > 0) {
      row.d = bag.default_effort
    }
    if (bag.supports_max_tokens === true) row.mt = true
    out[id] = row
  }
  return out
}

/**
 * Fold a `/api/v1/models` payload the caller already fetched into the store.
 *
 * The provider fetches that document to build the picker's list; reusing it
 * here means the common path costs no extra request, and a key-scoped listing
 * still describes every row it returned.
 */
export function recordOpenRouterCatalogPayload(payload: unknown): void {
  const models = deriveOpenRouterReasoningRows(payload)
  if (Object.keys(models).length === 0) return
  const next: CacheFile = { version: CACHE_VERSION, fetchedAt: Date.now(), models }
  cache = next
  loadAttempted = true
  writeCacheAtomically(next)
}

// ─── Refresh ─────────────────────────────────────────────────────────

function writeCacheAtomically(next: CacheFile): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    const staged = `${CACHE_FILE}.${process.pid}.tmp`
    const body = JSON.stringify(next)
    try {
      writeFileSync(staged, body, 'utf8')
      renameSync(staged, CACHE_FILE)
    } catch {
      // Windows can refuse a rename over an open file. A direct write is the
      // lesser evil: the file holds nothing secret or unrecoverable.
      writeFileSync(CACHE_FILE, body, 'utf8')
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

let refreshInFlight: Promise<void> | null = null
let refreshFailures = 0
let lastRefreshFailureAt = 0
const RETRY_BASE_MS = 5 * 60_000
const RETRY_CAP_MS = 60 * 60_000

function refreshRetryDelay(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * Refresh the stored ladders if missing or a day old. Fire-and-forget:
 * returns immediately, never throws, and a failed fetch leaves the previous
 * table in place. A stale ladder still describes the model; an absent one
 * only costs the chip.
 *
 * `/api/v1/models` is public, so this works before a key is configured — the
 * picker and the request path both need the ladder, and only one of them ever
 * holds credentials.
 */
export function ensureOpenRouterReasoningCatalogFresh(): void {
  void startOpenRouterReasoningRefresh()
}

/**
 * Same refresh, awaited.
 *
 * The picker draws its chips synchronously from the table, so the first
 * `/models` visit on a machine with no cached copy would otherwise render
 * every OpenRouter row chip-less until the next keypress. Callers that are
 * already awaiting a catalogue fetch await this too; nobody else needs to.
 */
export function warmOpenRouterReasoningCatalog(): Promise<void> {
  return startOpenRouterReasoningRefresh()
}

function startOpenRouterReasoningRefresh(): Promise<void> {
  if (process.env.TAU_OPENROUTER_REASONING_CATALOG === '0') return Promise.resolve()
  if (refreshInFlight) return refreshInFlight

  const now = Date.now()
  const sinceFailure = now - lastRefreshFailureAt
  if (
    refreshFailures > 0
    && sinceFailure >= 0
    && sinceFailure < refreshRetryDelay(refreshFailures)
  ) {
    return Promise.resolve()
  }

  let current = loadCache()
  if (!current) {
    // Another session may have written the file since this one first looked.
    loadAttempted = false
    current = loadCache()
  }
  const age = current ? now - current.fetchedAt : -1
  if (current && age >= 0 && age < TTL_MS) return Promise.resolve()

  const run = (async () => {
    try {
      const response = await fetch(CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        noteRefreshFailure()
        return
      }
      const models = deriveOpenRouterReasoningRows(await response.json())
      if (Object.keys(models).length === 0) {
        noteRefreshFailure()
        return
      }
      refreshFailures = 0
      const next: CacheFile = { version: CACHE_VERSION, fetchedAt: Date.now(), models }
      cache = next
      loadAttempted = true
      writeCacheAtomically(next)
    } catch {
      // Keep whatever is already stored. A refresh that fails must not turn a
      // described model into an undescribed one.
      noteRefreshFailure()
    } finally {
      refreshInFlight = null
    }
  })()
  refreshInFlight = run
  return run
}

function noteRefreshFailure(): void {
  refreshFailures += 1
  lastRefreshFailureAt = Date.now()
}

/** Test seam: install a known table and skip the network. */
export function _resetOpenRouterReasoningCatalogForTests(
  models?: Record<string, StoredRow> | null,
): void {
  cache = models
    ? { version: CACHE_VERSION, fetchedAt: Date.now(), models }
    : null
  loadAttempted = models !== undefined
  refreshFailures = 0
  lastRefreshFailureAt = 0
  refreshInFlight = null
}
