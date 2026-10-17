/**
 * xAI (Grok) model catalog: ids, context windows, output caps, reasoning
 * ladders and prices.
 *
 * Sources, most authoritative first:
 *
 *   1. xAI's own `GET /v1/models` for the logged-in key. Each row states the
 *      values the model accepts for `reasoning.effort`, its default effort,
 *      its context length and its prices (USD cents per 100M tokens), with the
 *      long-context tier and its threshold. Recorded whenever /models lists the
 *      provider and persisted, so a later session starts from it.
 *   2. The snapshot below: models.dev (2026-10-17) checked against
 *      docs.x.ai/developers/models and /developers/model-capabilities/text/
 *      reasoning.
 *
 * An id neither source knows gets no effort chip and no price: no
 * speculative field is ever sent, and nothing is billed at another model's
 * rate.
 *
 * Dependency-light on purpose (fs/os/path only): contextWindows.ts and
 * modelCost.ts read it synchronously on the cost path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/** USD per million tokens. */
export interface XaiPrice {
  input: number
  cachedInput: number
  output: number
}

export interface XaiModelMeta {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning: boolean
  /** Values `reasoning.effort` accepts. Empty when the model takes none. */
  efforts: readonly string[]
  /** What xAI uses when the request names no effort. */
  defaultEffort?: string
  /** False for rows that cannot call client-side functions. */
  toolCalling: boolean
  imageInput: boolean
  /** Accepts `input_file` parts (PDF). */
  fileInput: boolean
  price?: XaiPrice
  /** Rates for a request whose prompt reaches `threshold` tokens. */
  longContext?: { threshold: number; price: XaiPrice }
  aliases?: readonly string[]
  /** Unix seconds. Orders the picker newest first. */
  created?: number
}

const LONG_CONTEXT_THRESHOLD = 200_000
const seconds = (date: string): number => Math.floor(Date.parse(date) / 1000)

/**
 * Text models that can drive an agent. Left out: the Imagine image/video
 * rows (no text output) and grok-4.20-multi-agent-0309, which models.dev
 * lists without client-side tool calling — every Tau turn needs it.
 */
const SNAPSHOT: readonly XaiModelMeta[] = [
  {
    id: 'grok-4.7',
    name: 'Grok 4.7',
    contextWindow: 500_000,
    maxOutputTokens: 500_000,
    reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    price: { input: 2, cachedInput: 0.5, output: 6 },
    longContext: { threshold: LONG_CONTEXT_THRESHOLD, price: { input: 4, cachedInput: 1, output: 12 } },
    created: seconds('2026-09-21'),
  },
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    contextWindow: 500_000,
    maxOutputTokens: 500_000,
    reasoning: true,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    price: { input: 2, cachedInput: 0.5, output: 6 },
    longContext: { threshold: LONG_CONTEXT_THRESHOLD, price: { input: 4, cachedInput: 1, output: 12 } },
    created: seconds('2026-08-12'),
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    contextWindow: 500_000,
    maxOutputTokens: 500_000,
    reasoning: true,
    // No xhigh: xAI treats it as high on this model.
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    price: { input: 2, cachedInput: 0.3, output: 6 },
    longContext: { threshold: LONG_CONTEXT_THRESHOLD, price: { input: 4, cachedInput: 0.6, output: 12 } },
    created: seconds('2026-07-08'),
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    contextWindow: 1_000_000,
    maxOutputTokens: 30_000,
    reasoning: true,
    efforts: ['none', 'low', 'medium', 'high'],
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    price: { input: 1.25, cachedInput: 0.2, output: 2.5 },
    longContext: { threshold: LONG_CONTEXT_THRESHOLD, price: { input: 2.5, cachedInput: 0.4, output: 5 } },
    created: seconds('2026-04-17'),
  },
  {
    id: 'grok-build-0.1',
    name: 'Grok Build 0.1',
    contextWindow: 256_000,
    maxOutputTokens: 256_000,
    reasoning: true,
    efforts: [],
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    price: { input: 1, cachedInput: 0.2, output: 2 },
    longContext: { threshold: LONG_CONTEXT_THRESHOLD, price: { input: 2, cachedInput: 0.4, output: 4 } },
    created: seconds('2026-04-16'),
  },
  {
    id: 'grok-4.20-0309-reasoning',
    name: 'Grok 4.20 (Reasoning)',
    contextWindow: 1_000_000,
    maxOutputTokens: 30_000,
    reasoning: true,
    efforts: [],
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    price: { input: 1.25, cachedInput: 0.2, output: 2.5 },
    longContext: { threshold: LONG_CONTEXT_THRESHOLD, price: { input: 2.5, cachedInput: 0.4, output: 5 } },
    created: seconds('2026-03-09'),
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    name: 'Grok 4.20 (Non-Reasoning)',
    contextWindow: 1_000_000,
    maxOutputTokens: 30_000,
    reasoning: false,
    efforts: [],
    toolCalling: true,
    imageInput: true,
    fileInput: true,
    price: { input: 1.25, cachedInput: 0.2, output: 2.5 },
    longContext: { threshold: LONG_CONTEXT_THRESHOLD, price: { input: 2.5, cachedInput: 0.4, output: 5 } },
    created: seconds('2026-03-09'),
  },
]

