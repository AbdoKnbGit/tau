import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'path'
import type { ToolPermissionContext } from '../Tool.js'
import { getGrepIgnoreArgs } from '../tools/GrepTool/grepIgnore.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { getFileReadIgnorePatterns } from './permissions/filesystem.js'
import { readDenyExclusionGlobs } from './permissions/readDenyGlobs.js'
import { getPlatform } from './platform.js'
import { getGlobExclusionsForPluginCache } from './plugins/orphanedPluginFilter.js'
import { getRipgrepMajorVersion, ripGrep } from './ripgrep.js'
import {
  fileNameFilterArgs,
  fileNameOnly,
  isFileNameGlob,
  segmentsUnder,
  vcsExclusionArgs,
  withoutDotSlash,
} from './searchGlobs.js'
import { plural } from './stringUtils.js'

/**
 * Extracts the static base directory from a glob pattern.
 * The base directory is everything before the first glob special character (* ? [ {).
 * Returns the directory portion and the remaining relative pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  // Find the first glob special character: *, ?, [, {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // No glob characters - this is a literal path
    // Return the directory portion and filename as pattern
    const dir = dirname(pattern)
    const file = basename(pattern)
    return { baseDir: dir, relativePattern: file }
  }

  // Get everything before the first glob character
  const staticPrefix = pattern.slice(0, match.index)

  // Find the last path separator in the static prefix
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // No path separator before the glob - pattern is relative to cwd
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on Windows)
  // When lastSepIndex is 0, baseDir is empty but we need to use '/' as the root
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/'
  }

  // Handle Windows drive root paths (e.g., C:/*.txt)
  // 'C:' means "current directory on drive C" (relative), not root
  // We need 'C:/' or 'C:\' for the actual drive root
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + sep
  }

  return { baseDir, relativePattern }
}

/**
 * First path segment of `p` relative to `root`. A file sitting directly in
 * `root` groups under its own name. Notice-only, so a path outside `root`
 * (which should not happen) falls back to the whole path instead of throwing.
 */
function topLevelEntry(p: string, root: string): string {
  const rel = relative(root, p)
  if (!rel || rel.startsWith('..')) return p
  const cut = rel.search(/[\\/]/)
  return cut === -1 ? rel : rel.slice(0, cut)
}

/** Matches a search left out because ignore files exclude them. */
export type IgnoredMatches = {
  /** How many were left out; null when counting them failed. */
  count: number | null
  /** Where they are, largest first (see summarizeIgnored). */
  places: Array<{ path: string; count: number }>
  /** Places beyond `places`. */
  morePlaces: number
}

const MAX_IGNORED_PLACES = 5

// Name for the one-off ripgrep file type that carries a file-name glob.
const NAME_TYPE = 'taupattern'

/**
 * Files matching `pattern` that no ignore file excludes, oldest first.
 *
 * `--glob <pattern>` cannot do this alone: ripgrep lets a matching --glob
 * override every ignore rule. A directory the pattern matches (`**` and `*`
 * match them all) is walked even when ignored, and an ignored file the
 * pattern names is listed anyway. A file type is applied after the ignore
 * rules and never matches a directory, so it filters without overriding.
 * A pattern that only constrains the file name (`*.py`, `package.json`, or
 * either behind leading globstars) is exactly such a filter. Any other
 * pattern keeps its own --glob, and its results are kept only where a
 * type-filtered walk found the same file.
 */
async function listNotIgnored(
  pattern: string,
  walkArgs: string[],
  exclusions: string[],
  rg: (args: string[]) => Promise<string[]>,
): Promise<string[]> {
  const name = fileNameOnly(pattern)
  if (name !== null) {
    return rg([
      ...walkArgs,
      ...fileNameFilterArgs(NAME_TYPE, [name]),
      ...exclusions,
      '--sort=modified',
    ])
  }
  // Every match's name matches the pattern's last segment, so filtering on
  // it only shrinks the walk; when that segment is unusable, walk them all.
  const last = pattern.slice(pattern.lastIndexOf('/') + 1)
  const [matches, notIgnored] = await Promise.all([
    rg([...walkArgs, '--glob', pattern, ...exclusions, '--sort=modified']),
    rg([
      ...walkArgs,
      ...fileNameFilterArgs(NAME_TYPE, isFileNameGlob(last) ? [last] : []),
      ...exclusions,
    ]),
  ])
  const keep = new Set(notIgnored)
  return matches.filter(path => keep.has(path))
}

