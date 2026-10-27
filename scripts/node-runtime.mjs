import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

function environmentValue(env, name, platform) {
  if (platform !== 'win32') return env[name]
  // Match Node's child-process environment handling, including duplicate casing.
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function fullyQualifiedPath(directory, platform) {
  if (/[\0\r\n]/.test(directory)) return false
  return platform === 'win32'
    ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(directory)
    : posix.isAbsolute(directory)
}

export function getNodeRuntimeIssue(version, platform = process.platform) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return 'unsupported-version'
  const major = Number(match[1]), minor = Number(match[2])
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23))
    return 'require-esm'
  // Node's V8 delayed-task shutdown race is fixed in 24.20.0 and 26.7.0.
  // Node 23 and 25 ended before the fix was backported.
  // https://github.com/nodejs/node/pull/61999
  if (platform === 'win32' && major >= 23 &&
    !((major === 24 && minor >= 20) || (major === 26 && minor >= 7) || major >= 27))
    return 'windows-shutdown'
  return null
}

export function nodeRuntimeMessage(version, issue) {
  return issue === 'windows-shutdown'
    ? ''
    : `[tau] Tau requires Node.js 20.19+ or 22.12+ (require(esm) support); you are running ${version}. Upgrade Node.js, then retry.\n`
}

export function managedNodeRuntimePath(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return null
  const directory = environmentValue(env, 'LOCALAPPDATA', platform)
  return directory && fullyQualifiedPath(directory, platform)
    ? win32.join(directory, 'Tau', 'runtime', 'node.exe')
    : null
}

/** Resolve only absolute PATH entries and Tau's managed runtime. */
export function findCompatibleNodeRuntime({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  realpath = realpathSync,
  probe = candidate => spawnSync(candidate, ['-p', 'JSON.stringify({version:process.versions.node,arch:process.arch})'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  }),
} = {}) {
  const separator = platform === 'win32' ? ';' : ':'
  const paths = platform === 'win32' ? win32 : posix
  const searchPath = environmentValue(env, 'PATH', platform)
  const canonical = value => {
    let result
    try { result = realpath(value) } catch { result = value }
    return platform === 'win32' ? result.toLowerCase() : result
  }
  const seen = new Set([canonical(execPath)])
  const candidates = []
  for (const entry of (searchPath ?? '').split(separator)) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    if (!fullyQualifiedPath(directory, platform)) continue
    candidates.push(paths.join(directory, platform === 'win32' ? 'node.exe' : 'node'))
  }
  const managed = managedNodeRuntimePath(env, platform)
  if (managed) candidates.push(managed)
  for (const candidate of candidates) {
    if (!exists(candidate)) continue
    const identity = canonical(candidate)
    if (seen.has(identity)) continue
    seen.add(identity)
    try {
      const result = probe(candidate)
      if (result.error || result.status !== 0) continue
      const reported = JSON.parse(String(result.stdout ?? ''))
      if (reported?.arch === arch && typeof reported.version === 'string' &&
        getNodeRuntimeIssue(reported.version, platform) === null)
        return candidate
    } catch {
      // A stale/unusable PATH entry must not prevent checking later entries.
    }
  }
  return null
}
