// Local whisper.cpp speech-to-text. Detects an installed whisper-cli binary,
// writes the captured PCM as a WAV, and runs whisper-cli to get a transcript.
//
// User installs whisper.cpp themselves (one-time, platform-specific):
//   Windows: scoop install whisper-cpp
//   macOS:   brew install whisper-cpp
//   Linux:   build from source (https://github.com/ggerganov/whisper.cpp)
//
// Overrides via env vars:
//   TAU_WHISPER_BIN   - path to whisper-cli (or main) binary
//   TAU_WHISPER_MODEL - path to ggml-*.bin model file
//   TAU_WHISPER_PROMPT - optional decoding prompt for better local STT accuracy
// Legacy CLAUDEX_* names are still accepted for existing installs.

import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'

const WHISPER_BIN_ENV = 'TAU_WHISPER_BIN'
const WHISPER_MODEL_ENV = 'TAU_WHISPER_MODEL'
const WHISPER_PROMPT_ENV = 'TAU_WHISPER_PROMPT'
const LEGACY_WHISPER_BIN_ENV = 'CLAUDEX_WHISPER_BIN'
const LEGACY_WHISPER_MODEL_ENV = 'CLAUDEX_WHISPER_MODEL'
const LEGACY_WHISPER_PROMPT_ENV = 'CLAUDEX_WHISPER_PROMPT'

const DEFAULT_WHISPER_PROMPT = [
  'This is a coding assistant voice conversation.',
  'Common words and phrases include Tau, Codex, CLI, API, TypeScript, JavaScript, React, Node, PowerShell, file, files, folder, project, function, class, explain each file, and what each file does.',
].join(' ')

// Recording format used by src/services/voice.ts startRecording — must
// match exactly. whisper.cpp accepts 16 kHz mono PCM natively, so we can
// wrap it in a WAV header without resampling.
const SAMPLE_RATE = 16000
const CHANNELS = 1
const BIT_DEPTH = 16

type WhisperPaths = {
  bin: string
  model: string
}

let cachedPaths: WhisperPaths | null = null

function getEnvWithLegacy(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy]
}

function probeBinary(name: string): string | null {
  // spawn the candidate directly and look at result.error. --help is the
  // most universally accepted flag across whisper-cli/main/whisper variants;
  // exit code is irrelevant — we only care whether the binary is on PATH.
  const result = spawnSync(name, ['--help'], {
    stdio: 'ignore',
    timeout: 3000,
  })
  return result.error === undefined ? name : null
}

function findWhisperBin(): string | null {
  const override = getEnvWithLegacy(WHISPER_BIN_ENV, LEGACY_WHISPER_BIN_ENV)
  if (override) {
    if (existsSync(override)) return override
    logForDebugging(
      `[hey] configured whisper binary ${override} not found on disk, falling through to PATH lookup`,
    )
  }

  const home = homedir()
  const localCandidates =
    process.platform === 'win32'
      ? [
          join(home, '.voicemode', 'bin', 'whisper-cli.exe'),
          join(home, '.voicemode', 'bin', 'main.exe'),
        ]
      : [
          join(home, '.voicemode', 'bin', 'whisper-cli'),
          join(home, '.voicemode', 'bin', 'main'),
        ]
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return candidate
  }

  // whisper-cli is the modern name (post-1.7.x); main is the legacy entry
  // point (pre-1.7.x and some distro packages); whisper is occasionally
  // used as a wrapper. Order matters — newest first.
  for (const name of ['whisper-cli', 'whisper', 'main']) {
    const found = probeBinary(name)
    if (found) return found
    if (process.platform === 'win32') {
      const exe = probeBinary(`${name}.exe`)
      if (exe) return exe
    }
  }
  return null
}

