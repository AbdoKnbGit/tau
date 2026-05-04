// Hold-to-talk conversational voice mode (the /hey flow).
//
// On hold Space -> record audio via the existing voice service. On release ->
// run whisper.cpp on the buffer, call onSubmit(transcript) so REPL routes
// it through the normal user-message pipeline. The TTS reply is wired
// up separately in useHeyResponseSpeaker — this hook only owns capture
// and dispatch.
//
// Compared to useVoice (the existing /voice flow): no streaming STT, no
// interim-transcript injection, no input-box anchor. One-shot per
// recording. Much simpler.

import { useCallback, useEffect, useRef, useState } from 'react'
import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'

export type HeyState = 'idle' | 'recording' | 'transcribing'

type UseHeyArgs = {
  enabled: boolean
  onSubmit: (text: string) => void
  onTranscript?: (text: string) => void
  onError?: (message: string) => void
}

type UseHeyReturn = {
  state: HeyState
  handleKeyEvent: (fallbackMs?: number) => void
}

// Match the voice key release semantics: a >200ms gap between auto-repeat
// events counts as the user releasing the key. Auto-repeat fires every
// 30-80ms, so 200ms covers jitter without being so long that release
// detection feels laggy.
const RELEASE_TIMEOUT_MS = 200

// Used when we haven't yet seen auto-repeat (single press / first event).
// Covers the OS initial-repeat delay (~500ms on macOS default) plus
// headroom — if the user tapped and released, we still need to fire
// release detection eventually.
const REPEAT_FALLBACK_MS = 600

// Below this many bytes of PCM (16 kHz × 16-bit × 1 ch = 32 kB/sec), we
// treat the recording as an accidental tap and silently drop it instead
// of running whisper on noise. ~50ms of audio.
const MIN_PCM_BYTES = 1600
const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const FRAME_MS = 30
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS * BYTES_PER_SAMPLE) / 1000
const TRIM_PADDING_MS = 180
const TRIM_PADDING_BYTES =
  (SAMPLE_RATE * TRIM_PADDING_MS * BYTES_PER_SAMPLE) / 1000
const MIN_TRANSCRIBE_MS = 250
const MIN_VOICED_MS = 120
const MIN_PCM_RMS = 20
const MIN_PCM_PEAK = 300
const ACTIVE_FRAME_MIN_RMS = 55
const ACTIVE_FRAME_MIN_PEAK = 250

type PcmFrame = {
  start: number
  end: number
  rms: number
  peak: number
}

type PcmSpeechAnalysis = {
  durationMs: number
  overallRms: number
  peak: number
  frameCount: number
  activeFrameCount: number
  activeMs: number
  activeThreshold: number
  trimStart: number
  trimEnd: number
  trimmedBytes: number
}

function alignEven(value: number): number {
  return value - (value % BYTES_PER_SAMPLE)
}

function calculateStats(
  pcm: Buffer,
  start = 0,
  end = pcm.length,
): { rms: number; peak: number } {
  const evenStart = alignEven(Math.max(0, start))
  const evenEnd = alignEven(Math.min(pcm.length, end))
  let sumSq = 0
  let peak = 0
  let samples = 0
  for (let i = evenStart; i + 1 < evenEnd; i += BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(i)
    const abs = Math.abs(sample)
    if (abs > peak) peak = abs
    sumSq += sample * sample
    samples++
  }
  return {
    rms: samples > 0 ? Math.sqrt(sumSq / samples) : 0,
    peak,
  }
}

