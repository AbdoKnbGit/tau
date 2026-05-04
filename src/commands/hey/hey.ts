import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isHeyModeFeatureOn } from '../../voice/heyModeEnabled.js'
import {
  HEY_TEXT_ONLY_ENV,
  getHeyTtsDisabledEnvName,
  isHeyTtsEnabled,
} from '../../voice/heyTtsEnabled.js'
import {
  getSelectedVoiceModel,
  getSelectedVoiceProvider,
  getVoiceConversationModelDisplayName,
  hasVoiceConversationApiKey,
} from '../../voice/voiceConversation.js'

export const call: LocalCommandCall = async () => {
  if (!isHeyModeFeatureOn()) {
    return {
      type: 'text' as const,
      value: 'Hey mode is not available in this build.',
    }
  }

  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.heyEnabled === true

  // /hey is an explicit activator. /bye disables the mode.
  if (isCurrentlyEnabled) {
    return {
      type: 'text' as const,
      value: 'Hey mode is already enabled. Hold Space to talk; use /bye to turn it off.',
    }
  }

  // Verify mic and speech-to-text before saving so the user gets a
  // clear error up front rather than mid-conversation.
  const { checkRecordingAvailability, checkVoiceDependencies } = await import(
    '../../services/voice.js'
  )
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? 'Audio recording is not available in this environment.',
    }
  }
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `\nInstall audio recording tools: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording (or use the native audio backend).'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  const geminiVoice = await import('../../services/geminiVoice.js')
  const geminiSelected = getSelectedVoiceProvider() === 'gemini'
  const geminiAvailable = geminiSelected
    ? geminiVoice.checkGeminiVoiceAvailable()
    : { available: false, reason: null }

  const { checkWhisperAvailable } = await import('../../services/whisperLocal.js')
  const whisper = checkWhisperAvailable()
  if (!whisper.available && !geminiAvailable.available) {
    const geminiHint =
      geminiSelected && geminiAvailable.reason
        ? `\n\nGemini voice is selected, but unavailable: ${geminiAvailable.reason}`
        : ''
    return {
      type: 'text' as const,
      value: `Hey mode needs whisper.cpp for local speech-to-text.${geminiHint}\n\n${whisper.reason ?? ''}`,
    }
  }

  const ttsEnabled = isHeyTtsEnabled()
  const tts = ttsEnabled
    ? (await import('../../services/ttsLocal.js')).checkTtsAvailable()
    : { available: false, backend: null, reason: null }
  // Voice replies are the point of /hey, so they are on by default. Keep an
  // explicit env opt-out for terminals where OS TTS is unwanted.
  const disabledEnvName = getHeyTtsDisabledEnvName()
  const ttsNote = ttsEnabled
    ? tts.available
      ? `\nVoice replies are enabled${tts.backend === 'gemini' ? ' with Gemini TTS' : ''}.`
      : `\nVoice replies are enabled, but TTS is unavailable (${tts.reason ?? 'unknown'}). Replies will be text-only.`
    : `\nVoice replies are disabled by ${disabledEnvName ?? HEY_TEXT_ONLY_ENV}=1. Remove it to speak replies.`
  const sttNote =
    geminiAvailable.available && geminiSelected
      ? whisper.available
        ? '\nGemini transcription is enabled; local Whisper is available as fallback.'
        : '\nGemini transcription is enabled; local Whisper fallback is not installed.'
      : ''
  const voiceModelId = getSelectedVoiceModel()
  const voiceModel =
    getVoiceConversationModelDisplayName(voiceModelId) ?? voiceModelId
  const voiceNote =
    geminiSelected
      ? hasVoiceConversationApiKey()
        ? `\nVoice conversation model: ${voiceModel}.`
        : '\nGemini voice is selected, but no key is saved yet. Run /login and choose Gemini Voice; local fallback will be used for now.'
      : '\nVoice conversation is using local speech tools.'

  const result = updateSettingsForSource('userSettings', {
    heyEnabled: true,
    heyVoiceProvider: geminiSelected ? 'gemini' : 'local',
  })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_hey_toggled', {
    enabled: true,
    ttsAvailable: ttsEnabled && tts.available,
  })

  return {
    type: 'text' as const,
    value: `Hey mode enabled. Hold Space to talk; release to send. Tau will show "Heard: ..." before sending.${ttsNote}${sttNote}${voiceNote}`,
  }
}
