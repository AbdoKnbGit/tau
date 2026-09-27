import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import { getCwd } from '../../utils/cwd.js'
import { getPlatform } from '../../utils/platform.js'
import { byDepth, listProjectFiles } from '../../utils/projectFiles.js'
import { literalGlob } from '../../utils/searchGlobs.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import {
  extractLeadingCdCommand,
  normalizeForHostFs,
  resolveBashPathFrom,
} from './bashWorkdir.js'

type Platform = ReturnType<typeof getPlatform>

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

// Bound the search for a misplaced target so a command never waits long.
const CANDIDATE_SEARCH_BUDGET_MS = 2_000

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
 * Files named `fileName` under rootDir, nearest first, relative to it. Only
 * files the project's own ignore files keep, with hidden folders skipped, so
 * a copy inside a dependency tree, a build output or a virtualenv is never
 * offered. Bounded by depth, match count and time so it stays fast even in
 * big repos.
 */
async function findFileCandidates(
  rootDir: string,
  fileName: string | string[],
  { maxDepth = 4, maxMatches = 3 } = {},
): Promise<string[]> {
  const fsRoot = normalizeForFs(rootDir)
  const wanted = Array.isArray(fileName) ? fileName : [fileName]
  const caseInsensitive = process.platform === 'win32'
  const files = await listProjectFiles(fsRoot, {
    hidden: 'files',
    names: wanted.map(name => literalGlob(name, caseInsensitive)),
    // Folders up to maxDepth below the root, so files one level deeper.
    maxDepth: maxDepth + 1,
    signal: AbortSignal.timeout(CANDIDATE_SEARCH_BUDGET_MS),
  })
  return files
    .sort(byDepth(fsRoot))
    .slice(0, maxMatches)
    .map(file => path.relative(fsRoot, file))
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
  // The needed file lives in several different subdirectories. The shell tools
  // SURFACE these and run nothing — the model must re-run naming the one it
  // means (by absolute path). Guessing one (e.g. the shallowest) silently runs
  // the wrong target — the TP1/TP2 case. `dirs` are the absolute candidates;
  // `label` names what was found.
  | { kind: 'ambiguous'; message: string; label: string; dirs: string[] }

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
    '- Re-run with the absolute path or the command\'s native location flag set to the one you mean.',
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
  return { kind: 'ambiguous', message: formatAmbiguousTargetMessage(label, baseDir, dirs), label, dirs }
}

/**
 * When a target exists in several directories, choose ONE deterministically so a
 * repeated command never loops on an un-actionable block: the shallowest
 * candidate relative to baseDir (nearest the run dir) wins, ties broken
 * alphabetically. Returns the pick plus the display paths of the rest so the
 * shell tools can note the alternatives. Pure + cross-platform (reuses
 * displayWorkdir/caseFold).
 */
export function resolveAmbiguousPick(
  dirs: string[],
  baseDir: string,
): { workdir: string; relWorkdir: string; alternatives: string[] } {
  const ranked = [...dirs].sort((a, b) => {
    const da = displayWorkdir(baseDir, a)
    const db = displayWorkdir(baseDir, b)
    const byDepth = da.split(/[\\/]/).length - db.split(/[\\/]/).length
    if (byDepth !== 0) return byDepth
    const fa = caseFold(da)
    const fb = caseFold(db)
    return fa < fb ? -1 : fa > fb ? 1 : 0
  })
  const workdir = ranked[0]!
  return {
    workdir,
    relWorkdir: displayWorkdir(baseDir, workdir),
    alternatives: ranked.slice(1).map(d => displayWorkdir(baseDir, d)),
  }
}