function analyzePcmSpeech(pcm: Buffer): PcmSpeechAnalysis {
  const evenLength = alignEven(pcm.length)
  const durationMs = (evenLength / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000
  const overall = calculateStats(pcm, 0, evenLength)
  const frames: PcmFrame[] = []
  for (let start = 0; start < evenLength; start += FRAME_BYTES) {
    const end = Math.min(evenLength, start + FRAME_BYTES)
    const stats = calculateStats(pcm, start, end)
    frames.push({ start, end, rms: stats.rms, peak: stats.peak })
  }

  const sortedRms = frames.map(frame => frame.rms).sort((a, b) => a - b)
  const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.2)] ?? 0
  const activeThreshold = Math.max(ACTIVE_FRAME_MIN_RMS, noiseFloor * 2.2)
  const activeFrames = frames.filter(
    frame =>
      frame.rms >= activeThreshold && frame.peak >= ACTIVE_FRAME_MIN_PEAK,
  )

  const firstActive = activeFrames[0]
  const lastActive = activeFrames[activeFrames.length - 1]
  const trimStart = firstActive
    ? alignEven(Math.max(0, firstActive.start - TRIM_PADDING_BYTES))
    : 0
  const trimEnd = lastActive
    ? alignEven(Math.min(evenLength, lastActive.end + TRIM_PADDING_BYTES))
    : 0
  const activeMs = activeFrames.reduce(
    (total, frame) =>
      total +
      ((frame.end - frame.start) / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000,
    0,
  )

  return {
    durationMs,
    overallRms: overall.rms,
    peak: overall.peak,
    frameCount: frames.length,
    activeFrameCount: activeFrames.length,
    activeMs,
    activeThreshold,
    trimStart,
    trimEnd,
    trimmedBytes: Math.max(0, trimEnd - trimStart),
  }
}

function getPcmDropReason(analysis: PcmSpeechAnalysis): string | null {
  if (analysis.durationMs < MIN_TRANSCRIBE_MS) {
    return 'Recording was too short. Hold Space while you speak, then release.'
  }
  if (analysis.peak < MIN_PCM_PEAK || analysis.overallRms < MIN_PCM_RMS) {
    return 'No clear speech detected. Try speaking closer to the mic.'
  }
  if (analysis.activeMs < MIN_VOICED_MS || analysis.trimmedBytes === 0) {
    return 'No clear speech detected. Try again with less background noise.'
  }
  return null
}

