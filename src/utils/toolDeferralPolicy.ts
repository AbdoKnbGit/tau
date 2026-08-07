import { providerSupportsAnthropicToolSearch } from './model/providerCapabilities.js'
import type { APIProvider } from './model/providers.js'
import { isNormalToolingMode, type PowerMode } from './powerMode.js'

export function shouldDisableToolDeferralForProvider(
  provider: APIProvider,
  powerMode: PowerMode,
): boolean {
  if (powerMode === 'cheap') return true
  if (provider === 'firstParty') return true
  return (
    isNormalToolingMode(powerMode) &&
    !providerSupportsAnthropicToolSearch(provider)
  )
}
