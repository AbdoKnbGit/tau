import { normalize } from 'path'
import { getGrepIgnoreArgs } from '../tools/GrepTool/grepIgnore.js'
import { getRipgrepMajorVersion, ripGrep, ripGrepStream } from './ripgrep.js'
import {
  fileNameFilterArgs,
  segmentsUnder,
  vcsExclusionArgs,
} from './searchGlobs.js'

/**
 * Walking a project the way its own ignore files describe it.
 *
 * Every walk that decides what counts as the project (code retrieval, LSP
 * warm-up, the Bash preflight search, the provider context) goes through
 * here instead of carrying its own list of folder names to skip. Ignore files
 * (.gitignore, .ignore, .rgignore) are honoured the way Grep honours them,
 * outside repositories too, and VCS metadata is left out. A virtualenv that
 * ignores itself (uv, virtualenv and Python 3.13+ write `.gitignore` = `*`),
 * a dependency folder or a build output drops out wherever the project says
 * so, and nowhere else.
 */

// One-off ripgrep file type for name filters; unlike --glob, a type is
// applied after the ignore rules and never re-includes an ignored path.
const NAME_TYPE = 'tauproject'

export type ProjectWalk = {
  /**
   * Hidden entries to include: all of them, hidden files but no hidden
   * folders (what hand-written walks used to do), or none.
   */
  hidden: 'all' | 'files' | 'none'
  /** Keep only files whose name matches one of these globs. */
  names?: readonly string[]
  /** Deepest level listed; files directly in the root are level 1. */
  maxDepth?: number
  signal: AbortSignal
}

async function walkArgs(root: string, walk: ProjectWalk): Promise<string[]> {
  const args = ['--files']
  if (walk.hidden !== 'none') args.push('--hidden')
  args.push(
    ...(await getGrepIgnoreArgs(
      root,
      await getRipgrepMajorVersion(),
      walk.signal,
    )),
  )
  args.push(...fileNameFilterArgs(NAME_TYPE, walk.names ?? []))
  if (walk.maxDepth !== undefined) {
    args.push('--max-depth', String(walk.maxDepth))
  }
  args.push(...vcsExclusionArgs())
  if (walk.hidden === 'files') args.push('--glob', '!.*/')
  return args
}

/**
 * Absolute paths of the files under `root` that the project's ignore files
 * keep, in no particular order. A timeout or abort on `walk.signal` returns
 * what was found by then.
 */
export async function listProjectFiles(
  root: string,
  walk: ProjectWalk,
): Promise<string[]> {
  // Paths are printed under the root as spelled; give it one spelling.
  const dir = normalize(root)
  try {
    return await ripGrep(await walkArgs(dir, walk), dir, walk.signal)
  } catch {
    // Best effort: a failed or cancelled walk finds nothing.
    return []
  }
}

/** Order paths shallowest first, then by path, for "the nearest one". */
export function byDepth(root: string): (a: string, b: string) => number {
  return (a, b) =>
    segmentsUnder(a, root).length - segmentsUnder(b, root).length ||
    (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * Which of `folders` (names directly under `root`) hold at least one file
 * the project's ignore files keep. The walk stops as soon as every folder is
 * accounted for; one the walk never reaches holds nothing but ignored files.
 * A timeout or abort on `walk.signal` keeps what was found by then.
 */
export async function foldersWithProjectFiles(
  root: string,
  folders: readonly string[],
  walk: Omit<ProjectWalk, 'names' | 'maxDepth'>,
): Promise<string[]> {
  const pending = new Set(folders)
  const found = new Set<string>()
  if (pending.size === 0) return []
  const dir = normalize(root)
  const stop = new AbortController()
  const forward = () => stop.abort()
  walk.signal.addEventListener('abort', forward, { once: true })
  try {
    const args = await walkArgs(dir, { ...walk })
    await ripGrepStream(args, dir, stop.signal, lines => {
      for (const line of lines) {
        const top = segmentsUnder(line, dir)
        if (top.length > 1 && pending.delete(top[0]!)) found.add(top[0]!)
      }
      if (pending.size === 0) stop.abort()
    })
  } catch {
    // Stopped early, timed out, or ripgrep failed: keep what was found.
  } finally {
    walk.signal.removeEventListener('abort', forward)
  }
  return folders.filter(folder => found.has(folder))
}
