/**
 * Alibaba Cloud Model Studio (DashScope) model catalog — pay-as-you-go.
 *
 * Alibaba publishes an OpenAI-compatible endpoint whose `/models` route
 * answers ids and nothing else: no context window, no output cap, and — the
 * part that actually drives the picker — no statement of which models think or
 * how their thinking is steered. Qwen splits that across three request fields
 * (`enable_thinking`, `reasoning_effort`, `thinking_budget`) and which ones a
 * model accepts is genuinely per-model: qwen3.8-max takes an effort ladder,
 * qwen3.7-max only a toggle, qwen3-max neither. Sending the wrong one is a
 * 400, so guessing is not an option.
 *
 * So the capabilities are read from models.dev — the same catalogue
 * modelPricingCatalog.ts already prices from — under the two pay-as-you-go
 * provider ids:
 *
 *   alibaba      dashscope-intl.aliyuncs.com   (Singapore / international)
 *   alibaba-cn   dashscope.aliyuncs.com        (Beijing / mainland China)
 *
 * No model's ladder is written down here: `reasoning_options` from that
 * document IS the ladder, verbatim. A Qwen model released tomorrow gets a
 * correct chip on the next catalogue refresh, with no Tau release.
 *
 * The two surfaces compose: live `/models` says which ids THIS key may call,
 * models.dev says what each id can do. A live id models.dev has never heard of
 * stays usable with conservative defaults rather than being hidden.
 *
 * ── Region ───────────────────────────────────────────────────────────
 *
 * A Model Studio key is bound to the region that issued it, and the two
 * regions bill differently — qwen3-coder-flash is $0.30/$1.50 per 1M
 * internationally and $0.144/$0.574 in Beijing. So the region selects both the
 * endpoint and the price table, and `DASHSCOPE_BASE_URL` is the one knob that
 * moves both together.
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
import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { isModelPricingDisabled } from '../modelPricingCatalog.js'

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')
const CACHE_FILE = join(CONFIG_DIR, 'alibaba-models.json')
const CATALOG_URL = 'https://models.dev/api.json'
const CACHE_VERSION = 1
/** Capabilities move on model releases, not on the hour. */
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

export const ALIBABA_DEFAULT_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const ALIBABA_CN_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** models.dev provider ids for the two pay-as-you-go surfaces. */
export type AlibabaCatalogProviderId = 'alibaba' | 'alibaba-cn'

/**
 * The configured endpoint. Env only, matching MIMO_BASE_URL and
 * DEEPSEEK_BASE_URL: the key is region-bound, so whoever set the key knows
 * which host it belongs to and sets both together.
 */
export function alibabaBaseUrl(): string {
  const raw =
    process.env.DASHSCOPE_BASE_URL
    ?? process.env.ALIBABA_BASE_URL
    ?? process.env.MODELSTUDIO_BASE_URL
  const trimmed = raw?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : ALIBABA_DEFAULT_BASE_URL
}

/**
 * Which price table applies to the configured endpoint.
 *
 * Only `dashscope.aliyuncs.com` and the `cn-beijing` workspace hosts serve
 * mainland China; `dashscope-intl`, `dashscope-us` and the ap-southeast /
 * cn-hongkong workspace hosts are all billed at international rates. An
 * unrecognised host falls to international, which is the more expensive of the
 * two — a wrong guess then overstates spend rather than understating it.
 */
export function alibabaCatalogProviderId(
  baseUrl: string = alibabaBaseUrl(),
): AlibabaCatalogProviderId {
  let host: string
  try {
    host = new URL(baseUrl).host.toLowerCase()
  } catch {
    return 'alibaba'
  }
  if (host === 'dashscope.aliyuncs.com') return 'alibaba-cn'
  if (host.includes('cn-beijing')) return 'alibaba-cn'
  return 'alibaba'
}

