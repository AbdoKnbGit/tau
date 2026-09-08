import { createRequire } from 'node:module'
import { nativeVoiceLoadPath } from '../../scripts/native-voice.mjs'
import { getRunningPackageRoot } from '../utils/installIntegrity.js'
import type { NativeVoiceModule } from './liveTransport.js'

let native: NativeVoiceModule | undefined
export function loadNativeVoice(): NativeVoiceModule {
  if (native) return native
  const root = getRunningPackageRoot()
  if (!root) throw new Error('Cannot locate Tau audio. Launch with tau and retry /hey.')
  const loaded = createRequire(import.meta.url)(nativeVoiceLoadPath(root)) as NativeVoiceModule & { voiceAbiVersion?: () => number }
  if (typeof loaded.voiceAbiVersion !== 'function' || loaded.voiceAbiVersion() !== 1
      || typeof loaded.AudioCapture !== 'function' || typeof loaded.LiveWebRtcPeer !== 'function') {
    throw new Error('Tau audio is incompatible. Reinstall or update Tau.')
  }
  native = loaded
  return native
}
