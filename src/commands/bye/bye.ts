import type { LocalCommandCall } from '../../types/command.js'
import { stopLiveVoice } from '../../services/liveVoice.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const call: LocalCommandCall = async () => {
  // Stop first, even when settings are damaged or a connection is in flight.
  await stopLiveVoice()
  const result = updateSettingsForSource('userSettings', { heyEnabled: false })
  if (result.error) return { type: 'text', value: 'Voice and microphone stopped. Tau could not save the preference; check your settings file for syntax errors.' }
  settingsChangeDetector.notifyChange('userSettings')
  return { type: 'text', value: 'Voice off. Microphone and playback stopped.' }
}