function findWhisperModel(): string | null {
  const override = getEnvWithLegacy(WHISPER_MODEL_ENV, LEGACY_WHISPER_MODEL_ENV)
  if (override) {
    if (existsSync(override)) return override
    logForDebugging(
      `[hey] configured whisper model ${override} not found on disk`,
    )
  }

  // Common model locations across distributions of whisper.cpp. Prefer
  // English-only (.en) variants when available — smaller, faster, more
  // accurate for English speech. Fall back to multilingual otherwise.
  const home = homedir()
  const candidates = [
    // voicemode default layout
    join(home, '.voicemode', 'models', 'whisper', 'ggml-small.en.bin'),
    join(home, '.voicemode', 'models', 'whisper', 'ggml-small.bin'),
    join(home, '.voicemode', 'models', 'whisper', 'ggml-base.en.bin'),
    join(home, '.voicemode', 'models', 'whisper', 'ggml-base.bin'),
    // whisper.cpp clone default
    join(home, 'whisper.cpp', 'models', 'ggml-small.en.bin'),
    join(home, 'whisper.cpp', 'models', 'ggml-small.bin'),
    join(home, 'whisper.cpp', 'models', 'ggml-base.en.bin'),
    join(home, 'whisper.cpp', 'models', 'ggml-base.bin'),
    // Generic cache
    join(home, '.cache', 'whisper', 'ggml-small.en.bin'),
    join(home, '.cache', 'whisper', 'ggml-small.bin'),
    join(home, '.cache', 'whisper', 'ggml-base.en.bin'),
    join(home, '.cache', 'whisper', 'ggml-base.bin'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export type WhisperAvailability = {
  available: boolean
  bin: string | null
  model: string | null
  reason: string | null
}

function getInstallHint(missing: 'binary' | 'model'): string {
  if (missing === 'binary') {
    if (process.platform === 'win32') {
      return [
        'whisper.cpp not found.',
        '  Install: scoop install whisper-cpp',
        '  Or download a prebuilt release from https://github.com/ggerganov/whisper.cpp/releases',
        `  Or set ${WHISPER_BIN_ENV}=C:\\path\\to\\whisper-cli.exe`,
      ].join('\n')
    }
    if (process.platform === 'darwin') {
      return [
        'whisper.cpp not found.',
        '  Install: brew install whisper-cpp',
        `  Or set ${WHISPER_BIN_ENV}=/path/to/whisper-cli`,
      ].join('\n')
    }
    return [
      'whisper.cpp not found.',
      '  Build from source: git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make',
      `  Or set ${WHISPER_BIN_ENV}=/path/to/whisper-cli`,
    ].join('\n')
  }
  return [
    'Whisper model file not found.',
    '  Download a model (ggml-small.en.bin recommended for voice accuracy, ~466MB):',
    '    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    '  ggml-base.en.bin is faster but less accurate for casual coding speech.',
    `  Place at ~/.voicemode/models/whisper/ggml-small.en.bin or set ${WHISPER_MODEL_ENV}=/path/to/model.bin`,
  ].join('\n')
}

export function checkWhisperAvailable(): WhisperAvailability {
  if (cachedPaths) {
    return {
      available: true,
      bin: cachedPaths.bin,
      model: cachedPaths.model,
      reason: null,
    }
  }
  const bin = findWhisperBin()
  if (!bin) {
    return {
      available: false,
      bin: null,
      model: null,
      reason: getInstallHint('binary'),
    }
  }
  const model = findWhisperModel()
  if (!model) {
    return {
      available: false,
      bin,
      model: null,
      reason: getInstallHint('model'),
    }
  }
  cachedPaths = { bin, model }
  return { available: true, bin, model, reason: null }
}

export function _resetWhisperCacheForTesting(): void {
  cachedPaths = null
}

// Wrap raw 16-bit signed-LE mono PCM in a minimal WAV header so whisper-cli
// can read it as a normal audio file. Using a temp WAV instead of stdin
// because not every whisper.cpp build accepts piped input via -.
function makeWavHeader(pcmByteLength: number): Buffer {
  const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)
  const blockAlign = CHANNELS * (BIT_DEPTH / 8)
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + pcmByteLength, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(CHANNELS, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(BIT_DEPTH, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(pcmByteLength, 40)
  return buf
}

export type TranscribeOptions = {
  language?: string
  prompt?: string
  signal?: AbortSignal
}

function getWhisperPrompt(override?: string): string | undefined {
  if (override !== undefined) return override.trim() || undefined
  const envPrompt = getEnvWithLegacy(
    WHISPER_PROMPT_ENV,
    LEGACY_WHISPER_PROMPT_ENV,
  )
  if (envPrompt !== undefined) return envPrompt.trim() || undefined
  return DEFAULT_WHISPER_PROMPT
}

function formatWhisperArgsForLog(args: string[]): string {
  return args
    .map((arg, index) => {
      if (args[index - 1] === '--prompt') return `<prompt:${arg.length} chars>`
      return arg
    })
    .join(' ')
}

function isUnsupportedPromptError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    /(?:unknown|invalid|unrecognized|unexpected).{0,80}(?:argument|option|prompt)/i.test(
      message,
    ) ||
    /(?:argument|option|prompt).{0,80}(?:unknown|invalid|unrecognized)/i.test(
      message,
    )
  )
}

async function runWhisperCli(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const onAbort = () => {
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort)
      if (code !== 0) {
        const detail = `${stderr}\n${stdout}`.slice(-600).trim()
        reject(new Error(`whisper-cli exited ${code}: ${detail}`))
        return
      }
      resolve()
    })
    child.on('error', err => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
  })
}

