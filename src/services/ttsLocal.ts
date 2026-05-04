// Text-to-speech for hey-mode responses.
//
// Uses whatever the platform ships with — zero dependencies, no API key,
// no network. Quality varies (Windows SAPI ≈ macOS `say` < ElevenLabs)
// but this is the "just works" path that satisfies the user's keep-it-easy
// rule. Power users can later layer a higher-quality TTS via env var
// (TAU_TTS_CMD) without touching this file's surface.
//
// Per-platform backends:
//   Windows: powershell.exe -> System.Speech.Synthesizer (SAPI), detached stdio
//   macOS:   say -- (text via -- to handle leading-dash strings safely)
//   Linux:   espeak (best-effort; falls back to a no-op if espeak missing)

import { spawn, spawnSync } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkGeminiVoiceAvailable,
  getGeminiApiKey,
  isGeminiVoiceEnabled,
  isLocalVoiceForced,
  synthesizeSpeechPcm,
  wrapGeminiPcmAsWav,
} from './geminiVoice.js'
import { logForDebugging } from '../utils/debug.js'

const TTS_CMD_ENV = 'TAU_TTS_CMD'
const LEGACY_TTS_CMD_ENV = 'CLAUDEX_TTS_CMD'
const MAX_SPEECH_CHARS = 2000

function checkBinary(name: string): boolean {
  // --version isn't universal (espeak uses --version, say has no flag) so
  // probe by spawning with no args and looking only at the spawn error —
  // exit code is irrelevant, we only care that the binary exists on PATH.
  const result = spawnSync(name, [], {
    stdio: 'ignore',
    timeout: 2000,
  })
  return result.error === undefined
}

let availabilityCache: TtsAvailability | null = null
let availabilityCacheKey: string | null = null

function getCustomTtsCommand(): string | undefined {
  return process.env[TTS_CMD_ENV] ?? process.env[LEGACY_TTS_CMD_ENV]
}

export type TtsAvailability = {
  available: boolean
  backend: 'gemini' | 'sapi' | 'say' | 'espeak' | 'custom' | null
  reason: string | null
}

export function checkTtsAvailable(): TtsAvailability {
  const cacheKey = [
    process.platform,
    getCustomTtsCommand() ?? '',
    isGeminiVoiceEnabled() ? 'gemini' : 'local',
    isLocalVoiceForced() ? 'forced-local' : '',
    getGeminiApiKey() ? 'gemini-key' : 'no-gemini-key',
  ].join('|')
  if (availabilityCache && availabilityCacheKey === cacheKey) {
    return availabilityCache
  }
  availabilityCache = null
  availabilityCacheKey = cacheKey

  if (isGeminiVoiceEnabled() && !isLocalVoiceForced()) {
    const gemini = checkGeminiVoiceAvailable()
    if (gemini.available && hasGeminiAudioPlayer()) {
      availabilityCache = { available: true, backend: 'gemini', reason: null }
      return availabilityCache
    }
    logForDebugging(
      `[hey] Gemini TTS unavailable; falling back to local TTS: ${gemini.reason ?? 'no audio player available'}`,
    )
  }

  availabilityCache = checkLocalTtsAvailable()
  return availabilityCache
}

function checkLocalTtsAvailable(): TtsAvailability {
  if (getCustomTtsCommand()) {
    availabilityCache = { available: true, backend: 'custom', reason: null }
    return availabilityCache
  }

  if (process.platform === 'win32') {
    // PowerShell is present on every supported Windows version (5.1+ on
    // Win10+; pwsh on newer). System.Speech is part of .NET Framework
    // and is shipped with the OS. Treat as always available — the actual
    // failure surfaces from the spawned PowerShell at speak time, not
    // here, since checking would itself launch PowerShell.
    availabilityCache = { available: true, backend: 'sapi', reason: null }
    return availabilityCache
  }
  if (process.platform === 'darwin') {
    if (checkBinary('say')) {
      availabilityCache = { available: true, backend: 'say', reason: null }
      return availabilityCache
    }
    availabilityCache = {
      available: false,
      backend: null,
      reason: '`say` not found on PATH (it ships with macOS — check $PATH).',
    }
    return availabilityCache
  }
  // Linux + everything else
  if (checkBinary('espeak')) {
    availabilityCache = { available: true, backend: 'espeak', reason: null }
    return availabilityCache
  }
  if (checkBinary('espeak-ng')) {
    availabilityCache = { available: true, backend: 'espeak', reason: null }
    return availabilityCache
  }
  availabilityCache = {
    available: false,
    backend: null,
    reason:
      'No TTS engine available. Install espeak (e.g. `sudo apt install espeak` or `sudo dnf install espeak`).',
  }
  return availabilityCache
}

export function _resetTtsCacheForTesting(): void {
  availabilityCache = null
  availabilityCacheKey = null
}

let activeSpeaker: ReturnType<typeof spawn> | null = null
let activeGeminiController: AbortController | null = null

