import { getInitialSettings } from '../utils/settings/settings.js'

// /hey is the Codex realtime conversation with hold-Space input.
// Native audio and OpenAI OAuth availability are checked when starting a session.
export function isHeyModeFeatureOn(): boolean {
  return true
}

export function isHeyModeEnabled(): boolean {
  if (!isHeyModeFeatureOn()) return false
  return getInitialSettings().heyEnabled === true
}
