/** Focused tests for killProcessTree's Windows taskkill invocation. */

import { EventEmitter } from 'events'
import { killProcessTree } from './processTree.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function test(name: string, run: () => void) {
  try {
    run()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

type SpawnCall = {
  file: string
  args: readonly string[]
  options: Record<string, unknown>
}

/** Recording fakes, so no test can reach a real process. */
function fakes() {
  const spawnCalls: SpawnCall[] = []
  const treeKillCalls: unknown[][] = []
  const processKillCalls: unknown[][] = []
  const taskkill = new EventEmitter()
  const deps = {
    spawnImpl: ((
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      spawnCalls.push({ file, args, options })
      return taskkill
    }) as never,
    treeKillImpl: ((...args: unknown[]) => {
      treeKillCalls.push(args)
    }) as never,
    processKillImpl: ((...args: unknown[]) => {
      processKillCalls.push(args)
      return true
    }) as never,
  }
  return { spawnCalls, treeKillCalls, processKillCalls, taskkill, deps }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

console.log('killProcessTree:')

test('Windows spawns System32 taskkill.exe by absolute path, without a shell', () => {
  const f = fakes()
  killProcessTree(1234, {
    platform: 'win32',
    env: { SystemRoot: 'D:\\Windows' },
    ...f.deps,
  })
  assert(f.spawnCalls.length === 1, `expected one spawn, got ${f.spawnCalls.length}`)
  const { file, args, options } = f.spawnCalls[0]!
  assert(file === 'D:\\Windows\\System32\\taskkill.exe', `wrong file: ${file}`)
  assert(same(args, ['/PID', '1234', '/T', '/F']), `wrong args: ${JSON.stringify(args)}`)
  assert(!('shell' in options), 'no shell option may be set')
  assert(options.detached === true, 'taskkill must be detached to outlive Tau')
  assert(options.windowsHide === true, 'taskkill must not open a window')
  assert(options.stdio === 'ignore', 'taskkill output must be ignored')
  assert(f.treeKillCalls.length === 0, 'tree-kill must not run on Windows')
  assert(f.processKillCalls.length === 0, 'the direct kill must not run')
})

test('an asynchronous taskkill spawn error is consumed', () => {
  const f = fakes()
  killProcessTree(1234, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    ...f.deps,
  })
  // EventEmitter throws on an 'error' event nobody listens to.
  f.taskkill.emit('error', new Error('spawn taskkill.exe ENOENT'))
})

test('a synchronous spawn failure does not escape', () => {
  const f = fakes()
  killProcessTree(1234, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    ...f.deps,
    spawnImpl: (() => {
      throw new Error('spawn EPERM')
    }) as never,
  })
  assert(
    f.treeKillCalls.length === 0 && f.processKillCalls.length === 0,
    'a failed spawn must not trigger another kill path',
  )
})

test('Windows without a usable SystemRoot or WINDIR kills the pid directly', () => {
  for (const env of [
    {},
    { SystemRoot: 'relative\\Windows', WINDIR: 'E:\\Windows\ninvalid' },
  ]) {
    const f = fakes()
    killProcessTree(1234, { platform: 'win32', env, ...f.deps })
    assert(f.spawnCalls.length === 0, 'must not spawn a guessed or PATH taskkill')
    assert(f.treeKillCalls.length === 0, 'must not fall back to tree-kill')
    assert(
      same(f.processKillCalls, [[1234, 'SIGKILL']]),
      `wrong direct kill: ${JSON.stringify(f.processKillCalls)}`,
    )
  }
})

test('the direct kill ignores a process that already exited', () => {
  const f = fakes()
  killProcessTree(1234, {
    platform: 'win32',
    env: {},
    ...f.deps,
    processKillImpl: (() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }) as never,
  })
})

test('other platforms keep calling tree-kill exactly as before', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const f = fakes()
    killProcessTree(1234, {
      platform,
      env: { SystemRoot: 'C:\\Windows' },
      ...f.deps,
    })
    assert(
      same(f.treeKillCalls, [[1234, 'SIGKILL']]),
      `${platform}: wrong tree-kill call ${JSON.stringify(f.treeKillCalls)}`,
    )
    assert(f.spawnCalls.length === 0, `${platform}: taskkill must not be spawned`)
    assert(f.processKillCalls.length === 0, `${platform}: the direct kill must not run`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
