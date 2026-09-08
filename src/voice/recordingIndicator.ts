type VoicePhase = ReturnType<typeof import('../services/liveVoice.js').getLiveVoiceSnapshot>['phase']

/** Derive recording display from confirmed capture, never merely a keypress. */
export function getRecordingIndicator(phase: VoicePhase, error?: string | null) {
  switch (phase) {
    case 'off': return null
    case 'connecting': return { label: '○ VOICE', hint: 'Connecting…', color: 'suggestion' as const }
    case 'recording': return { label: '● REC', hint: 'Release Space to send', color: 'error' as const }
    case 'ready': return { label: '○ VOICE', hint: 'Hold Space to talk · /bye to stop', color: 'suggestion' as const }
    case 'working': return { label: '○ VOICE', hint: 'Tau is working · hold Space to talk', color: 'suggestion' as const }
    case 'speaking': return { label: '◖ VOICE', hint: 'Speaking · hold Space to interrupt', color: 'suggestion' as const }
    case 'error': return { label: '○ VOICE', hint: `${(error || 'Connection failed').slice(0, 140)} · /hey to retry`, color: 'error' as const }
  }
}