/**
 * Count the matches missing from `listed` and say where they are. Each is
 * attributed to the shallowest folder under the search root that holds no
 * listed match, so a whole ignored tree (a virtualenv, a dependency folder)
 * reads as one place instead of thousands of files; an ignored file that
 * sits beside listed ones is its own place.
 */
function summarizeIgnored(
  allMatches: string[],
  listed: string[],
  searchDir: string,
): IgnoredMatches {
  const listedSet = new Set(listed)
  let listedDirs: Set<string> | undefined
  const places = new Map<string, number>()
  let count = 0
  for (const path of allMatches) {
    if (listedSet.has(path)) continue
    count++
    if (!listedDirs) {
      listedDirs = new Set()
      for (const shown of listed) {
        const parts = segmentsUnder(shown, searchDir)
        let dir = ''
        for (let i = 0; i < parts.length - 1; i++) {
          dir = i === 0 ? parts[0]! : `${dir}/${parts[i]}`
          listedDirs.add(dir)
        }
      }
    }
    let place = ''
    for (const part of segmentsUnder(path, searchDir)) {
      place = place ? `${place}/${part}` : part
      if (!listedDirs.has(place)) break
    }
    places.set(place, (places.get(place) ?? 0) + 1)
  }
  const ranked = [...places].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )
  return {
    count,
    places: ranked.slice(0, MAX_IGNORED_PLACES).map(([place, n]) => ({
      path: join(searchDir, ...place.split('/')),
      count: n,
    })),
    morePlaces: Math.max(0, ranked.length - MAX_IGNORED_PLACES),
  }
}

/**
 * One line telling the model what a search left out because ignore files
 * exclude it, and how to get it; null when nothing was left out.
 */
