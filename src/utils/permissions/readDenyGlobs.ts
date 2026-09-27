import { isAbsolute, relative } from 'path'
import picomatch from 'picomatch'
import { escapeGlobLiteral } from '../searchGlobs.js'

/**
 * Read-deny rules as ripgrep exclusion globs for a search whose globs are
 * anchored at `anchor` (a ripGrep call with `globsRelativeToTarget`).
 *
 * `patternsByRoot` is getFileReadIgnorePatterns(): a rule with a root is
 * anchored there (`/secrets/**` in project settings means that folder under
 * the project), a rule without one matches at any depth.
 *
 * A rooted rule is rewritten to mean the same thing seen from `anchor`,
 * wherever the search starts:
 * - root at or below the anchor: prefix the path between them;
 * - root above the anchor: walk the rule's leading segments down the folders
 *   between them (`**` may take any number) and keep what is left, so a rule
 *   such as `~/` + `**` + `/*.pem` still applies to a search of one project;
 * - unrelated trees (another drive, a sibling folder): nothing to exclude.
 * The old normalizer dropped the root-above case, so those rules hid nothing.
 */
export function readDenyExclusionGlobs(
  patternsByRoot: ReadonlyMap<string | null, readonly string[]>,
  anchor: string,
): string[] {
  const globs = new Set<string>()
  for (const [root, patterns] of patternsByRoot) {
    for (const pattern of patterns) {
      for (const glob of anchorPattern(root, pattern, anchor)) {
        globs.add(`!${glob}`)
      }
    }
  }
  return [...globs]
}

function anchorPattern(
  root: string | null,
  pattern: string,
  anchor: string,
): string[] {
  const tail = pattern.endsWith('/') ? '/' : ''
  const body = pattern.replace(/^\/+|\/+$/g, '')
  if (!body) return []
  // No root: any depth, as Grep has always applied these.
  if (root === null) return [`**/${body}${tail}`]
  // gitignore rules: a slash before the end anchors the rule at its root.
  const anchored = pattern.startsWith('/') || body.includes('/')

  const down = foldersBelow(anchor, root)
  if (down) {
    const at = down.map(folder => `/${escapeGlobLiteral(folder)}`).join('')
    return [anchored ? `${at}/${body}${tail}` : `${at}/**/${body}${tail}`]
  }
  const up = foldersBelow(root, anchor)
  if (!up) return []
  if (!anchored) return [`**/${body}${tail}`]
  const rests = remaindersBelow(body.split('/'), up)
  // An empty remainder: the rule covers a folder holding the anchor.
  if (rests.includes('')) return ['**']
  return rests.map(rest => `/${rest}${tail}`)
}

/** Folders from `from` down to `to`; null unless `to` is at or below `from`. */
function foldersBelow(from: string, to: string): string[] | null {
  const rel = relative(from, to)
  if (!rel) return []
  if (isAbsolute(rel) || rel === '..' || /^\.\.[\\/]/.test(rel)) return null
  return rel.split(/[\\/]+/).filter(Boolean)
}

/**
 * What is left of a rule's segments once they have matched `folders`, the
 * path from the rule's root down to the anchor. '' means the rule matched one
 * of those folders itself, which denies everything below it.
 */
function remaindersBelow(segments: string[], folders: string[]): string[] {
  const out = new Set<string>()
  const seen = new Set<string>()
  const visit = (s: number, f: number): void => {
    const key = `${s}:${f}`
    if (seen.has(key)) return
    seen.add(key)
    if (s === segments.length) {
      out.add('')
      return
    }
    if (f === folders.length) {
      out.add(segments.slice(s).join('/'))
      return
    }
    const segment = segments[s]!
    if (segment === '**') {
      visit(s + 1, f)
      visit(s, f + 1)
      return
    }
    if (segmentMatches(segment, folders[f]!)) visit(s + 1, f + 1)
  }
  visit(0, 0)
  return [...out]
}

/**
 * One segment of a rule against one folder name, ignoring case as the Read
 * check does. When in doubt the rule is kept: hiding one file too many is
 * safe, listing a denied one is not.
 */
function segmentMatches(segment: string, folder: string): boolean {
  if (!/[*?[\]{}\\]/.test(segment)) {
    return segment.toLowerCase() === folder.toLowerCase()
  }
  try {
    return picomatch.isMatch(folder, segment, { dot: true, nocase: true })
  } catch {
    return true
  }
}