// --- Anchor a command to an absolute location (lane- + background-proof) -----
// The working directory is unreliable when it rides the optional `workdir`
// tool-input field: the model forgets it, and some provider lanes drop it. The
// command STRING, by contrast, always survives parsing, lanes, and
// backgrounding. So once the resolver has found the target's absolute
// directory, we bake that absolute location INTO the command instead of setting
// `workdir`:
//   - a script with a file argument  →  rewrite the arg to the absolute file
//       (`node server.js` → `node '/c/Users/.../server.js'`); no cwd change, so
//       it stays a one-off and `__dirname`/relative requires resolve correctly.
//   - anything else (compose, `python -m`, npm, cargo, …) → run inside a
//       ONE-OFF cwd change that never drifts the session cwd:
//         bash:        (cd '<abs>' && <cmd>)              ← subshell
//         powershell:  Push-Location -LiteralPath '<abs>'; <cmd>; Pop-Location
// Both forms preserve the real exit code (bash short-circuits `&& pwd` on
// failure; PowerShell captures $LASTEXITCODE before writing cwd). Pure string
// transforms — the caller only invokes these on an `auto` resolution, where the
// absolute path is already known to exist.

export type AnchorShell = 'bash' | 'powershell'

/**
 * Spell an absolute host-fs path for the target shell. Git Bash wants POSIX
 * form (`/c/Users/...`) so the backslashes in a Windows path are not treated as
 * escapes; PowerShell keeps the native `C:\Users\...`. Cross-platform: a no-op
 * on non-Windows hosts.
 */
function spellAbsolutePath(absHostPath: string, shell: AnchorShell, platform: Platform): string {
  if (shell === 'bash' && platform === 'windows') {
    try {
      return windowsPathToPosixPath(absHostPath)
    } catch {
      return absHostPath
    }
  }
  return absHostPath
}

/** Single-quote a path for the shell (always quote — harmless and space-safe). */
function quotePathForShell(p: string, shell: AnchorShell): string {
  return shell === 'bash'
    ? `'${p.replace(/'/g, `'\\''`)}'`
    : `'${p.replace(/'/g, "''")}'`
}

function insertAfterLeadingRunner(
  command: string,
  runnerPattern: string,
  insertion: string,
): string | null {
  const envAssignment = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*`
  const re = new RegExp(`(^\\s*${envAssignment}(?:${runnerPattern}))(?=$|[\\s;&|])`, 'i')
  const match = re.exec(command)
  if (!match) return null
  const end = match.index + match[1]!.length
  return `${command.slice(0, end)} ${insertion}${command.slice(end)}`
}

function firstExecutableBase(command: string): string | null {
  const tokens = tokenizeSegment(firstCommandSegment(command))
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  return tokens[i]
    ?.replace(/\.exe$/i, '')
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase() ?? null
}

function commandHasFlag(command: string, flags: Set<string>): boolean {
  const tokens = tokenizeSegment(firstCommandSegment(command))
  return tokens.some(token => flags.has(token.split('=')[0]!.toLowerCase()))
}

function findComposeFileInDirSync(absDir: string): string | null {
  const fsDir = normalizeForFs(absDir)
  for (const name of COMPOSE_FILE_NAMES) {
    const candidate = path.join(fsDir, name)
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Keep anchoring conservative; failure falls back to the generic wrapper.
    }
  }
  return null
}

function anchorComposeCommand(
  command: string,
  absDir: string,
  shell: AnchorShell,
  platform: Platform,
): string | null {
  if (!extractComposeInvocation(command)) return null
  const composeFile = findComposeFileInDirSync(absDir)
  if (!composeFile) return null
  const fileArg = quotePathForShell(spellAbsolutePath(composeFile, shell, platform), shell)
  return insertAfterLeadingRunner(
    command,
    String.raw`(?:docker(?:\.exe)?\s+compose|docker-compose(?:\.exe)?|podman(?:\.exe)?\s+compose|podman-compose(?:\.exe)?)`,
    `-f ${fileArg}`,
  )
}

function anchorNativeLocationFlag(
  command: string,
  absDir: string,
  shell: AnchorShell,
  platform: Platform,
): string | null {
  const dirArg = quotePathForShell(spellAbsolutePath(absDir, shell, platform), shell)
  const manifestRunner = extractManifestRunner(command)
  if (manifestRunner === 'npm' && !commandHasFlag(command, new Set(['--prefix']))) {
    return insertAfterLeadingRunner(command, String.raw`npm(?:\.exe)?`, `--prefix ${dirArg}`)
  }
  if (manifestRunner === 'yarn' && !commandHasFlag(command, new Set(['--cwd']))) {
    return insertAfterLeadingRunner(command, String.raw`yarn(?:\.exe)?`, `--cwd ${dirArg}`)
  }
  if (manifestRunner === 'pnpm' && !commandHasFlag(command, new Set(['--dir', '-c']))) {
    return insertAfterLeadingRunner(command, String.raw`pnpm(?:\.exe)?`, `--dir ${dirArg}`)
  }

  const head = firstExecutableBase(command)
  if (head === 'git' && !commandHasFlag(command, new Set(['-c', '--git-dir', '--work-tree']))) {
    return insertAfterLeadingRunner(command, String.raw`git(?:\.exe)?`, `-C ${dirArg}`)
  }

  const marker = matchProjectToolMarkers(command)
  if (marker?.tools.some(tool => tool === 'make') && !commandHasFlag(command, new Set(['-c']))) {
    return insertAfterLeadingRunner(command, String.raw`make(?:\.exe)?`, `-C ${dirArg}`)
  }
  if (
    marker?.tools.some(tool => tool === 'terraform' || tool === 'tofu') &&
    !commandHasFlag(command, new Set(['-chdir']))
  ) {
    const runner = firstExecutableBase(command)
    if (runner === 'terraform' || runner === 'tofu') {
      return insertAfterLeadingRunner(command, String.raw`${runner}(?:\.exe)?`, `-chdir=${dirArg}`)
    }
  }

  return anchorComposeCommand(command, absDir, shell, platform)
}

/**
 * Replace the first standalone occurrence of `token` (optionally quoted) in
 * `command` with `replacement`. Bounded so it only matches a whole argument
 * (preceded by start/whitespace, followed by end/whitespace/operator), never a
 * substring of another token. Returns the command unchanged if not found.
 */
function replaceFirstArg(command: string, token: string, replacement: string): string {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\s)(['"]?)${esc}\\2(?=$|[\\s;&|])`)
  const m = re.exec(command)
  if (!m) return command
  const start = m.index + m[1]!.length
  const matchedLen = m[0].length - m[1]!.length
  return command.slice(0, start) + replacement + command.slice(start + matchedLen)
}

