import { spawn } from 'child_process'
import treeKill from 'tree-kill'
import { resolveWindowsTaskkillPath } from './execFileNoThrow.js'

type KillProcessTreeDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawnImpl?: typeof spawn
  treeKillImpl?: typeof treeKill
  processKillImpl?: typeof process.kill
}

/**
 * Kill `pid` and all of its descendants. Fire-and-forget, like tree-kill.
 *
 * On Windows tree-kill runs `exec('taskkill …')`, and cmd.exe resolves a bare
 * `taskkill` from the current folder before PATH, so a taskkill.bat in the
 * project would run on every interrupt. Spawn System32's taskkill.exe by
 * absolute path instead, without a shell. Other platforms keep tree-kill.
 */
export function killProcessTree(
  pid: number,
  {
    platform = process.platform,
    env = process.env,
    spawnImpl = spawn,
    treeKillImpl = treeKill,
    processKillImpl = process.kill.bind(process),
  }: KillProcessTreeDeps = {},
): void {
  if (platform !== 'win32') {
    treeKillImpl(pid, 'SIGKILL')
    return
  }

  const taskkillPath = resolveWindowsTaskkillPath(env)
  if (!taskkillPath) {
    // Never guess the Windows drive or trust a PATH/cwd taskkill. Killing
    // the shell alone is the safe degraded mode.
    try {
      processKillImpl(pid, 'SIGKILL')
    } catch {
      // The process already exited.
    }
    return
  }

  try {
    const taskkill = spawnImpl(
      taskkillPath,
      ['/PID', String(pid), '/T', '/F'],
      {
        stdio: 'ignore',
        // Node ends attached children when it exits; the kill must outlive Tau.
        detached: true,
        windowsHide: true,
      },
    )
    // A failed spawn (e.g. ENOENT) emits 'error' asynchronously. Unhandled,
    // it would crash Tau.
    taskkill.once('error', () => {})
  } catch {
    // Like tree-kill, a failed kill stays silent.
  }
}
