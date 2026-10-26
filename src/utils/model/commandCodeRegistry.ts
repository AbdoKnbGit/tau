/**
 * Command Code's own model catalog: which models take images, how large their
 * windows are, what they are called and what they cost, long-context tiers
 * included.
 *
 * The source is the catalog Command Code's CLI reads,
 * `/provider/v1/models?view=client`: the rows /models lists plus the hidden
 * ones, each with its pricing, input modalities and aliases. Two copies answer,
 * field by field:
 *
 *   live     the rows listModels last fetched, kept on disk so the next
 *            session starts from them
 *   bundled  commandCodeRegistrySeed.json, the same endpoint as of the build
 *            (scripts/refresh-commandcode-models.mjs), for a machine that has
 *            not fetched yet
 *
 * Exact ids and Command Code's own aliases only. Nearest-name matching is what
 * billed Kimi K3.1 Pro at Kimi K3's rate and labelled it "Kimi K3": a model
 * the catalog does not list is unknown, not its neighbour. A dated snapshot
 * (`-20270101`) counts as its base model.
 */

import { readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  rowToPrice,
  type CatalogPrice,
  type CatalogPriceRow,
  type CatalogTierRow,
} from '../modelPricingCatalog.js'
import bundled from './commandCodeRegistrySeed.json'

type Entry = {
  name?: string
  image?: boolean
  context?: number
  price?: CatalogPriceRow
}

type Rates = [input: number, output: number, cacheRead: number | null, cacheWrite: number]

const STORE_VERSION = 1

const FREE: CatalogPriceRow = [0, 0, 0, 0]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

/**
 * One rate set. An unlisted cache write costs 0, which is how Command Code's
 * CLI prices it, not the input rate.
 */
function toRates(rates: Record<string, unknown>): Rates | undefined {
  const input = amount(rates.inputCost)
  const output = amount(rates.outputCost)
  if (input === undefined || output === undefined) return undefined
  return [input, output, amount(rates.cacheReadCost) ?? null, amount(rates.cacheWriteCost) ?? 0]
}

/**
 * A `pricing` block as a catalog price row. Command Code's tiers name the
 * largest prompt each one covers and override the flat rates; catalog tiers
 * name the size a rate starts above. So tier i starts where tier i-1 stops,
 * and past a last tier that has a bound the flat rate applies again. A tier
 * list out of order, or open-ended before its end, prices flat, as the CLI
 * does.
 */
function toPriceRow(pricing: unknown): CatalogPriceRow | undefined {
  if (!isRecord(pricing)) return undefined
  const flat = toRates(pricing)
  if (!flat) return undefined
  const listed = Array.isArray(pricing.contextTiers) ? pricing.contextTiers : []
  let base = flat
  let start = 0
  const tiers: CatalogTierRow[] = []
  for (const [index, tier] of listed.entries()) {
    const rates = isRecord(tier) && isRecord(tier.rates)
      ? toRates({ ...pricing, ...tier.rates })
      : undefined
    const bound = isRecord(tier) ? tier.maxContext : undefined
    const upTo = amount(bound)
    const ordered = bound === undefined
      ? index === listed.length - 1
      : upTo !== undefined && upTo > start
    if (!rates || !ordered) return flat
    if (index === 0) base = rates
    else tiers.push([start, ...rates])
    if (upTo !== undefined) start = upTo
  }
  const last = listed.at(-1)
  if (isRecord(last) && last.maxContext !== undefined) tiers.push([start, ...flat])
  return tiers.length > 0 ? [...base, tiers] : base
}

function toEntry(row: Record<string, unknown>): Entry {
  const context = amount(row.context_length)
  const free = isRecord(row.display) && row.display.badge === 'free'
  return {
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined,
    image: Array.isArray(row.inputModalities)
      ? row.inputModalities.includes('image')
      : undefined,
    context: context !== undefined && context > 0 ? context : undefined,
    // A free model may list no pricing at all; its badge is the price.
    price: toPriceRow(row.pricing) ?? (free ? FREE : undefined),
  }
}

function keyOf(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase() : ''
}

