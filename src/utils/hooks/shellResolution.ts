import { accessSync, constants, statSync } from 'fs'
import { findPowerShell } from '../shell/powershellDetection.js'
import { discoverGitBashPath } from '../windowsPaths.js'
import { getCwd } from '../cwd.js'
import { executablePaths } from '../executablePath.js'

function resolutionKey(): string {
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'CLAUDE_CODE_GIT_BASH_PATH'])
  const environment = Object.keys(process.env).sort()
    .filter(name => names.has(process.platform === 'win32' ? name.toUpperCase() : name))
    .map(name => [name, process.env[name]])
  let processCwd: string | undefined
  try { processCwd = process.cwd() } catch { /* The original worktree may have been removed. */ }
  return JSON.stringify([process.platform, processCwd, getCwd(), environment])
}

function available(path: string | null): path is string {
  if (!path) return false
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

let bash: { key: string; path: string } | undefined
let powershell: { key: string; path: Promise<string | null> } | undefined

/** Hook resolution rechecks cached files and never permanently caches a miss. */
export function getHookGitBashPath(): string | null {
  const key = resolutionKey()
  if (bash?.key === key && available(bash.path)) return bash.path
  const path = discoverGitBashPath()
  bash = available(path) ? { key, path } : undefined
  return bash?.path ?? null
}

export async function getHookPowerShellPath(): Promise<string | null> {
  const key = resolutionKey()
  const cached = powershell
  if (cached?.key === key) {
    const path = await cached.path
    if (available(path)) return path
  }
  const entry = { key, path: findPowerShell(async command => executablePaths(command)[0] ?? null) }
  powershell = entry
  try {
    const path = await entry.path
    if (available(path)) return path
    if (powershell === entry) powershell = undefined
    return null
  } catch (error) {
    if (powershell === entry) powershell = undefined
    throw error
  }
}
