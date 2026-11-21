import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fsOperations.js'

const SKILL_MD_RE = /^skill\.md$/i
// Claude Code's limits: a plugin tree deeper or wider than this is not scanned.
const MAX_SCAN_DEPTH = 32
const MAX_SCAN_DIRECTORIES = 4096

/**
 * Recursively walk a plugin directory, invoking onFile for each .md file.
 *
 * The namespace array tracks the subdirectory path relative to the root
 * (e.g., ['foo', 'bar'] for root/foo/bar/file.md). Callers that don't need
 * namespacing can ignore the second argument.
 *
 * When stopAtSkillDir is true and a directory contains SKILL.md, onFile is
 * called for all .md files in that directory but subdirectories are not
 * scanned — skill directories are leaf containers.
 *
 * Readdir errors are swallowed with a debug log so one bad directory doesn't
 * abort a plugin load.
 */
export async function walkPluginMarkdown(
  rootDir: string,
  onFile: (fullPath: string, namespace: string[]) => Promise<void>,
  opts: { stopAtSkillDir?: boolean; logLabel?: string } = {},
): Promise<void> {
  const fs = getFsImplementation()
  const label = opts.logLabel ?? 'plugin'
  let scannedDirectories = 0
  let stopped = false

  async function scan(dirPath: string, namespace: string[]): Promise<void> {
    if (namespace.length >= MAX_SCAN_DEPTH) {
      logForDebugging(
        `Skipping ${label} directory beyond depth ${MAX_SCAN_DEPTH}: ${dirPath}`,
        { level: 'error' },
      )
      return
    }
    if (++scannedDirectories > MAX_SCAN_DIRECTORIES) {
      if (!stopped) {
        stopped = true
        logForDebugging(
          `Stopping ${label} scan after ${MAX_SCAN_DIRECTORIES} directories (root=${rootDir})`,
          { level: 'error' },
        )
      }
      return
    }
    try {
      const entries = await fs.readdir(dirPath)

      if (
        opts.stopAtSkillDir &&
        entries.some(e => e.isFile() && SKILL_MD_RE.test(e.name))
      ) {
        // Skill directory: collect .md files here, don't recurse.
        await Promise.all(
          entries.map(entry =>
            entry.isFile() && entry.name.toLowerCase().endsWith('.md')
              ? onFile(join(dirPath, entry.name), namespace)
              : undefined,
          ),
        )
        return
      }

      await Promise.all(
        entries.map(entry => {
          const fullPath = join(dirPath, entry.name)
          if (entry.isDirectory()) {
            return scan(fullPath, [...namespace, entry.name])
          }
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            return onFile(fullPath, namespace)
          }
          return undefined
        }),
      )
    } catch (error) {
      logForDebugging(
        `Failed to scan ${label} directory ${dirPath}: ${error}`,
        { level: 'error' },
      )
    }
  }

  await scan(rootDir, [])
}
