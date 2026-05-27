import { stat } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { getPlatform } from '../../utils/platform.js'
import { posixPathToWindowsPath } from '../../utils/windowsPaths.js'

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
export function normalizeForFs(target: string, platform = getPlatform()): string {
  if (platform !== 'windows') return target
  // Match Git Bash drive form `/c/`, Cygwin `/cygdrive/c/`, and UNC `//`.
  if (!/^(\/[a-zA-Z]\/|\/cygdrive\/|\/\/)/.test(target)) return target
  try {
    return posixPathToWindowsPath(target)
  } catch {
    return target
  }
}

const LEADING_CD_RE =
  /^\s*cd\s+(?:--\s+)?((?:"(?:\\.|[^"\\])*")|'(?:[^']*)'|[^\s;&|]+)\s*&&/i

export type BashPreflightInput = {
  command: string
  workdir?: string
}

export type BashPreflightValidationResult =
  | { ok: true }
  | { ok: false; message: string }

function unquoteShellToken(token: string): string {
  const trimmed = token.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function shellQuoteForHint(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isDynamicCdTarget(target: string): boolean {
  return (
    target === '' ||
    target === '-' ||
    target.startsWith('~') ||
    /[$`*?[{]/.test(target)
  )
}

function extractLeadingCdTarget(command: string): string | null {
  const match = LEADING_CD_RE.exec(command)
  if (!match?.[1]) return null

  const target = unquoteShellToken(match[1])
  return isDynamicCdTarget(target) ? null : target
}

async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function resolveFrom(baseDir: string, target: string): string {
  const normalized = normalizeForFs(target)
  return isAbsolute(normalized) ? normalized : resolve(baseDir, normalized)
}

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

  const cdTarget = extractLeadingCdTarget(input.command)
  if (!cdTarget) return { ok: true }

  const resolvedTarget = resolveFrom(baseDir, cdTarget)
  if (await pathExistsAsDirectory(resolvedTarget)) return { ok: true }

  return {
    ok: false,
    message: formatMissingCdTargetMessage(cdTarget, resolvedTarget, baseDir),
  }
}