// Stop any currently-speaking TTS process. Safe to call when no speech
// is active. Used by /hey when the user starts a new turn — the previous
// response shouldn't keep talking over fresh input.
export function stopSpeaking(): void {
  if (activeGeminiController && !activeGeminiController.signal.aborted) {
    activeGeminiController.abort()
  }
  activeGeminiController = null
  if (activeSpeaker && !activeSpeaker.killed) {
    try {
      activeSpeaker.kill('SIGTERM')
    } catch (err) {
      logForDebugging(
        `[hey] failed to stop active TTS process: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  activeSpeaker = null
}

function killActiveSpeakerOnAbort(signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {}
  const onAbort = () => stopSpeaking()
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

function isAbortLikeError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof Error && /aborted|abort/i.test(err.message))
  )
}

function encodePowerShellCommand(script: string): string {
  // -EncodedCommand expects UTF-16LE.
  return Buffer.from(script, 'utf16le').toString('base64')
}

function buildPowerShellSapiCommand(text: string): string {
  // Put the text in a UTF-8 base64 literal inside the encoded command.
  // This keeps the TUI out of PowerShell's stdin/stdout/stderr lifecycle,
  // while still avoiding argv quoting problems for arbitrary assistant text.
  const encodedText = Buffer.from(text, 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))`,
    '$s.Speak($t)',
  ].join(';')
}

export type SpeakOptions = {
  signal?: AbortSignal
}

// Speak the given text. On Windows we resolve once SAPI is spawned so the CLI
// never depends on the speech child closing; other backends resolve when audio
// playback finishes. The previous speaker (if any) is interrupted because
// overlapping voices are worse than truncating.
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const trimmed = text.trim().slice(0, MAX_SPEECH_CHARS)
  if (!trimmed) return

  const avail = checkTtsAvailable()
  if (!avail.available) {
    logForDebugging(`[hey] TTS unavailable: ${avail.reason ?? 'unknown'}`)
    return
  }
  logForDebugging(
    `[hey] TTS starting backend=${avail.backend ?? 'unknown'} chars=${trimmed.length} platform=${process.platform}`,
  )

  stopSpeaking()

  const cleanupAbort = killActiveSpeakerOnAbort(opts.signal)

  try {
    if (avail.backend === 'gemini') {
      try {
        await spawnGeminiSpeak(trimmed, opts)
        return
      } catch (err) {
        if (isAbortLikeError(err)) return
        logForDebugging(
          `[hey] Gemini TTS failed; falling back to local TTS: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
          { level: 'error' },
        )
        const fallback = checkLocalTtsAvailable()
        if (!fallback.available) {
          logForDebugging(
            `[hey] local TTS fallback unavailable: ${fallback.reason ?? 'unknown'}`,
          )
          return
        }
        await speakWithBackend(trimmed, fallback.backend)
        return
      }
    }
    if (avail.backend) {
      await speakWithBackend(trimmed, avail.backend)
      return
    }
    logForDebugging('[hey] TTS skipped: no backend selected')
  } finally {
    cleanupAbort()
  }
}

async function speakWithBackend(
  text: string,
  backend: TtsAvailability['backend'],
): Promise<void> {
  if (backend === 'custom') {
    await spawnCustomSpeak(text)
    return
  }
  if (backend === 'sapi') {
    await spawnPowerShellSpeak(text)
    return
  }
  if (backend === 'say') {
    await spawnSaySpeak(text)
    return
  }
  if (backend === 'espeak') {
    await spawnEspeakSpeak(text)
    return
  }
}

type AudioFilePlayer = {
  bin: string
  args: string[]
  label: string
}

function hasGeminiAudioPlayer(): boolean {
  if (process.platform === 'win32') return true
  if (process.platform === 'darwin') return checkBinary('afplay')
  return checkBinary('paplay') || checkBinary('aplay') || checkBinary('ffplay')
}

function getGeminiAudioPlayer(wavPath: string): AudioFilePlayer | null {
  if (process.platform === 'win32') {
    return {
      bin: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodePowerShellCommand(buildPowerShellWavPlayCommand(wavPath)),
      ],
      label: 'powershell-soundplayer',
    }
  }
  if (process.platform === 'darwin' && checkBinary('afplay')) {
    return { bin: 'afplay', args: [wavPath], label: 'afplay' }
  }
  if (checkBinary('paplay')) {
    return { bin: 'paplay', args: [wavPath], label: 'paplay' }
  }
  if (checkBinary('aplay')) {
    return { bin: 'aplay', args: ['-q', wavPath], label: 'aplay' }
  }
  if (checkBinary('ffplay')) {
    return {
      bin: 'ffplay',
      args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', wavPath],
      label: 'ffplay',
    }
  }
  return null
}

function buildPowerShellWavPlayCommand(wavPath: string): string {
  const encodedPath = Buffer.from(wavPath, 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System',
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    '$player = New-Object System.Media.SoundPlayer',
    '$player.SoundLocation = $p',
    '$player.Load()',
    '$player.PlaySync()',
  ].join(';')
}

async function spawnGeminiSpeak(
  text: string,
  opts: SpeakOptions,
): Promise<void> {
  const controller = new AbortController()
  activeGeminiController = controller
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  let tempDir: string | null = null
  try {
    const pcm = await synthesizeSpeechPcm(text, {
      signal: controller.signal,
    })
    if (controller.signal.aborted) throw new Error('Gemini TTS aborted')
    if (activeGeminiController === controller) activeGeminiController = null

    tempDir = await mkdtemp(join(tmpdir(), 'tau-gemini-tts-'))
    const wavPath = join(tempDir, 'speech.wav')
    await writeFile(wavPath, wrapGeminiPcmAsWav(pcm))
    await spawnAudioFileSpeak(wavPath, tempDir)
    tempDir = null
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    if (activeGeminiController === controller) activeGeminiController = null
    if (tempDir) {
      void rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function spawnAudioFileSpeak(
  wavPath: string,
  tempDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const player = getGeminiAudioPlayer(wavPath)
    if (!player) {
      reject(new Error('No audio player available for Gemini TTS output.'))
      return
    }

    const child = spawn(player.bin, player.args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    activeSpeaker = child
    let settled = false
    const cleanup = () => {
      if (activeSpeaker === child) activeSpeaker = null
      void rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
    child.once('spawn', () => {
      settled = true
      logForDebugging(
        `[hey] Gemini TTS playback spawned backend=${player.label} pid=${child.pid ?? 'unknown'} file=${wavPath}`,
      )
      child.unref()
      resolve()
    })
    child.once('close', () => {
      cleanup()
      logForDebugging(`[hey] Gemini TTS playback completed backend=${player.label}`)
    })
    child.once('error', err => {
      cleanup()
      logForDebugging(
        `[hey] Gemini TTS playback spawn error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        { level: 'error' },
      )
      if (!settled) reject(err)
    })
  })
}

function spawnPowerShellSpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Keep Windows SAPI completely off the TUI stdio streams. The previous
    // implementation piped text through PowerShell stdin and resolved on
    // child close; in the full Ink app that made the reply lifecycle depend
    // on a child process closing after audio playback. Fire-and-forget keeps
    // the CLI stable once speech has started, while stopSpeaking() can still
    // terminate the child for the next /hey turn.
    const encodedCommand = encodePowerShellCommand(
      buildPowerShellSapiCommand(text),
    )
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodedCommand,
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    activeSpeaker = child
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (activeSpeaker === child) activeSpeaker = null
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    child.once('spawn', () => {
      logForDebugging(
        `[hey] PowerShell SAPI spawned pid=${child.pid ?? 'unknown'} fire_and_forget=true`,
      )
      child.unref()
      resolve()
    })
    child.once('error', err => {
      if (activeSpeaker === child) activeSpeaker = null
      logForDebugging(
        `[hey] PowerShell SAPI spawn error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        { level: 'error' },
      )
      finish(err)
    })
  })
}

function spawnSaySpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `--` separates `say`'s flags from the text, so leading dashes in
    // the text aren't reinterpreted. say reads from stdin if no text is
    // given, but the flag form is simpler and avoids encoding edge cases.
    const child = spawn('say', ['--', text], { stdio: 'ignore' })
    activeSpeaker = child
    child.on('close', () => {
      if (activeSpeaker === child) activeSpeaker = null
      logForDebugging('[hey] say completed')
      resolve()
    })
    child.on('error', err => {
      if (activeSpeaker === child) activeSpeaker = null
      logForDebugging(
        `[hey] say spawn error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        { level: 'error' },
      )
      reject(err)
    })
  })
}

function spawnEspeakSpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('espeak', ['--', text], { stdio: 'ignore' })
    activeSpeaker = child
    child.on('close', () => {
      if (activeSpeaker === child) activeSpeaker = null
      logForDebugging('[hey] espeak completed')
      resolve()
    })
    child.on('error', err => {
      if (activeSpeaker === child) activeSpeaker = null
      logForDebugging(
        `[hey] espeak spawn error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        { level: 'error' },
      )
      reject(err)
    })
  })
}

function spawnCustomSpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = getCustomTtsCommand()
    if (!cmd) {
      resolve()
      return
    }
    // The custom command is parsed shell-style; user supplies the full
    // invocation (e.g. `flite -voice slt -t`) and we pipe text via stdin.
    // Splitting on whitespace is intentionally simple — quoting is the
    // user's responsibility, matching the shell-quote semantics already
    // used elsewhere in the codebase.
    const parts = cmd.split(/\s+/).filter(Boolean)
    const [bin, ...args] = parts
    if (!bin) {
      resolve()
      return
    }
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    activeSpeaker = child
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (activeSpeaker === child) activeSpeaker = null
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    child.on('close', () => {
      logForDebugging('[hey] custom TTS completed')
      finish()
    })
    child.on('error', err => {
      logForDebugging(
        `[hey] custom TTS spawn error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
        { level: 'error' },
      )
      finish(err)
    })
    child.stdin?.on('error', err => {
      logForDebugging(
        `[hey] custom TTS stdin error: ${err instanceof Error ? err.message : String(err)}`,
      )
      finish()
    })
    try {
      child.stdin?.end(text, 'utf8')
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
