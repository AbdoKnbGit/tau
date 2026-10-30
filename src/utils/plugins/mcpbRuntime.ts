import { constants } from 'fs'
import { access, chmod, lstat, open, stat } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, isAbsolute, join, normalize, relative } from 'path'
import { isInBundledMode } from '../bundledMode.js'
import { logForDebugging } from '../debug.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'
import { satisfies } from '../semver.js'

export type McpbLaunchConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

type McpbCompatibility = {
  platforms?: unknown
  runtimes?: { python?: unknown; node?: unknown }
}

type RuntimeCandidate = { command: string; prefix: string[] }

/**
 * The bundle cannot start on this machine, for a reason the user can act on.
 * The message is shown as written, instead of a late "Connection closed".
 */
export class McpbRuntimeError extends Error {}

const PROBE_TIMEOUT_MS = 10_000
const RELOAD_HINT = 'reopen the terminal, then run /reload-plugins'
const PYTHON_INSTALL_URL = 'https://www.python.org/downloads/'
const INSTALL_URLS: Record<string, string> = {
  uv: 'https://docs.astral.sh/uv/getting-started/installation/',
}

// Tried after the command the bundle asked for. The first that really runs wins.
const PYTHON_FALLBACKS: RuntimeCandidate[] =
  process.platform === 'win32'
    ? [
        { command: 'python', prefix: [] },
        { command: 'py', prefix: ['-3'] },
        { command: 'python3', prefix: [] },
      ]
    : [
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] },
      ]

const MACH_O_MAGIC = [
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  'cafebabe',
  'cafebabf',
]

// Successes only, so installing a runtime and reloading plugins takes effect.
// Keeps the answer stable within a session too: a different command would change
// the config hash and make excludeStalePluginClients reconnect the server.
const resolvedRuntimes = new Map<string, RuntimeCandidate>()

function pathValue(env: NodeJS.ProcessEnv): string {
  const key =
    process.platform === 'win32'
      ? Object.keys(env).find(name => name.toUpperCase() === 'PATH')
      : 'PATH'
  return (key && env[key]) || ''
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
}

async function exists(path: string): Promise<boolean> {
  try {
    // lstat: Windows' app execution aliases refuse stat.
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Same search the launch will do: the cwd and PATH on Windows, PATH elsewhere. */
async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const isWindows = process.platform === 'win32'
  const dirs = pathValue(env).split(delimiter).filter(Boolean)
  const extensions = isWindows ? ['', ...windowsExtensions(env)] : ['']
  for (const dir of isWindows ? [process.cwd(), ...dirs] : dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension)
      try {
        const info = await lstat(candidate)
        if (info.isDirectory()) continue
        if (!isWindows) await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here, keep looking.
      }
    }
  }
  return null
}

/** Manifests may use Python's comma form (">=3.10,<4"). */
function declaredRange(range: unknown): string | undefined {
  return typeof range === 'string' ? range.replaceAll(',', ' ') : undefined
}

function meetsRange(version: string, range: string | undefined): boolean {
  return !range || satisfies(version, range)
}

async function probeVersion(
  candidate: RuntimeCandidate,
  pattern: RegExp,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  // From the home folder: on Windows the current folder is searched first, and
  // a checked-out repository must not get a program run just by being there.
  const { stdout, stderr, code } = await execFileNoThrowWithCwd(
    candidate.command,
    [...candidate.prefix, '--version'],
    {
      timeout: PROBE_TIMEOUT_MS,
      preserveOutputOnError: true,
      cwd: homedir(),
      env,
    },
  )
  if (code !== 0) return null
  const match = pattern.exec(`${stdout}\n${stderr}`)
  return match ? `${match[1]}${match[2] ?? '.0'}` : null
}

/**
 * Runs each candidate instead of guessing from names or paths, which is what
 * keeps this the same on every OS: Windows' Store placeholder exits with an
 * error, Python 2 fails the version check, and a real Store Python passes.
 * A declared version range only picks between working Pythons. Authors often
 * list what they tested, so a mismatch is logged, not fatal.
 */
