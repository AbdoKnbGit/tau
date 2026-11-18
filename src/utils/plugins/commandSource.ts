/**
 * The `command` plugin source: a command the marketplace declares, run on the
 * user's machine (through sh, or cmd.exe on Windows, from the home directory)
 * after they accept it. It prints the absolute path of a plugin directory,
 * which is copied into the plugin cache (copy mode) or used in place through
 * links (link mode, not on Windows).
 *
 * The command runner is a parameter and the imports are Node built-ins and
 * leaf helpers, so this module is testable on its own.
 */
import { createHash } from 'crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
} from 'fs/promises'
import { dirname, join, posix, win32 } from 'path'
import { hasPluginContent } from './archiveSource.js'
import { copyDir, isWithinDirectory } from './pluginFiles.js'
import type { PluginSource } from './schemas.js'

export type CommandPluginSource = Extract<PluginSource, { source: 'command' }>

export function isCommandSource(
  source: PluginSource,
): source is CommandPluginSource {
  return typeof source === 'object' && source.source === 'command'
}

export function isLinkModeCommandSource(source: PluginSource): boolean {
  return isCommandSource(source) && source.mode === 'link'
}

export const COMMAND_SOURCE_DEFAULT_TIMEOUT_SECONDS = 60
// Copy mode limits (Claude Code's documented ones). Link mode copies nothing.
const MAX_COPY_BYTES = 256 * 1024 * 1024
const MAX_COPY_ENTRIES = 20_000

export type CommandRunner = (
  command: string,
  options: { timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string; stderr: string; error?: string }>

// A command a catalog declares runs without the user's credentials: any
// variable whose name looks like one is removed (Git's GIT_CONFIG_KEY_<n>
// excepted), as Claude Code does for helpers a repository or plugin supplies.
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|CREDENTIAL/i
const CREDENTIAL_NAMES = new Set(['ANTHROPIC_CUSTOM_HEADERS'])
const KEPT_NAME = /^GIT_CONFIG_KEY_\d+$/i

export function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    const credential =
      CREDENTIAL_NAME.test(name) || CREDENTIAL_NAMES.has(name.toUpperCase())
    if (credential && !KEPT_NAME.test(name)) continue
    kept[name] = value
  }
  return kept
}

/** The one absolute path a command printed, or why its output is refused. */
export function parsePrintedDirectory(
  stdout: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  if (lines.length !== 1) {
    throw new Error(
      'must print exactly one line: the absolute path of the plugin directory',
    )
  }
  const printed = lines[0]!.trim()
  if (platform === 'win32' && /^[\\/]{2}/.test(printed)) {
    throw new Error(`printed a network path (${printed}), which is not allowed`)
  }
  const paths = platform === 'win32' ? win32 : posix
  if (!paths.isAbsolute(printed)) {
    throw new Error(`printed "${printed}", which is not an absolute path`)
  }
  return printed
}

/** Resolve and check the printed directory; returns its real path. */
export async function validatePrintedDirectory(
  printed: string,
  sessionCwd: string,
): Promise<string> {
  let real: string
  try {
    real = await realpath(printed)
  } catch {
    throw new Error(`printed ${printed}, which does not exist`)
  }
  if (!(await stat(real)).isDirectory()) {
    throw new Error(`printed ${printed}, which is not a directory`)
  }
  if (!(await hasPluginContent(real))) {
    throw new Error(
      `printed ${printed}, which has no plugin content at its top level (such as .claude-plugin/, skills/, commands/, agents/ or hooks/)`,
    )
  }
  const cwd = await realpath(sessionCwd).catch(() => sessionCwd)
  if (isWithinDirectory(real, cwd)) {
    throw new Error(
      `printed ${printed}, which is the directory this session started in or one of its parents`,
    )
  }
  return real
}

async function assertCopyLimits(dir: string): Promise<void> {
  let entries = 0
  let bytes = 0
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      entries++
      if (entries > MAX_COPY_ENTRIES) {
        throw new Error(
          `printed a directory with more than ${MAX_COPY_ENTRIES} entries; copy mode can't take it (link mode can, outside Windows)`,
        )
      }
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        bytes += (await lstat(path)).size
        if (bytes > MAX_COPY_BYTES) {
          throw new Error(
            'printed a directory larger than 256 MiB; copy mode can\'t take it (link mode can, outside Windows)',
          )
        }
      }
    }
  }
  await walk(dir)
}

