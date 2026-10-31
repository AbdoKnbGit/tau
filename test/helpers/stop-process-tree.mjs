import { spawn } from 'node:child_process'

// The launcher starts the CLI as a child, and stopping a process on Windows does not reach its children.
// A CLI left behind holds the output pipes open, so a test waiting for them would wait forever.
// POSIX callers spawn with `detached: process.platform !== 'win32'`, which gives the tree its own group.
export function stopProcessTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
