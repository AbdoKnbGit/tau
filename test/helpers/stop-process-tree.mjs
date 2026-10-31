import { spawn } from 'node:child_process'

// Stops a CLI that stopped answering, along with anything it started. Without this, a stuck child that
// holds the output pipes open would keep a test waiting on them forever.
// POSIX callers spawn with `detached: process.platform !== 'win32'`, which gives the tree its own group.
export function stopProcessTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
