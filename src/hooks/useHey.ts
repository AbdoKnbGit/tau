import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  beginLiveVoiceRecording,
  endLiveVoiceRecording,
  getLiveVoiceSnapshot,
  subscribeLiveVoice,
} from '../services/liveVoice.js'
import { createPushToTalkHold } from '../voice/pushToTalkHold.js'

export type HeyState = ReturnType<typeof getLiveVoiceSnapshot>['phase']

export function useHey({ enabled, onError }: {
  enabled: boolean
  onError?: (message: string) => void
}) {
  // Audio levels update the small indicator, not the entire REPL tree.
  const state = useSyncExternalStore(
    subscribeLiveVoice,
    () => getLiveVoiceSnapshot().phase,
    () => 'off' as HeyState,
  )
  const errorRef = useRef(onError)
  errorRef.current = onError
  const holdRef = useRef<ReturnType<typeof createPushToTalkHold> | null>(null)

  useEffect(() => {
    const hold = createPushToTalkHold({
      begin: beginLiveVoiceRecording,
      end: endLiveVoiceRecording,
      onError: error => errorRef.current?.(
        error instanceof Error ? error.message : String(error),
      ),
    })
    holdRef.current = hold
    return () => {
      hold.dispose()
      if (holdRef.current === hold) holdRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled || state === 'off' || state === 'error' || state === 'connecting') {
      holdRef.current?.cancel()
    }
  }, [enabled, state])

  const handleKeyEvent = useCallback((fallbackMs?: number) => {
    const phase = getLiveVoiceSnapshot().phase
    if (!enabled || phase === 'off' || phase === 'error' || phase === 'connecting') return
    holdRef.current?.press(fallbackMs)
  }, [enabled])
  const cancelHold = useCallback(() => holdRef.current?.cancel(), [])
  const isHolding = useCallback(() => holdRef.current?.isHolding() ?? false, [])

  return { state, handleKeyEvent, cancelHold, isHolding }
}
