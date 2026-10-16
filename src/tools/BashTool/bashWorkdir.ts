import { statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import path from 'path'
import pathWin32 from 'path/win32'
import { getCwd } from '../../utils/cwd.js'
import { getPlatform } from '../../utils/platform.js'
import { posixPathToWindowsPath } from '../../utils/windowsPaths.js'

type Platform = ReturnType<typeof getPlatform>

export type BashExecutionWorkdirInput = {
  command: string
  workdir?: string
  command_parts?: unknown
  /**
   * Set when workdir was synthesized from a model-written leading `cd X && …`.
   * The model's mental model after writing that command is "the shell is now
   * in X", so BashTool persists the session cwd to X (within allowed working
   * paths) to mirror real shell semantics. Never set for an explicit workdir,
   * which is documented as a one-off override.
   */
  _workdirFromCd?: boolean
}

const LEADING_CD_RE =
  /^\s*cd\s+(?:--\s+)?((?:"(?:\\.|[^"\\])*")|'(?:[^']*)'|[^\s;&|]+)\s*&&\s*([\s\S]+?)\s*$/i

function pathApi(
  platform: Platform,
): typeof path.posix | typeof pathWin32 {
  return platform === 'windows' ? pathWin32 : path.posix
}

function isExistingDirectory(
  target: string,
  platform: Platform,
): boolean {
  try {
    return statSync(normalizeForHostFs(target, platform)).isDirectory()
  } catch {
    return false
  }
}

function pathEndsWith(
  target: string,
  suffixParts: string[],
  platform: Platform,
): boolean {
  if (suffixParts.length === 0) return false
  const api = pathApi(platform)
  const targetParts = api
    .resolve(target)
    .split(/[\\/]+/)
    .filter(Boolean)
  if (suffixParts.length > targetParts.length) return false
  const offset = targetParts.length - suffixParts.length
  return suffixParts.every((part, index) => {
    const actual = targetParts[offset + index]
    return platform === 'windows'
      ? actual?.toLowerCase() === part.toLowerCase()
      : actual === part
  })
}

/**
 * Recover the common "cwd suffix was repeated" mistake without guessing a
 * different project. Example:
 *
 *   cwd:       C:\repo\sd\ef
 *   requested: sd/ef
 *   lexical:   C:\repo\sd\ef\sd\ef
 *
 * If the lexical directory exists, it always wins. Otherwise, only collapse to
 * the nearest existing ancestor when the missing suffix exactly repeats that
 * ancestor's own suffix. This is host/path-shape based, not machine-specific.
 */
function recoverRepeatedWorkdirSuffix(
  candidate: string,
  platform: Platform,
): string {
  const api = pathApi(platform)
  const absolute = api.resolve(candidate)
  if (isExistingDirectory(absolute, platform)) return absolute

  const missingParts: string[] = []
  let ancestor = absolute
  for (let depth = 0; depth < 40; depth++) {
    const parent = api.dirname(ancestor)
    if (parent === ancestor) break
    missingParts.unshift(api.basename(ancestor))
    ancestor = parent
    if (!isExistingDirectory(ancestor, platform)) continue
    return pathEndsWith(ancestor, missingParts, platform) ? ancestor : absolute
  }
  return absolute
}

/**
 * Recover a `cd`-derived workdir the model expressed relative to an ANCESTOR of
 * cwd rather than to cwd itself — the common "I wrote the path from the project
 * root, but the shell is actually in a subdirectory" mistake. Example:
 *
 *   cwd:       C:\repo\todo-app\backend
 *   cd target: todo-app/frontend   (model treats cwd as C:\repo)
 *   lexical:   C:\repo\todo-app\backend\todo-app\frontend   (does not exist)
 *   recovered: C:\repo\todo-app\frontend                    (exists → use it)
 *
 * Only fires when the lexical workdir does NOT exist and the relative move has no
 * `..`/absolute escape. Walks up cwd's ancestors (never scanning the user's home
 * directory or above) and returns the NEAREST ancestor for which that same
 * relative path resolves to a real directory — nearest-wins keeps it
 * deterministic and biased toward the closest (most specific) project root. When
 * nothing matches it returns the original workdir unchanged, so a genuinely bad
 * path still surfaces the clear "workdir does not exist" error downstream rather
 * than being silently redirected somewhere wrong. Complements
 * recoverRepeatedWorkdirSuffix (which handles the reverse "suffix repeated"
 * shape); the two are composed by normalizeBashExecutionInput.
 */
function recoverWorkdirFromAncestor(
  cwd: string,
  workdir: string,
  platform: Platform,
): string {
  const api = pathApi(platform)
  const absWorkdir = api.resolve(workdir)
  if (isExistingDirectory(absWorkdir, platform)) return workdir

  const absCwd = api.resolve(cwd)
  const rel = api.relative(absCwd, absWorkdir)
  // Only the "expressed relative to an ancestor" shape is recoverable: a forward
  // relative move, no parent escape, not itself absolute.
  if (!rel || rel.startsWith('..') || api.isAbsolute(rel)) return workdir

  const fold = (p: string): string =>
    platform === 'windows' ? p.toLowerCase() : p
  const home = fold(api.resolve(homedir()))
  let ancestor = api.dirname(absCwd)
  for (let depth = 0; depth < 40; depth++) {
    // Never treat home or above as a base — avoids matching a stray same-named
    // directory elsewhere in the home tree that isn't the project the model meant.
    if (fold(ancestor) === home) break
    const candidate = api.resolve(ancestor, rel)
    if (isExistingDirectory(candidate, platform)) return candidate
    const parent = api.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return workdir
}

/**
 * Translate shell-facing absolute path spellings into host fs spellings.
 * On Windows this lets Node validate Git Bash paths like /c/Users/...,
 * while non-Windows hosts keep /c/... as a real POSIX path.
 */
export function normalizeForHostFs(
  target: string,
  platform: Platform = getPlatform(),
): string {
  if (platform !== 'windows') return target
  // Match the /tmp alias used by file tools (expandPath) and bashProvider.
  // Resolve it before Win32 path handling interprets it as a drive-root path.
  if (/^\/tmp(?:\/|$)/.test(target)) {
    return pathWin32.join(tmpdir(), target.slice(5))
  }
  if (!/^(\/[a-zA-Z]\/|\/cygdrive\/|\/\/)/.test(target)) return target
  try {
    return posixPathToWindowsPath(target)
  } catch {
    return target
  }
}

export function resolveBashPathFrom(
  baseDir: string,
  target: string,
  platform: Platform = getPlatform(),
): string {
  const fsTarget = normalizeForHostFs(target, platform)
  const api = pathApi(platform)
  return api.isAbsolute(fsTarget) ? fsTarget : api.resolve(baseDir, fsTarget)
}

/**
 * Compare two directory spellings for cwd-equality. Tolerates Git Bash vs
 * native spellings, trailing separators, and case differences on Windows.
 * Used for "did the cwd actually move?" checks — not for security decisions.
 */
export function isSameBashCwd(
  a: string,
  b: string,
  platform: Platform = getPlatform(),
): boolean {
  const api = pathApi(platform)
  const ra = api.resolve(normalizeForHostFs(a, platform))
  const rb = api.resolve(normalizeForHostFs(b, platform))
  return platform === 'windows'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb
}

export function resolveEffectiveBashCwd(
  input: Pick<BashExecutionWorkdirInput, 'workdir'>,
  cwd = getCwd(),
  platform: Platform = getPlatform(),
): string {
  return input.workdir
    ? resolveBashPathFrom(cwd, input.workdir, platform)
    : cwd
}

function unquoteShellToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isDynamicCdTarget(target: string): boolean {
  return (
    target === '' ||
    target === '-' ||
    target.startsWith('~') ||
    /[$`*?[{]/.test(target)
  )
}

export function extractLeadingCdCommand(
  command: string,
): { target: string; remainder: string } | null {
  const match = LEADING_CD_RE.exec(command)
  if (!match?.[1] || !match[2]?.trim()) return null

  const target = unquoteShellToken(match[1])
  if (isDynamicCdTarget(target)) return null
  return { target, remainder: match[2].trim() }
}

export function normalizeBashExecutionInput<T extends BashExecutionWorkdirInput>(
  input: T,
  cwd = getCwd(),
  platform: Platform = getPlatform(),
): T {
  if (input.command_parts) return input

  const hadProvidedWorkdir = input.workdir !== undefined
  let command = input.command
  let workdir = input.workdir
    ? recoverRepeatedWorkdirSuffix(
        resolveBashPathFrom(cwd, input.workdir, platform),
        platform,
      )
    : undefined
  let changed = false
  let convertedCd = false

  if (workdir !== input.workdir) changed = true

  for (let i = 0; i < 10; i++) {
    const leadingCd = extractLeadingCdCommand(command)
    if (!leadingCd) break

    const baseDir = resolveEffectiveBashCwd({ workdir }, cwd, platform)
    workdir = resolveBashPathFrom(baseDir, leadingCd.target, platform)
    command = leadingCd.remainder
    changed = true
    convertedCd = true
  }

  if (convertedCd && workdir) {
    workdir = recoverRepeatedWorkdirSuffix(workdir, platform)
    // A bare leading `cd <relative>` (no explicit workdir) is the case the model
    // most often gets wrong by treating cwd as the project root. When the literal
    // target does not exist, try resolving it against cwd's ancestors instead of
    // letting it fail with a raw "workdir does not exist".
    if (!hadProvidedWorkdir) {
      workdir = recoverWorkdirFromAncestor(cwd, workdir, platform)
    }
  }

  return changed
    ? ({
        ...input,
        command,
        workdir,
        _workdirFromCd: convertedCd ? true : input._workdirFromCd,
      } as T)
    : input
}

export function normalizeBashExecutionInputInPlace<
  T extends BashExecutionWorkdirInput,
>(
  input: T,
  cwd = getCwd(),
  platform: Platform = getPlatform(),
): T {
  const normalized = normalizeBashExecutionInput(input, cwd, platform)
  if (normalized !== input) {
    input.command = normalized.command
    input.workdir = normalized.workdir
    input._workdirFromCd = normalized._workdirFromCd
  }
  return input
}
