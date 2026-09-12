import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Keep ripgrep's repository boundaries when searching inside a repo. Outside
 * one, enable its native hierarchical gitignore handling (added in rg 12).
 *
 * This is deliberately fresh and search-specific: findGitRoot's cached,
 * lexical Git discovery cannot account for git init during a session, symlink
 * targets, or ripgrep 15's Jujutsu (.jj) repositories.
 */
export async function getGrepIgnoreArgs(
  target: string,
  ripgrepMajorVersion: number | null,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted()
  if (ripgrepMajorVersion === null || ripgrepMajorVersion < 12) return []

  // Do not add network filesystem probes to the existing UNC search path.
  if (target.startsWith('\\\\') || target.startsWith('//')) return []

  let current: string
  try {
    const [canonicalPath, info] = await Promise.all([realpath(target), stat(target)])
    // Explicit files already bypass ignore filtering. Leave that escape hatch
    // and errors for missing/inaccessible targets to the existing search path.
    if (!info.isDirectory()) return []
    current = canonicalPath
  } catch {
    signal?.throwIfAborted()
    return []
  }

  const markers = ripgrepMajorVersion >= 15 ? ['.git', '.jj'] : ['.git']
  for (;;) {
    signal?.throwIfAborted()
    for (const marker of markers) {
      try {
        await stat(join(current, marker))
        return []
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // If repository discovery is inconclusive, preserve normal rg behavior.
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return []
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  signal?.throwIfAborted()
  return ['--no-require-git']
}
