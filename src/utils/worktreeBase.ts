import { randomUUID } from 'node:crypto'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

export type WorktreeBase = 'head' | 'remote-default'

export class WorktreeBaseError extends Error {
  override name = 'WorktreeBaseError'
}

/** Resolve once, in the caller's checkout, and create from the immutable SHA. */
export async function resolveWorktreeBase(
  cwd: string,
  options: { base?: WorktreeBase; remote?: string; prNumber?: number } = {},
): Promise<{ baseBranch: string; baseSha: string }> {
  async function resolveCommit(ref: string): Promise<string> {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { cwd },
    )
    if (result.code !== 0) {
      throw new WorktreeBaseError(
        ref === 'HEAD'
          ? 'Cannot create a worktree from HEAD: the current checkout must have a commit.'
          : `Cannot resolve the fetched worktree base: ${result.stderr.trim()}`,
      )
    }
    return result.stdout.trim()
  }

  if (options.prNumber === undefined && (options.base ?? 'head') === 'head') {
    return { baseBranch: 'HEAD', baseSha: await resolveCommit('HEAD') }
  }

  if (
    options.prNumber !== undefined &&
    (!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0)
  ) {
    throw new WorktreeBaseError('Invalid worktree pull request number.')
  }
  if (options.prNumber === undefined && options.base !== 'remote-default') {
    throw new WorktreeBaseError(`Unknown worktree base: ${options.base}`)
  }

  const remote = options.remote ?? 'origin'
  // Fetch remote HEAD itself: cached origin/HEAD and default-branch discovery
  // can both be stale after the server changes its default branch. An explicit
  // private refspec also works with narrow/single-branch clone fetch mappings.
  const sourceRef =
    options.prNumber === undefined ? 'HEAD' : `refs/pull/${options.prNumber}/head`
  const baseBranch =
    options.prNumber === undefined
      ? `${remote}/HEAD`
      : `${remote}/pull/${options.prNumber}/head`
  const temporaryRef = `refs/tau/worktree-bases/${randomUUID()}`
  try {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--refmap=',
        '--',
        remote,
        `+${sourceRef}:${temporaryRef}`,
      ],
      {
        cwd,
        timeout: 60_000,
        stdin: 'ignore',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          GCM_INTERACTIVE: 'never',
        },
      },
    )
    if (result.code !== 0) {
      throw new WorktreeBaseError(
        `Cannot fetch worktree base ${baseBranch}: ${result.stderr.trim() || 'remote unavailable'}. ` +
        'No cached commit was used. Check the remote or select Current commit in /config.',
      )
    }
    return { baseBranch, baseSha: await resolveCommit(temporaryRef) }
  } finally {
    // Never share FETCH_HEAD between simultaneous agents/PR fetches. Each
    // operation owns its temporary ref; cleanup cannot remove another's ref.
    await execFileNoThrowWithCwd(gitExe(), ['update-ref', '-d', temporaryRef], { cwd })
  }
}
