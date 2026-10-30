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

// Node's V8 delayed-task shutdown race is fixed in 24.20.0 and 26.7.0.
// Node 23 and 25 ended before the fix was backported.
// https://github.com/nodejs/node/pull/61999
const WINDOWS_SHUTDOWN_FIXED_MINOR = new Map([[24, 20], [26, 7]])

// When each release line stops getting security updates.
// https://github.com/nodejs/Release
const NODE_END_OF_LIFE = new Map([
  [20, '2026-04-30'],
  [22, '2027-04-30'],
  [23, '2025-06-01'],
  [24, '2028-04-30'],
  [25, '2026-06-01'],
  [26, '2029-04-30'],
])

const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'

const today = now => now.toISOString().slice(0, 10)
const majorOf = version => Number(/^v?(\d+)\./.exec(version)?.[1])

function recommendedNode(now) {
  const line = [24, 26].find(major => today(now) <= NODE_END_OF_LIFE.get(major))
  return line ? `Node.js ${line} LTS` : 'the current Node.js LTS'
}

export function getNodeRuntimeIssue(version, platform = process.platform) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) return 'unsupported-version'
  const major = Number(match[1]), minor = Number(match[2])
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23))
    return 'require-esm'
  if (platform === 'win32' && major >= 23 && major < 27 &&
    !(minor >= WINDOWS_SHUTDOWN_FIXED_MINOR.get(major)))
    return 'windows-shutdown'
  return null
}

export function nodeRuntimeMessage(version, issue, now = new Date()) {
  if (issue === 'windows-shutdown') {
    const major = majorOf(version)
    const fixedMinor = WINDOWS_SHUTDOWN_FIXED_MINOR.get(major)
    const target = fixedMinor === undefined ? recommendedNode(now) : `Node.js ${major}.${fixedMinor} or newer`
    return `[tau] Warning: Node.js ${version} has a Windows bug that can crash Tau when it exits. Update to ${target}: ${NODE_DOWNLOAD_URL}\n`
  }
  return `[tau] Tau requires Node.js 20.19+ or 22.12+ (require(esm) support); you are running ${version}. Install ${recommendedNode(now)} from ${NODE_DOWNLOAD_URL}, then retry.\n`
}

/** Empty while the version's release line still gets security updates. */
export function nodeEndOfLifeMessage(version, now = new Date()) {
  const end = NODE_END_OF_LIFE.get(majorOf(version))
  if (!end || today(now) <= end) return ''
  return `[tau] Warning: Node.js ${version} stopped getting security updates on ${end}. Update to ${recommendedNode(now)}: ${NODE_DOWNLOAD_URL}\n`
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
