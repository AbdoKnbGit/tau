import { access } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { which } from '../../utils/which.js'

export const RUST_ANALYZER_COMMAND = 'rust-analyzer'
export const RUST_ANALYZER_PLUGIN_ID =
  'rust-analyzer-lsp@claude-plugins-official'

const READINESS_TIMEOUT_MS = 5_000
const INSTALL_TIMEOUT_MS = 5 * 60_000

export type RustAnalyzerReadiness = {
  ready: boolean
  commandPath: string | null
  rustupPath: string | null
  detail?: string
}

const readinessCache = new Map<string, Promise<RustAnalyzerReadiness>>()

export function isRustAnalyzerCommand(command: string): boolean {
  const executable = basename(command.trim()).toLowerCase()
  return executable === 'rust-analyzer' || executable === 'rust-analyzer.exe'
}

async function resolveExecutable(command: string): Promise<string | null> {
  const hasPathSeparator = command.includes('/') || command.includes('\\')
  if (isAbsolute(command) || hasPathSeparator) {
    try {
      await access(command, fsConstants.X_OK)
      return command
    } catch {
      return null
    }
  }
  return which(command).catch(() => null)
}

function resultDetail(result: {
  stdout: string
  stderr: string
  error?: string
}): string | undefined {
  const detail = result.stderr.trim() || result.stdout.trim() || result.error
  if (!detail) return undefined
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail
}

/**
 * Verify that rust-analyzer is runnable for the active workspace, not merely
 * present on PATH. This catches rustup proxies whose selected toolchain does
 * not have the rust-analyzer component installed.
 */
export function checkRustAnalyzerReadiness(
  cwd = getCwd(),
  command = RUST_ANALYZER_COMMAND,
): Promise<RustAnalyzerReadiness> {
  const cacheKey = `${cwd}\0${command}`
  const cached = readinessCache.get(cacheKey)
  if (cached) return cached

  const check = (async (): Promise<RustAnalyzerReadiness> => {
    const [commandPath, rustupPath] = await Promise.all([
      resolveExecutable(command),
      resolveExecutable('rustup'),
    ])
    if (!commandPath) {
      return {
        ready: false,
        commandPath: null,
        rustupPath,
        detail: `${RUST_ANALYZER_COMMAND} was not found on PATH`,
      }
    }

    const result = await execFileNoThrowWithCwd(commandPath, ['--version'], {
      cwd,
      timeout: READINESS_TIMEOUT_MS,
      preserveOutputOnError: true,
      stdin: 'ignore',
      killTreeOnTimeout: true,
    })
    return {
      ready: result.code === 0,
      commandPath,
      rustupPath,
      detail: result.code === 0 ? undefined : resultDetail(result),
    }
  })()

  readinessCache.set(cacheKey, check)
  return check
}

export function clearRustAnalyzerReadinessCache(): void {
  readinessCache.clear()
}

/**
 * Install rust-analyzer for the workspace-selected Rust toolchain. The caller
 * must obtain explicit user consent before invoking this function.
 */
export async function installRustAnalyzerWithRustup(
  cwd = getCwd(),
): Promise<RustAnalyzerReadiness> {
  const rustupPath = await resolveExecutable('rustup')
  if (!rustupPath) {
    return {
      ready: false,
      commandPath: null,
      rustupPath: null,
      detail:
        'rustup is unavailable; install rust-analyzer with your Rust distribution, then retry',
    }
  }

  const result = await execFileNoThrowWithCwd(
    rustupPath,
    ['component', 'add', 'rust-analyzer'],
    {
      cwd,
      timeout: INSTALL_TIMEOUT_MS,
      preserveOutputOnError: true,
      stdin: 'ignore',
      killTreeOnTimeout: true,
    },
  )
  clearRustAnalyzerReadinessCache()

  if (result.code !== 0) {
    return {
      ready: false,
      commandPath: null,
      rustupPath,
      detail:
        resultDetail(result) ??
        'rustup could not install the rust-analyzer component',
    }
  }

  return checkRustAnalyzerReadiness(cwd)
}