/** Human label for the active endpoint, for /usage and /login copy. */
export function alibabaRegionLabel(baseUrl: string = alibabaBaseUrl()): string {
  return alibabaCatalogProviderId(baseUrl) === 'alibaba-cn'
    ? 'Beijing (mainland China)'
    : 'international (Singapore)'
}

// ─── Capability rows ─────────────────────────────────────────────────

/**
 * One model as the picker and the transformer need it. `toggle` and `efforts`
 * come straight from models.dev `reasoning_options` and decide which request
 * fields are legal for this model — see alibabaThinking.ts.
 */
export interface AlibabaModelMeta {
  id: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  /** Model reasons at all. False → no thinking field is ever sent. */
  reasoning: boolean
  /** `enable_thinking` is accepted (a hybrid thinking/non-thinking row). */
  toggle: boolean
  /** Published `reasoning_effort` values, in the order models.dev lists them. */
  efforts: readonly string[]
  tools: boolean
  vision: boolean
  /** ISO date models.dev last touched the row; drives picker order. */
  released: string
  /** False for a live id models.dev has never described. */
  described: boolean
}

/** Stored form — the same fields, minus the id, which is the map key. */
export interface StoredRow {
  n: string
  c: number
  o: number
  r: boolean
  t: boolean
  e: string[]
  tl: boolean
  v: boolean
  d: string
}

export interface CacheFile {
  version: number
  fetchedAt: number
  regions: Partial<Record<AlibabaCatalogProviderId, Record<string, StoredRow>>>
}

/** Output cap for a model models.dev does not describe. */
const FALLBACK_OUTPUT_TOKENS = 32_768
/** Context window for a model models.dev does not describe. */
const FALLBACK_CONTEXT_WINDOW = 131_072

/**
 * First-paint seed: the rows the tier defaults in configs.ts name, so /models
 * and a subagent spawn both work before the first catalogue fetch lands, and
 * on a machine that never reaches models.dev. Everything else — including
 * these rows' real ladders once a refresh completes — comes from the
 * catalogue.
 */
const SEED: Readonly<Record<string, StoredRow>> = {
  'qwen3.8-max': {
    n: 'Qwen3.8 Max',
    c: 1_000_000,
    o: 131_072,
    r: true,
    t: true,
    e: ['low', 'medium', 'xhigh'],
    tl: true,
    v: true,
    d: '2026-08-03',
  },
  'qwen3.8-flash': {
    n: 'Qwen3.8 Flash',
    c: 1_000_000,
    o: 131_072,
    r: true,
    t: true,
    e: ['low', 'medium', 'xhigh'],
    tl: true,
    v: true,
    d: '2026-08-26',
  },
  'qwen3.7-max': {
    n: 'Qwen3.7 Max',
    c: 1_000_000,
    o: 65_536,
    r: true,
    t: true,
    e: [],
    tl: true,
    v: false,
    d: '2026-05-21',
  },
  'qwen3.7-plus': {
    n: 'Qwen3.7 Plus',
    c: 1_000_000,
    o: 65_536,
    r: true,
    t: true,
    e: [],
    tl: true,
    v: true,
    d: '2026-06-04',
  },
  'qwen3-coder-plus': {
    n: 'Qwen3 Coder Plus',
    c: 1_048_576,
    o: 65_536,
    r: false,
    t: false,
    e: [],
    tl: true,
    v: false,
    d: '2025-07-23',
  },
  'qwen-flash': {
    n: 'Qwen Flash',
    c: 1_000_000,
    o: 32_768,
    r: true,
    t: true,
    e: [],
    tl: true,
    v: false,
    d: '2025-07-28',
  },
}

// ─── In-memory state ─────────────────────────────────────────────────

let cache: CacheFile | null = null
let loadAttempted = false
/** Live `/models` ids for the active key, so the picker can hide the rest. */
const liveIds = new Map<AlibabaCatalogProviderId, Set<string>>()

