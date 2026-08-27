/**
 * Published per-token prices from models.dev, so third-party models can be
 * costed instead of counted as unpriced.
 *
 * MODEL_COSTS in modelCost.ts covers Claude and Gemini. Everything else was
 * unpriced, which is honest but reports $0 for real spending. models.dev is a
 * community-maintained catalogue (MIT, https://models.dev) whose entries are
 * keyed by provider and by the same model id the provider itself uses -
 * `deepseek/deepseek-v4-flash` is exactly the id a session runs - so a lookup
 * is an exact match rather than a guess.
 *
 * Kept dependency-light on purpose: fs/os/path only. modelCost.ts sits behind
 * a broken transitive import that stops it loading outside the bundler, and
 * pricing rules are worth testing.
 *
 * ── Discipline ───────────────────────────────────────────────────────
 *
 *   - Lookups are synchronous and pure memory. Cost is computed per stream
 *     part; it can never wait on a network.
 *   - A failed refresh changes nothing. The table on disk stays, however old.
 *     Prices move over months, so a stale price is approximately right, while
 *     a missing one is only ever "unpriced" - never a wrong number.
 *   - A price is used only when BOTH the provider and the model id match.
 *     Guessing across providers would attribute one vendor's rate to another.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')
const CACHE_FILE = join(CONFIG_DIR, 'model-prices.json')
const CATALOG_URL = 'https://models.dev/api.json'
const CACHE_VERSION = 1

/**
 * Opt out of the catalogue entirely: no request to models.dev, and any table
 * already on disk is ignored.
 *
 * Off means off. Continuing to price from a previously downloaded file would
 * leave someone who disabled this unable to get back to the built-in
 * behaviour without deleting a file they were never told about.
 *
 * Set CLAUDEX_DISABLE_MODEL_PRICING to 1/true/yes to disable. Matching the
 * existing CLAUDEX_DISABLE_AFT convention.
 */
