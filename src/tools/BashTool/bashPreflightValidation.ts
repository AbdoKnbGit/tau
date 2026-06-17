import { readdir, stat } from 'fs/promises'
import path from 'path'
import { getCwd } from '../../utils/cwd.js'
import {
  extractLeadingCdCommand,
  normalizeForHostFs,
  resolveBashPathFrom,
} from './bashWorkdir.js'

/**
 * On Windows, Git Bash users routinely write absolute paths in POSIX form
 * (`/c/Users/...`, `/cygdrive/c/...`, `//server/share/...`). Node's
 * `fs.stat` on Windows cannot resolve these — it tries them literally and
 * reports ENOENT even when the directory clearly exists. We translate
 * before passing to fs operations so the preflight stops false-flagging
 * valid paths.
 *
 * Platform is a parameter (defaults to detected host) so tests can
 * exercise the Windows code path on any host.
 */
export const normalizeForFs = normalizeForHostFs

export type BashPreflightInput = {
  command: string
  workdir?: string
}

export type BashPreflightValidationResult =
  | { ok: true }
  | { ok: false; message: string }

function shellQuoteForHint(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

const resolveFrom = resolveBashPathFrom

function formatMissingWorkdirMessage(
  workdir: string,
  resolvedWorkdir: string,
): string {
  return [
    'Bash preflight blocked this command before execution.',
    '',
    'Reason:',
    `The requested workdir ${shellQuoteForHint(workdir)} does not exist (resolved to ${shellQuoteForHint(resolvedWorkdir)}).`,
    '',
    'Correction guidance:',
    '- Locate the real project directory before running the command.',
    "- For JavaScript projects, search for the manifest first: find .. -maxdepth 4 -name package.json -not -path '*/node_modules/*'",
    '- Retry with the correct workdir value instead of changing directories inside the command.',
    '',
    'The command was not executed.',
  ].join('\n')
}

function formatMissingCdTargetMessage(
  cdTarget: string,
  resolvedTarget: string,
  baseDir: string,
): string {
  return [
    'Bash preflight blocked this command before execution.',
    '',
    'Reason:',
    `The command starts with cd ${shellQuoteForHint(cdTarget)} && ..., but that directory does not exist from ${shellQuoteForHint(baseDir)}.`,
    `Resolved target: ${shellQuoteForHint(resolvedTarget)}`,
    '',
    'Correction guidance:',
    '- Verify the active directory and target before retrying: pwd && ls -la',
    "- If this is a subproject command, locate the manifest first: find .. -maxdepth 4 -name package.json -not -path '*/node_modules/*'",
    '- Prefer the Bash tool workdir parameter with the real directory instead of cd <dir> && <command>.',
    '',
    'The command was not executed.',
  ].join('\n')
}

// --- Script/manifest target preflight ---------------------------------------
// Catches the classic wrong-directory failure BEFORE execution: the model is
// at the project root, the file lives in a subdirectory (backend/server.js),
// and it runs `node server.js`. Instead of letting the shell fail with a bare
// ENOENT, we verify the target exists in the directory the command would run
// in — and when it doesn't, we locate it nearby and hand back the exact
// workdir/path to use.

const SCRIPT_INTERPRETERS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node',
  'python', 'python3', 'python2', 'py', 'pypy', 'pypy3',
  'ruby', 'perl', 'php', 'lua',
  'bash', 'sh', 'zsh', 'dash', 'ksh',
  'pwsh', 'powershell',
])

const SCRIPT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx',
  '.py', '.rb', '.pl', '.php', '.lua', '.sh', '.bash', '.ps1',
])

// Flags that switch the interpreter to inline-code/module mode or consume the
// next token — a file argument can no longer be identified reliably.
const SCRIPT_BAILOUT_FLAGS = new Set(['-c', '-e', '-m', '-p', '--eval', '--print'])

const MANIFEST_RUNNERS = new Set(['npm', 'yarn', 'pnpm'])

// Subcommands that hard-require an existing package.json in the working
// directory. Deliberately narrow: `npm install <pkg>` can legitimately run
// without one (it creates it), so installs only count when bare.
const MANIFEST_SUBCOMMANDS = new Set(['run', 'start', 'test', 'build', 'dev', 'ci'])
const MANIFEST_BARE_INSTALL_SUBCOMMANDS = new Set(['install', 'i'])