function normalizeTranscriptForHallucinationCheck(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLikelyLowSignalHallucination(
  text: string,
  analysis: PcmSpeechAnalysis,
): boolean {
  if (analysis.activeMs >= 300 || analysis.peak >= 1800) return false
  const normalized = normalizeTranscriptForHallucinationCheck(text)
  return [
    'thank you',
    'thank you for watching',
    'thanks for watching',
    'you',
    'bye',
    'hello',
    'hi',
  ].includes(normalized)
}

function normalizeCodingTranscript(text: string): string {
  const original = text.replace(/\s+/g, ' ').trim()
  let next = original
  const hasCodingContext =
    /\b(explain|file|files|folder|folders|project|code|source|class|function|cli|api|does|do)\b/i.test(
      next,
    )

  if (hasCodingContext) {
    next = next.replace(/\b(?:30|thirty)\s+stars?\b/gi, 'each file')
  }

  next = next
    .replace(/\bwhat\s+(?:is|its?|it's)\s+does\b/gi, 'what it does')
    .replace(/\bwhat\s+each\s+file\s+is\s+does\b/gi, 'what each file does')
    .replace(/\bto\s+me\s+to\s+me\b/gi, 'to me')

  return next.replace(/\s+/g, ' ').trim()
}

// Lazy-loaded modules. Voice (audio capture) is heavy on first import
// because of the native module dlopen — defer it to first activation.
// Whisper module is light, but keep the lazy import for symmetry.
type VoiceModule = typeof import('../services/voice.js')
type WhisperModule = typeof import('../services/whisperLocal.js')
type TtsModule = typeof import('../services/ttsLocal.js')
type GeminiVoiceModule = typeof import('../services/geminiVoice.js')
let voiceModule: VoiceModule | null = null
let whisperModule: WhisperModule | null = null
let ttsModule: TtsModule | null = null
let geminiVoiceModule: GeminiVoiceModule | null = null

async function loadVoiceModule(): Promise<VoiceModule> {
  if (voiceModule) return voiceModule
  voiceModule = await import('../services/voice.js')
  return voiceModule
}
async function loadWhisperModule(): Promise<WhisperModule> {
  if (whisperModule) return whisperModule
  whisperModule = await import('../services/whisperLocal.js')
  return whisperModule
}
async function loadTtsModule(): Promise<TtsModule> {
  if (ttsModule) return ttsModule
  ttsModule = await import('../services/ttsLocal.js')
  return ttsModule
}
async function loadGeminiVoiceModule(): Promise<GeminiVoiceModule> {
  if (geminiVoiceModule) return geminiVoiceModule
  geminiVoiceModule = await import('../services/geminiVoice.js')
  return geminiVoiceModule
}

function stopActiveSpeech(): void {
  void loadTtsModule()
    .then(mod => mod.stopSpeaking())
    .catch(err => logError(toError(err)))
}

async function transcribeWithConfiguredProvider(pcm: Buffer): Promise<string> {
  const gemini = await loadGeminiVoiceModule()
  if (gemini.isGeminiTranscriptionEnabled()) {
    const availability = gemini.checkGeminiVoiceAvailable()
    if (availability.available) {
      try {
        return await gemini.transcribePcm(pcm)
      } catch (err) {
        const error = toError(err)
        logForDebugging(
          `[hey] Gemini STT failed; falling back to local whisper: ${error.stack ?? error.message}`,
          { level: 'error' },
        )
        const whisper = await loadWhisperModule()
        const whisperAvailable = whisper.checkWhisperAvailable()
        if (!whisperAvailable.available) {
          throw new Error(
            `Gemini transcription failed (${error.message}) and local whisper fallback is unavailable: ${whisperAvailable.reason ?? 'unknown'}`,
          )
        }
      }
    } else {
      logForDebugging(
        `[hey] Gemini STT unavailable; falling back to local whisper: ${availability.reason ?? 'unknown'}`,
      )
    }
  }

  const whisper = await loadWhisperModule()
  return whisper.transcribePcm(pcm)
}

export function useHey({
  enabled,
  onSubmit,
  onTranscript,
  onError,
}: UseHeyArgs): UseHeyReturn {
  const [state, setState] = useState<HeyState>('idle')
  const stateRef = useRef<HeyState>('idle')
  const audioChunksRef = useRef<Buffer[]>([])
  const recordingStartRef = useRef(0)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const seenRepeatRef = useRef(false)
  // Latest callbacks via refs so handleKeyEvent doesn't churn deps and
  // recreate timers on every render.
  const onSubmitRef = useRef(onSubmit)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  onSubmitRef.current = onSubmit
  onTranscriptRef.current = onTranscript
  onErrorRef.current = onError

  function updateState(next: HeyState): void {
    stateRef.current = next
    setState(next)
  }

  // Pre-load voice module when hey-mode is enabled so the first hold has
  // no first-press dlopen cost. Same pattern as useVoice.
  useEffect(() => {
    if (enabled) {
      void loadVoiceModule().catch(err => logError(toError(err)))
    }
  }, [enabled])

  const cleanup = useCallback((): void => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    audioChunksRef.current = []
    seenRepeatRef.current = false
    voiceModule?.stopRecording()
  }, [])

  // Stop and tear down any in-flight session whenever hey-mode toggles
  // off (or unmount). Without this, a stale recording keeps the mic
  // open and the next /hey enable will see weird state.
  useEffect(() => {
    if (!enabled && stateRef.current !== 'idle') {
      cleanup()
      updateState('idle')
    }
    return () => {
      cleanup()
    }
  }, [enabled, cleanup])

  async function startRecording(): Promise<void> {
    stopActiveSpeech()
    const voice = await loadVoiceModule()
    const availability = await voice.checkRecordingAvailability()
    if (!availability.available) {
      onErrorRef.current?.(
        availability.reason ?? 'Audio recording is not available.',
      )
      cleanup()
      updateState('idle')
      return
    }

    audioChunksRef.current = []
    recordingStartRef.current = Date.now()
    updateState('recording')

    const started = await voice.startRecording(
      (chunk: Buffer) => {
        // Defensive copy: cpal hands us a slice into a shared backing buffer
        // that's reused on subsequent reads. Without the copy the earlier
        // chunks get clobbered before whisper sees them.
        audioChunksRef.current.push(Buffer.from(chunk))
      },
      () => {
        // Device error / external stop. Treat as user-released so we still
        // try to transcribe whatever was captured.
        if (stateRef.current === 'recording') {
          void finishRecording()
        }
      },
      { silenceDetection: false },
    )
    if (!started) {
      onErrorRef.current?.(
        'Failed to start audio capture. Check that your microphone is accessible.',
      )
      cleanup()
      updateState('idle')
    }
  }

  async function finishRecording(): Promise<void> {
    if (stateRef.current !== 'recording') return
    updateState('transcribing')
    const voice = voiceModule
    voice?.stopRecording()
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    seenRepeatRef.current = false

    const pcm = Buffer.concat(audioChunksRef.current)
    audioChunksRef.current = []
    const recordingDurationMs = Date.now() - recordingStartRef.current

    if (pcm.length < MIN_PCM_BYTES) {
      logForDebugging(
        `[hey] recording too short (${pcm.length}B, ${recordingDurationMs}ms) — ignoring`,
      )
      updateState('idle')
      return
    }

    try {
      const analysis = analyzePcmSpeech(pcm)
      logForDebugging(
        `[hey] audio analysis: duration=${analysis.durationMs.toFixed(0)}ms active=${analysis.activeMs.toFixed(0)}ms frames=${analysis.activeFrameCount}/${analysis.frameCount} rms=${analysis.overallRms.toFixed(1)} peak=${analysis.peak} threshold=${analysis.activeThreshold.toFixed(1)} trim=${analysis.trimmedBytes}B/${pcm.length}B`,
      )
      const dropReason = getPcmDropReason(analysis)
      if (dropReason) {
        logForDebugging(
          `[hey] dropping recording before transcription: ${dropReason}`,
        )
        onErrorRef.current?.(dropReason)
        return
      }

      const pcmForTranscription = pcm.subarray(
        analysis.trimStart,
        analysis.trimEnd,
      )
      const rawText = await transcribeWithConfiguredProvider(
        pcmForTranscription,
      )
      logForDebugging(
        `[hey] transcript raw chars=${rawText.length}: "${rawText.slice(0, 160)}"`,
      )
      const text = normalizeCodingTranscript(rawText)
      if (text !== rawText) {
        logForDebugging(
          `[hey] transcript normalized: "${rawText.slice(0, 120)}" -> "${text.slice(0, 120)}"`,
        )
      }
      logEvent('tengu_hey_transcribed', {
        recordingDurationMs,
        transcriptChars: text.length,
        pcmBytes: pcm.length,
        trimmedPcmBytes: pcmForTranscription.length,
      })
      if (text) {
        if (isLikelyLowSignalHallucination(text, analysis)) {
          logForDebugging(
            `[hey] dropping likely low-signal transcription hallucination: "${text.slice(0, 120)}"`,
          )
          onErrorRef.current?.(
            'No clear speech detected. Try again with less background noise.',
          )
          return
        }
        onTranscriptRef.current?.(text)
        onSubmitRef.current(text)
      } else {
        onErrorRef.current?.(
          'No speech detected. Try speaking closer to the mic.',
        )
      }
    } catch (err) {
      const error = toError(err)
      logError(error)
      onErrorRef.current?.(`Transcription failed: ${error.message}`)
    } finally {
      updateState('idle')
    }
  }

  function armReleaseTimer(): void {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
    }
    releaseTimerRef.current = setTimeout(() => {
      releaseTimerRef.current = null
      if (stateRef.current === 'recording') {
        void finishRecording()
      }
    }, RELEASE_TIMEOUT_MS)
  }

  const handleKeyEvent = useCallback(
    (fallbackMs: number = REPEAT_FALLBACK_MS): void => {
      if (!enabled) return
      // Drop key events during transcription — the user has already
      // released; new presses should wait until idle to start the next turn.
      if (stateRef.current === 'transcribing') return

      if (stateRef.current === 'idle') {
        void startRecording()
        // Fallback: if no auto-repeat arrives within fallbackMs, arm the
        // release timer anyway. Covers tap-and-release where the user lets
        // go before the OS initial-repeat delay elapses.
        repeatFallbackTimerRef.current = setTimeout(() => {
          repeatFallbackTimerRef.current = null
          if (stateRef.current === 'recording' && !seenRepeatRef.current) {
            seenRepeatRef.current = true
            armReleaseTimer()
          }
        }, fallbackMs)
        return
      }

      // recording: another keypress means auto-repeat is firing — the user
      // is still holding. Note we saw a repeat (so the release timer is
      // safe to arm) and reset the release timer.
      seenRepeatRef.current = true
      if (repeatFallbackTimerRef.current) {
        clearTimeout(repeatFallbackTimerRef.current)
        repeatFallbackTimerRef.current = null
      }
      armReleaseTimer()
    },
    [enabled],
  )

  return { state, handleKeyEvent }
}
