// Gemini-backed voice helpers for /hey.
//
// This module intentionally uses the REST API directly instead of adding
// @google/genai. The voice path should stay plug-and-play: one API key, no
// extra runtime dependency, and local Whisper/OS TTS remains the fallback.

import { logForDebugging } from '../utils/debug.js'
import {
  DEFAULT_GEMINI_STT_MODEL,
  DEFAULT_GEMINI_TTS_MODEL,
  getSelectedVoiceModel,
  getSelectedVoiceName,
  getSelectedVoiceProvider,
  getVoiceConversationApiKey,
} from '../voice/voiceConversation.js'

const GEMINI_STT_MODEL_ENV = 'TAU_GEMINI_STT_MODEL'
const GEMINI_TTS_MODEL_ENV = 'TAU_GEMINI_TTS_MODEL'
const GEMINI_VOICE_ENV = 'TAU_GEMINI_VOICE'
const GEMINI_TTS_VOICE_ENV = 'TAU_GEMINI_TTS_VOICE'
const GEMINI_TTS_STYLE_ENV = 'TAU_GEMINI_TTS_STYLE'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_STT_TIMEOUT_MS = 30_000
const GEMINI_TTS_TIMEOUT_MS = 45_000

const WAV_CHANNELS = 1
const WAV_SAMPLE_WIDTH_BYTES = 2
const PCM_16_BIT_DEPTH = 16
export const GEMINI_TTS_SAMPLE_RATE = 24000

type GeminiTextPart = {
  text?: string
  inlineData?: {
    data?: string
    mimeType?: string
  }
  inline_data?: {
    data?: string
    mime_type?: string
  }
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: GeminiTextPart[]
    }
  }>
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

export type GeminiVoiceAvailability = {
  available: boolean
  reason: string | null
}

export type GeminiTranscribeOptions = {
  signal?: AbortSignal
}

export type GeminiTtsOptions = {
  signal?: AbortSignal
}

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function getGeminiApiKey(): string | undefined {
  return getVoiceConversationApiKey()
}

export function isGeminiVoiceEnabled(): boolean {
  return getSelectedVoiceProvider() === 'gemini'
}

export function isGeminiTranscriptionEnabled(): boolean {
  return getSelectedVoiceProvider() === 'gemini'
}

export function isLocalVoiceForced(): boolean {
  return getSelectedVoiceProvider() === 'local'
}

export function checkGeminiVoiceAvailable(): GeminiVoiceAvailability {
  if (!getGeminiApiKey()) {
    return {
      available: false,
      reason:
        'Run /login and choose Gemini Voice to save an API key for voice conversation.',
    }
  }
  return { available: true, reason: null }
}

function makeWavBuffer(
  pcm: Buffer,
  opts: { sampleRate: number; channels?: number; sampleWidthBytes?: number },
): Buffer {
  const channels = opts.channels ?? WAV_CHANNELS
  const sampleWidthBytes = opts.sampleWidthBytes ?? WAV_SAMPLE_WIDTH_BYTES
  const bitDepth = sampleWidthBytes * 8
  const byteRate = opts.sampleRate * channels * sampleWidthBytes
  const blockAlign = channels * sampleWidthBytes
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(opts.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitDepth, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function getGeminiEndpoint(model: string): string {
  return `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`
}

function createTimedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return { signal: timeoutSignal, cleanup: () => {} }

  const controller = new AbortController()
  const abortFromOuter = () => controller.abort(signal.reason)
  const abortFromTimeout = () => controller.abort(timeoutSignal.reason)
  signal.addEventListener('abort', abortFromOuter, { once: true })
  timeoutSignal.addEventListener('abort', abortFromTimeout, { once: true })
  if (signal.aborted) abortFromOuter()
  if (timeoutSignal.aborted) abortFromTimeout()
  return {
    signal: controller.signal,
    cleanup: () => {
      signal.removeEventListener('abort', abortFromOuter)
      timeoutSignal.removeEventListener('abort', abortFromTimeout)
    },
  }
}

async function readGeminiJson(
  response: Response,
): Promise<GeminiGenerateContentResponse> {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as GeminiGenerateContentResponse
  } catch {
    return { error: { message: text.slice(0, 500) } }
  }
}

function getGeminiErrorMessage(
  status: number,
  payload: GeminiGenerateContentResponse,
): string {
  const apiError = payload.error
  const code = apiError?.status ?? apiError?.code ?? status
  const message = apiError?.message ?? 'unknown Gemini API error'
  return `Gemini API ${code}: ${message}`
}

