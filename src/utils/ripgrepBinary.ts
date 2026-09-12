import { spawnSync } from 'child_process'
import { existsSync } from 'fs'

type SpawnSyncLike = typeof spawnSync

/** Unknown/non-ripgrep output must never enable flags the binary may reject. */
export function parseRipgrepMajorVersion(output: string): number | null {
  const match = /^ripgrep (\d+)\.\d+\.\d+(?:[-+][^\s]+)?(?:\s|$)/.exec(output)
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}

/**
 * A downloaded file is not necessarily executable on the current host
 * (wrong architecture, corrupt archive, missing loader, or an OS policy can
 * all reject it). Probe it before selection so callers can fall back to the
 * system `rg` instead of failing every search.
 */
export function isUsableRipgrep(
  command: string,
  options: {
    fileExists?: (path: string) => boolean
    spawnSyncImpl?: SpawnSyncLike
  } = {},
): boolean {
  const fileExists = options.fileExists ?? existsSync
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync
  if (!fileExists(command)) return false

  try {
    const probe = spawnSyncImpl(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    })
    return (
      probe.status === 0 &&
      typeof probe.stdout === 'string' &&
      probe.stdout.startsWith('ripgrep ')
    )
  } catch {
    return false
  }
}