/**
 * Wrap a command so it runs in `absDir` as a ONE-OFF (the session cwd never
 * drifts). bash uses a subshell; PowerShell uses Push/Pop-Location.
 */
export function wrapWithDirPrefix(
  command: string,
  absDir: string,
  shell: AnchorShell,
  platform: Platform = getPlatform(),
): string {
  const dir = quotePathForShell(spellAbsolutePath(absDir, shell, platform), shell)
  return shell === 'bash'
    ? `(cd ${dir} && ${command})`
    : `Push-Location -LiteralPath ${dir}; ${command}; Pop-Location`
}

/**
 * Bake the resolved absolute location into a command. For a script with a file
 * argument, rewrite the argument to the absolute file path (no cwd change
 * needed). Otherwise run the command inside a one-off cwd change (dir prefix).
 */
export function anchorCommandToDir(
  command: string,
  absDir: string,
  shell: AnchorShell,
  platform: Platform = getPlatform(),
): string {
  const token = extractScriptFileTarget(command)
  if (token) {
    const absFile = resolveBashPathFrom(absDir, token.replace(/^\.[\\/]+/, ''), platform)
    const spelled = quotePathForShell(spellAbsolutePath(absFile, shell, platform), shell)
    const rewritten = replaceFirstArg(command, token, spelled)
    if (rewritten !== command) return rewritten
    // Could not rewrite the arg (unexpected quoting) — fall back to a cwd change.
  }
  const nativeAnchored = anchorNativeLocationFlag(command, absDir, shell, platform)
  if (nativeAnchored) return nativeAnchored
  return wrapWithDirPrefix(command, absDir, shell, platform)
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

/**
 * Like collectTargetDirs but for a target named by a relative SUB-PATH
 * (`scripts/run.py`, `api/server.js`): search each root for the leaf file, keep
 * only matches whose path ends with the full sub-path, then strip that suffix to
 * land on the directory from which `<runner> <relPath>` resolves. Mirrors
 * collectModuleWorkdirs' suffix logic. Stops once two distinct dirs are found.
 */
async function collectPathSuffixDirs(
  roots: string[],
  relPath: string,
  maxDepth: number,
): Promise<string[]> {
  const relNorm = caseFold(normalizeForFs(relPath).replace(/\\/g, '/'))
  const leaf = path.posix.basename(relNorm)
  const upLevels = relNorm.split('/').length - 1
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const root of roots.slice(0, MAX_SEARCH_ROOTS)) {
    const fsRoot = normalizeForFs(root)
    const candidates = await findFileCandidates(fsRoot, leaf, {
      maxDepth,
      maxMatches: 8,
    })
    for (const candidate of candidates) {
      const candNorm = caseFold(candidate.replace(/\\/g, '/'))
      if (candNorm !== relNorm && !candNorm.endsWith(`/${relNorm}`)) continue
      // dirname() already dropped the leaf; strip the remaining sub-path
      // segments (relPath minus its leaf) to reach the run dir.
      let workdir = path.resolve(fsRoot, path.dirname(candidate))
      for (let k = 0; k < upLevels; k++) workdir = path.dirname(workdir)
      const key = caseFold(workdir)
      if (!seen.has(key)) {
        seen.add(key)
        ordered.push(workdir)
      }
    }
    if (ordered.length >= 2) break
  }
  return ordered
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
  // A relative sub-path (`scripts/run.py`, `api/server.js`) CAN still be located:
  // find the directory from which that exact suffix resolves and run there. An
  // absolute path or a `..` escape can't be fixed by a workdir, so leave those
  // for the shell to report.
  if (/[\\/]/.test(scriptTarget)) {
    const rel = scriptTarget.replace(/^\.[\\/]+/, '')
    if (path.isAbsolute(normalizeForFs(rel)) || rel.split(/[\\/]/).includes('..')) {
      return { kind: 'none' }
    }
    // `./run.py` reduces to a bare name — use the plain leaf-name search.
    if (!/[\\/]/.test(rel)) {
      const dirs = await collectTargetDirs(roots, rel, 4)
      return pickWorkdir(dirs, baseDir, rel)
    }
    const dirs = await collectPathSuffixDirs(roots, rel, 6)
    return pickWorkdir(dirs, baseDir, rel)
  }
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

// --- Python `-m module` preflight -------------------------------------------
// `python -m pkg.sub` names no file in argv — Python resolves the module from
// sys.path (cwd first). The classic failure mirrors the script case: the model
// runs from the repo root while the package lives in a subdirectory, and Python
// fails with "No module named 'pkg'". The script preflight deliberately bails on
// `-m` (it switches the interpreter to module mode), so handle it here: locate
// the module's file in a subdirectory and run from the directory that makes the
// dotted import resolve. Shared by Bash + PowerShell via resolveTargetWorkdir,
// so the model never has to remember `workdir` for this case.

const MODULE_RUNNERS = new Set([
  'python', 'python3', 'python2', 'py', 'pypy', 'pypy3',
])

/**
 * Parse a `python -m a.b.c` invocation. Returns the module plus the on-disk
 * shapes it can execute (`a/b/c.py` or `a/b/c/__main__.py`) and the leaf file
 * names to search for. Null for anything that isn't a clean `-m <dotted.name>`.
 */
export function extractPythonModuleTarget(
  command: string,
): { module: string; candidateRelPaths: string[]; leafNames: string[] } | null {
  const tokens = tokenizeSegment(firstCommandSegment(command))
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  const head = tokens[i]
    ?.replace(/\.exe$/i, '')
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
  if (!head || !MODULE_RUNNERS.has(head)) return null
  for (i += 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '-m') {
      const mod = tokens[i + 1]
      if (!mod || mod.startsWith('-') || isDynamicToken(mod)) return null
      if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(mod)) return null
      const parts = mod.split('.')
      const base = parts.join('/')
      const leaf = parts[parts.length - 1]!
      return {
        module: mod,
        candidateRelPaths: [`${base}.py`, `${base}/__main__.py`],
        leafNames: [`${leaf}.py`, '__main__.py'],
      }
    }
    // A positional before `-m` means this is `python script.py`, not `-m`.
    if (!token.startsWith('-')) return null
  }
  return null
}

