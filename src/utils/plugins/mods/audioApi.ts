import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { realpath, stat, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { extname, isAbsolute, join, resolve as resolvePath } from 'path'
import { isWithinDirectory } from '../pluginFiles.js'
import { which } from '../../which.js'

type ModRecord = Record<string, any>

const MAX_CLIP_BYTES = 16 * 1024 * 1024
const MAX_SPEECH = 4096
// A clip that ends at once must not turn a loop into a stream of processes.
const MIN_LOOP_MS = 250

const TYPES: Record<string, string> = {
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/ogg': '.ogg', 'audio/opus': '.opus',
  'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/aac': '.aac', 'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a', 'audio/aiff': '.aiff', 'audio/x-aiff': '.aiff', 'audio/webm': '.webm',
}
const EXTENSIONS = new Set(Object.values(TYPES))

/**
 * Tests name a command to stand in for every player and synthesizer, as a
 * JSON argv: a clip runs `[...argv, 'play', file, gain]`, speech
 * `[...argv, 'speak', voice]` with the text on stdin.
 */
function testCommand(): string[] | undefined {
  const raw = process.env.TAU_TEST_AUDIO_COMMAND
  if (!raw) return undefined
  const argv = JSON.parse(raw) as unknown
  if (!Array.isArray(argv) || !argv.length || argv.some(item => typeof item !== 'string'))
    throw new Error('TAU_TEST_AUDIO_COMMAND is a JSON array of strings')
  return argv as string[]
}

type Run = { argv: string[]; env?: Record<string, string>; input?: string }

/** Runs one player or synthesizer to its end; the signal kills it. */
function run(command: Run, signal: AbortSignal): Promise<{ code: number | null; stderr: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve({ code: null, stderr: '', aborted: true })
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      stdio: [command.input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...command.env },
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 4000) stderr += chunk })
    const abort = () => { child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', code => {
      signal.removeEventListener('abort', abort)
      resolve({ code, stderr: stderr.trim(), aborted: signal.aborted })
    })
    if (command.input !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(command.input)
    }
  })
}

// Windows: the platform's MediaPlayer, which opens a clip on its own and
// reports its length once it has (WAV, MP3, WMA, AAC/M4A).
const WINDOWS_PLAY = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName PresentationCore',
  '$player = New-Object System.Windows.Media.MediaPlayer',
  '$player.Volume = [Math]::Min(1.0, [double]$env:TAU_AUDIO_GAIN)',
  '$player.Open([Uri]::new($env:TAU_AUDIO_FILE))',
  '$deadline = [DateTime]::UtcNow.AddSeconds(10)',
  'while (-not $player.NaturalDuration.HasTimeSpan) {',
  "  if ([DateTime]::UtcNow -gt $deadline) { [Console]::Error.WriteLine('the clip did not open'); exit 2 }",
  '  Start-Sleep -Milliseconds 25',
  '}',
  '$player.Play()',
  'Start-Sleep -Milliseconds ([int][Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds) + 150)',
  '$player.Close()',
].join('\n')
const WINDOWS_SPEAK = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:TAU_SPEAK_VOICE) { $synth.SelectVoice($env:TAU_SPEAK_VOICE) }',
  '$synth.Speak($env:TAU_SPEAK_TEXT)',
].join('\n')
const powershell = (script: string) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]