function loadCache(): CacheFile | null {
  if (loadAttempted) return cache
  loadAttempted = true
  try {
    if (!existsSync(CACHE_FILE)) return null
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CacheFile
    if (parsed?.version !== CACHE_VERSION) return null
    if (!parsed.regions || typeof parsed.regions !== 'object') return null
    cache = parsed
  } catch {
    // An unreadable cache is simply no cache; the next refresh rewrites it.
    cache = null
  }
  return cache
}

/**
 * models.dev spells some ids with dashes where DashScope uses dots
 * (`qwen2-5-72b-instruct` for `qwen2.5-72b-instruct`). Normalising both sides
 * lets a live id find its description. Verified unambiguous: no provider in
 * the catalogue publishes two ids that differ only by that substitution.
 */
export function normalizeAlibabaModelId(id: string): string {
  return id.trim().toLowerCase().replace(/\./g, '-')
}

function rowsFor(region: AlibabaCatalogProviderId): Record<string, StoredRow> {
  const stored = loadCache()?.regions[region]
  if (stored && Object.keys(stored).length > 0) return stored
  return SEED
}

function toMeta(
  id: string,
  row: StoredRow,
  described: boolean,
): AlibabaModelMeta {
  return {
    id,
    name: row.n,
    contextWindow: row.c,
    maxOutputTokens: row.o,
    reasoning: row.r,
    toggle: row.t,
    efforts: row.e,
    tools: row.tl,
    vision: row.v,
    released: row.d,
    described,
  }
}

/**
 * What models.dev says about a model id, or undefined when it says nothing.
 *
 * Undefined is the honest answer and callers depend on it: the transformer
 * sends NO thinking field for an undescribed model rather than guessing one
 * the endpoint may reject.
 */
export function getAlibabaModelMeta(
  model: string,
  region: AlibabaCatalogProviderId = alibabaCatalogProviderId(),
): AlibabaModelMeta | undefined {
  ensureAlibabaCatalogFresh()
  const rows = rowsFor(region)
  const id = model.trim()
  const direct = rows[id]
  if (direct) return toMeta(id, direct, true)
  const key = normalizeAlibabaModelId(id)
  for (const [candidate, row] of Object.entries(rows)) {
    if (normalizeAlibabaModelId(candidate) === key) return toMeta(id, row, true)
  }
  return undefined
}

/** Per-model output ceiling, or a conservative cap for an unknown row. */
export function alibabaMaxOutputTokens(model: string): number {
  return getAlibabaModelMeta(model)?.maxOutputTokens ?? FALLBACK_OUTPUT_TOKENS
}

// ─── Live `/models` reconciliation ───────────────────────────────────

/**
 * Ids DashScope is not going to serve as chat completions.
 *
 * `/models` returns the whole Model Studio surface — speech, embeddings,
 * rerankers, image and video generation — while the OpenAI-compatible route
 * answers only text chat. models.dev settles this for every id it describes
 * (input and output modalities); this pattern only decides ids it has never
 * seen, so it filters rather than claims: a new `qwen4-plus` passes straight
 * through.
 */
const NON_CHAT_ID =
  /(?:^|-)(?:asr|tts|ocr|embedding|rerank|paraformer|cosyvoice|sambert|wanx|wan2|image|video|realtime|livetranslate|t2i|t2v|i2v)(?:-|$)/i

/**
 * Fold a live `/v1/models` response into the picker's view.
 *
 * The response carries ids only, so this records WHICH ids the key may call;
 * the descriptions still come from models.dev. Ids the catalogue has never
 * described stay in the list with conservative defaults — a model Alibaba
 * shipped this morning is usable this morning.
 */
export function recordAlibabaLiveModels(
  ids: readonly string[],
  region: AlibabaCatalogProviderId = alibabaCatalogProviderId(),
): void {
  const kept = new Set<string>()
  for (const raw of ids) {
    const id = raw?.trim()
    if (!id) continue
    if (getAlibabaModelMeta(id, region)) {
      kept.add(id)
      continue
    }
    if (NON_CHAT_ID.test(id)) continue
    kept.add(id)
  }
  if (kept.size > 0) liveIds.set(region, kept)
}