/**
 * Find directories from which `python -m <module>` would resolve: search roots
 * for the module's leaf file, keep only matches whose path ends with the full
 * dotted-path-as-folders, then strip that suffix to land on the import root.
 * Stops once two distinct workdirs are found (enough to know it's ambiguous).
 */
async function collectModuleWorkdirs(
  roots: string[],
  target: { candidateRelPaths: string[]; leafNames: string[] },
): Promise<string[]> {
  const relNormalized = target.candidateRelPaths.map(rel => caseFold(rel))
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const root of roots.slice(0, MAX_SEARCH_ROOTS)) {
    const fsRoot = normalizeForFs(root)
    const candidates = await findFileCandidates(fsRoot, target.leafNames, {
      maxDepth: 6,
      maxMatches: 8,
    })
    for (const candidate of candidates) {
      const candNorm = caseFold(candidate.replace(/\\/g, '/'))
      const matchRel = relNormalized.find(
        rel => candNorm === rel || candNorm.endsWith(`/${rel}`),
      )
      if (!matchRel) continue
      // Strip the module-relative path (e.g. ml/train_wear.py) off the file's
      // directory to land on the import root.
      let workdir = path.resolve(fsRoot, path.dirname(candidate))
      const upLevels = matchRel.split('/').length - 1
      for (let k = 0; k < upLevels; k++) workdir = path.dirname(workdir)
      const key = caseFold(workdir)
      if (!seen.has(key)) {
        seen.add(key)
        ordered.push(workdir)
      }
    }
    if (ordered.length >= 2) break
  }
  return ordered
}

