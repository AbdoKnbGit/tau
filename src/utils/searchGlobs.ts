import { relative } from 'path'

/**
 * Where each version-control system keeps its own database. Never project
 * content, on any OS (git never lists `.git`), so every project walk leaves
 * them out. Everything else a walk skips comes from the project's own ignore
 * files, never from a list of folder names.
 */
export const VCS_METADATA_DIRS = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
] as const

/** ripgrep arguments that leave out VCS metadata, whatever the pattern. */
export function vcsExclusionArgs(): string[] {
  return VCS_METADATA_DIRS.flatMap(dir => ['--glob', `!${dir}`])
}

/**
 * A literal name as a glob that matches only itself. Metacharacters become
 * one-character classes, which --glob and --type-add read the same way on
 * every OS; a backslash (a legal name character outside Windows) is escaped.
 */
export function escapeGlobLiteral(text: string): string {
  return text.replace(/[\\*?[\]{}]/g, ch => (ch === '\\' ? '\\\\' : `[${ch}]`))
}

/**
 * {@link escapeGlobLiteral}, optionally case-insensitive: each letter becomes
 * a two-case class. For type filters, which have no case-insensitive switch.
 */
export function literalGlob(text: string, ignoreCase: boolean): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const upper = ch.toUpperCase()
    if (ignoreCase && lower !== upper) out += `[${lower}${upper}]`
    else out += escapeGlobLiteral(ch)
  }
  return out
}

/**
 * A glob that ripgrep can also apply as a file type: one path segment, no
 * negation, no `:` (the --type-add separator), `**` only on its own, and no
 * backslash, which --glob reads as an escape and a type does not on Windows.
 */
export function isFileNameGlob(glob: string): boolean {
  if (!glob || glob.startsWith('!') || /[\\/:]/.test(glob)) return false
  if (glob.includes('**') && glob !== '**') return false
  let braces = 0
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '[') {
      const close = glob.indexOf(']', i + 2)
      if (close === -1) return false
      i = close
    } else if (glob[i] === '{') {
      braces++
    } else if (glob[i] === '}' && --braces < 0) {
      return false
    }
  }
  return braces === 0
}

/**
 * The file-name glob a pattern reduces to when it constrains nothing but the
 * name (`*.py`, or the same behind leading globstars), else null.
 */
export function fileNameOnly(pattern: string): string | null {
  let name = pattern
  while (name.startsWith('**/')) name = name.slice(3)
  return isFileNameGlob(name) ? name : null
}

/**
 * ripgrep arguments keeping only files whose name matches one of `globs`,
 * as a one-off file type. Unlike a --glob, a type is applied after the ignore
 * rules and never matches a folder, so it cannot re-include an ignored path.
 */
export function fileNameFilterArgs(
  type: string,
  globs: readonly string[],
): string[] {
  if (globs.length === 0) return []
  return [
    ...globs.flatMap(glob => ['--type-add', `${type}:${glob}`]),
    '--type',
    type,
  ]
}

/**
 * ripgrep never strips a leading `./` from a glob, so `./src/*.ts` matched
 * nothing. Drop it (after an optional `!`); a pattern that is only `./`
 * stays as it was.
 */
export function withoutDotSlash(pattern: string): string {
  const negated = pattern.startsWith('!')
  let body = negated ? pattern.slice(1) : pattern
  while (body.startsWith('./')) body = body.slice(2)
  if (!body) return pattern
  return negated ? `!${body}` : body
}

/** Path segments of `path` below `root` (either separator). */
export function segmentsUnder(path: string, root: string): string[] {
  const rest =
    path.startsWith(root) &&
    (/[\\/]$/.test(root) || /[\\/]/.test(path[root.length] ?? ''))
      ? path.slice(root.length)
      : relative(root, path)
  return rest.split(/[\\/]+/).filter(Boolean)
}
