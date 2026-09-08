import type { LocalCommandCall } from '../../types/command.js'
import { startLiveVoice, stopLiveVoice } from '../../services/liveVoice.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const call: LocalCommandCall = async () => {
  try {
    await startLiveVoice()
    const result = updateSettingsForSource('userSettings', { heyEnabled: true })
    if (result.error) {
      await stopLiveVoice()
      return { type: 'text', value: 'Voice stopped because Tau could not save hey mode. Check your settings file for syntax errors.' }
    }
    settingsChangeDetector.notifyChange('userSettings')
    return { type: 'text', value: 'Voice ready. Hold Space at an empty prompt to talk; release to stop recording. A red ● REC appears above the prompt while the microphone is active. /bye ends the call.' }
  } catch (error) {
    return { type: 'text', value: `Could not start voice: ${error instanceof Error ? error.message : String(error)}` }
  }
}
