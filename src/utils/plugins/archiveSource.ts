/**
 * The `archive` plugin source: a zip downloaded over HTTPS (limits in
 * marketplaceDownload.ts), refused when it doesn't match the entry's pinned
 * SHA-256, and extracted with the same size, path and link checks as every
 * other plugin zip. The plugin root may be the top of the zip or one
 * directory down.
 *
 * Request headers: the marketplace url source's own headers go along when the
 * archive is on that URL's origin; the entry's `headers` are laid over them.
 * A redirect to another origin carries none of them (marketplaceDownload.ts).
 *
 * This module imports only Node built-ins: callers pass the marketplace
 * source and the zip extractor in, so it stays testable on its own.
 */
import { createHash, randomBytes } from 'crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  MarketplaceSource,
  PluginMarketplaceEntry,
  PluginSource,
} from './schemas.js'

export type ArchivePluginSource = Extract<PluginSource, { source: 'archive' }>

export function isArchiveSource(
  source: PluginSource,
): source is ArchivePluginSource {
  return typeof source === 'object' && source.source === 'archive'
}

// Names a catalog entry may not send with its archive download: they route a
// request or claim a client identity instead of authenticating it.
// Authorization and other authentication names pass through.
const ROUTING_OR_IDENTITY_HEADERS = new Set([
  'host',
  'cookie',
  'forwarded',
  'via',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-cluster-client-ip',
])
const ROUTING_OR_IDENTITY_PREFIXES = ['x-forwarded-', 'proxy-']

/** Whether a marketplace entry may set this request header. */
export function isCatalogSettableHeader(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return (
    !ROUTING_OR_IDENTITY_HEADERS.has(lower) &&
    !ROUTING_OR_IDENTITY_PREFIXES.some(prefix => lower.startsWith(prefix))
  )
}

function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase()
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lower) delete headers[existing]
  }
  headers[name] = value
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** Whether the marketplace's own headers go with this archive download. */
export function sharesMarketplaceOrigin(
  entry: PluginMarketplaceEntry,
  marketplaceSource: MarketplaceSource | undefined,
): marketplaceSource is Extract<MarketplaceSource, { source: 'url' }> {
  return (
    isArchiveSource(entry.source) &&
    marketplaceSource?.source === 'url' &&
    sameOrigin(marketplaceSource.url, entry.source.url)
  )
}

/**
 * The headers an `archive` entry's download carries, and the entry header
 * names that were dropped. Layers, lowest first: the marketplace url source's
 * headers (its static ones, or those with its helper's output laid over them,
 * as `helperHeaders.marketplace`) when the archive is on its origin; the
 * entry's `headers`; what the entry's headersHelper printed. Throws when the
 * entry names a headersHelper whose output wasn't supplied: downloading
 * without the credential it mints can only fail or fetch the wrong file.
 */
export function resolveArchiveHeaders(
  entry: PluginMarketplaceEntry,
  marketplaceSource: MarketplaceSource | undefined,
  helperHeaders: {
    marketplace?: Record<string, string>
    entry?: Record<string, string>
  } = {},
): { headers: Record<string, string>; dropped: string[] } {
  const headers: Record<string, string> = {}
  const dropped: string[] = []
  if (!isArchiveSource(entry.source)) return { headers, dropped }
  if (entry.headersHelper && !helperHeaders.entry) {
    throw new Error(
      `Plugin "${entry.name}" fetches its archive through a headersHelper command that was not run`,
    )
  }

  if (sharesMarketplaceOrigin(entry, marketplaceSource)) {
    const marketplaceHeaders =
      helperHeaders.marketplace ?? marketplaceSource.headers ?? {}
    for (const [name, value] of Object.entries(marketplaceHeaders)) {
      setHeader(headers, name, value)
    }
  }
  for (const layer of [entry.headers ?? {}, helperHeaders.entry ?? {}]) {
    for (const [name, value] of Object.entries(layer)) {
      if (isCatalogSettableHeader(name)) setHeader(headers, name, value)
      else if (!dropped.includes(name)) dropped.push(name)
    }
  }
  return { headers, dropped }
}

// What a plugin directory holds at its top level (Claude Code uses the same
// test for a command source's output).
const PLUGIN_CONTENT_MARKERS = [
  '.claude-plugin',
  'skills',
  'commands',
  'agents',
  'hooks',
  'output-styles',
  '.mcp.json',
  '.lsp.json',
]

// Files archive tools add beside the real content.
const ARCHIVE_NOISE = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db'])

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function hasPluginContent(dir: string): Promise<boolean> {
  for (const marker of PLUGIN_CONTENT_MARKERS) {
    if (await exists(join(dir, marker))) return true
  }
  return false
}

/** The plugin root inside an extracted zip: the top, or its one directory. */
export async function findArchivePluginRoot(dir: string): Promise<string> {
  if (await hasPluginContent(dir)) return dir
  const entries = (await readdir(dir, { withFileTypes: true })).filter(
    entry => !ARCHIVE_NOISE.has(entry.name),
  )
  if (entries.length === 1 && entries[0]!.isDirectory()) {
    return join(dir, entries[0]!.name)
  }
  return dir
}

/** Extracts the zip at `zipPath` into `targetDir`, enforcing its limits. */
export type ZipExtractor = (zipPath: string, targetDir: string) => Promise<void>

/**
 * Verify and extract a downloaded archive into `targetPath`, which must not
 * exist yet. Work happens in a staging directory beside it, so a failure
 * leaves nothing at `targetPath`. Returns the archive's SHA-256.
 */
export async function installArchiveBytes(
  bytes: Uint8Array,
  source: ArchivePluginSource,
  targetPath: string,
  extract: ZipExtractor,
): Promise<{ sha256: string }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const expected = source.sha256?.toLowerCase()
  if (expected && expected !== sha256) {
    throw new Error(
      `Plugin archive integrity check failed for ${source.url}: expected sha256 ${expected}, got ${sha256}. ` +
        'The archive was not installed. Verify the sha256 in the marketplace entry, or that the URL serves the intended file.',
    )
  }

  const staging = `${targetPath}.staging-${randomBytes(4).toString('hex')}`
  try {
    await mkdir(staging, { recursive: true })
    const zipPath = join(staging, 'plugin.zip')
    const contents = join(staging, 'contents')
    await writeFile(zipPath, bytes)
    await extract(zipPath, contents)
    await rename(await findArchivePluginRoot(contents), targetPath)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { sha256 }
}