export function isModelPricingDisabled(): boolean {
  const raw = process.env.CLAUDEX_DISABLE_MODEL_PRICING?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/** Prices change over months. A day-old table is still a good table. */
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

/** [input, output, cacheRead, cacheWrite] in USD per million tokens. */
export type CatalogPriceRow = [number, number, number | null, number | null]

export type CatalogTable = {
  version: number
  fetchedAt: number
  providers: Record<string, Record<string, CatalogPriceRow>>
}

/** The shape modelCost.ts consumes. Declared here to avoid importing it. */
export type CatalogPrice = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

/**
 * Tau provider id to models.dev provider id, where they differ.
 *
 * Providers absent from the catalogue entirely - antigravity, kiro, cursor,
 * lxd, commandcode, modelrouter - simply find nothing and stay unpriced.
 *
 * Flat-fee providers ARE priced here. A subscription has no per-token bill,
 * so the figure is what the same usage would cost at published rates - an
 * API-equivalent value, not an invoice. Callers must label it as such.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  firstParty: 'anthropic',
  bedrock: 'amazon-bedrock',
  vertex: 'google-vertex',
  foundry: 'azure',
  gemini: 'google',
  cloudflare: 'cloudflare-workers-ai',
  nim: 'nvidia',
  glm: 'zhipuai',
  moonshot: 'moonshotai',
  fireworks: 'fireworks-ai',
  // Xiaomi ships MiMo. Token Plan deployments live under
  // xiaomi-token-plan-{sgp,cn,ams}; the default endpoint is plain 'xiaomi'.
  mimo: 'xiaomi',
  copilot: 'github-copilot',
  clinepass: 'cline-pass',
  opencodego: 'opencode-go',
  iflow: 'iflowcn',
  kilocode: 'kilo',
}

/**
 * Providers whose usage must never be priced from the catalogue.
 *
 * Only local runtimes qualify. Inference on your own machine has no published
 * rate to apply, and borrowing a hosted one would be pure fiction - models.dev
 * does list an 'lmstudio' provider, and using it would price local GPU time as
 * though it were somebody's API.
 */
const NEVER_PRICED: ReadonlySet<string> = new Set(['ollama', 'lmstudio'])

/**
 * The models.dev provider id for a Tau provider, or null when it must not be
 * priced from the catalogue.
 */
export function resolveCatalogProvider(tauProvider: string): string | null {
  if (NEVER_PRICED.has(tauProvider)) return null
  return PROVIDER_ALIASES[tauProvider] ?? tauProvider
}

/**
 * Reduce a models.dev api.json payload to the prices alone.
 *
 * The published document is ~4MB of capability metadata; the rows below are
 * ~300KB. Only models quoting both an input and an output rate are kept - a
 * half-specified entry cannot price a request.
 */
export function deriveTable(payload: unknown, fetchedAt: number): CatalogTable {
  const providers: CatalogTable['providers'] = {}
  if (payload && typeof payload === 'object') {
    for (const [providerId, provider] of Object.entries(
      payload as Record<string, unknown>,
    )) {
      const models = (provider as { models?: unknown } | null)?.models
      if (!models || typeof models !== 'object') continue

      const rows: Record<string, CatalogPriceRow> = {}
      for (const [modelId, model] of Object.entries(
        models as Record<string, unknown>,
      )) {
        const cost = (model as { cost?: unknown } | null)?.cost as
          | Record<string, unknown>
          | undefined
        if (!cost || typeof cost !== 'object') continue
        const input = cost.input
        const output = cost.output
        if (typeof input !== 'number' || typeof output !== 'number') continue
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue
        rows[modelId] = [
          input,
          output,
          typeof cost.cache_read === 'number' ? cost.cache_read : null,
          typeof cost.cache_write === 'number' ? cost.cache_write : null,
        ]
      }
      if (Object.keys(rows).length > 0) providers[providerId] = rows
    }
  }
  return { version: CACHE_VERSION, fetchedAt, providers }
}

/** Convert a stored row into the cost shape modelCost.ts expects. */
export function rowToPrice(row: CatalogPriceRow): CatalogPrice {
  const [input, output, cacheRead, cacheWrite] = row
  return {
    inputTokens: input,
    outputTokens: output,
    // Absent cache rates fall back to the uncached input rate rather than to
    // zero: treating an unstated cache read as free would understate a cached
    // conversation, which is most of a long session.
    promptCacheReadTokens: cacheRead ?? input,
    promptCacheWriteTokens: cacheWrite ?? input,
    // models.dev does not quote server-side web search; leave it uncharged
    // rather than invent a rate.
    webSearchRequests: 0,
  }
}

let table: CatalogTable | null = null
let loadAttempted = false

function loadTable(): CatalogTable | null {
  if (loadAttempted) return table
  loadAttempted = true
  try {
    if (!existsSync(CACHE_FILE)) return null
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CatalogTable
    if (parsed?.version !== CACHE_VERSION) return null
    if (!parsed.providers || typeof parsed.providers !== 'object') return null
    table = parsed
  } catch {
    // An unreadable cache is simply no cache; the next refresh rewrites it.
    table = null
  }
  return table
}

/**
 * Published prices for a model, or null when the catalogue cannot price it.
 *
 * Null is the safe answer: the caller reports the model as unpriced rather
 * than substituting another model's rate.
 */
export function lookupCatalogPrice(
  tauProvider: string,
  model: string,
): CatalogPrice | null {
  if (isModelPricingDisabled()) return null
  const providerId = resolveCatalogProvider(tauProvider)
  if (!providerId) return null

  const current = loadTable()
  const rows = current?.providers[providerId]
  if (!rows) return null

  const row = rows[model] ?? rows[model.toLowerCase()]
  return row ? rowToPrice(row) : null
}

/** When the stored table was fetched, or null when there is none. */
export function getCatalogFetchedAt(): number | null {
  return loadTable()?.fetchedAt ?? null
}

/** Test seam. */
function noteRefreshFailure(): void {
  refreshFailures += 1
  lastRefreshFailureAt = Date.now()
}

/** Exported so the retry policy can be tested without a network. */
export const _refreshRetryDelay = refreshRetryDelay

export function resetCatalogForTests(next?: CatalogTable | null): void {
  table = next ?? null
  loadAttempted = next !== undefined
  refreshFailures = 0
  lastRefreshFailureAt = 0
  refreshInFlight = false
}

/**
 * Write the table so a concurrent reader can never see half of it.
 *
 * This file is ~300KB and every session writes the same path, so a plain
 * overwrite leaves a window where another session parses a truncated document.
 * loadTable() would treat that as no catalogue at all and quietly price
 * nothing until the next refresh. Writing to a private temporary file and
 * renaming it into place makes the swap atomic.
 *
 * The temporary name carries the pid so two sessions refreshing together
 * cannot corrupt each other's staging file.
 */
function writeTableAtomically(derived: CatalogTable): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  const staged = `${CACHE_FILE}.${process.pid}.tmp`
  const body = JSON.stringify(derived)
  try {
    writeFileSync(staged, body, 'utf8')
    renameSync(staged, CACHE_FILE)
  } catch {
    // Windows can refuse a rename over an open file. A direct write is the
    // lesser evil: the reader recovers on its next refresh, and the price
    // table holds nothing secret or unrecoverable.
    try {
      writeFileSync(CACHE_FILE, body, 'utf8')
    } catch {
      // Nothing to salvage; the in-memory table still serves this session.
    }
    try {
      if (existsSync(staged)) unlinkSync(staged)
    } catch {
      // A stray staging file is harmless.
    }
  }
}

