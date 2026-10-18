import isEqual from 'lodash-es/isEqual.js'
import { clearAllCaches } from './cacheUtils.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'
import {
  addMarketplaceSource,
  loadKnownMarketplacesConfig,
  saveMarketplaceToSettings,
} from './marketplaceManager.js'
import { parseMarketplaceInput } from './parseMarketplaceInput.js'
import type { MarketplaceSource } from './schemas.js'

/** Resolve a name or source without downloading or changing settings. */
export async function resolveInstallMarketplace(input: string): Promise<
  { name: string; source?: never } | { name?: never; source: MarketplaceSource }
> {
  const config = await loadKnownMarketplacesConfig()
  const known = Object.hasOwn(config, input) ? config[input] : undefined
  const source = known?.source ?? (await parseMarketplaceInput(input))
  if (!source) {
    throw new Error(`Marketplace "${input}" is not configured. Use a source such as owner/repo, a URL, or a local path.`)
  }
  if ('error' in source) throw new Error(source.error)
  if (!isSourceAllowedByPolicy(source)) {
    throw new Error(`Marketplace "${input}" is blocked by your organization's policy`)
  }
  if (known) return { name: input }
  for (const [name, entry] of Object.entries(config)) {
    if (isEqual(entry.source, source)) return { name }
  }
  return { source }
}

/** Called after the interactive add confirmation, or an explicit CLI install. */
export async function addInstallMarketplace(
  source: MarketplaceSource,
  onProgress?: (message: string) => void,
): Promise<string> {
  const { name, resolvedSource } = await addMarketplaceSource(source, onProgress)
  saveMarketplaceToSettings(name, { source: resolvedSource })
  clearAllCaches()
  return name
}
