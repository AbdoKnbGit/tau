import { useEffect } from 'react'
import { applyPowerMode } from '../commands/mode/mode.js'
import { useNotifications } from '../context/notifications.js'
import { useSetAppState } from '../state/AppState.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import {
  type APIProvider,
  getAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  subscribeActiveProviderChange,
} from '../utils/model/providers.js'
import {
  getPowerModeFromSettings,
  providerSupportsCheapMode,
} from '../utils/powerMode.js'
import { getInitialSettings } from '../utils/settings/settings.js'

/**
 * Keeps the session out of cheap mode while its provider has none
 * (Antigravity). Checks once on mount, which covers a launch on Antigravity
 * with cheap saved, then after every provider switch, whichever path made it:
 * /models, favorites, /login, /fallback, surf. Leaving cheap is exactly
 * `/mode normal` — persisted, pinned, caches dropped, LSP started — plus a
 * notice saying why.
 */
export function useProviderPowerModeGuard(): void {
  const setAppState = useSetAppState()
  const { addNotification } = useNotifications()

  useEffect(() => {
    function leaveCheapModeIfUnsupported(provider: APIProvider): void {
      if (providerSupportsCheapMode(provider)) return
      if (getPowerModeFromSettings(getInitialSettings()) !== 'cheap') return
      // Provider switches call this synchronously from setActiveProvider, so
      // nothing here may throw into the switch that triggered it.
      try {
        const name = PROVIDER_DISPLAY_NAMES[provider]
        const { error } = applyPowerMode('normal', setAppState)
        addNotification({
          key: 'provider-power-mode-guard',
          text: error
            ? `${name} has no cheap mode. ${error}`
            : `${name} has no cheap mode — switched to normal mode`,
          priority: 'high',
        })
      } catch (error) {
        logError(toError(error))
      }
    }

    leaveCheapModeIfUnsupported(getAPIProvider())
    return subscribeActiveProviderChange(leaveCheapModeIfUnsupported)
  }, [setAppState, addNotification])
}