let refreshInFlight = false
let refreshFailures = 0
let lastRefreshFailureAt = 0

/** 5min, 10min, 20min, 40min, then hourly. The payload is ~4MB. */
const RETRY_BASE_MS = 5 * 60_000
const RETRY_CAP_MS = 60 * 60_000

function refreshRetryDelay(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * Refresh the stored table if it is missing or a day old. Fire-and-forget:
 * returns immediately, never throws, and leaves the previous table untouched
 * when the fetch fails.
 *
 * Called on discovering a model with no known price, so a session that never
 * meets one issues no request at all.
 */
export function ensureModelPricesFresh(): void {
  if (isModelPricingDisabled()) return
  if (refreshInFlight) return

  let current = loadTable()
  if (!current) {
    // Another session may have written the table since this one first looked.
    // Re-reading a local file beats re-downloading four megabytes.
    loadAttempted = false
    current = loadTable()
  }

  const now = Date.now()
  const age = current ? now - current.fetchedAt : -1
  if (current && age >= 0 && age < TTL_MS) return

  // Without this, a table that cannot be fetched - offline, or the service
  // down - restarts a 4MB download on every unpriced message, because a null
  // table can never satisfy the freshness check above.
  const sinceFailure = now - lastRefreshFailureAt
  if (
    refreshFailures > 0 &&
    sinceFailure >= 0 &&
    sinceFailure < refreshRetryDelay(refreshFailures)
  ) {
    return
  }

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
      const derived = deriveTable(await response.json(), Date.now())
      if (Object.keys(derived.providers).length === 0) {
        noteRefreshFailure()
        return
      }

      refreshFailures = 0
      table = derived
      loadAttempted = true
      writeTableAtomically(derived)
    } catch {
      noteRefreshFailure()
      // Keep whatever is already stored. A refresh that fails must not turn
      // priced models into unpriced ones.
    } finally {
      refreshInFlight = false
    }
  })()
}

/**
 * Providers billing a flat subscription rather than per token.
 *
 * Their usage can still be valued at published rates, but the result is what
 * the same work would have cost on an API - not an amount owed. Callers show
 * it as an estimate so a subscriber is never told they were charged.
 */
const FLAT_FEE_PROVIDERS: ReadonlySet<string> = new Set([
  'antigravity',
  'kiro',
  'cursor',
  'cline',
  'clinepass',
  'copilot',
  'kilocode',
  'commandcode',
])

export function isFlatFeeProvider(tauProvider: string): boolean {
  return FLAT_FEE_PROVIDERS.has(tauProvider)
}

/**
 * Whether a provider runs on the user's own machine, and so can never incur
 * cost. Distinct from "absent from the catalogue": those may cost money that
 * simply is not published, whereas local inference genuinely costs nothing.
 */
export function isLocalProvider(tauProvider: string): boolean {
  return NEVER_PRICED.has(tauProvider)
}