function metaForLiveId(
  id: string,
  region: AlibabaCatalogProviderId,
): AlibabaModelMeta {
  return (
    getAlibabaModelMeta(id, region) ?? {
      id,
      name: id,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      maxOutputTokens: FALLBACK_OUTPUT_TOKENS,
      // An undescribed row sends no thinking field at all: `enable_thinking`
      // on a model that does not take it is a 400, and silence always parses.
      reasoning: false,
      toggle: false,
      efforts: [],
      tools: true,
      vision: false,
      released: '',
      described: false,
    }
  )
}

/**
 * Every model to show, newest first.
 *
 * Once a live `/models` call has landed the answer is exactly what this key
 * may call; before that it is what models.dev describes for the region.
 */
export function listAlibabaModelMeta(
  region: AlibabaCatalogProviderId = alibabaCatalogProviderId(),
): AlibabaModelMeta[] {
  ensureAlibabaCatalogFresh()
  const live = liveIds.get(region)
  const metas = live
    ? [...live].map(id => metaForLiveId(id, region))
    : Object.entries(rowsFor(region)).map(([id, row]) => toMeta(id, row, true))

  return metas.sort((a, b) => {
    // Described rows lead, newest release first; undescribed ids trail in id
    // order so a brand-new model is findable without claiming a date for it.
    if (a.described !== b.described) return a.described ? -1 : 1
    if (a.released !== b.released) return b.released.localeCompare(a.released)
    return a.id.localeCompare(b.id)
  })
}

function toModelInfo(meta: AlibabaModelMeta): ModelInfo {
  const tags: string[] = []
  if (meta.reasoning) tags.push('reasoning')
  if (meta.tools) tags.push('tools')
  if (meta.vision) tags.push('vision')
  return {
    id: meta.id,
    name: meta.name,
    contextWindow: meta.contextWindow,
    supportsToolCalling: meta.tools,
    ...(tags.length > 0 ? { tags } : {}),
  }
}

/** Catalogue rows for the picker, in provider-owned order. */
export function alibabaModelCatalog(
  region: AlibabaCatalogProviderId = alibabaCatalogProviderId(),
): ModelInfo[] {
  return listAlibabaModelMeta(region).map(toModelInfo)
}

// ─── Refresh ─────────────────────────────────────────────────────────

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Reduce one models.dev provider block to the rows above.
 *
 * Exported so the derivation is testable without a network: hand it the shape
 * models.dev publishes and check the ladder that comes out.
 */
export function deriveAlibabaRows(provider: unknown): Record<string, StoredRow> {
  const out: Record<string, StoredRow> = {}
  const models = (provider as { models?: unknown } | null)?.models
  if (!models || typeof models !== 'object') return out

  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    const model = raw as Record<string, unknown> | null
    if (!model) continue

    const modalities = model.modalities as
      | { input?: unknown; output?: unknown }
      | undefined
    const input = Array.isArray(modalities?.input) ? modalities.input : []
    const output = Array.isArray(modalities?.output) ? modalities.output : []
    // Chat only. A row that cannot take text in or hand text back is a
    // speech, embedding or image endpoint the compatible-mode route never
    // serves, and listing it would only produce a 400 on selection.
    if (input.length > 0 && !input.includes('text')) continue
    if (output.length > 0 && !output.includes('text')) continue
    // The Realtime rows speak the websocket Realtime API, not chat
    // completions, so this lane can never call them however their modalities
    // read. This is the one id-shaped rule applied to described rows: it is a
    // statement about which API serves them, not about what they can do.
    if (/realtime/i.test(id)) continue

    const limit = model.limit as
      | { context?: unknown; output?: unknown }
      | undefined
    const options = Array.isArray(model.reasoning_options)
      ? (model.reasoning_options as Array<Record<string, unknown>>)
      : []
    const efforts: string[] = []
    let toggle = false
    for (const option of options) {
      if (option?.type === 'toggle') toggle = true
      if (option?.type === 'effort' && Array.isArray(option.values)) {
        for (const value of option.values) {
          if (typeof value === 'string' && value.length > 0) efforts.push(value)
        }
      }
    }
    const reasoning = model.reasoning === true

    out[id] = {
      n:
        typeof model.name === 'string' && model.name.length > 0
          ? model.name
          : id,
      c: readNumber(limit?.context) ?? FALLBACK_CONTEXT_WINDOW,
      o: readNumber(limit?.output) ?? FALLBACK_OUTPUT_TOKENS,
      r: reasoning,
      t: reasoning && toggle,
      e: reasoning ? efforts : [],
      tl: model.tool_call !== false,
      v: input.includes('image'),
      d:
        typeof model.last_updated === 'string'
          ? model.last_updated
          : typeof model.release_date === 'string'
            ? model.release_date
            : '',
    }
  }
  return out
}

