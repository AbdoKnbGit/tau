import type { APIProvider } from '../../../utils/model/providers.js'

type NativeLaneReadinessResolver = (provider: APIProvider) => boolean

// Dependency-leaf bridge: toolSearch cannot import providerShim directly
// because providerShim initializes lanes whose tool modules import toolSearch.
// providerShim installs its authoritative synchronous resolver at module load.
let readinessResolver: NativeLaneReadinessResolver | null = null
const eagerLatchedProviders = new Set<APIProvider>()

export function installNativeLaneReadinessResolver(
  resolver: NativeLaneReadinessResolver,
): void {
  readinessResolver = resolver
}

export function providerWillUseNativeLane(provider: APIProvider): boolean {
  if (eagerLatchedProviders.has(provider)) return false
  const ready = readinessResolver?.(provider) ?? false
  if (!ready) eagerLatchedProviders.add(provider)
  return ready
}

export function _resetNativeLaneReadinessForTest(): void {
  readinessResolver = null
  eagerLatchedProviders.clear()
}
