import { useAppState } from '../state/AppState.js'
import { isHeyModeFeatureOn } from '../voice/heyModeEnabled.js'

/**
 * Reactive selector for hey-mode (the /hey conversational hold-Space flow).
 * Unlike voice, hey-mode has no auth or GrowthBook gate — STT is local
 * (whisper.cpp) and TTS is OS-native — so this is just user intent +
 * feature flag.
 *
 * Reads from AppState so toggles via /hey re-render dependent components
 * without needing a manual settingsChangeDetector subscription.
 */
export function useHeyEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.heyEnabled === true)
  return isHeyModeFeatureOn() && userIntent
}
