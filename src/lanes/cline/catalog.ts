/**
 * Cline gateway catalog.
 *
 * Cline publishes two public feeds that its IDE extension and CLI load:
 *   GET /api/v1/ai/cline/models              the usage-billed catalog
 *   GET /api/v1/ai/cline/recommended-models  featured buckets
 *                                            (recommended, free, clinePass)
 *
 * Everything the lane needs to know about a model (Cline Pass membership,
 * context window, prompt-cache support, API price) is read from these feeds
 * instead of from id lists compiled into Tau. The Cline Pass normalization
 * mirrors sdk/packages/llms/src/catalog/catalog-cline-recommended.ts in
 * Cline's SDK.
 */

import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import {
  getClinePassModelDisplayName,
  toClinePassModelInfo,
} from '../../utils/model/clinePassCatalog.js'

export interface RawClineModelInfo {
  id?: string
  name?: string
  description?: string | null
  created?: number | null
  supportsReasoning?: boolean | null
  supportsThinking?: boolean | null
  supports_reasoning?: boolean | null
  supports_thinking?: boolean | null
  capabilities?: string[] | null
  model_info?: {
    supports_reasoning?: boolean | null
    supportsThinking?: boolean | null
    supportsReasoning?: boolean | null
    capabilities?: string[] | null
  } | null
  context_length?: number | null
  top_provider?: {
    context_length?: number | null
    max_completion_tokens?: number | null
  } | null
  architecture?: {
    modality?: string | string[] | null
    input_modalities?: string[] | null
    output_modalities?: string[] | null
  } | null
  pricing?: Record<string, string | number | null | undefined> | null
  supported_parameters?: string[] | null
}

export type ClineCatalogModel = RawClineModelInfo & { id: string }

export interface ClineFeedEntry {
  id?: string
  name?: string
  description?: string
  tags?: string[]
}

export interface ClineRecommendedFeed {
  recommended?: ClineFeedEntry[]
  free?: ClineFeedEntry[]
  clinePass?: ClineFeedEntry[]
}

export interface ClineCatalogIndex {
  byId: Map<string, ClineCatalogModel>
  bySlug: Map<string, ClineCatalogModel[]>
}

function unwrapSuccessEnvelope(payload: unknown): unknown {
  if (
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && (payload as { success?: unknown }).success === true
    && 'data' in payload
  ) {
    return (payload as { data: unknown }).data
  }
  return payload
}

function isCatalogModel(value: unknown): value is ClineCatalogModel {
  return !!value
    && typeof value === 'object'
    && typeof (value as RawClineModelInfo).id === 'string'
    && ((value as RawClineModelInfo).id as string).length > 0
}

export function parseClineCatalog(payload: unknown): ClineCatalogModel[] {
  let list: unknown = unwrapSuccessEnvelope(payload)
  if (!Array.isArray(list) && list && typeof list === 'object') {
    const record = list as { data?: unknown; models?: unknown }
    list = Array.isArray(record.data) ? record.data : record.models
  }
  return Array.isArray(list) ? list.filter(isCatalogModel) : []
}

export function parseClineRecommendedFeed(payload: unknown): ClineRecommendedFeed | null {
  const unwrapped = unwrapSuccessEnvelope(payload)
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
    return null
  }
  const record = unwrapped as Record<string, unknown>
  const bucket = (key: string): ClineFeedEntry[] | undefined =>
    Array.isArray(record[key]) ? record[key] as ClineFeedEntry[] : undefined
  const feed: ClineRecommendedFeed = {
    recommended: bucket('recommended'),
    free: bucket('free'),
    clinePass: bucket('clinePass'),
  }
  return feed.recommended || feed.free || feed.clinePass ? feed : null
}

function modelSlug(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1)
}

export function buildClineCatalogIndex(
  models: readonly ClineCatalogModel[],
): ClineCatalogIndex {
  const byId = new Map<string, ClineCatalogModel>()
  const bySlug = new Map<string, ClineCatalogModel[]>()
  for (const model of models) {
    const id = model.id.toLowerCase()
    if (!byId.has(id)) byId.set(id, model)
    // `~vendor/x-latest` rows are moving aliases, not a model of their own.
    if (id.startsWith('~')) continue
    const slug = modelSlug(id)
    const bucket = bySlug.get(slug)
    if (bucket) bucket.push(model)
    else bySlug.set(slug, [model])
  }
  return { byId, bySlug }
}

// A dated snapshot row such as `qwen/qwen3.8-max-0902` serves a feed id that
// names only the model (`cline-pass/qwen3.8-max`). The suffix has to be a
// date, so `glm-5.3` never borrows the metadata of `glm-5.3-flash`.
const DATED_SNAPSHOT_SUFFIX = /^-(?:\d{4}|\d{6}|\d{8}|\d{4}-\d{2}-\d{2})$/

/**
 * The catalog row that describes `modelId`: the exact id, else the same model
 * under its upstream vendor (Cline Pass ids carry only the model name, as in
 * the SDK's lookup), else that model's newest dated snapshot.
 */
