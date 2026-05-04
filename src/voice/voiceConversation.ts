import {
  deleteProviderKey,
  loadProviderKey,
  saveProviderKey,
} from '../services/api/auth/api_key_manager.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

export const VOICE_CONVERSATION_PROVIDER = 'voiceConversation' as const
export const VOICE_CONVERSATION_LABEL = 'Voice Conversation'
export const GEMINI_VOICE_KEY = 'gemini_voice'
export const GEMINI_PROVIDER_KEY = 'gemini'

export const DEFAULT_GEMINI_STT_MODEL = 'gemini-2.5-flash'
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts'
export const DEFAULT_GEMINI_TTS_VOICE = 'Kore'

export type VoiceConversationProvider = 'local' | 'gemini'
export type VoiceConversationKeySource =
  | 'gemini_voice'
  | 'gemini'
  | 'env'
  | null

export type VoiceConversationModel = {
  id: string
  name: string
  tags: readonly string[]
}

export const VOICE_CONVERSATION_MODELS: readonly VoiceConversationModel[] = [
  {
    id: 'gemini-2.5-flash-preview-tts',
    name: 'Gemini 2.5 Flash Preview TTS',
    tags: ['recommended', 'fast'],
  },
  {
    id: 'gemini-2.5-pro-preview-tts',
    name: 'Gemini 2.5 Pro Preview TTS',
    tags: ['pro'],
  },
]

const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY'
const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY'
const TAU_GEMINI_API_KEY_ENV = 'TAU_GEMINI_API_KEY'
const VOICE_PROVIDER_ENV = 'TAU_VOICE_PROVIDER'
const TTS_BACKEND_ENV = 'TAU_TTS_BACKEND'

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function normalizeMode(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/[_\s-]+/g, '')
}

export function getLegacyEnvVoiceProvider():
  | VoiceConversationProvider
  | undefined {
  const voiceProvider = normalizeMode(process.env[VOICE_PROVIDER_ENV])
  const ttsBackend = normalizeMode(process.env[TTS_BACKEND_ENV])
  if (
    voiceProvider === 'gemini' ||
    voiceProvider === 'google' ||
    ttsBackend === 'gemini' ||
    ttsBackend === 'google'
  ) {
    return 'gemini'
  }
  if (
    voiceProvider === 'local' ||
    voiceProvider === 'native' ||
    ttsBackend === 'local' ||
    ttsBackend === 'native'
  ) {
    return 'local'
  }
  return undefined
}

export function getSelectedVoiceProvider(): VoiceConversationProvider {
  const configured = getInitialSettings().heyVoiceProvider
  if (configured === 'gemini' || configured === 'local') return configured
  const legacy = getLegacyEnvVoiceProvider()
  if (legacy) return legacy
  return hasStoredVoiceConversationKey() ? 'gemini' : 'local'
}

export function setSelectedVoiceProvider(
  provider: VoiceConversationProvider,
): { error: Error | null } {
  const result = updateSettingsForSource('userSettings', {
    heyVoiceProvider: provider,
  })
  if (!result.error) {
    settingsChangeDetector.notifyChange('userSettings')
  }
  return result
}

export function getSelectedVoiceModel(): string {
  const configured = getInitialSettings().heyVoiceModel?.trim()
  return configured || DEFAULT_GEMINI_TTS_MODEL
}

export function getSelectedVoiceName(): string {
  const configured = getInitialSettings().heyVoiceName?.trim()
  return configured || DEFAULT_GEMINI_TTS_VOICE
}

export function setSelectedVoiceModel(
  modelId: string,
): { error: Error | null } {
  const result = updateSettingsForSource('userSettings', {
    heyVoiceProvider: 'gemini',
    heyVoiceModel: modelId,
  })
  if (!result.error) {
    settingsChangeDetector.notifyChange('userSettings')
  }
  return result
}

export function getVoiceConversationModelDisplayName(
  modelId: string,
): string | null {
  return (
    VOICE_CONVERSATION_MODELS.find(model => model.id === modelId)?.name ?? null
  )
}

export function isVoiceConversationModel(modelId: string): boolean {
  return VOICE_CONVERSATION_MODELS.some(model => model.id === modelId)
}

export function hasStoredVoiceConversationKey(): boolean {
  return Boolean(loadProviderKey(GEMINI_VOICE_KEY))
}

export function getVoiceConversationKeySource(): VoiceConversationKeySource {
  if (loadProviderKey(GEMINI_VOICE_KEY)) return 'gemini_voice'
  if (loadProviderKey(GEMINI_PROVIDER_KEY)) return 'gemini'
  if (
    getEnv(TAU_GEMINI_API_KEY_ENV) ||
    getEnv(GEMINI_API_KEY_ENV) ||
    getEnv(GOOGLE_API_KEY_ENV)
  ) {
    return 'env'
  }
  return null
}

export function getVoiceConversationApiKey(): string | undefined {
  return (
    loadProviderKey(GEMINI_VOICE_KEY) ??
    loadProviderKey(GEMINI_PROVIDER_KEY) ??
    getEnv(TAU_GEMINI_API_KEY_ENV) ??
    getEnv(GEMINI_API_KEY_ENV) ??
    getEnv(GOOGLE_API_KEY_ENV)
  )
}

export function hasVoiceConversationApiKey(): boolean {
  return Boolean(getVoiceConversationApiKey())
}

export function saveVoiceConversationApiKey(key: string): void {
  saveProviderKey(GEMINI_VOICE_KEY, key)
  process.env[TAU_GEMINI_API_KEY_ENV] = key
  process.env[GEMINI_API_KEY_ENV] = key
}

export function clearVoiceConversationCredentials(): void {
  const stored = loadProviderKey(GEMINI_VOICE_KEY)
  deleteProviderKey(GEMINI_VOICE_KEY)
  if (!stored || process.env[TAU_GEMINI_API_KEY_ENV] === stored) {
    delete process.env[TAU_GEMINI_API_KEY_ENV]
  }
  if (stored && process.env[GEMINI_API_KEY_ENV] === stored) {
    delete process.env[GEMINI_API_KEY_ENV]
  }
}

export function activateGeminiVoiceConversation(): { error: Error | null } {
  return setSelectedVoiceProvider('gemini')
}

export function deactivateVoiceConversation(): { error: Error | null } {
  return setSelectedVoiceProvider('local')
}

export function getVoiceConversationStatus(): {
  provider: VoiceConversationProvider
  keySource: VoiceConversationKeySource
  modelId: string
  modelName: string
  voiceName: string
} {
  const modelId = getSelectedVoiceModel()
  return {
    provider: getSelectedVoiceProvider(),
    keySource: getVoiceConversationKeySource(),
    modelId,
    modelName: getVoiceConversationModelDisplayName(modelId) ?? modelId,
    voiceName: getSelectedVoiceName(),
  }
}
