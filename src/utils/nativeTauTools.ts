import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getCwd } from './cwd.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const binaryName = process.platform === 'win32' ? 'tau-tools.exe' : 'tau-tools'
let cachedNativeTauToolsPath: string | null | undefined

export function getNativeTauToolsPath(): string | null {
  if (cachedNativeTauToolsPath !== undefined) {
    return cachedNativeTauToolsPath
  }

  const candidates = [
    // Bundled JS package: dist/cli.mjs -> dist/native/tau-tools.
    resolve(moduleDir, 'native', binaryName),
    // Source/dev execution: src/utils/nativeTauTools.ts -> dist/native/tau-tools.
    resolve(moduleDir, '../../dist/native', binaryName),
    // Some test/bundle layouts place this module one level below dist.
    resolve(moduleDir, '../native', binaryName),
  ]

  cachedNativeTauToolsPath =
    candidates.find(candidate => existsSync(candidate)) ?? null
  return cachedNativeTauToolsPath
}

export function isNativeTauToolsAvailable(): boolean {
  return getNativeTauToolsPath() !== null
}

export async function runNativeTauTool(
  command: string,
  args: string[],
  options: {
    input?: string
    timeoutMs?: number
    maxBuffer?: number
  } = {},
): Promise<string> {
  const binary = getNativeTauToolsPath()
  if (!binary) {
    throw new Error(
      'Native Tau tools are not available. Run `npm run build:native-tools` from the Tau repository, or reinstall with Go 1.25.8+ available.',
    )
  }

  const result = await execFileNoThrowWithCwd(binary, [command, ...args], {
    cwd: getCwd(),
    abortSignal: undefined,
    timeout: options.timeoutMs ?? 30_000,
    preserveOutputOnError: true,
    maxBuffer: options.maxBuffer ?? 5_000_000,
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    input: options.input,
  })

  if (result.code !== 0) {
    const detail = [result.stderr, result.error, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim()
    throw new Error(detail || `tau-tools ${command} failed`)
  }

  return result.stdout
}

export function runNativeTauToolSync(
  command: string,
  args: string[],
  options: {
    input?: string
    timeoutMs?: number
    maxBuffer?: number
  } = {},
): string | null {
  const binary = getNativeTauToolsPath()
  if (!binary) return null

  const result = spawnSync(binary, [command, ...args], {
    cwd: getCwd(),
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: options.maxBuffer ?? 1_000_000,
    windowsHide: true,
  })

  if (result.status !== 0 || result.error) {
    return null
  }

  return result.stdout
}
