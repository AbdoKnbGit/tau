#!/usr/bin/env node
// Poll a URL and open it in the default browser when it responds.
// Usage: node scripts/open-if-running.js http://localhost:3000 [--timeout=30000] [--interval=500]

const { exec } = await import('node:child_process')
const { setTimeout: wait } = await import('node:timers/promises')

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('Usage: open-if-running.js <url> [--timeout=30000] [--interval=500]')
  process.exit(2)
}

const url = argv[0]
const timeoutArg = argv.find(a => a.startsWith('--timeout='))
const intervalArg = argv.find(a => a.startsWith('--interval='))
const timeout = timeoutArg ? Number(timeoutArg.split('=')[1]) : 30000
const interval = intervalArg ? Number(intervalArg.split('=')[1]) : 500

const start = Date.now()
let opened = false

async function check() {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (res.ok) return true
    // treat any 2xx/3xx as success
    if (res.status >= 200 && res.status < 400) return true
  } catch (e) {
    // ignore
  }
  return false
}

function openBrowser(u) {
  const platform = process.platform
  let cmd
  if (platform === 'darwin') cmd = `open "${u}"`
  else if (platform === 'win32') cmd = `start "" "${u}"`
  else cmd = `xdg-open "${u}"`

  exec(cmd, (err) => {
    if (err) {
      console.error('Failed to open browser:', err.message)
      process.exit(1)
    } else {
      console.log('Opened browser to', u)
      process.exit(0)
    }
  })
}

(async () => {
  console.log(`Waiting for ${url} (timeout ${timeout}ms)...`)
  while (Date.now() - start < timeout) {
    if (await check()) {
      console.log(`${url} is reachable, opening browser...`)
      opened = true
      openBrowser(url)
      break
    }
    await wait(interval)
  }
  if (!opened) {
    console.error(`Timed out waiting for ${url}`)
    process.exit(1)
  }
})()