async function resolvePython(
  command: string,
  range: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeCandidate> {
  const memoKey = JSON.stringify([command, range, pathValue(env)])
  const memoized = resolvedRuntimes.get(memoKey)
  if (memoized) return memoized

  let outOfRange: RuntimeCandidate | undefined
  for (const candidate of [
    { command, prefix: [] },
    ...PYTHON_FALLBACKS.filter(fallback => fallback.command !== command),
  ]) {
    const version = await probeVersion(candidate, /^Python (3\.\d+)(\.\d+)?/m, env)
    if (!version) continue
    if (meetsRange(version, range)) {
      resolvedRuntimes.set(memoKey, candidate)
      return candidate
    }
    outOfRange ??= candidate
  }
  if (outOfRange) {
    logForDebugging(
      `MCPB wants Python ${range}, none found; trying ${outOfRange.command}`,
      { level: 'warn' },
    )
    resolvedRuntimes.set(memoKey, outOfRange)
    return outOfRange
  }
  const placeholderNote =
    process.platform === 'win32'
      ? ' (the Microsoft Store placeholder does not count)'
      : ''
  throw new McpbRuntimeError(
    `This plugin needs Python, which was not found${placeholderNote}. Install Python 3 from ${PYTHON_INSTALL_URL}, ${RELOAD_HINT}.`,
  )
}

/** Tau already runs on Node, so a bundle's "node" always has a fallback. */
async function resolveNode(
  command: string,
  range: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const onPath = await findOnPath(command, env)
  if (onPath) {
    if (!range) return command
    const version = await probeVersion(
      { command, prefix: [] },
      /^v(\d+\.\d+)(\.\d+)?/m,
      env,
    )
    if (version && meetsRange(version, range)) return command
  }
  if (!isInBundledMode() && meetsRange(process.versions.node, range)) {
    return process.execPath
  }
  if (onPath) return command
  throw new McpbRuntimeError(
    `This plugin needs Node.js, which was not found. Install it, ${RELOAD_HINT}.`,
  )
}

async function nativeProgramOs(
  path: string,
): Promise<'Windows' | 'macOS' | 'Linux' | null> {
  const file = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(4), 0, 4, 0)
    const magic = buffer.toString('hex', 0, bytesRead)
    if (magic.startsWith('4d5a')) return 'Windows'
    if (magic === '7f454c46') return 'Linux'
    return MACH_O_MAGIC.includes(magic) ? 'macOS' : null
  } finally {
    await file.close()
  }
}

/**
 * A program named by full path, usually ${__dirname}/bin/server. Bundles packed
 * on Windows carry no exec bit, and a program built for another OS only fails
 * later with an unrelated error, so both are settled here.
 */
async function prepareProgramPath(
  command: string,
  extractedPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const program = normalize(command)
  const extensions =
    process.platform === 'win32' ? ['', ...windowsExtensions(env)] : ['']
  let found: string | undefined
  for (const extension of extensions) {
    if (await exists(program + extension)) {
      found = program + extension
      break
    }
  }
  if (!found) {
    throw new McpbRuntimeError(
      `This plugin's server program is missing: ${command}. It may not support this operating system.`,
    )
  }
  const fromBundle = relative(extractedPath, found)
  if (fromBundle.startsWith('..') || isAbsolute(fromBundle)) return program

  const programOs = await nativeProgramOs(found)
  const currentOs =
    process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'darwin'
        ? 'macOS'
        : 'Linux'
  const runsViaWsl = programOs === 'Windows' && getPlatform() === 'wsl'
  if (programOs && programOs !== currentOs && !runsViaWsl) {
    throw new McpbRuntimeError(
      `This plugin only ships a ${programOs} program (${fromBundle}), so it cannot run on ${currentOs}. Ask the plugin author for a ${currentOs} build.`,
    )
  }
  if (process.platform !== 'win32') {
    const { mode } = await stat(found)
    if (!(mode & 0o111)) {
      await chmod(found, mode | 0o755).catch(error => {
        logForDebugging(`Could not mark ${found} executable: ${error}`, {
          level: 'warn',
        })
      })
    }
  }
  return program
}

/**
 * Turn a manifest's command into one that runs here, or explain why it can't.
 * Runs on every load (nothing here reaches the on-disk cache), because the
 * answer belongs to this machine and today's PATH, not to the bundle.
 */
export async function resolveMcpbLaunch(
  config: McpbLaunchConfig,
  compatibility: McpbCompatibility | undefined,
  extractedPath: string,
): Promise<McpbLaunchConfig> {
  const platforms = compatibility?.platforms
  if (Array.isArray(platforms) && !platforms.includes(process.platform)) {
    // Not fatal: bundles written for Claude Desktop rarely list Linux, yet most
    // scripts run there. A wrong-OS program is caught below.
    logForDebugging(
      `MCPB lists platforms ${platforms.join(', ')}; trying on ${process.platform}`,
    )
  }

  const env = { ...process.env, ...config.env }
  const args = config.args ?? []
  const { command } = config

  if (isAbsolute(command)) {
    return {
      ...config,
      command: await prepareProgramPath(command, extractedPath, env),
      args,
    }
  }
  if (/[\\/]/.test(command)) return { ...config, args }

  const name = command.toLowerCase().replace(/\.exe$/, '')
  if (name === 'python' || name === 'python3') {
    const python = await resolvePython(
      command,
      declaredRange(compatibility?.runtimes?.python),
      env,
    )
    return {
      ...config,
      command: python.command,
      args: [...python.prefix, ...args],
    }
  }
  if (name === 'node') {
    return {
      ...config,
      command: await resolveNode(
        command,
        declaredRange(compatibility?.runtimes?.node),
        env,
      ),
      args,
    }
  }
  if (!(await findOnPath(command, env))) {
    const installUrl = INSTALL_URLS[name]
    const install = installUrl ? `Install it from ${installUrl}` : 'Install it'
    throw new McpbRuntimeError(
      `This plugin needs "${command}", which was not found on your PATH. ${install}, ${RELOAD_HINT}.`,
    )
  }
  return { ...config, args }
}
