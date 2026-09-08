import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import { getLiveVoiceSnapshot, subscribeLiveVoice } from '../services/liveVoice.js'
import { getRecordingIndicator } from '../voice/recordingIndicator.js'

/** Immediately above PromptInput in fullscreen and scrollback layouts. */
export function LiveVoiceIndicator(): React.ReactNode {
  const snapshot = useSyncExternalStore(subscribeLiveVoice, getLiveVoiceSnapshot, getLiveVoiceSnapshot)
  const indicator = getRecordingIndicator(snapshot.phase, snapshot.error)
  if (!indicator) return null
  const meter = snapshot.phase === 'recording'
    ? ' ' + '▮'.repeat(Math.max(1, Math.min(8, Math.round(snapshot.inputLevel * 8))))
    : ''
  return <Box noSelect={true} flexDirection="row" paddingX={1}>
    <Text color={indicator.color} bold>{indicator.label}{meter}</Text>
    <Text dimColor={true}> · {indicator.hint}</Text>
  </Box>
}
