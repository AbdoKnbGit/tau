import { execFile } from 'child_process'
import { join } from 'path'
import { logForDebugging } from './debug.js'

const CHECK_MS = 2_000

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function whenGone(pid: number, onGone: () => void): void {
  logForDebugging(`Watching process ${pid}, which waits for this run`)
  const timer = setInterval(() => {
    if (isRunning(pid)) return
    clearInterval(timer)
    logForDebugging(`Process ${pid} was killed, so this run stops too`)
    onGone()
  }, CHECK_MS)
  timer.unref()
}

/**
 * A script stops a run by killing what it started. On Windows that is usually npm's tau.cmd, and killing
 * cmd.exe does not reach the CLI under it: the run goes on spending quota, and the script waiting on the
 * output hangs too. Nothing signals the CLI, so this looks for it.
 *
 * Only for a parent that waits for this process, because any other parent may leave on purpose and expect
 * the run to carry on, like `nohup` or a detached spawn: a cmd.exe wrapper does not exit before what it
 * started, and neither does the launcher when it starts a compatible Node. If one of those is gone first,
 * it was killed. The one exception looks the same from here: a batch file that runs node.exe itself with
 * `start` and leaves later. `start tau` has a cmd.exe of its own that waits, and so carries on.
 */
export function watchForKilledWrapper(onKilled: () => void): void {
  const launcher = process.env.TAU_LAUNCHER_PID
  const aboveLauncher = process.env.TAU_LAUNCHER_PARENT_PID
  // Not for anything this run starts in turn, which has a parent of its own.
  delete process.env.TAU_LAUNCHER_PID
  delete process.env.TAU_LAUNCHER_PARENT_PID
  const underLauncher = launcher === String(process.ppid)
  if (underLauncher) whenGone(process.ppid, onKilled)
  if (process.platform !== 'win32') return
  const candidate = underLauncher ? Number(aboveLauncher) : process.ppid
  if (!candidate) return
  const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe')
  execFile(
    tasklist,
    ['/fi', `PID eq ${candidate}`, '/fo', 'csv', '/nh'],
    { windowsHide: true, timeout: 30_000 },
    (error, stdout) => {
      if (!error && /^"cmd\.exe"/i.test(stdout.trimStart())) whenGone(candidate, onKilled)
    },
  ).unref()
}