function extractText(response: GeminiGenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  return parts
    .map(part => part.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractInlineAudio(response: GeminiGenerateContentResponse): Buffer {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    const data = part.inlineData?.data ?? part.inline_data?.data
    if (data) return Buffer.from(data, 'base64')
  }
  throw new Error('Gemini TTS returned no inline audio data.')
}

function cleanTranscript(text: string): string {
  let next = text.replace(/\s+/g, ' ').trim()
  next = next.replace(/^transcript\s*:\s*/i, '')
  next = next.replace(/^["']+|["']+$/g, '').trim()
  if (/^(?:no speech|silence|empty|inaudible)$/i.test(next)) return ''
  return next
}

function getSttPrompt(): string {
  return [
    'Transcribe this short coding-assistant voice command.',
    'Return only the exact words the speaker said.',
    'Do not explain, summarize, add punctuation commentary, or invent missing words.',
    'If there is no intelligible speech, return an empty string.',
    'Common terms include Tau, Codex, CLI, API, TypeScript, JavaScript, React, Node, PowerShell, file, files, folder, project, function, class, explain each file, and what each file does.',
  ].join(' ')
}

function getTtsPrompt(text: string): string {
  const style =
    getEnv(GEMINI_TTS_STYLE_ENV) ??
    'Say this as Tau, a calm and smart coding partner speaking directly to the user. Sound natural and conversational, with clear pacing. Do not read markdown symbols or file syntax mechanically.'
  return `${style}\n\nSay:\n${text}`
}

export async function transcribePcm(
  pcm: Buffer,
  opts: GeminiTranscribeOptions = {},
): Promise<string> {
  const apiKey = getGeminiApiKey()
  if (!apiKey) throw new Error('Missing Gemini voice API key.')

  const model = getEnv(GEMINI_STT_MODEL_ENV) ?? DEFAULT_GEMINI_STT_MODEL
  const wav = makeWavBuffer(pcm, {
    sampleRate: 16000,
    channels: WAV_CHANNELS,
    sampleWidthBytes: WAV_SAMPLE_WIDTH_BYTES,
  })
  const body = {
    contents: [
      {
        parts: [
          { text: getSttPrompt() },
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: wav.toString('base64'),
            },
          },
        ],
      },
    ],
  }

  logForDebugging(
    `[hey] Gemini STT request model=${model} pcm=${pcm.length}B wav=${wav.length}B`,
  )
  const timedSignal = createTimedSignal(opts.signal, GEMINI_STT_TIMEOUT_MS)
  let payload: GeminiGenerateContentResponse = {}
  let status = 0
  let ok = false
  try {
    const response = await fetch(getGeminiEndpoint(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: timedSignal.signal,
    })
    status = response.status
    ok = response.ok
    payload = await readGeminiJson(response)
  } finally {
    timedSignal.cleanup()
  }
  if (!ok || payload.error) {
    throw new Error(getGeminiErrorMessage(status, payload))
  }
  const transcript = cleanTranscript(extractText(payload))
  logForDebugging(
    `[hey] Gemini STT transcript chars=${transcript.length}: "${transcript.slice(0, 160)}"`,
  )
  return transcript
}

export async function synthesizeSpeechPcm(
  text: string,
  opts: GeminiTtsOptions = {},
): Promise<Buffer> {
  const apiKey = getGeminiApiKey()
  if (!apiKey) throw new Error('Missing Gemini voice API key.')

  const model =
    getEnv(GEMINI_TTS_MODEL_ENV) ??
    getSelectedVoiceModel() ??
    DEFAULT_GEMINI_TTS_MODEL
  const voice =
    getEnv(GEMINI_TTS_VOICE_ENV) ??
    getEnv(GEMINI_VOICE_ENV) ??
    getSelectedVoiceName()
  const prompt = getTtsPrompt(text)
  const body = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
    },
    model,
  }

  logForDebugging(
    `[hey] Gemini TTS request model=${model} voice=${voice} chars=${text.length} promptChars=${prompt.length}`,
  )
  const timedSignal = createTimedSignal(opts.signal, GEMINI_TTS_TIMEOUT_MS)
  let payload: GeminiGenerateContentResponse = {}
  let status = 0
  let ok = false
  try {
    const response = await fetch(getGeminiEndpoint(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: timedSignal.signal,
    })
    status = response.status
    ok = response.ok
    payload = await readGeminiJson(response)
  } finally {
    timedSignal.cleanup()
  }
  if (!ok || payload.error) {
    throw new Error(getGeminiErrorMessage(status, payload))
  }
  const audio = extractInlineAudio(payload)
  logForDebugging(`[hey] Gemini TTS audio pcm=${audio.length}B`)
  if (audio.length % WAV_SAMPLE_WIDTH_BYTES !== 0) {
    logForDebugging(
      `[hey] Gemini TTS returned odd PCM byte length (${audio.length}B); playback may fail`,
    )
  }
  return audio
}

export function wrapGeminiPcmAsWav(pcm: Buffer): Buffer {
  return makeWavBuffer(pcm, {
    sampleRate: GEMINI_TTS_SAMPLE_RATE,
    channels: WAV_CHANNELS,
    sampleWidthBytes: PCM_16_BIT_DEPTH / 8,
  })
}
