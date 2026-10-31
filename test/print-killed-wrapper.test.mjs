// A script stops a run by killing what it started. If that is a wrapper with the CLI under it, the CLI has to
// stop too, or it goes on spending quota and the script waiting on the output hangs. A parent that leaves on
// purpose is different, and a run it left behind has to carry on.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'
import { stopProcessTree } from './helpers/stop-process-tree.mjs'

const cli = resolve('dist/cli.mjs')
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tau-killed-wrapper-')))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
const sleep = ms => new Promise(done => setTimeout(done, ms))
const PRINT_ARGS = ['-p', 'hello', '--model', 'claude-sonnet-4-6', '--no-session-persistence', '--tools=']
const WATCHED_ARGS = [...PRINT_ARGS, '--debug-to-stderr']

let number = 0
async function place(answer) {
  const home = join(root, `case-${number++}`)
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(home, 'config'))
  writeFileSync(join(home, 'config', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' }))
  const seen = { requests: 0 }
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"input_tokens":1}')
      return
    }
    seen.requests++
    answer?.(request, response)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|TAU_|CLAUDEX|CI$|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$)/i.test(key)))
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, 'config'),
    ANTHROPIC_API_KEY: 'sk-ant-wrapper-fixture-key-0000000', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', TAU_SKIP_PREFLIGHT: '1',
  })
  return { home, workspace, env, seen, stop: () => { server.close(); server.closeAllConnections() } }
}

async function untilRequest(seen, ms = 90_000) {
  const end = Date.now() + ms
  while (!seen.requests) {
    assert.ok(Date.now() < end, 'the run never reached the model')
    await sleep(100)
  }
}

// The output pipes close only when the last process holding them has gone, so this is the CLI's exit.
function untilPipesClose(child, ms) {
  return Promise.race([
    new Promise(done => child.once('close', () => done(true))),
    sleep(ms).then(() => false),
  ])
}

// What npm writes for a global bin, and what spawn(..., { shell: true }) or subprocess.Popen starts.
function placeShim(run) {
  const shim = join(run.home, 'tau.cmd')
  writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${cli}" %*`, '',
  ].join('\r\n'))
  return shim
}

// On Windows the run first has to look at what its parent is. Its debug line says when the watch is in place.
function untilWatching(child, ms = 60_000) {
  return new Promise(done => {
    let text = ''
    const timer = setTimeout(() => done(false), ms)
    child.stderr.on('data', part => {
      text += part
      if (text.includes(`Watching process ${child.pid},`)) {
        clearTimeout(timer)
        done(true)
      }
    })
  })
}

test('killing npm\'s tau.cmd stops the run and lets the script finish', { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
  const run = await place()
  const shim = placeShim(run)
  // /s takes off the outer quotes, so the whole line needs a pair of its own.
  const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${shim}" ${WATCHED_ARGS.join(' ')}"`], {
    cwd: run.workspace, env: run.env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  const watching = untilWatching(child)
  try {
    await untilRequest(run.seen)
    assert.equal(await watching, true, 'the watch never started')
    child.kill()
    assert.equal(await untilPipesClose(child, 30_000), true, 'the CLI under the killed wrapper kept running')
  } finally {
    stopProcessTree(child)
    run.stop()
  }
})

test('a launcher killed without a chance to pass the signal on stops the run', { timeout: 180_000 }, async () => {
  const run = await place()
  // The same start the launcher gives a compatible Node, from a parent that can be killed outright.
  const launcher = join(run.home, 'launcher.cjs')
  writeFileSync(launcher, `require('node:child_process').spawn(process.execPath, ${JSON.stringify([cli, ...WATCHED_ARGS])}, { env: { ...process.env, TAU_LAUNCHER_PID: String(process.pid), TAU_LAUNCHER_PARENT_PID: String(process.ppid) }, stdio: 'inherit', windowsHide: true })\n`)
  const child = spawn(process.execPath, [launcher], { cwd: run.workspace, env: run.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => {})
  const watching = untilWatching(child)
  try {
    await untilRequest(run.seen)
    assert.equal(await watching, true, 'the watch never started')
    child.kill('SIGKILL')
    assert.equal(await untilPipesClose(child, 30_000), true, 'the CLI under the killed launcher kept running')
  } finally {
    stopProcessTree(child)
    run.stop()
  }
})

test('killing a cmd.exe wrapper above the launcher stops the run too', { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
  const run = await place()
  const launcher = join(run.home, 'launcher.cjs')
  writeFileSync(launcher, `require('node:child_process').spawn(process.execPath, ${JSON.stringify([cli, ...WATCHED_ARGS])}, { env: { ...process.env, TAU_LAUNCHER_PID: String(process.pid), TAU_LAUNCHER_PARENT_PID: String(process.ppid) }, stdio: 'inherit', windowsHide: true })\n`)
  // /s takes off the outer quotes, so the whole line needs a pair of its own.
  const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${process.execPath}" "${launcher}""`], {
    cwd: run.workspace, env: run.env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  const watching = untilWatching(child)
  try {
    await untilRequest(run.seen)
    assert.equal(await watching, true, 'the watch never started')
    child.kill()
    assert.equal(await untilPipesClose(child, 30_000), true, 'the CLI under the launcher kept running')
  } finally {
    stopProcessTree(child)
    run.stop()
  }
})

