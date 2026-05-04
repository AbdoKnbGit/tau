import { getInitialSettings } from '../utils/settings/settings.js'

// Hey-mode (the /hey conversational hold-Space flow) is intentionally available in
// external builds. Unlike /voice it does not require Anthropic OAuth or the
// claude.ai voice_stream feature: STT is local whisper.cpp and TTS is OS-native.
// Runtime prerequisites are checked by /hey before the setting is enabled.
export function isHeyModeFeatureOn(): boolean {
  return true
}

export function isHeyModeEnabled(): boolean {
  if (!isHeyModeFeatureOn()) return false
  return getInitialSettings().heyEnabled === true
}