const SNAPSHOT_BY_ID = new Map(SNAPSHOT.map(model => [model.id, model]))

/** One row of `GET /v1/models`, as far as Tau relies on it. */
export interface XaiApiModel {
  id?: string
  aliases?: string[]
  context_length?: number | null
  created?: number
  prompt_text_token_price?: number | null
  cached_prompt_text_token_price?: number | null
  completion_text_token_price?: number | null
  prompt_text_token_price_long_context?: number | null
  cached_prompt_text_token_price_long_context?: number | null
  completion_text_token_price_long_context?: number | null
  long_context_threshold?: number | null
  prompt_image_token_price?: number | null
  image_price?: number | null
  capabilities?: {
    reasoning_effort?: string[] | null
    default_reasoning_effort?: string | null
  } | null
}

/** Canonical lookup key: lowercased, without an `xai/` prefix or effort tag. */
export function normalizeXaiModelId(model: string): string {
  let id = model.trim().toLowerCase()
  const effortTag = id.lastIndexOf('::effort=')
  if (effortTag >= 0) id = id.slice(0, effortTag)
  return id.replace(/^(?:xai|x-ai)\//, '')
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** xAI quotes USD cents per 100 million tokens; Tau prices per million. */
function perMillion(centsPer100M: unknown): number | undefined {
  const value = positive(centsPer100M)
  return value === undefined ? undefined : value / 10_000
}

function liveEfforts(row: XaiApiModel): string[] | undefined {
  const raw = row.capabilities?.reasoning_effort
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const effort = value.trim().toLowerCase()
    if (effort && !out.includes(effort)) out.push(effort)
  }
  return out
}

function prettyName(id: string): string {
  return id
    .split('-')
    .map(part => (part === 'grok' ? 'Grok' : part))
    .join(' ')
}

/** Merge one live row over what the snapshot says about the same id. */
export function xaiMetaFromApi(row: XaiApiModel): XaiModelMeta | undefined {
  const id = typeof row.id === 'string' ? normalizeXaiModelId(row.id) : ''
  if (!id) return undefined
  const known = SNAPSHOT_BY_ID.get(id)

  const input = perMillion(row.prompt_text_token_price)
  const output = perMillion(row.completion_text_token_price)
  // A row with no text prices is an image or video generator.
  if (!known && (input === undefined || output === undefined)) return undefined
  if (id.startsWith('grok-imagine')) return undefined

  const price = input !== undefined && output !== undefined
    ? { input, output, cachedInput: perMillion(row.cached_prompt_text_token_price) ?? input }
    : known?.price
  const threshold = positive(row.long_context_threshold)
  const longInput = perMillion(row.prompt_text_token_price_long_context)
  const longOutput = perMillion(row.completion_text_token_price_long_context)
  const longContext = threshold !== undefined && longInput !== undefined && longOutput !== undefined
    ? {
        threshold,
        price: {
          input: longInput,
          output: longOutput,
          // The language-models route documents 0 here as "same as the
          // standard cached rate"; /v1/models leaves it null.
          cachedInput: perMillion(row.cached_prompt_text_token_price_long_context)
            ?? price?.cachedInput
            ?? longInput,
        },
      }
    : (row.long_context_threshold === 0 ? undefined : known?.longContext)

  const efforts = liveEfforts(row) ?? known?.efforts ?? []
  const defaultEffortRaw = row.capabilities?.default_reasoning_effort
  const defaultEffort = typeof defaultEffortRaw === 'string' && efforts.includes(defaultEffortRaw.toLowerCase())
    ? defaultEffortRaw.toLowerCase()
    : known?.defaultEffort
  const aliases = Array.isArray(row.aliases)
    ? row.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
        .map(normalizeXaiModelId)
    : known?.aliases

  return {
    id,
    name: known?.name ?? prettyName(id),
    contextWindow: positive(row.context_length) ?? known?.contextWindow,
    maxOutputTokens: known?.maxOutputTokens,
    reasoning: known?.reasoning ?? (efforts.length > 0 || !id.includes('non-reasoning')),
    efforts,
    ...(defaultEffort !== undefined && { defaultEffort }),
    toolCalling: known?.toolCalling ?? !id.includes('multi-agent'),
    imageInput: known?.imageInput ?? positive(row.prompt_image_token_price) !== undefined,
    fileInput: known?.fileInput ?? false,
    ...(price && { price }),
    ...(longContext && { longContext }),
    ...(aliases && aliases.length > 0 && { aliases }),
    created: positive(row.created) ?? known?.created,
  }
}

// ─── Live catalog (recorded from /models, persisted) ─────────────────

let live: Map<string, XaiModelMeta> | null = null
let liveLoadedFrom: string | null = null

function storePath(): string {
  return process.env.TAU_XAI_MODEL_CATALOG_STORE || join(homedir(), '.claude', 'xai-models.json')
}

function loadLive(): Map<string, XaiModelMeta> {
  const path = storePath()
  if (live && liveLoadedFrom === path) return live
  liveLoadedFrom = path
  live = new Map()
  try {
    if (!existsSync(path)) return live
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { rows?: unknown }
    if (Array.isArray(parsed?.rows)) indexRows(live, parsed.rows as XaiApiModel[])
  } catch {
    // An unreadable store is no store; the next /models listing rewrites it.
  }
  return live
}

function indexRows(target: Map<string, XaiModelMeta>, rows: readonly XaiApiModel[]): void {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const meta = xaiMetaFromApi(row)
    if (meta) target.set(meta.id, meta)
  }
}

