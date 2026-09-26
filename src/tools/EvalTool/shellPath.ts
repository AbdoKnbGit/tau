/**
 * Programs the Bash tool can run must be runnable from a cell too.
 *
 * On Windows the Bash tool runs Git Bash, whose PATH starts with directories
 * that exist only inside its MSYS layer (/mingw64/bin, /usr/bin, ~/bin). The
 * kernel inherits Tau's own PATH, which has none of them, so a program the
 * model had just found with `which` in Bash — pdftotext here — raised
 * FileNotFoundError from `subprocess` in a cell. The model's next guess, the
 * MSYS path `/mingw64/bin/pdftotext`, is not a path Windows Python can open.
 *
 * So the kernel gets the directories the shell resolves programs from, asked
 * of that same shell in native form (`cygpath -w -p`): no install location is
 * assumed. They are appended, never prepended, so everything the kernel
 * already resolved — its interpreter, system commands — resolves the same.
 *
 * Other platforms have nothing to add: the shell snapshot pins the Bash tool's
 * PATH to this process's own (ShellSnapshot.getClaudeCodeSnapshotContent), so
 * the two already agree.
 */

import { execFile } from 'child_process'
import { delimiter as pathDelimiter } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { getPlatform } from '../../utils/platform.js'
import { findGitBashPath } from '../../utils/windowsPaths.js'

const PROBE_TIMEOUT_MS = 5_000
/** Prints nothing when the shell has no MSYS/Cygwin layer to translate. */
const NATIVE_PATH_COMMAND = 'command -v cygpath >/dev/null 2>&1 && cygpath -w -p "$PATH"'

let probe: Promise<string[]> | undefined

/** The Bash tool's shell on Windows, chosen the way Shell.findSuitableShell chooses it. */
function bashToolShell(): string | null {
  const override = process.env.CLAUDE_CODE_SHELL
  if (override && (override.includes('bash') || override.includes('zsh'))) return override
  return findGitBashPath()
}

/**
 * Directories on the Bash tool's PATH, as native paths. Empty where the two
 * PATHs already agree, and whenever the shell cannot be asked. Asked once per
 * session: the answer only changes when the user edits their environment,
 * which needs a restart to reach Tau anyway.
 */
export function bashToolPathEntries(): Promise<string[]> {
  if (getPlatform() !== 'windows') return Promise.resolve([])
  probe ??= new Promise<string[]>(resolve => {
    const shell = bashToolShell()
    if (!shell) return resolve([])
    execFile(
      shell,
      ['-c', NATIVE_PATH_COMMAND],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          logForDebugging(`Eval: could not read the Bash tool's PATH: ${error.message}`)
          return resolve([])
        }
        resolve(splitPathList(stdout, ';'))
      },
    )
  })
  return probe
}

export function splitPathList(text: string, delimiter: string): string[] {
  return text
    .trim()
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
}

/**
 * `env` with `entries` appended to its PATH, skipping any directory already
 * on it. The existing key keeps its spelling (`Path` on Windows): adding a
 * second, differently cased PATH would leave the child with two.
 */
export function withAppendedPath(
  env: Record<string, string>,
  entries: readonly string[],
  options: { delimiter?: string; caseInsensitive?: boolean } = {},
): Record<string, string> {
  if (entries.length === 0) return env
  const delimiter = options.delimiter ?? pathDelimiter
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = splitPathList(env[key] ?? '', delimiter)
  const normalize = (entry: string) => {
    const trimmed = entry.replace(/[\\/]+$/, '')
    return caseInsensitive ? trimmed.toLowerCase() : trimmed
  }
  const seen = new Set(current.map(normalize))
  const added: string[] = []
  for (const entry of entries) {
    const id = normalize(entry)
    if (!id || seen.has(id)) continue
    seen.add(id)
    added.push(entry)
  }
  if (added.length === 0) return env
  return { ...env, [key]: [...current, ...added].join(delimiter) }
}

/** Test-only: forget the probed PATH. */
export function _resetBashToolPathForTest(): void {
  probe = undefined
}