async function resolveModuleWorkdir(
  command: string,
  baseDir: string,
  roots: string[],
): Promise<TargetWorkdirResolution | null> {
  const target = extractPythonModuleTarget(command)
  if (!target) return null
  // Already importable from the run dir — nothing to redirect.
  for (const rel of target.candidateRelPaths) {
    if (await pathExists(resolveFrom(baseDir, rel))) return { kind: 'none' }
  }
  const dirs = await collectModuleWorkdirs(roots, target)
  return pickWorkdir(dirs, baseDir, `the ${target.module} module`)
}

// --- Generic project-tool workdir (data-driven) -----------------------------
// Most project CLIs resolve their root from a MARKER FILE in the working
// directory or an ancestor: dvc→dvc.yaml, cargo→Cargo.toml, go→go.mod,
// make→Makefile, terraform→*.tf, gradle→build.gradle, … Run one from the wrong
// root and it fails with a "no project / not found" error — exactly like
// `npm`/`docker compose`, which got bespoke resolvers above. Rather than a
// function per tool, this is ONE table-driven resolver: supporting a new tool
// is a single row. Shared by Bash + PowerShell via resolveTargetWorkdir.

interface ProjectToolMarker {
  /** First-token executables (after env vars; path + .exe stripped, lowercased). */
  tools: string[]
  /** Marker FILES that identify the project root. */
  markers: string[]
  /** Human label for the model-facing cwd note. */
  label: string
}

const PROJECT_TOOL_MARKERS: ProjectToolMarker[] = [
  { tools: ['dvc'], markers: ['dvc.yaml', 'dvc.lock'], label: 'the DVC project (dvc.yaml)' },
  { tools: ['cargo'], markers: ['Cargo.toml'], label: 'Cargo.toml' },
  { tools: ['go'], markers: ['go.mod'], label: 'go.mod' },
  { tools: ['mvn', 'mvnw'], markers: ['pom.xml'], label: 'pom.xml' },
  { tools: ['gradle', 'gradlew'], markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], label: 'the Gradle build' },
  { tools: ['make'], markers: ['Makefile', 'makefile', 'GNUmakefile'], label: 'the Makefile' },
  { tools: ['poetry', 'pdm', 'hatch'], markers: ['pyproject.toml'], label: 'pyproject.toml' },
  { tools: ['pipenv'], markers: ['Pipfile'], label: 'the Pipfile' },
  { tools: ['bundle', 'bundler'], markers: ['Gemfile'], label: 'the Gemfile' },
  { tools: ['composer'], markers: ['composer.json'], label: 'composer.json' },
  { tools: ['mix'], markers: ['mix.exs'], label: 'mix.exs' },
  { tools: ['dbt'], markers: ['dbt_project.yml'], label: 'the dbt project' },
  { tools: ['snakemake'], markers: ['Snakefile'], label: 'the Snakefile' },
  { tools: ['terraform', 'tofu'], markers: ['main.tf', 'versions.tf', 'providers.tf', 'terraform.tf'], label: 'the Terraform config' },
]