// A run its parent left behind has to reach the model and still be there to take the answer.
async function assertCarriesOn(start) {
  let answer
  const run = await place((request, response) => { answer = () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply('STILL-ANSWERED', 'claude-sonnet-4-6'))
  } })
  const output = join(run.home, 'output.txt')
  const child = start(run, output)
  try {
    await new Promise(done => child.once('close', done))
    await untilRequest(run.seen)
    // Well past the time a watch would have noticed the parent had gone.
    await sleep(6000)
    answer()
    const end = Date.now() + 60_000
    let text = ''
    while (!text.includes('STILL-ANSWERED') && Date.now() < end) {
      await sleep(250)
      text = readFileSync(output, 'utf8')
    }
    assert.match(text, /STILL-ANSWERED/, 'the run did not carry on after its parent left')
  } finally {
    run.stop()
  }
}

test('a parent that leaves on purpose does not stop the run', { timeout: 180_000 }, () => assertCarriesOn((run, output) => {
  // Starts the run detached and exits right after, the way a background job does.
  const parent = join(run.home, 'parent.cjs')
  writeFileSync(parent, `const { openSync } = require('node:fs')
const out = openSync(${JSON.stringify(output)}, 'w')
require('node:child_process').spawn(process.execPath, ${JSON.stringify([cli, ...PRINT_ARGS])}, { detached: true, env: process.env, stdio: ['ignore', out, out], windowsHide: true }).unref()
`)
  return spawn(process.execPath, [parent], { cwd: run.workspace, env: run.env, windowsHide: true, stdio: 'ignore' })
}))

function runBatch(run, lines) {
  const script = join(run.home, 'background.cmd')
  writeFileSync(script, ['@echo off', ...lines, ''].join('\r\n'))
  return spawn(process.env.ComSpec, ['/d', '/c', script], { cwd: run.workspace, env: run.env, windowsHide: true, stdio: 'ignore' })
}

test('a batch file that starts tau in the background and leaves later does not stop it', { skip: process.platform !== 'win32', timeout: 180_000 }, () => assertCarriesOn((run, output) => runBatch(run, [
  `start "" /b "${placeShim(run)}" ${PRINT_ARGS.join(' ')} > "${output}" 2>&1`,
  'ping -n 9 127.0.0.1 > nul',
])))

test('a batch file that starts node.exe in the background and leaves later does not stop it', { skip: process.platform !== 'win32', timeout: 180_000 }, () => assertCarriesOn((run, output) => runBatch(run, [
  `start "" /b "${process.execPath}" "${cli}" ${PRINT_ARGS.join(' ')} > "${output}" 2>&1`,
  'ping -n 9 127.0.0.1 > nul',
])))

test('a batch file that starts node.exe in the background and leaves at once does not stop it', { skip: process.platform !== 'win32', timeout: 180_000 }, () => assertCarriesOn((run, output) => runBatch(run, [
  `start "" /b "${process.execPath}" "${cli}" ${PRINT_ARGS.join(' ')} > "${output}" 2>&1`,
])))