/** The players that can play `file` here, best first. */
async function players(file: string, gain: number): Promise<Run[]> {
  const test = testCommand()
  if (test) return [{ argv: [...test, 'play', file, String(gain)] }]
  if (process.platform === 'darwin') return [{ argv: ['afplay', '-v', String(gain), file] }]
  if (process.platform === 'win32')
    return [{ argv: powershell(WINDOWS_PLAY), env: { TAU_AUDIO_FILE: file, TAU_AUDIO_GAIN: String(gain) } }]
  const wav = extname(file) === '.wav'
  const candidates: Array<[string, (path: string) => string[]]> = [
    ['paplay', path => [path, `--volume=${Math.round(gain * 65536)}`, file]],
    ['pw-play', path => [path, `--volume=${gain}`, file]],
    ['ffplay', path => [path, '-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(Math.min(1, gain) * 100)), file]],
    ...(wav ? [['aplay', (path: string) => [path, '-q', file]] as [string, (path: string) => string[]]] : []),
  ]
  const found: Run[] = []
  for (const [name, argv] of candidates) {
    const path = await which(name).catch(() => null)
    if (path) found.push({ argv: argv(path) })
  }
  return found
}

/** The synthesizer that speaks here, if the system has one. */
async function synthesizer(text: string, voice: string | undefined): Promise<Run | undefined> {
  const test = testCommand()
  if (test) return { argv: [...test, 'speak', voice ?? ''], input: text }
  if (process.platform === 'darwin') return { argv: ['say', ...(voice ? ['-v', voice] : [])], input: text }
  if (process.platform === 'win32')
    return { argv: powershell(WINDOWS_SPEAK), env: { TAU_SPEAK_TEXT: text, ...(voice ? { TAU_SPEAK_VOICE: voice } : {}) } }
  for (const name of ['espeak-ng', 'espeak']) {
    const path = await which(name).catch(() => null)
    if (path) return { argv: [path, ...(voice ? ['-v', voice] : []), '--stdin'], input: text }
  }
  const spd = await which('spd-say').catch(() => null)
  if (spd) return { argv: [spd, '-w', ...(voice ? ['-y', voice] : []), '--', text] }
  return undefined
}

/** A clip as a file to hand a player, and whether it is ours to delete. */
async function clipFile(clip: ModRecord, root: string, signal: AbortSignal): Promise<{ path: string; temporary: boolean }> {
  const kinds = ['asset', 'url', 'base64'].filter(name => clip[name] !== undefined)
  if (kinds.length !== 1) throw new Error('audio.play takes one clip: { asset }, { url } or { base64, mime }')
  if (clip.asset !== undefined) {
    const asset = clip.asset
    if (typeof asset !== 'string' || !asset || isAbsolute(asset) || /^[\\/]/.test(asset) ||
        asset.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..'))
      throw new Error('audio.play asset is a path inside the plugin, like sounds/done.wav')
    const realRoot = await realpath(root)
    let real: string
    try {
      real = await realpath(resolvePath(realRoot, asset))
    } catch {
      throw new Error(`audio.play: the plugin has no file ${asset}`)
    }
    if (!isWithinDirectory(realRoot, real)) throw new Error(`audio.play: ${asset} is outside the plugin`)
    const info = await stat(real)
    if (!info.isFile()) throw new Error(`audio.play: ${asset} is not a file`)
    if (info.size > MAX_CLIP_BYTES) throw new Error('audio.play: a clip is at most 16 MiB')
    return { path: real, temporary: false }
  }
  let bytes: Buffer
  let extension: string | undefined
  if (clip.url !== undefined) {
    if (typeof clip.url !== 'string') throw new Error('audio.play url must be a string')
    const { modHttpFetch } = await import('./sessionApi.js')
    const response = await modHttpFetch(clip.url, undefined, signal, true)
    if (!response.ok) throw new Error(`audio.play: ${clip.url} answered ${response.status}`)
    bytes = response.bytes as Buffer
    const type = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    extension = TYPES[type] ?? (EXTENSIONS.has(extname(new URL(clip.url).pathname).toLowerCase())
      ? extname(new URL(clip.url).pathname).toLowerCase() : undefined)
    if (!extension) throw new Error(`audio.play: ${clip.url} is not an audio clip this terminal plays`)
  } else {
    if (typeof clip.base64 !== 'string' || typeof clip.mime !== 'string')
      throw new Error('audio.play takes { base64, mime } for bytes')
    extension = TYPES[clip.mime.split(';')[0]!.trim().toLowerCase()]
    if (!extension) throw new Error(`audio.play: ${clip.mime} is not an audio type this terminal plays`)
    if (clip.base64.length > Math.ceil(MAX_CLIP_BYTES / 3) * 4 + 4) throw new Error('audio.play: a clip is at most 16 MiB')
    bytes = Buffer.from(clip.base64, 'base64')
  }
  if (!bytes.length) throw new Error('audio.play: the clip is empty')
  if (bytes.length > MAX_CLIP_BYTES) throw new Error('audio.play: a clip is at most 16 MiB')
  const path = join(tmpdir(), `tau-audio-${randomUUID()}${extension}`)
  await writeFile(path, bytes)
  return { path, temporary: true }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted || ms <= 0) return resolve()
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  signal.addEventListener('abort', done, { once: true })
})

/**
 * `$.audio.play`: a clip of the plugin's, at a URL, or as bytes, played now
 * (clips are not queued), once or looped until the call is stopped. A
 * system without a player skips it; a clip that cannot play rejects.
 */
export async function playModClip(event: ModRecord, root: string, signal: AbortSignal): Promise<void> {
  const clip = event.clip
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) throw new Error('audio.play takes a clip')
  const gain = event.gain === undefined ? 1 : event.gain
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 4)
    throw new Error('audio.play gain is a number from 0 to 4')
  const loop = event.shouldLoop === true
  const file = await clipFile(clip as ModRecord, root, signal)
  try {
    const choices = gain === 0 ? [] : await players(file.path, gain)
    // Silent, or nothing here plays sound: a loop still lasts until stopped.
    if (!choices.length) {
      if (loop) await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    do {
      const started = Date.now()
      let failure: string | undefined
      let played = false
      for (const choice of choices) {
        let result
        try {
          result = await run(choice, signal)
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
          continue
        }
        if (result.aborted) return
        if (result.code === 0) { played = true; break }
        failure = result.stderr || `${choice.argv[0]} exited with ${String(result.code)}`
      }
      if (!played) throw new Error(`audio.play could not play the clip: ${failure ?? 'no player'}`)
      if (loop) await sleep(MIN_LOOP_MS - (Date.now() - started), signal)
    } while (loop && !signal.aborted)
  } finally {
    if (file.temporary) await unlink(file.path).catch(() => {})
  }
}

let speaking: Promise<unknown> = Promise.resolve()

/**
 * `$.audio.speak`: the platform's synthesizer says the text (its first 4096
 * characters); utterances wait for each other. Rejects without one.
 */
export function speakModText(event: ModRecord, signal: AbortSignal): Promise<{ via: 'system' }> {
  if (typeof event.text !== 'string') return Promise.reject(new Error('audio.speak requires text'))
  if (event.voice !== undefined && (typeof event.voice !== 'string' || !event.voice.trim()))
    return Promise.reject(new Error('audio.speak voice is the name of an installed voice'))
  const text = event.text.slice(0, MAX_SPEECH)
  const turn = speaking.catch(() => {}).then(async () => {
    if (signal.aborted) throw new Error('audio.speak was stopped before it spoke')
    const command = await synthesizer(text, event.voice)
    if (!command) throw new Error('audio.speak: this system has no speech synthesizer')
    const result = await run(command, signal)
    if (result.aborted) throw new Error('audio.speak was stopped')
    if (result.code !== 0)
      throw new Error(`audio.speak failed: ${result.stderr || `${command.argv[0]} exited with ${String(result.code)}`}`)
    return { via: 'system' as const }
  })
  speaking = turn
  return turn
}
