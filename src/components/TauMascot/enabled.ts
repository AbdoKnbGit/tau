import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

// The mascot is opt-in. The choice lives in the global config, and this tiny
// store lets the band appear or leave the moment /mascot or /config flips it.
const listeners = new Set<() => void>()

export function isMascotEnabled(): boolean {
  return getGlobalConfig().mascotEnabled === true
}

export function setMascotEnabled(enabled: boolean): void {
  if (isMascotEnabled() !== enabled) {
    saveGlobalConfig(current => ({ ...current, mascotEnabled: enabled }))
  }
  for (const listener of listeners) listener()
}

export function subscribeMascotEnabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