// Scaffold subcommands CREATE a project, so they must never be redirected into
// an existing one (cargo new, go mod init, poetry init, …). Generic, not per-tool.
const SCAFFOLD_SUBCOMMANDS = new Set(['init', 'new', 'create'])

export function matchProjectToolMarkers(command: string): ProjectToolMarker | null {
  const tokens = tokenizeSegment(firstCommandSegment(command))
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  const head = tokens[i]
    ?.replace(/\.exe$/i, '')
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
  if (!head) return null
  if (tokens.slice(i + 1, i + 4).some(t => SCAFFOLD_SUBCOMMANDS.has(t.toLowerCase()))) {
    return null
  }
  return PROJECT_TOOL_MARKERS.find(entry => entry.tools.includes(head)) ?? null
}

/** True when any marker is present in dir or an ancestor (tools walk up). */
async function markerReachableUpward(dir: string, markers: string[]): Promise<boolean> {
  let cur = normalizeForFs(dir)
  for (let depth = 0; depth < 40; depth++) {
    for (const marker of markers) {
      if (await pathExists(path.join(cur, marker))) return true
    }
    const parent = path.dirname(cur)
    if (parent === cur) return false
    cur = parent
  }
  return false
}

async function resolveProjectToolWorkdir(
  command: string,
  baseDir: string,
  roots: string[],
): Promise<TargetWorkdirResolution | null> {
  const match = matchProjectToolMarkers(command)
  if (!match) return null
  // The tool walks up to find its marker — if it's reachable from the run dir
  // or any ancestor, it resolves on its own. Nothing to redirect.
  if (await markerReachableUpward(baseDir, match.markers)) return { kind: 'none' }
  const dirs = await collectTargetDirs(roots, match.markers, 4)
  return pickWorkdir(dirs, baseDir, match.label)
}

// --- Learn the project from files the model touches -------------------------
// The model reliably uses absolute paths for file ops (Read/Edit/Write all
// record the file's directory as a search root) even when it never passes
// `workdir`. But the project/import root is usually ABOVE the file's dir, and
// the resolvers only search DOWNWARD from roots — so a `dvc.yaml` or import
// root one level up is missed. Fix: expand each known root UP to its enclosing
// project root so the downward search can then find the target. This is what
// lets `dvc repro` / `python -m ml.x` auto-resolve to the project the model is
// clearly working in, with no `workdir` and no per-tool special-casing.

// Generic VCS/build/dependency markers — any ecosystem, nothing machine- or
// OS-specific. Ubiquitous files (README/LICENSE) are excluded so the walk
// doesn't stop short of the real root.
const PROJECT_ROOT_MARKERS = new Set([
  '.git', '.hg', '.svn',
  'package.json', 'deno.json', 'deno.jsonc',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock', 'environment.yml', 'environment.yaml',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'Gemfile', 'composer.json', 'mix.exs',
  'dvc.yaml', '.dvc',
  'Makefile', 'CMakeLists.txt', 'meson.build', 'pubspec.yaml',
])

const _projectRootCache = new Map<string, string | null>()

/**
 * Walk up from `startDir` to the nearest enclosing project root (a directory
 * holding a known marker). Returns null if none is found before reaching the
 * user's home directory — home and its ancestors are never treated as a project
 * root, so the later downward search can't scan huge unrelated trees. Home is
 * resolved at runtime (`os.homedir()`); the walk uses platform-agnostic path
 * ops — nothing is hardcoded to a machine or OS. Cached per dir per session.
 */
