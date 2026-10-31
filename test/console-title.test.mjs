// Windows keeps one title per console, shared by everything on it. On a console with an empty title, Node 22 can
// crash as it starts, so leaving Tau must never leave it empty. Each case runs on a hidden console of its own, under
// a parent that is no shell, because a shell would put the title back by itself.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const self = fileURLToPath(import.meta.url)
const BEFORE = 'the title before Tau'
const CANNOT_TELL = 'this Node does not report the title of the console'

// Runs the real exit cleanup from the built bundle, the way a terminal session reaches it.
async function leave() {
  const distPath = resolve('dist/tau.mjs')
  const harness = join(dirname(distPath), `.console-title-${process.pid}.mjs`)
  writeFileSync(harness, `${readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')}
export function __title() {
  init_gracefulShutdown();
  return { cleanupTerminalModes };
}
`)
  try {
    const { cleanupTerminalModes } = (await import(pathToFileURL(harness).href)).__title()
    Object.defineProperty(process.stdout, 'isTTY', { value: true })
    cleanupTerminalModes()
  } finally {
    unlinkSync(harness)
  }
}

// A running Node keeps the title it first read, so only a new one can say what the title is now.
const titleNow = () => spawnSync(process.execPath, ['-p', 'process.title'], { encoding: 'utf8', timeout: 60_000 }).stdout.trim()

// Sets the console's title, leaves Tau on that console, then asks what the title is now.
function onThisConsole() {
  process.title = BEFORE
  if (titleNow() !== BEFORE) {
    console.log(`title:${CANNOT_TELL}`)
    return
  }
  const left = spawnSync(process.execPath, [self, 'leave'], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(left.status, 0, left.stderr)
  console.log(`title:${titleNow()}`)
}

function assertTitleAfterLeaving(t, expected, env = {}) {
  const run = spawnSync(process.execPath, [self, 'console'], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  assert.equal(run.status, 0, run.stderr)
  const title = /^title:(.*)$/m.exec(run.stdout)?.[1]
  if (title === CANNOT_TELL) t.skip(CANNOT_TELL)
  else assert.equal(title, expected)
}

const mode = process.argv[2]
if (mode === 'leave') await leave()
else if (mode === 'console') onThisConsole()
else {
  const options = { skip: process.platform !== 'win32', timeout: 200_000 }
  // Node 20 and 22 read an empty title as "node", so a wrong result here is not the title this names.
  test('leaving does not leave the console without a title', options, t => {
    assertTitleAfterLeaving(t, 'tau', { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '' })
  })

  test('with title changes turned off, leaving keeps the title', options, t => {
    assertTitleAfterLeaving(t, BEFORE, { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' })
  })
}
