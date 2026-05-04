import { logEvent } from '../../services/analytics/index.js'
import { stopSpeaking } from '../../services/ttsLocal.js'
import type { LocalCommandCall } from '../../types/command.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

export const call: LocalCommandCall = async () => {
  if (getInitialSettings().heyEnabled !== true) {
    stopSpeaking()
    return {
      type: 'text' as const,
      value: 'Hey mode is already disabled.',
    }
  }

  const result = updateSettingsForSource('userSettings', {
    heyEnabled: false,
  })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }

  stopSpeaking()
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_hey_toggled', { enabled: false })
  return {
    type: 'text' as const,
    value: 'Hey mode disabled. Voice conversation is off.',
  }
}