export async function findEnclosingProjectRoot(startDir: string): Promise<string | null> {
  const cacheKey = caseFold(normalizeForFs(startDir))
  const cached = _projectRootCache.get(cacheKey)
  if (cached !== undefined) return cached

  const home = caseFold(normalizeForFs(homedir()))
  let cur = normalizeForFs(startDir)
  let result: string | null = null
  for (let depth = 0; depth < 30; depth++) {
    if (caseFold(cur) === home) break // never treat home or above as a project root
    let names: string[]
    try {
      names = await readdir(cur)
    } catch {
      break
    }
    if (names.some(name => PROJECT_ROOT_MARKERS.has(name))) {
      result = cur
      break
    }
    const parent = path.dirname(cur)
    if (parent === cur) break // filesystem root
    cur = parent
  }
  _projectRootCache.set(cacheKey, result)
  return result
}

/** Add each root's enclosing project root to the search set (deduped). */
async function expandRootsWithProjectRoots(roots: string[]): Promise<string[]> {
  const out = [...roots]
  for (const root of roots) {
    const projectRoot = await findEnclosingProjectRoot(root)
    if (projectRoot) out.push(projectRoot)
  }
  return dedupRoots(out)
}

// --- Resolution cache ("resolve once, reuse") -------------------------------
// A repeated command (the model runs `python test_api.py` again, or a follow-up
// in the same project) should NOT pay the bounded-but-real filesystem search
// every time. We cache the resolved auto-workdir keyed by the run directory plus
// the target's identity, and re-validate each hit (the target must STILL be
// present at the cached dir, AND must NOT have appeared in the run dir itself)
// so a moved/deleted/local file can never produce a stale redirect. A failed
// re-validation evicts and falls through to the full search, so the cache can
// never produce a worse answer than no cache. Session-scoped (cleared on
// restart); unrelated to any provider/prompt cache.

type TargetDescriptor = { sig: string; label: string }

/**
 * Identify the command's target the SAME way (and in the SAME dispatch order) as
 * the resolver chain below, returning a stable cache signature + human label, or
 * null when the command names no statically-checkable target. The resolvers
 * themselves are untouched — this only feeds the cache key.
 */
function describeTarget(command: string): TargetDescriptor | null {
  const script = extractScriptFileTarget(command)
  if (script) {
    const rel = script.replace(/^\.[\\/]+/, '')
    return { sig: `script:${caseFold(rel)}`, label: path.basename(normalizeForFs(rel)) }
  }
  const mod = extractPythonModuleTarget(command)
  if (mod) return { sig: `module:${mod.module}`, label: `the ${mod.module} module` }
  if (extractManifestRunner(command)) {
    return { sig: 'manifest:package.json', label: 'package.json' }
  }
  const tool = matchProjectToolMarkers(command)
  if (tool) return { sig: `tool:${caseFold(tool.markers.join(','))}`, label: tool.label }
  if (extractComposeInvocation(command)) return { sig: 'compose', label: 'the Compose file' }
  return null
}

/**
 * True when the command's target already resolves from `dir` — i.e. running it
 * there needs no redirect. Reuses each resolver's own existence check so a
 * cached workdir is validated exactly the way it was originally chosen, and so a
 * run dir that has since grown its own copy of the target defeats a stale hit.
 */
async function targetPresentAt(command: string, dir: string): Promise<boolean> {
  const script = extractScriptFileTarget(command)
  if (script) return pathExists(resolveFrom(dir, script.replace(/^\.[\\/]+/, '')))
  const mod = extractPythonModuleTarget(command)
  if (mod) {
    for (const rel of mod.candidateRelPaths) {
      if (await pathExists(resolveFrom(dir, rel))) return true
    }
    return false
  }
  if (extractManifestRunner(command)) return pathExists(resolveFrom(dir, 'package.json'))
  const tool = matchProjectToolMarkers(command)
  if (tool) return markerReachableUpward(dir, tool.markers)
  if (extractComposeInvocation(command)) return composeFileExistsIn(dir)
  return false
}

const _targetWorkdirCache = new Map<string, string>()

/**
 * Resolve where a command's target file lives when it is not in the execution
 * directory. Handles, uniformly:
 *   - script interpreters: `node server.js`, `python app.py`, `./run.sh`
 *   - package-manifest runners: `npm run build`, `yarn test`, `pnpm i`
 *   - Compose: `docker compose up`, `docker-compose up`, podman
 * A single unambiguous subdirectory is returned as an `auto` workdir (applied at
 * execution time by the shell tools, so the model never has to retry); several
 * different subdirectories are `ambiguous`. Shared by BashTool and
 * PowerShellTool so both shells behave identically. A successful `auto` is
 * cached so a repeat of the same target from the same run dir is instant.
 */