export function formatIgnoredNote(
  ignored: IgnoredMatches | undefined,
  [one, many]: [string, string] = ['match', 'matches'],
): string | null {
  if (!ignored || ignored.count === 0) return null
  if (ignored.count === null) {
    return `(${many[0]!.toUpperCase()}${many.slice(1)} excluded by .gitignore/.ignore rules are left out, and counting them failed. Pass include_ignored: true to include them.)`
  }
  const where = ignored.places.map(p => `${p.path} (${p.count})`)
  if (ignored.morePlaces > 0) {
    where.push(
      `${ignored.morePlaces} more ${plural(ignored.morePlaces, 'place')}`,
    )
  }
  const single = ignored.count === 1
  return `(Left out ${ignored.count} ${single ? one : many} excluded by .gitignore/.ignore rules: ${where.join(', ')}. Pass include_ignored: true to include ${single ? 'it' : 'them'}.)`
}

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
  { includeIgnored = false }: { includeIgnored?: boolean } = {},
): Promise<{
  files: string[]
  truncated: boolean
  /** Total matches before the page slice. */
  total: number
  /** Distinct top-level entries in the returned page. Set only when truncated. */
  shownEntries?: number
  /** Distinct top-level entries across every match. Set only when truncated. */
  totalEntries?: number
  /** Matches left out by ignore files. Absent when they are included. */
  ignored?: IgnoredMatches
}> {
  let searchDir = cwd
  let searchPattern = filePattern

  // Handle absolute paths by extracting the base directory and converting to relative pattern
  // ripgrep's --glob flag only works with relative patterns
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }
  // Results are printed under the root as spelled, so give it one spelling:
  // `C:/x` from a model would otherwise come back as `C:/x\sub\file`.
  searchDir = normalize(searchDir)
  searchPattern = withoutDotSlash(searchPattern)

  // Use ripgrep for better memory performance
  // --files: list files instead of searching content
  // --sort=modified: sort by modification time (oldest first)
  // --hidden: include hidden files (default true, set CLAUDE_CODE_GLOB_HIDDEN=false to exclude)
  // Ignore files (.gitignore, .ignore, .rgignore) are honoured the way Grep
  // honours them, outside repositories too. include_ignored, or
  // CLAUDE_CODE_GLOB_NO_IGNORE=true for every search, lists ignored files too.
  // Note: use || instead of ?? to treat empty string as unset (defaulting to true)
  const hidden = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_HIDDEN || 'true')
  const base = ['--files', ...(hidden ? ['--hidden'] : [])]

  // VCS metadata, read-deny rules and orphaned plugin versions. They follow
  // the pattern's own --glob because the last matching glob wins, and they
  // apply to the count too, so nothing they hide is reported as ignored.
  const exclusions = vcsExclusionArgs()
  for (const glob of readDenyExclusionGlobs(
    getFileReadIgnorePatterns(toolPermissionContext),
    searchDir,
  )) {
    exclusions.push('--glob', glob)
  }
  for (const exclusion of await getGlobExclusionsForPluginCache(searchDir)) {
    exclusions.push('--glob', exclusion)
  }

  // Every match, ignored or not.
  const everyMatch = [
    ...base,
    '--no-ignore',
    '--glob',
    searchPattern,
    ...exclusions,
  ]

  // The pattern and the deny globs are relative to the search root.
  const rg = (args: string[]) =>
    ripGrep(args, searchDir, abortSignal, { globsRelativeToTarget: true })

  let allPaths: string[]
  let ignored: IgnoredMatches | undefined
  if (includeIgnored || isEnvTruthy(process.env.CLAUDE_CODE_GLOB_NO_IGNORE)) {
    allPaths = await rg([...everyMatch, '--sort=modified'])
  } else {
    // Counting what the ignore files leave out runs alongside the listing.
    // It is unsorted, so it costs less than the one sorted walk over every
    // file that Glob used to make.
    const counted = rg(everyMatch).then(
      paths => ({ paths }),
      (error: unknown) => ({ error }),
    )
    const ignoreArgs = await getGrepIgnoreArgs(
      searchDir,
      await getRipgrepMajorVersion(),
      abortSignal,
    )
    allPaths = await listNotIgnored(
      searchPattern,
      [...base, ...ignoreArgs],
      exclusions,
      rg,
    )
    const every = await counted
    if ('paths' in every) {
      ignored = summarizeIgnored(every.paths, allPaths, searchDir)
    } else {
      abortSignal.throwIfAborted()
      logForDebugging(`Glob: counting ignored matches failed: ${every.error}`)
      ignored = { count: null, places: [], morePlaces: 0 }
    }
  }

  // ripgrep returns relative paths, convert to absolute
  const absolutePaths = allPaths.map(p =>
    isAbsolute(p) ? p : join(searchDir, p),
  )

  const truncated = absolutePaths.length > offset + limit
  const files = absolutePaths.slice(offset, offset + limit)

  // Truncation-notice metadata. `--sort=modified` is oldest-first, so an
  // over-cap page is the OLDEST slice of the tree and can sit entirely inside
  // one directory — an unpacked archive or an npm install restores old mtimes
  // and sorts to the front. Without the spread, a page drawn from one folder
  // reads as if it represented the whole result. One pass over an array that
  // is already materialized, so this adds no I/O and only runs when truncated.
  let shownEntries: number | undefined
  let totalEntries: number | undefined
  if (truncated) {
    const all = new Set<string>()
    for (const p of absolutePaths) all.add(topLevelEntry(p, searchDir))
    const shown = new Set<string>()
    for (const p of files) shown.add(topLevelEntry(p, searchDir))
    totalEntries = all.size
    shownEntries = shown.size
  }

  return {
    files,
    truncated,
    total: absolutePaths.length,
    ...(shownEntries !== undefined && { shownEntries }),
    ...(totalEntries !== undefined && { totalEntries }),
    ...(ignored && { ignored }),
  }
}