/**
 * Fold a live `/v1/models` listing into the catalog and persist it. The rows
 * are stored as xAI sent them, so a later build re-derives from the source.
 */
export function recordXaiLiveModels(rows: readonly XaiApiModel[]): void {
  const next = new Map<string, XaiModelMeta>()
  indexRows(next, rows)
  if (next.size === 0) return
  live = next
  liveLoadedFrom = storePath()
  try {
    const path = storePath()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const staged = `${path}.${process.pid}.tmp`
    writeFileSync(staged, JSON.stringify({ fetchedAt: Date.now(), rows }), 'utf8')
    try {
      renameSync(staged, path)
    } catch {
      writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), rows }), 'utf8')
    }
  } catch {
    // The in-memory catalog still serves this session.
  }
}

/** Metadata for a model id or alias, live data first. */
export function getXaiModelMeta(model: string): XaiModelMeta | undefined {
  const id = normalizeXaiModelId(model)
  if (!id) return undefined
  const rows = loadLive()
  const direct = rows.get(id) ?? SNAPSHOT_BY_ID.get(id)
  if (direct) return direct
  for (const meta of rows.values()) {
    if (meta.aliases?.includes(id)) return meta
  }
  // `<model>-latest` aliases the newest build of <model>.
  if (id.endsWith('-latest')) return getXaiModelMeta(id.slice(0, -'-latest'.length))
  return undefined
}

/**
 * Every agent-capable model, newest first: the live listing when one has been
 * recorded, else the snapshot.
 */
export function listXaiModelMeta(): XaiModelMeta[] {
  const rows = loadLive()
  const source = rows.size > 0 ? [...rows.values()] : [...SNAPSHOT]
  return source
    .filter(meta => meta.toolCalling)
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
}

/** Effort values the model accepts, in xAI's order. */
export function xaiEffortsFor(model: string): readonly string[] {
  return getXaiModelMeta(model)?.efforts ?? []
}

export function getXaiContextWindow(model: string): number | undefined {
  return getXaiModelMeta(model)?.contextWindow
}

/** Output cap to send as `max_output_tokens`, or undefined when unknown. */
export function xaiMaxOutputTokens(model: string): number | undefined {
  return getXaiModelMeta(model)?.maxOutputTokens
}

/** Rates the US regional endpoint applies on top of the global ones. */
const US_REGIONAL_MULTIPLIER = 1.1

export function isXaiUsRegionalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'us.api.x.ai'
  } catch {
    return false
  }
}

/**
 * Per-million prices for one request. `promptTokens` is the whole prompt the
 * request carried (fresh + cached): xAI bills every token of a request whose
 * prompt reaches the threshold at the long-context rate.
 */
export function getXaiCatalogPrice(
  model: string,
  promptTokens: number,
  baseUrl?: string,
): XaiPrice | undefined {
  const meta = getXaiModelMeta(model)
  if (!meta?.price) return undefined
  const tier = meta.longContext && promptTokens >= meta.longContext.threshold
    ? meta.longContext.price
    : meta.price
  const multiplier = isXaiUsRegionalBaseUrl(baseUrl) ? US_REGIONAL_MULTIPLIER : 1
  return {
    input: tier.input * multiplier,
    cachedInput: tier.cachedInput * multiplier,
    output: tier.output * multiplier,
  }
}

/** Test seam: forget the live catalog (and optionally seed it). */
export function _resetXaiCatalogForTests(rows?: readonly XaiApiModel[]): void {
  live = new Map()
  liveLoadedFrom = storePath()
  if (rows) indexRows(live, rows)
}