/**
 * A digest of a directory's contents: paths, file bytes and link targets, in
 * a fixed order, so identical output gives the identical version on any OS.
 */
export async function hashDirectoryContents(dir: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(current: string, relativePath: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    for (const entry of entries) {
      const path = join(current, entry.name)
      const name = relativePath ? `${relativePath}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        const target = (await readlink(path)).replace(/\\/g, '/')
        hash.update(`L\0${name}\0${target}\0`)
      } else if (entry.isDirectory()) {
        hash.update(`D\0${name}\0`)
        await walk(path, name)
      } else if (entry.isFile()) {
        hash.update(`F\0${name}\0`)
        hash.update(await readFile(path))
        hash.update('\0')
      }
    }
  }
  await walk(dir, '')
  return hash.digest('hex')
}

/** Link mode: one link per top-level entry of the printed directory. */
async function linkPrintedDirectory(
  real: string,
  target: string,
): Promise<string> {
  const names = (await readdir(real)).sort()
  for (const name of names) {
    const path = join(real, name)
    if (!(await lstat(path)).isSymbolicLink()) continue
    const resolved = await realpath(path).catch(() => undefined)
    if (!resolved || !isWithinDirectory(real, resolved)) {
      throw new Error(
        `printed a directory whose top-level entry "${name}" is a symlink pointing outside it`,
      )
    }
  }
  await mkdir(target, { recursive: true })
  for (const name of names) {
    const path = join(real, name)
    const info = await stat(path)
    await symlink(path, join(target, name), info.isDirectory() ? 'dir' : 'file')
  }
  // The version follows the directory's real path and top-level entries,
  // not the files inside them: print a new path to publish new content.
  return createHash('sha256').update(`${real}\n${names.join('\n')}`).digest('hex')
}

/** The directory a link-mode cache entry points into, if it is one. */
export async function linkedDirectoryOf(
  installPath: string,
): Promise<string | undefined> {
  try {
    for (const name of await readdir(installPath)) {
      const path = join(installPath, name)
      if (!(await lstat(path)).isSymbolicLink()) continue
      return await realpath(dirname(await readlink(path)))
    }
  } catch {
    // Not a link-mode entry, or one whose directory is gone.
  }
  return undefined
}

export type CommandSourceOptions = {
  run: CommandRunner
  /** Where the session started; the printed directory may not contain it. */
  sessionCwd: string
  homeDir: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/**
 * Run a command source and put its plugin directory at `targetPath` (which
 * must not exist yet). Returns the digest its version is derived from.
 * Errors read as the end of "The command for plugin X …".
 */
export async function installFromCommandSource(
  source: CommandPluginSource,
  targetPath: string,
  options: CommandSourceOptions,
): Promise<{ digest: string }> {
  const platform = options.platform ?? process.platform
  const mode = source.mode ?? 'copy'
  if (mode === 'link' && platform === 'win32') {
    throw new Error(
      'uses "mode": "link", which is not supported on Windows; the marketplace entry needs "mode": "copy"',
    )
  }

  const timeoutSeconds = source.timeout ?? COMMAND_SOURCE_DEFAULT_TIMEOUT_SECONDS
  const result = await options.run(source.command, {
    timeoutMs: timeoutSeconds * 1000,
    cwd: options.homeDir,
    env: options.env,
  })
  if (result.code !== 0) {
    if (/timed out/i.test(result.error ?? '')) {
      throw new Error(`ran longer than its ${timeoutSeconds}-second timeout`)
    }
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ')
    throw new Error(
      `exited with code ${result.code}${detail ? `: ${detail}` : ''}`,
    )
  }

  const printed = parsePrintedDirectory(result.stdout, platform)
  const real = await validatePrintedDirectory(printed, options.sessionCwd)
  if (mode === 'link') {
    return { digest: await linkPrintedDirectory(real, targetPath) }
  }
  await assertCopyLimits(real)
  await copyDir(real, targetPath)
  return { digest: await hashDirectoryContents(targetPath) }
}
