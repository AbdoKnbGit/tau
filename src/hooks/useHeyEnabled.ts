import { useAppState } from '../state/AppState.js'
import { isHeyModeFeatureOn } from '../voice/heyModeEnabled.js'

/**
 * Reactive selector for hey-mode (the /hey conversational hold-Space flow).
 * Runtime connectivity and Codex authentication are checked by /hey. This
 * selector represents the user's mode choice; it never opens the microphone.
 *
 * Reads from AppState so toggles via /hey re-render dependent components
 * without needing a manual settingsChangeDetector subscription.
 */
export function useHeyEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.heyEnabled === true)
  return isHeyModeFeatureOn() && userIntent
}