// Transcribe a 16 kHz / 16-bit / mono PCM buffer to text using whisper-cli.
// Returns the cleaned-up transcript (no timestamps, segments joined by spaces).
// Throws if whisper.cpp is not installed or the binary fails.
export async function transcribePcm(
  pcm: Buffer,
  opts: TranscribeOptions = {},
): Promise<string> {
  const avail = checkWhisperAvailable()
  if (!avail.available || !avail.bin || !avail.model) {
    throw new Error(avail.reason ?? 'whisper.cpp not available')
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'tau-hey-'))
  const wavPath = join(tempDir, 'audio.wav')
  const txtStem = join(tempDir, 'audio')
  const txtPath = `${txtStem}.txt`

  try {
    const wav = Buffer.concat([makeWavHeader(pcm.length), pcm])
    await writeFile(wavPath, wav)

    // -otxt + -of writes the transcript to <stem>.txt — much more reliable
    // than parsing stdout, which is polluted by init/info lines on some
    // builds. -np suppresses progress dots; -nt strips timestamps.
    const language = opts.language ?? 'en'
    const args = [
      '-m',
      avail.model,
      '-f',
      wavPath,
      '-l',
      language,
      '-nt',
      '-np',
      '-otxt',
      '-of',
      txtStem,
    ]
    const prompt = getWhisperPrompt(opts.prompt)
    const argsWithPrompt = prompt ? [...args, '--prompt', prompt] : args

    logForDebugging(
      `[hey] running ${avail.bin} ${formatWhisperArgsForLog(argsWithPrompt)} (pcm ${pcm.length}B, promptChars=${prompt?.length ?? 0})`,
    )

    try {
      await runWhisperCli(avail.bin, argsWithPrompt, opts.signal)
    } catch (err) {
      if (!prompt || !isUnsupportedPromptError(err)) throw err
      logForDebugging(
        '[hey] whisper prompt option unsupported by this build; retrying without --prompt',
      )
      await runWhisperCli(avail.bin, args, opts.signal)
    }

    let raw = ''
    try {
      raw = await readFile(txtPath, 'utf8')
    } catch (err) {
      // Some whisper.cpp builds emit transcript to stdout when -of is the
      // wav stem itself. Surface a clear error rather than silently
      // returning empty — caller will show the message to the user.
      logError(err as Error)
      throw new Error(
        'whisper-cli completed but produced no transcript file. Check that your whisper.cpp build supports -otxt -of.',
      )
    }

    return raw.replace(/\s+/g, ' ').trim()
  } finally {
    void rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
