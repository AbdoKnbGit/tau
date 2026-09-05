/**
 * Locates the `cloudflared` binary.
 *
 * PATH alone is not enough. The Windows installer drops the binary in
 * `C:\Program Files (x86)\cloudflared` and never touches PATH; winget and
 * Homebrew do add it, but to an environment a long-running process started
 * before the install will never see. Telling a user who just installed it
 * "cloudflared is not installed" is both wrong and unactionable, so search the
 * places every installer actually uses before giving up.
 *
 * PATH resolution is done by hand rather than by shelling out to
 * `where`/`which`: one code path for every OS, no shell, and it honours
 * PATHEXT on Windows.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const BIN = 'cloudflared'

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

function executableNames(): string[] {
  if (process.platform !== 'win32') return [BIN]
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
    .split(';')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
  // Plain `cloudflared` last: CreateProcess would find it, but an extensionless
  // file on Windows is the unusual case.
  return [...exts.map(ext => BIN + ext), BIN]
}

function fromPath(): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const names = executableNames()
  const out: string[] = []
  for (const dir of dirs) {
    for (const name of names) out.push(join(dir, name))
  }
  return out
}

/** Directories that hold a `Cloudflare.cloudflared_*` package folder. */
function wingetPackageDirs(): string[] {
  const root = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : null
  if (!root || !existsSync(root)) return []
  try {
    return readdirSync(root)
      .filter(name => name.toLowerCase().startsWith('cloudflare.cloudflared'))
      .map(name => join(root, name))
  } catch {
    return []
  }
}

function wellKnown(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      // The official .msi lands here and does not edit PATH.
      join(pf86, 'cloudflared', 'cloudflared.exe'),
      join(pf, 'cloudflared', 'cloudflared.exe'),
      join(local, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
      ...wingetPackageDirs().map(dir => join(dir, 'cloudflared.exe')),
      join(home, 'scoop', 'shims', 'cloudflared.exe'),
      join(process.env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey', 'bin', 'cloudflared.exe'),
    ]
  }

  if (process.platform === 'darwin') {
    return [
      '/opt/homebrew/bin/cloudflared', // Apple Silicon
      '/usr/local/bin/cloudflared', // Intel
      '/opt/local/bin/cloudflared', // MacPorts
      join(home, '.local', 'bin', 'cloudflared'),
    ]
  }

  return [
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/bin/cloudflared',
    '/snap/bin/cloudflared',
    join(home, '.local', 'bin', 'cloudflared'),
    join(home, 'bin', 'cloudflared'),
  ]
}

export type CloudflaredLocation = {
  path: string
  /** False when it was found off-PATH, which is worth saying out loud. */
  onPath: boolean
}

/**
 * Absolute path to a usable cloudflared, or null. An explicit
 * TAU_CLOUDFLARED wins over everything — the escape hatch for an install
 * in a place nobody predicted.
 */
export function resolveCloudflared(): CloudflaredLocation | null {
  const override = process.env.TAU_CLOUDFLARED?.trim()
  if (override) {
    return isFile(override) ? { path: override, onPath: false } : null
  }

  for (const candidate of fromPath()) {
    if (isFile(candidate)) return { path: candidate, onPath: true }
  }
  for (const candidate of wellKnown()) {
    if (isFile(candidate)) return { path: candidate, onPath: false }
  }
  return null
}

/** Install guidance for the current OS only — three platforms of noise helps nobody. */
export function installHint(): string {
  if (process.platform === 'win32') {
    return 'Install it with:  winget install --id Cloudflare.cloudflared'
  }
  if (process.platform === 'darwin') {
    return 'Install it with:  brew install cloudflared'
  }
  return 'Install it from:  https://pkg.cloudflare.com'
}