export async function resolveTargetWorkdir(
  command: string,
  baseDir: string,
  searchRoots: string[] = [],
): Promise<TargetWorkdirResolution> {
  // Fast path: a previously-resolved target whose file is still in place (and
  // which has NOT appeared in baseDir itself) is returned without re-searching.
  const descriptor = describeTarget(command)
  const cacheKey = descriptor
    ? `${caseFold(normalizeForFs(baseDir))}\u0000${descriptor.sig}`
    : undefined
  if (cacheKey) {
    const cached = _targetWorkdirCache.get(cacheKey)
    if (cached !== undefined) {
      if (
        !(await targetPresentAt(command, baseDir)) &&
        (await targetPresentAt(command, cached))
      ) {
        return {
          kind: 'auto',
          workdir: cached,
          relWorkdir: displayWorkdir(baseDir, cached),
          label: descriptor!.label,
        }
      }
      _targetWorkdirCache.delete(cacheKey)
    }
  }

  // Search the run dir plus every other directory we have reason to know about
  // (workspace dirs + dirs used this session), AND each one's enclosing project
  // root — so a target that lives one level up from a file the model edited
  // (e.g. dvc.yaml above .../ml/train.py) still resolves. baseDir stays first
  // so it wins ties.
  const roots = await expandRootsWithProjectRoots(dedupRoots([baseDir, ...searchRoots]))
  const result =
    (await resolveScriptWorkdir(command, baseDir, roots)) ??
    (await resolveModuleWorkdir(command, baseDir, roots)) ??
    (await resolveManifestWorkdir(command, baseDir, roots)) ??
    (await resolveProjectToolWorkdir(command, baseDir, roots)) ??
    // Compose stays LAST: it returns {kind:'none'} (not null) for non-compose
    // commands, so it terminates the ?? chain and must be the terminal default.
    (await resolveComposeWorkdir(command, baseDir, roots))

  // Remember only SPECIFIC-FILE executions: a script (`node x.js`) or a Python
  // module (`-m pkg`) names a concrete target, so caching its directory is
  // safe and useful. compose/manifest/project-tool name NO file in the command,
  // so a cached directory would stick every future `docker compose` on the
  // first one ever resolved (the TP2-for-TP1 bug) — those re-search every time
  // (and surface when several candidates exist).
  if (
    cacheKey &&
    result.kind === 'auto' &&
    descriptor &&
    (descriptor.sig.startsWith('script:') || descriptor.sig.startsWith('module:'))
  ) {
    _targetWorkdirCache.set(cacheKey, result.workdir)
  }
  return result
}

/**
 * Target-existence preflight shared by BashTool and PowerShellTool. The
 * wrong-directory case is auto-corrected at execution time (resolveTargetWorkdir
 * → the shell tools' call()), INCLUDING the multi-candidate case: rather than
 * block — which loops a weak model on an error it can't act on — the tools
 * surface every candidate so the model re-runs naming the one it means (no
 * silent guess). So this stays as a shared seam in case future checks need it.
 */
export async function validateCommandTargetExists(
  _command: string,
  _baseDir: string,
): Promise<BashPreflightValidationResult> {
  return { ok: true }
}

export async function validateBashExecutionPreflight(
  input: BashPreflightInput,
  cwd = getCwd(),
): Promise<BashPreflightValidationResult> {
  let baseDir = cwd

  if (input.workdir) {
    const resolvedWorkdir = resolveFrom(cwd, input.workdir)
    if (await pathExistsAsDirectory(resolvedWorkdir)) {
      baseDir = resolvedWorkdir
    }
  }

  let commandToCheck = input.command
  const leadingCd = extractLeadingCdCommand(input.command)
  if (leadingCd) {
    const resolvedTarget = resolveFrom(baseDir, leadingCd.target)
    if (await pathExistsAsDirectory(resolvedTarget)) {
      baseDir = resolvedTarget
      commandToCheck = leadingCd.remainder
    }
  }

  return validateCommandTargetExists(commandToCheck, baseDir)
}
