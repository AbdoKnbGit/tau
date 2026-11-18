/**
 * Reading a marketplace catalog (marketplace.json) the way Claude Code does:
 * every plugin entry is validated on its own, so an entry this build can't
 * use makes only that entry unavailable instead of failing the whole catalog.
 *
 * Unavailable entries are kept by name with a reason. An installed plugin
 * whose entry became unusable then says why, and removal detection does not
 * mistake it for a plugin the marketplace deleted.
 *
 * This module does no I/O, so every caller (URL fetch, git checkout, local
 * directory, zip cache) gets the same result for the same document.
 */
import { z } from 'zod/v4'
import { lazySchema } from '../lazySchema.js'
import {
  getKnownPluginSourceTypes,
  getPluginSourceVariant,
  PluginIdSchema,
  PluginMarketplaceEntrySchema,
  PluginMarketplaceSchema,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
} from './schemas.js'

export type UnavailableMarketplaceEntry = {
  /** The entry's name as written in the catalog. */
  name: string
  /** Why this build can't use the entry, in words a user can act on. */
  reason: string
}

export type ParsedPluginMarketplace = PluginMarketplace & {
  unavailablePlugins: UnavailableMarketplaceEntry[]
}

type CatalogIssue = { path: PropertyKey[]; message: string }

export type MarketplaceCatalogParseResult =
  | { success: true; data: ParsedPluginMarketplace }
  | { success: false; error: { issues: CatalogIssue[] } }

/** Top-level fields validated as usual; entries are validated one by one. */
const CatalogEnvelopeSchema = lazySchema(() =>
  PluginMarketplaceSchema().extend({ plugins: z.array(z.unknown()) }),
)

const MAX_REASON_ISSUES = 3

export function parseMarketplaceCatalog(
  input: unknown,
): MarketplaceCatalogParseResult {
  const envelope = CatalogEnvelopeSchema().safeParse(input)
  if (!envelope.success) {
    return { success: false, error: { issues: envelope.error.issues } }
  }

  const plugins: PluginMarketplaceEntry[] = []
  const unavailablePlugins: UnavailableMarketplaceEntry[] = []
  for (const raw of envelope.data.plugins) {
    const entry = PluginMarketplaceEntrySchema().safeParse(raw)
    if (entry.success) {
      plugins.push(entry.data)
      continue
    }
    // An entry without a usable name can't be installed or referred to.
    const name = readEntryName(raw)
    if (name !== undefined) {
      unavailablePlugins.push({
        name,
        reason: describeUnusableEntry(raw, entry.error.issues),
      })
    }
  }

  return {
    success: true,
    data: { ...envelope.data, plugins, unavailablePlugins },
  }
}

/** Adapter for readers that take a zod-like `safeParse`. */
export const MarketplaceCatalogParser = { safeParse: parseMarketplaceCatalog }

function readEntryName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const name = (raw as { name?: unknown }).name
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

function readSourceType(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = (raw as { source?: unknown }).source
  if (!source || typeof source !== 'object') return undefined
  const type = (source as { source?: unknown }).source
  return typeof type === 'string' ? type : undefined
}