/** Reduce a whole api.json payload to both pay-as-you-go regions. */
export function deriveAlibabaCache(
  payload: unknown,
  fetchedAt: number,
): CacheFile {
  const regions: CacheFile['regions'] = {}
  if (payload && typeof payload === 'object') {
    const document = payload as Record<string, unknown>
    for (const region of ['alibaba', 'alibaba-cn'] as const) {
      const rows = deriveAlibabaRows(document[region])
      if (Object.keys(rows).length > 0) regions[region] = rows
    }
  }
  return { version: CACHE_VERSION, fetchedAt, regions }
}

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

let refreshInFlight = false
let refreshFailures = 0
let lastRefreshFailureAt = 0
const RETRY_BASE_MS = 5 * 60_000
const RETRY_CAP_MS = 60 * 60_000

function refreshRetryDelay(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * Refresh the stored capabilities if missing or a day old. Fire-and-forget:
 * returns immediately, never throws, and a failed fetch leaves the previous
 * table in place. A stale ladder still describes the model; an absent one
 * silently drops the picker's chip.
 *
 * Honours CLAUDEX_DISABLE_MODEL_PRICING, which opts out of models.dev
 * entirely — capabilities and prices come from the same document.
 */
export function ensureAlibabaCatalogFresh(): void {
  if (isModelPricingDisabled()) return
  if (refreshInFlight) return

  const now = Date.now()
  const sinceFailure = now - lastRefreshFailureAt
  if (
    refreshFailures > 0
    && sinceFailure >= 0
    && sinceFailure < refreshRetryDelay(refreshFailures)
  ) {
    return
  }

  let current = loadCache()
  if (!current) {
    // Another session may have written the file since this one first looked.
    loadAttempted = false
    current = loadCache()
  }
  const age = current ? now - current.fetchedAt : -1
  if (current && age >= 0 && age < TTL_MS) return

  refreshInFlight = true
  void (async () => {
    try {
      const response = await fetch(CATALOG_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        noteRefreshFailure()
        return
      }
      const derived = deriveAlibabaCache(await response.json(), Date.now())
      if (Object.keys(derived.regions).length === 0) {
        noteRefreshFailure()
        return
      }
      refreshFailures = 0
      cache = derived
      loadAttempted = true
      writeCacheAtomically(derived)
    } catch {
      // Keep whatever is already stored. A refresh that fails must not turn a
      // described model into an undescribed one.
      noteRefreshFailure()
    } finally {
      refreshInFlight = false
    }
  })()
}

function noteRefreshFailure(): void {
  refreshFailures += 1
  lastRefreshFailureAt = Date.now()
}

/** Test seam: install a known table and skip the network. */
export function _resetAlibabaCatalogForTests(next?: CacheFile | null): void {
  cache = next ?? null
  loadAttempted = next !== undefined
  refreshFailures = 0
  lastRefreshFailureAt = 0
  refreshInFlight = false
  liveIds.clear()
}
