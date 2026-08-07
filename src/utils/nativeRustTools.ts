import { statSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { getCwd } from './cwd.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const binaryName =
  process.platform === 'win32' ? 'tau-rust-tools.exe' : 'tau-rust-tools'

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') return true
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export function getNativeRustToolsPath(): string | null {
  const candidates = [
    // Bundled JS package: dist/cli.mjs -> dist/native/tau-rust-tools.
    resolve(moduleDir, 'native', binaryName),
    // Source/dev execution: src/utils/nativeRustTools.ts -> dist/native/....
    resolve(moduleDir, '../../dist/native', binaryName),
    // Some test/bundle layouts place this module one level below dist.
    resolve(moduleDir, '../native', binaryName),
  ]
  return candidates.find(candidate => isExecutableFile(candidate)) ?? null
}

export function isNativeRustToolsAvailable(): boolean {
  return getNativeRustToolsPath() !== null
}

export async function runNativeRustTool(
  command: string,
  args: string[],
  options: {
    abortSignal?: AbortSignal
    timeoutMs?: number
    maxBuffer?: number
    input?: string
  } = {},
): Promise<string> {
  const binary = getNativeRustToolsPath()
  if (!binary) {
    throw new Error(
      'Native Rust capabilities are not available. Run `node scripts/build-native-rust-tools.mjs` from the Tau repository, or reinstall with Rust 1.85+ available.',
    )
  }

  const result = await execFileNoThrowWithCwd(binary, [command, ...args], {
    cwd: getCwd(),
    abortSignal: options.abortSignal,
    timeout: options.timeoutMs ?? 30_000,
    preserveOutputOnError: true,
    maxBuffer: options.maxBuffer ?? 5_000_000,
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    input: options.input,
    killTreeOnTimeout: true,
  })

  if (result.code !== 0) {
    const detail = [result.stderr, result.error, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim()
    throw new Error(detail || `tau-rust-tools ${command} failed`)
  }
  return result.stdout
}
