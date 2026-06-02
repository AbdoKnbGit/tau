import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const NATIVE_SHELL_PARSER_TIMEOUT_MS = 1_500
const MAX_NATIVE_SHELL_INPUT_BYTES = 512 * 1024

export type NativeShellDiagnostic = {
  message: string
  line?: number
  column?: number
  offset?: number
}

export type NativeShellSummary = {
  commandCount: number
  firstCommands: string[]
  operators: string[]
  hasCd: boolean
  hasPipeline: boolean
  hasRedirect: boolean
  hasControlFlow: boolean
  hasHeredoc: boolean
  hasFunction: boolean
  hasSubshell: boolean
  hasCommandSubstitution: boolean
}

export type NativeShellAnalysis = {
  ok: boolean
  parser: string
  formatted?: string
  diagnostics?: NativeShellDiagnostic[]
  summary?: NativeShellSummary
}

function nativeBinaryName(): string {
  return process.platform === 'win32' ? 'tau-shell-parse.exe' : 'tau-shell-parse'
}

export function findNativeShellParserBinary(): string | null {
  if (process.env.TAU_DISABLE_NATIVE_SHELL_PARSER === '1') return null

  const explicit = process.env.TAU_SHELL_PARSE_BIN
  if (explicit && existsSync(explicit)) return explicit

  const here = dirname(fileURLToPath(import.meta.url))
  const name = nativeBinaryName()
  const candidates = [
    join(here, 'native', name),
    resolve(process.cwd(), 'dist', 'native', name),
    resolve(here, '..', '..', '..', 'dist', 'native', name),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function isNativeShellAnalysis(value: unknown): value is NativeShellAnalysis {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.ok === 'boolean' && typeof record.parser === 'string'
}

export async function analyzeNativeShellCommand(
  command: string,
): Promise<NativeShellAnalysis | null> {
  if (command.trim() === '') return null

  const payload = JSON.stringify({ command })
  if (Buffer.byteLength(payload, 'utf8') > MAX_NATIVE_SHELL_INPUT_BYTES) {
    return null
  }

  const binary = findNativeShellParserBinary()
  if (!binary) return null

  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let proc

    const finish = (analysis: NativeShellAnalysis | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(analysis)
    }

    try {
      proc = spawn(binary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      resolve(null)
      return
    }

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish(null)
    }, NATIVE_SHELL_PARSER_TIMEOUT_MS)

    proc.stdout?.on('data', data => {
      stdout += data.toString('utf8')
    })
    proc.stderr?.on('data', data => {
      stderr += data.toString('utf8')
    })
    proc.on('error', () => finish(null))
    proc.on('close', () => {
      if (!stdout.trim()) {
        finish(null)
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        if (isNativeShellAnalysis(parsed)) {
          finish(parsed)
          return
        }
      } catch {
        // ignore malformed helper output
      }
      if (stderr.trim()) {
        finish({
          ok: false,
          parser: 'native-shell-parser',
          diagnostics: [{ message: stderr.trim() }],
        })
        return
      }
      finish(null)
    })

    proc.stdin?.end(payload, 'utf8')
  })
}
