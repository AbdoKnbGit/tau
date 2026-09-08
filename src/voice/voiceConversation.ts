import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import {
  LIVE_VOICE_OPTIONS,
  isLiveVoice,
  resolveLiveVoice,
  type LiveVoice,
} from './liveVoices.js'

export {
  DEFAULT_LIVE_VOICE,
  LIVE_VOICE_OPTIONS,
  LIVE_VOICE_VALUES,
  isLiveVoice,
  resolveLiveVoice,
  type LiveVoice,
} from './liveVoices.js'

// This catalogue row selects a voice; it never changes the coding provider/model.
export const VOICE_CONVERSATION_PROVIDER = 'voiceConversation' as const
export const VOICE_CONVERSATION_LABEL = 'Codex Voice'
export const LIVE_VOICE_LOGIN_HINT =
  'Run /login openai and choose ChatGPT OAuth, then run /hey. Voice requires Codex voice access.'

export function getSelectedLiveVoice(): LiveVoice {
  // Older settings may contain a Gemini voice such as Kore. Ignore retired
  // provider/model settings and resolve the voice without mutating credentials.
  return resolveLiveVoice(getInitialSettings().heyVoiceName)
}

export function setSelectedLiveVoice(voice: string): { error: Error | null } {
  if (!isLiveVoice(voice)) {
    return { error: new Error(`Unsupported Codex voice: ${voice}`) }
  }
  const result = updateSettingsForSource('userSettings', { heyVoiceName: voice })
  if (!result.error) settingsChangeDetector.notifyChange('userSettings')
  return result
}

export function getLiveVoiceDisplayName(voice: string): string | null {
  return LIVE_VOICE_OPTIONS.find(option => option.value === voice)?.label ?? null
}