function index(rows: readonly unknown[]): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  const records = rows.filter(isRecord)
  for (const row of records) {
    const key = keyOf(row.id)
    if (key) entries.set(key, toEntry(row))
  }
  // An alias never shadows a model listed under that id.
  for (const row of records) {
    const entry = entries.get(keyOf(row.id))
    if (!entry || !Array.isArray(row.aliases)) continue
    for (const alias of row.aliases) {
      const key = keyOf(alias)
      if (key && !entries.has(key)) entries.set(key, entry)
    }
  }
  return entries
}

function storePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'commandcode-models.json')
}

let bundledIndex: Map<string, Entry> | undefined
// Keyed on the store path so tests that set CLAUDE_CONFIG_DIR get a fresh read.
let live: { path: string, entries: Map<string, Entry> } | undefined

function liveIndex(): Map<string, Entry> {
  const path = storePath()
  if (live?.path === path) return live.entries
  let rows: unknown[] = []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (isRecord(parsed) && parsed.version === STORE_VERSION && Array.isArray(parsed.data)) {
      rows = parsed.data
    }
  } catch {
    // Nothing fetched yet, or an unreadable copy: the bundled one answers.
  }
  live = { path, entries: index(rows) }
  return live.entries
}

function lookup<K extends keyof Entry>(modelId: string, field: K): Entry[K] | undefined {
  const id = modelId.trim().toLowerCase()
  if (!id) return undefined
  bundledIndex ??= index(bundled.data)
  const undated = id.replace(/[-@]\d{8}$/, '')
  for (const key of undated === id ? [id] : [id, undated]) {
    const value = liveIndex().get(key)?.[field] ?? bundledIndex.get(key)?.[field]
    if (value !== undefined) return value
  }
  return undefined
}

/** Whether Command Code lists the model as taking image input; undefined when it does not list it. */
export function commandCodeRegistryImageInput(modelId: string): boolean | undefined {
  return lookup(modelId, 'image')
}

export function commandCodeRegistryContextWindow(modelId: string): number | undefined {
  return lookup(modelId, 'context')
}

export function commandCodeRegistryName(modelId: string): string | undefined {
  return lookup(modelId, 'name')
}

/**
 * Command Code's rate for a request whose whole prompt, cached tokens
 * included, was `contextTokens` long, or null when it lists no price.
 */
export function commandCodeRegistryPrice(
  modelId: string,
  contextTokens = 0,
): CatalogPrice | null {
  const row = lookup(modelId, 'price')
  return row ? rowToPrice(row, contextTokens) : null
}

/** The fields this module reads, so the copy on disk stays small. */
function trimRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    ...(typeof row.name === 'string' ? { name: row.name } : {}),
    ...(Array.isArray(row.aliases) && row.aliases.length > 0 ? { aliases: row.aliases } : {}),
    context_length: row.context_length,
    inputModalities: row.inputModalities,
    ...(row.pricing !== undefined ? { pricing: row.pricing } : {}),
    ...(isRecord(row.display) && row.display.badge ? { display: { badge: row.display.badge } } : {}),
  }
}

// Saves run one after another, so the newest catalog is the one left on disk.
let saving: Promise<void> = Promise.resolve()

/**
 * Adopt the rows of a client-catalog fetch, and keep them for later sessions.
 * A response with no usable row changes nothing. A write that fails leaves
 * this session on the rows it already holds.
 */
export function recordCommandCodeCatalog(rows: readonly unknown[]): void {
  const kept = rows.filter(isRecord).filter(row => keyOf(row.id)).map(trimRow)
  const entries = index(kept)
  if (entries.size === 0) return
  const path = storePath()
  live = { path, entries }
  saving = saving.then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true })
      const pending = `${path}.${process.pid}.tmp`
      await writeFile(pending, JSON.stringify({ version: STORE_VERSION, data: kept }), 'utf8')
      await rename(pending, path)
    } catch {
      // Best effort.
    }
  })
}

/** Test seam: forget the live copy so the next lookup reads disk again. */
export function _resetCommandCodeRegistryForTest(): void {
  live = undefined
}
