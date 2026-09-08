/** Voice IDs accepted by the Codex realtime service used by OMP /live. */
export const LIVE_VOICE_OPTIONS = [
  { value: 'arbor', label: 'Arbor' },
  { value: 'breeze', label: 'Breeze' },
  { value: 'cove', label: 'Cove' },
  { value: 'ember', label: 'Ember' },
  { value: 'juniper', label: 'Juniper' },
  { value: 'maple', label: 'Maple' },
  { value: 'sol', label: 'Sol' },
  { value: 'spruce', label: 'Spruce' },
  { value: 'vale', label: 'Vale' },
] as const

export type LiveVoice = (typeof LIVE_VOICE_OPTIONS)[number]['value']
export const LIVE_VOICE_VALUES = LIVE_VOICE_OPTIONS.map(option => option.value)
export const DEFAULT_LIVE_VOICE: LiveVoice = 'sol'

export function isLiveVoice(value: unknown): value is LiveVoice {
  return typeof value === 'string' && LIVE_VOICE_VALUES.some(voice => voice === value)
}

/** Old or unsupported voice settings safely migrate to the default on read. */
export function resolveLiveVoice(value: unknown): LiveVoice {
  return isLiveVoice(value) ? value : DEFAULT_LIVE_VOICE
}