function describeUnusableEntry(raw: unknown, issues: CatalogIssue[]): string {
  const sourceType = readSourceType(raw)
  if (sourceType !== undefined && !getKnownPluginSourceTypes().has(sourceType)) {
    return `its source type "${sourceType}" isn't supported by this version of Tau`
  }
  // A union reports a bad source as "Invalid input"; its own variant says why.
  const variant = sourceType ? getPluginSourceVariant(sourceType) : undefined
  const sourceIssues = variant?.safeParse((raw as { source: unknown }).source)
  if (sourceIssues && !sourceIssues.success) {
    issues = [
      ...sourceIssues.error.issues.map(issue => ({
        path: ['source', ...issue.path],
        message: issue.message,
      })),
      ...issues.filter(issue => issue.path[0] !== 'source'),
    ]
  }
  const shown = issues
    .slice(0, MAX_REASON_ISSUES)
    .map(issue =>
      issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: ${issue.message}`
        : issue.message,
    )
  if (issues.length > MAX_REASON_ISSUES) shown.push('…')
  return `its marketplace entry is invalid (${shown.join('; ')})`
}

type CatalogView = Pick<PluginMarketplace, 'plugins' | 'renames'> & {
  unavailablePlugins?: readonly UnavailableMarketplaceEntry[]
}

/** Names the catalog lists, usable or not. */
export function getCatalogEntryNames(catalog: CatalogView): Set<string> {
  const names = new Set(catalog.plugins.map(p => p.name))
  for (const entry of catalog.unavailablePlugins ?? []) names.add(entry.name)
  return names
}

export function findUnavailableEntry(
  catalog: CatalogView,
  name: string,
): UnavailableMarketplaceEntry | undefined {
  if (catalog.plugins.some(p => p.name === name)) return undefined
  return catalog.unavailablePlugins?.find(entry => entry.name === name)
}

export type PluginRenameResolution =
  | { kind: 'renamed'; to: string }
  | { kind: 'removed' }
  | { kind: 'unresolved'; reason: string }

/**
 * Follow the catalog's `renames` map from `name` to the entry that replaces
 * it. `names` are the names the chain may end on (default: every entry the
 * catalog lists). Returns undefined when `renames` has no entry for `name`.
 */
export function followRenameChain(
  renames: Readonly<Record<string, string | null>> | undefined,
  name: string,
  names: ReadonlySet<string>,
): PluginRenameResolution | undefined {
  if (!renames || !Object.hasOwn(renames, name)) return undefined
  const visited = new Set<string>([name])
  let current = name
  for (;;) {
    const next = renames[current]
    if (next === null) return { kind: 'removed' }
    if (typeof next !== 'string' || next === '') {
      return { kind: 'unresolved', reason: `"${current}" maps to an empty name` }
    }
    if (names.has(next)) return { kind: 'renamed', to: next }
    if (visited.has(next)) {
      return {
        kind: 'unresolved',
        reason: `the chain from "${name}" loops back to "${next}"`,
      }
    }
    if (!Object.hasOwn(renames, next)) {
      return {
        kind: 'unresolved',
        reason: `"${next}" is neither a plugin in the catalog nor a key in renames`,
      }
    }
    visited.add(next)
    current = next
  }
}

/**
 * What the catalog says about a plugin name it no longer lists. A name that
 * is still listed is never renamed, whatever `renames` says about it.
 */
export function resolvePluginRename(
  catalog: CatalogView,
  name: string,
): PluginRenameResolution | undefined {
  const names = getCatalogEntryNames(catalog)
  if (names.has(name)) return undefined
  return followRenameChain(catalog.renames, name, names)
}

/**
 * A sentence explaining why `name` can't be used from this catalog, or
 * undefined when the catalog simply doesn't mention it.
 */
export function explainMissingCatalogEntry(
  catalog: CatalogView,
  name: string,
  marketplaceName: string,
): string | undefined {
  const unavailable = findUnavailableEntry(catalog, name)
  if (unavailable) {
    return `Plugin "${name}" in marketplace "${marketplaceName}" can't be used: ${unavailable.reason}`
  }
  const rename = resolvePluginRename(catalog, name)
  if (!rename) return undefined
  switch (rename.kind) {
    case 'renamed':
      return `Plugin "${name}" was renamed to "${rename.to}" in marketplace "${marketplaceName}"`
    case 'removed':
      return `Plugin "${name}" was removed from marketplace "${marketplaceName}"`
    case 'unresolved':
      return `Plugin "${name}" is listed in the renames of marketplace "${marketplaceName}", but the chain does not resolve: ${rename.reason}`
  }
}

/** Issues `tau plugin validate` reports for a catalog's `renames` map. */
export function validateRenames(
  renames: Readonly<Record<string, string | null>>,
  pluginNames: ReadonlySet<string>,
): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = []
  for (const from of Object.keys(renames)) {
    const target = renames[from]
    if (typeof target === 'string' && !PluginIdSchema().safeParse(`${target}@placeholder`).success) {
      issues.push({
        path: `renames.${from}`,
        message: `target "${target}" is not a valid plugin name`,
      })
      continue
    }
    const resolution = followRenameChain(renames, from, pluginNames)
    if (resolution?.kind === 'unresolved') {
      issues.push({
        path: `renames.${from}`,
        message: `chain does not resolve (${resolution.reason}) — target must be a name in plugins[], a key in renames, or null`,
      })
    }
  }
  return issues
}