export function findClineCatalogModel(
  modelId: string,
  index: ClineCatalogIndex,
): ClineCatalogModel | undefined {
  const id = modelId.trim().toLowerCase()
  if (!id) return undefined
  const exact = index.byId.get(id)
  if (exact) return exact

  const slug = modelSlug(id)
  const sameSlug = index.bySlug.get(slug)
  if (sameSlug && sameSlug.length > 0) return sameSlug[0]

  let dated: ClineCatalogModel | undefined
  for (const [candidateSlug, models] of index.bySlug) {
    if (
      !candidateSlug.startsWith(slug)
      || !DATED_SNAPSHOT_SUFFIX.test(candidateSlug.slice(slug.length))
    ) {
      continue
    }
    for (const model of models) {
      if (!dated || (model.created ?? 0) > (dated.created ?? 0)) dated = model
    }
  }
  return dated
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined
}

export function catalogContextWindow(model: RawClineModelInfo): number | undefined {
  return positiveNumber(model.context_length)
    ?? positiveNumber(model.top_provider?.context_length)
}

export function catalogSupportsTools(model: RawClineModelInfo): boolean {
  return Array.isArray(model.supported_parameters)
    ? model.supported_parameters.includes('tools')
      || model.supported_parameters.includes('tool_choice')
    : true
}

function catalogPrice(model: RawClineModelInfo, key: string): number | undefined {
  const raw = model.pricing?.[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** The catalog prices cache reads only for models whose upstream caches prompts. */
export function catalogSupportsPromptCache(model: RawClineModelInfo): boolean {
  return catalogPrice(model, 'input_cache_read') !== undefined
}

/**
 * Free through the API itself: zero input and output price in the billed
 * catalog. The feed's `free` bucket is not this. Cline serves those models
 * free only inside its IDE extension and CLI, never through the API.
 */
export function catalogIsFreeViaApi(model: RawClineModelInfo): boolean {
  return catalogPrice(model, 'prompt') === 0
    && catalogPrice(model, 'completion') === 0
}

/**
 * Catalog names carry the vendor and the snapshot date:
 * "Z.ai: GLM 5.3 Flash" -> "GLM 5.3 Flash",
 * "Qwen: Qwen3.8 Max (0902)" -> "Qwen3.8 Max".
 */
export function clineModelDisplayName(name: string | null | undefined): string | undefined {
  if (!name) return undefined
  const cleaned = name
    .replace(/^[^:]{1,40}:\s+/, '')
    .replace(/\s+\(?(?:\d{4}|\d{8}|\d{4}-\d{2}-\d{2})\)?$/, '')
    .trim()
  return cleaned || undefined
}

/**
 * The live Cline Pass list: the feed's `clinePass` bucket, in feed order,
 * named and tool-flagged from the catalog row of the upstream model. The
 * feed's `free` bucket is deliberately left out: Cline refuses those models
 * outside its own apps, so listing them in Tau would only offer entries that
 * always fail.
 *
 * The context window is only ever the one Cline Pass serves, which `describe`
 * reads from models.dev's `cline-pass` block. The upstream row overstates it
 * (glm-5.3 lists 1,310,720 upstream where Pass serves 1,000,000), so without
 * a description the model states no window and Tau's other window sources
 * decide.
 */
export function buildClinePassModels(
  feed: ClineRecommendedFeed | null,
  index: ClineCatalogIndex | null,
  describe?: (id: string) => { contextWindow?: number } | undefined,
): ModelInfo[] {
  const seen = new Set<string>()
  const models: ModelInfo[] = []
  for (const entry of feed?.clinePass ?? []) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const key = id.toLowerCase()
    if (!id || seen.has(key)) continue
    seen.add(key)

    const upstream = index ? findClineCatalogModel(id, index) : undefined
    // The feed sends the bare id as the name for Cline Pass rows.
    const feedName = typeof entry.name === 'string' && entry.name.trim() !== id
      ? entry.name.trim()
      : undefined
    const name = clineModelDisplayName(upstream?.name)
      ?? feedName
      ?? getClinePassModelDisplayName(id)
      ?? modelSlug(id)
    models.push(toClinePassModelInfo(id, name, {
      contextWindow: describe?.(id)?.contextWindow,
      supportsToolCalling: upstream ? catalogSupportsTools(upstream) : undefined,
    }))
  }
  return models
}

/** Loads in a row that did not bring back both feeds, and when the last ended. */
export interface ClineCatalogFailure {
  count: number
  at: number
}

/**
 * Whether a catalog that fell short `failure.count` times in a row may be
 * loaded again: `baseMs` after the first shortfall, doubling with each one
 * after it, never more than `capMs`. A clock that moved backwards counts as
 * due, so a retry is never put off indefinitely.
 */
export function isClineCatalogRetryDue(
  failure: ClineCatalogFailure,
  now: number,
  baseMs: number,
  capMs: number,
): boolean {
  const elapsed = now - failure.at
  if (elapsed < 0) return true
  const doublings = Math.min(30, Math.max(0, failure.count - 1))
  return elapsed >= Math.min(capMs, baseMs * 2 ** doublings)
}