// Directory names skipped while searching for a misplaced target. Hidden
// directories (leading dot) are skipped unconditionally.
const SKIPPED_SEARCH_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  'venv', '__pycache__', 'vendor',
])

function firstCommandSegment(command: string): string {
  return command.split(/&&|\|\||;|\||\n/)[0]?.trim() ?? ''
}

function tokenizeSegment(segment: string): string[] {
  const matches = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return matches.map(token => token.replace(/^["']|["']$/g, ''))
}

function isDynamicToken(token: string): boolean {
  return /[*?$`{~<>]/.test(token)
}

/**
 * Extract the script-file target of the first command in a (possibly
 * compound) command line, or null when there is no statically checkable
 * file target. Conservative by design: any ambiguity returns null.
 */
export function extractScriptFileTarget(command: string): string | null {
  const tokens = tokenizeSegment(firstCommandSegment(command))
  let i = 0
  // Skip leading VAR=value environment assignments
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  const head = tokens[i]
  if (!head || isDynamicToken(head)) return null

  // Direct relative execution: ./script.sh, ../tools/run.py
  if (/^\.\.?[\\/]/.test(head)) return head

  const headBase = head
    .replace(/\.exe$/i, '')
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
  if (!SCRIPT_INTERPRETERS.has(headBase)) return null
  i++
  // Run-style subcommand that takes a file (deno run x.ts, bun run x.ts)
  if ((headBase === 'deno' || headBase === 'bun') && tokens[i] === 'run') i++

  for (; i < tokens.length; i++) {
    const token = tokens[i]!
    if (SCRIPT_BAILOUT_FLAGS.has(token)) return null
    if (token.startsWith('-')) continue
    // First positional argument: only treat as a file when it looks like one
    if (isDynamicToken(token)) return null
    const ext = path.extname(token).toLowerCase()
    if (!SCRIPT_EXTENSIONS.has(ext)) return null
    return token
  }
  return null
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(normalizeForFs(target))
    return true
  } catch {
    return false
  }
}

/**
 * Breadth-first search for a file name under rootDir. Bounded (depth,
 * directory count, match count) so it stays fast even in big repos.
 */
async function findFileCandidates(
  rootDir: string,
  fileName: string | string[],
  { maxDepth = 4, maxDirs = 500, maxMatches = 3 } = {},
): Promise<string[]> {
  const fsRoot = normalizeForFs(rootDir)
  const wanted = Array.isArray(fileName) ? fileName : [fileName]
  const caseInsensitive = process.platform === 'win32'
  const wantedLower = new Set(wanted.map(name => name.toLowerCase()))
  const matchesName = (name: string): boolean =>
    caseInsensitive ? wantedLower.has(name.toLowerCase()) : wanted.includes(name)
  const matches: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: fsRoot, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < maxDirs && matches.length < maxMatches) {
    const { dir, depth } = queue.shift()!
    visited++
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && matchesName(entry.name)) {
        matches.push(path.relative(fsRoot, path.join(dir, entry.name)))
        if (matches.length >= maxMatches) break
      } else if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !entry.name.startsWith('.') &&
        !SKIPPED_SEARCH_DIRS.has(entry.name)
      ) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
      }
    }
  }
  return matches
}

function extractManifestRunner(command: string): string | null {
  const tokens = tokenizeSegment(firstCommandSegment(command))
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  const head = tokens[i]?.toLowerCase()
  if (!head || !MANIFEST_RUNNERS.has(head)) return null
  const rest = tokens.slice(i + 1)
  // Global/prefixed/workspace invocations don't need a local manifest
  if (rest.some(t => ['-g', '--global', '--prefix', '-C', '-w', '--workspace'].includes(t))) {
    return null
  }
  const positionals = rest.filter(t => !t.startsWith('-'))
  const subcommand = positionals[0]?.toLowerCase()
  if (!subcommand) return null
  if (MANIFEST_SUBCOMMANDS.has(subcommand)) return head
  // Bare `npm install` / `yarn install` needs a manifest; `npm install <pkg>`
  // does not (it creates one).
  if (MANIFEST_BARE_INSTALL_SUBCOMMANDS.has(subcommand) && positionals.length === 1) {
    return head
  }
  return null
}

// --- Compose (implicit config-in-cwd) preflight -----------------------------
// `docker compose up` / `docker-compose up` name no file in argv — they look
// for a Compose file in the working directory (and walk up its parents). The
// classic failure mirrors the script case: the model runs from the repo root
// while the Compose file lives in a subdirectory, and the shell fails with
// "no configuration file provided: not found". We catch that before execution
// and hand back the exact workdir / -f to use.

// Discovery order matches docker's: compose.yaml wins, docker-compose.yml last.
const COMPOSE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
]

// Compose subcommands that operate on a project and therefore need a Compose
// file. Deliberately excludes file-less subcommands (version, ls, help) so
// those never get blocked.
const COMPOSE_PROJECT_SUBCOMMANDS = new Set([
  'up', 'down', 'build', 'start', 'stop', 'restart', 'ps', 'logs',
  'pull', 'push', 'run', 'exec', 'config', 'create', 'rm', 'kill',
  'pause', 'unpause', 'top', 'events', 'images', 'port', 'scale',
  'watch', 'cp', 'wait', 'attach', 'stats',
])

// Global flags placed before the subcommand that consume the next token as a
// value. Skipping their value keeps us from mistaking it for the subcommand.
const COMPOSE_VALUE_FLAGS = new Set([
  '-p', '--project-name', '--profile', '--env-file', '--ansi',
  '--progress', '--parallel', '-c', '--context', '-H', '--host',
  '--log-level',
])

// Flags that point Compose at an explicit file/dir, so the cwd-based preflight
// must not second-guess the location (covers `--file=x` via split on `=`).
const COMPOSE_EXPLICIT_LOCATION_FLAGS = new Set([
  '-f', '--file', '--project-directory',
])

/**
 * Identify a `docker compose` / `docker-compose` (or podman) invocation that
 * needs a Compose file discovered from the working directory. Returns null —
 * meaning "don't preflight" — for explicit `-f`/`--project-directory`, a
 * `COMPOSE_FILE=` env assignment, file-less subcommands, or anything we can't
 * statically parse. Conservative by design: a miss is safe, a false block is not.
 */
export function extractComposeInvocation(
  command: string,
): { runner: string } | null {
  const tokens = tokenizeSegment(firstCommandSegment(command))
  let i = 0
  // Leading VAR=value env assignments. An explicit COMPOSE_FILE already points
  // Compose at a specific file — don't second-guess it.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
    if (/^COMPOSE_FILE=/.test(tokens[i]!)) return null
    i++
  }

  const head = tokens[i]?.replace(/\.exe$/i, '').toLowerCase()
  if (!head) return null

  let runner: string
  if (head === 'docker-compose' || head === 'podman-compose') {
    runner = head
    i++
  } else if (head === 'docker' || head === 'podman') {
    // Only the plain `docker compose` form is parsed; we don't try to step over
    // docker's own global flags (`docker --context x compose`). Missing those
    // rare forms just skips the preflight — it never produces a false block.
    if (tokens[i + 1]?.toLowerCase() !== 'compose') return null
    runner = `${head} compose`
    i += 2
  } else {
    return null
  }

  let subcommand: string | undefined
  for (; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.startsWith('-')) {
      const flagName = token.split('=')[0]!
      if (COMPOSE_EXPLICIT_LOCATION_FLAGS.has(flagName)) return null
      // Space-separated value form (`-p name`): skip the value token too.
      if (!token.includes('=') && COMPOSE_VALUE_FLAGS.has(token)) i++
      continue
    }
    subcommand = token.toLowerCase()
    break
  }

  if (!subcommand || !COMPOSE_PROJECT_SUBCOMMANDS.has(subcommand)) return null
  return { runner }
}

async function composeFileExistsIn(dir: string): Promise<boolean> {
  for (const name of COMPOSE_FILE_NAMES) {
    if (await pathExists(resolveFrom(dir, name))) return true
  }
  return false
}

export type TargetWorkdirResolution =
  | { kind: 'none' }
  // Exactly one subdirectory holds the needed file — run there. `workdir` is the
  // absolute directory, `relWorkdir` is relative to baseDir, and `label` names
  // what was found (for the model-facing note).
  | { kind: 'auto'; workdir: string; relWorkdir: string; label: string }
  // The needed file lives in several different subdirectories — can't guess.
  | { kind: 'ambiguous'; message: string }

// Keep the cross-root file search cheap: cap how many roots we scan.
const MAX_SEARCH_ROOTS = 16

const caseFold = (p: string): string =>
  process.platform === 'win32' ? p.toLowerCase() : p

/** Dedup directories by resolved host-fs spelling, dropping empties. */
function dedupRoots(roots: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    if (!root) continue
    const key = caseFold(normalizeForFs(root))
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/**
 * Search each root (downward, bounded) for any of fileNames and return the
 * DIRECTORIES that contain a match, as absolute host-fs paths. This is what
 * makes "run from any known directory" work: roots include the current dir, the
 * workspace's added dirs, and dirs the model has used this session. Stops early
 * once two distinct directories are found (enough to know it's ambiguous) and
 * caps the number of roots so the scan stays fast.
 */
async function collectTargetDirs(
  roots: string[],
  fileNames: string | string[],
  maxDepth: number,
): Promise<string[]> {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const root of roots.slice(0, MAX_SEARCH_ROOTS)) {
    const fsRoot = normalizeForFs(root)
    const candidates = await findFileCandidates(fsRoot, fileNames, {
      maxDepth,
      maxDirs: 250,
    })
    for (const candidate of candidates) {
      const dir = path.resolve(fsRoot, path.dirname(candidate))
      const key = caseFold(dir)
      if (!seen.has(key)) {
        seen.add(key)
        ordered.push(dir)
      }
    }
    if (ordered.length >= 2) break
  }
  return ordered
}

function displayWorkdir(baseDir: string, dir: string): string {
  const rel = path.relative(normalizeForFs(baseDir), dir)
  return rel && !rel.startsWith('..') ? rel : dir
}

function formatAmbiguousTargetMessage(
  label: string,
  baseDir: string,
  dirs: string[],
): string {
  return [
    'Shell preflight blocked this command before execution.',
    '',
    'Reason:',
    `${label} is not in ${shellQuoteForHint(baseDir)} (the directory this command would run in) and exists in more than one known location:`,
    ...dirs.map(dir => `- ${shellQuoteForHint(dir)}`),
    '',
    'Correction guidance:',
    '- Re-run with the workdir parameter (or an explicit path) set to the one you mean.',
    '',
    'The command was not executed.',
  ].join('\n')
}

/**
 * Turn matched directories into a workdir decision:
 *   - none: nothing nearby to redirect to.
 *   - auto: exactly one directory holds the file → run there (absolute workdir).
 *   - ambiguous: several different directories hold it → caller blocks.
 */
function pickWorkdir(
  dirs: string[],
  baseDir: string,
  label: string,
): TargetWorkdirResolution {
  if (dirs.length === 0) return { kind: 'none' }
  if (dirs.length === 1) {
    const dir = dirs[0]!
    return { kind: 'auto', workdir: dir, relWorkdir: displayWorkdir(baseDir, dir), label }
  }
  return { kind: 'ambiguous', message: formatAmbiguousTargetMessage(label, baseDir, dirs) }
}

/**
 * Decide where a `docker compose` / `docker-compose` (or podman) command should
 * run when the execution directory has no Compose file of its own. Searches the
 * given roots (defaults to baseDir only).
 *
 * Compose v2 also discovers files by walking UP into parents, but we ignore
 * ancestors on purpose: a stray compose file in a home / Desktop / checkout
 * parent (very common) would otherwise hijack the run. A file in a known
 * directory is almost always the intended one.
 */
export async function resolveComposeWorkdir(
  command: string,
  baseDir: string,
  roots: string[] = [baseDir],
): Promise<TargetWorkdirResolution> {
  const compose = extractComposeInvocation(command)
  if (!compose) return { kind: 'none' }
  // A Compose file already resolves from here — nothing to redirect.
  if (await composeFileExistsIn(baseDir)) return { kind: 'none' }
  const dirs = await collectTargetDirs(roots, COMPOSE_FILE_NAMES, 4)
  return pickWorkdir(dirs, baseDir, 'the Compose file')
}

async function resolveScriptWorkdir(
  command: string,
  baseDir: string,
  roots: string[],
): Promise<TargetWorkdirResolution | null> {
  const scriptTarget = extractScriptFileTarget(command)
  if (!scriptTarget) return null
  // Already resolves from the run dir — nothing to redirect.
  if (await pathExists(resolveFrom(baseDir, scriptTarget))) return { kind: 'none' }
  // A path component (api/server.js) can't be satisfied by changing the workdir
  // without corrupting the path — leave it for the shell to report.
  if (/[\\/]/.test(scriptTarget)) return { kind: 'none' }
  const fileName = path.basename(normalizeForFs(scriptTarget))
  const dirs = await collectTargetDirs(roots, fileName, 4)
  return pickWorkdir(dirs, baseDir, fileName)
}

async function resolveManifestWorkdir(
  command: string,
  baseDir: string,
  roots: string[],
): Promise<TargetWorkdirResolution | null> {
  const manifestRunner = extractManifestRunner(command)
  if (!manifestRunner) return null
  if (await pathExists(resolveFrom(baseDir, 'package.json'))) return { kind: 'none' }
  const dirs = await collectTargetDirs(roots, 'package.json', 3)
  return pickWorkdir(dirs, baseDir, 'package.json')
}

/**
 * Resolve where a command's target file lives when it is not in the execution
 * directory. Handles, uniformly:
 *   - script interpreters: `node server.js`, `python app.py`, `./run.sh`
 *   - package-manifest runners: `npm run build`, `yarn test`, `pnpm i`
 *   - Compose: `docker compose up`, `docker-compose up`, podman
 * A single unambiguous subdirectory is returned as an `auto` workdir (applied at
 * execution time by the shell tools, so the model never has to retry); several
 * different subdirectories are `ambiguous`. Shared by BashTool and
 * PowerShellTool so both shells behave identically.
 */
export async function resolveTargetWorkdir(
  command: string,
  baseDir: string,
  searchRoots: string[] = [],
): Promise<TargetWorkdirResolution> {
  // Search the run dir plus every other directory we have reason to know about
  // (workspace dirs + dirs used this session), so a target that lives in a
  // different tree still resolves. baseDir stays first so it wins ties.
  const roots = dedupRoots([baseDir, ...searchRoots])
  return (
    (await resolveScriptWorkdir(command, baseDir, roots)) ??
    (await resolveManifestWorkdir(command, baseDir, roots)) ??
    (await resolveComposeWorkdir(command, baseDir, roots))
  )
}

/**
 * Block decision shared by BashTool and PowerShellTool. The wrong-directory
 * case is normally auto-corrected at execution time (resolveTargetWorkdir → the
 * shell tools' call()), so this only blocks when the target genuinely lives in
 * several different subdirectories and we cannot safely pick one.
 */
export async function validateCommandTargetExists(
  command: string,
  baseDir: string,
): Promise<BashPreflightValidationResult> {
  const resolution = await resolveTargetWorkdir(command, baseDir)
  if (resolution.kind === 'ambiguous') {
    return { ok: false, message: resolution.message }
  }
  return { ok: true }
}

export async function validateBashExecutionPreflight(
  input: BashPreflightInput,
  cwd = getCwd(),
): Promise<BashPreflightValidationResult> {
  let baseDir = cwd

  if (input.workdir) {
    const resolvedWorkdir = resolveFrom(cwd, input.workdir)
    if (!(await pathExistsAsDirectory(resolvedWorkdir))) {
      return {
        ok: false,
        message: formatMissingWorkdirMessage(input.workdir, resolvedWorkdir),
      }
    }
    baseDir = resolvedWorkdir
  }

  let commandToCheck = input.command
  const leadingCd = extractLeadingCdCommand(input.command)
  if (leadingCd) {
    const resolvedTarget = resolveFrom(baseDir, leadingCd.target)
    if (!(await pathExistsAsDirectory(resolvedTarget))) {
      return {
        ok: false,
        message: formatMissingCdTargetMessage(leadingCd.target, resolvedTarget, baseDir),
      }
    }
    baseDir = resolvedTarget
    commandToCheck = leadingCd.remainder
  }

  return validateCommandTargetExists(commandToCheck, baseDir)
}
