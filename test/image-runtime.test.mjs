import assert from 'node:assert/strict'
import childProcess, { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdtemp, mkdir, open, readFile, realpath, writeFile, readdir, stat, rm, symlink } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ensureImageRuntime, findNpmCli, resolveImageRuntimeTarget } from '../scripts/image-runtime.mjs'
import { RG_VERSION } from '../scripts/postinstall.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolveImageRuntimeTarget()

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function fakeSharp(packageRoot, version = '0.35.5', health = 'healthy') {
  const root = join(packageRoot, 'node_modules', 'sharp')
  await json(join(root, 'package.json'), { name: 'sharp', version, main: 'index.cjs' })
  await writeFile(join(root, 'index.cjs'), 'module.exports = () => {};\n')
  await writeFile(join(root, 'health.txt'), health)
  return root
}

async function sharpRoot(modulePath) {
  let cursor = (await stat(modulePath)).isDirectory() ? modulePath : dirname(modulePath)
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(cursor, 'package.json'), 'utf8'))
      if (manifest.name === 'sharp') return cursor
    } catch {}
    const parent = dirname(cursor)
    assert.notEqual(parent, cursor, `no sharp package contains ${modulePath}`)
    cursor = parent
  }
}

async function probe(modulePath) {
  try { return (await readFile(join(await sharpRoot(modulePath), 'health.txt'), 'utf8')) === 'healthy' }
  catch { return false }
}

async function snapshot(root) {
  const files = {}
  async function visit(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else files[path.slice(root.length + 1)] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  await visit(root)
  return files
}

async function fixture(t, { version = '0.35.5', health = 'broken', installed = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tau-image-runtime-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const packageRoot = join(root, 'shared package')
  const cacheRoot = join(root, 'user cache')
  await json(join(packageRoot, 'package.json'), { name: '@abdoknbgit/tau', version: '0.0.0', dependencies: { sharp: '^0.35.5' } })
  if (installed) await fakeSharp(packageRoot, version, health)
  else await json(join(packageRoot, 'package-lock.json'), { lockfileVersion: 3, packages: { 'node_modules/sharp': { version } } })
  const calls = []
  const options = {
    cacheRoot, target, probe,
    install: async (staging, wantedVersion) => {
      calls.push({ staging, wantedVersion })
      await fakeSharp(staging, wantedVersion)
    },
  }
  return { root, packageRoot, cacheRoot, calls, options }
}

test('target selection distinguishes native Windows, both macOS architectures, glibc and musl', () => {
  for (const [platform, arch, glibc, expected] of [
    ['win32', 'x64', undefined, 'win32-x64'],
    ['win32', 'arm64', undefined, 'win32-arm64'],
    ['darwin', 'x64', undefined, 'darwin-x64'],
    ['darwin', 'arm64', undefined, 'darwin-arm64'],
    ['linux', 'x64', '2.39', 'linux-x64'],
    ['linux', 'arm64', '2.39', 'linux-arm64'],
    ['linux', 'x64', '', 'linuxmusl-x64'],
    ['linux', 'arm64', '', 'linuxmusl-arm64'],
  ]) assert.equal(resolveImageRuntimeTarget({ platform, arch, glibc }), expected)
})

test('working installed decoder does not install, modify the package, or create a cache', async t => {
  const f = await fixture(t, { health: 'healthy' })
  const before = await snapshot(f.root)
  const result = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(result.ok, true)
  assert.equal(result.source, 'installed')
  assert.equal(await probe(result.modulePath), true)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(await snapshot(f.root), before)
})

test('read-only diagnostics do not install or prevent recovery later in the same process', async t => {
  const f = await fixture(t)
  const before = await snapshot(f.root)
  const diagnostic = await ensureImageRuntime(f.packageRoot, { ...f.options, repair: false })
  assert.equal(diagnostic.ok, false)
  assert.ok(diagnostic.reason)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await snapshot(f.root), before)
  const recovered = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.source, 'repaired')
  assert.equal(f.calls.length, 1)
})

test('shared Windows-only installation recovers into a user cache without changing any package files', async t => {
  const f = await fixture(t)
  const otherPlatform = join(f.packageRoot, 'node_modules', '@img', 'sharp-win32-x64', 'native.node')
  await mkdir(dirname(otherPlatform), { recursive: true })
  await writeFile(otherPlatform, 'working Windows decoder stays byte-identical')
  const before = await snapshot(f.packageRoot)
  const result = await ensureImageRuntime(f.packageRoot, { ...f.options, target: 'linux-x64' })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'repaired')
  const cachedPath = relative(await realpath(f.cacheRoot), await realpath(result.modulePath))
  assert.ok(cachedPath && !isAbsolute(cachedPath) && !cachedPath.startsWith('..'))
  assert.equal(await probe(result.modulePath), true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].wantedVersion, '0.35.5')
  assert.deepEqual(await snapshot(f.packageRoot), before)
})

test('a cache reached through a filesystem alias publishes and reuses the same verified decoder', async t => {
  const f = await fixture(t)
  await mkdir(f.cacheRoot)
  const alias = join(f.root, 'cache alias')
  await symlink(f.cacheRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await ensureImageRuntime(f.packageRoot, { ...f.options, cacheRoot: alias })
  assert.equal(result.ok, true, result.reason)
  const cachedPath = relative(await realpath(f.cacheRoot), await realpath(result.modulePath))
  assert.ok(cachedPath && !isAbsolute(cachedPath) && !cachedPath.startsWith('..'))
  const reused = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(reused.ok, true, reused.reason)
  assert.equal(reused.modulePath, result.modulePath)
  assert.equal(f.calls.length, 1, 'equivalent filesystem paths must not install another decoder')
})

test('image recovery accepts package and cache paths containing spaces and Unicode', async t => {
  const f = await fixture(t)
  const packageRoot = join(f.root, 'partagé τ مشروع', 'Tau package')
  const cacheRoot = join(f.root, '用户 cache', 'images τ')
  await fakeSharp(packageRoot, '0.35.5', 'broken')
  const before = await snapshot(packageRoot)
  const result = await ensureImageRuntime(packageRoot, { ...f.options, cacheRoot })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.source, 'repaired')
  assert.equal(await probe(result.modulePath), true)
  assert.deepEqual(await snapshot(packageRoot), before)
})

test('concurrent callers share one repair and all receive a verified module', async t => {
  const f = await fixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const installationStarted = new Promise(resolve => { started = resolve })
  const install = f.options.install
  const options = { ...f.options, install: async (...args) => { started(); await gate; return install(...args) } }
  const pending = Array.from({ length: 12 }, () => ensureImageRuntime(f.packageRoot, options))
  await installationStarted
  release()
  const results = await Promise.all(pending)
  assert.equal(f.calls.length, 1)
  assert.ok(results.every(result => result.ok && result.modulePath === results[0].modulePath))
  assert.equal(await probe(results[0].modulePath), true)
})

test('independent runtime instances coordinate through the cache lease and do not install over each other', async t => {
  const f = await fixture(t)
  const independent = await import(`../scripts/image-runtime.mjs?lease-test=${Date.now()}`)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const installationStarted = new Promise(resolve => { started = resolve })
  const install = f.options.install
  const options = { ...f.options, install: async (...args) => { started(); await gate; return install(...args) } }
  const first = ensureImageRuntime(f.packageRoot, options)
  await installationStarted
  const second = independent.ensureImageRuntime(f.packageRoot, options)
  release()
  const results = await Promise.all([first, second])
  assert.equal(f.calls.length, 1)
  assert.ok(results.every(result => result.ok))
  assert.equal(results[0].modulePath, results[1].modulePath)
})

test('waiting for another installer has a deadline and does not disturb the active owner', async t => {
  const f = await fixture(t)
  const independent = await import(`../scripts/image-runtime.mjs?lock-timeout-test=${Date.now()}`)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const installationStarted = new Promise(resolve => { started = resolve })
  const install = f.options.install
  const first = ensureImageRuntime(f.packageRoot, { ...f.options, install: async (...args) => {
    started(); await gate; return install(...args)
  } })
  await installationStarted
  try {
    const blocked = await independent.ensureImageRuntime(f.packageRoot, { ...f.options, lockTimeoutMs: 20 })
    assert.equal(blocked.ok, false)
    assert.match(blocked.reason, /another.*recovery|running/i)
  } finally { release() }
  assert.equal((await first).ok, true)
  assert.equal(f.calls.length, 1)
})

for (const failure of ['offline', 'corrupt', 'missing']) {
  test(`${failure} repair stays nonfatal, leaves no usable partial cache, and is attempted only once`, async t => {
    const f = await fixture(t)
    let attempts = 0
    const options = { ...f.options, install: async (staging, version) => {
      attempts++
      if (failure === 'offline') throw new Error('fixture registry is unavailable')
      if (failure === 'corrupt') await fakeSharp(staging, version, 'broken')
    } }
    const first = await ensureImageRuntime(f.packageRoot, options)
    assert.equal(first.ok, false)
    assert.ok(first.reason)
    const again = await ensureImageRuntime(f.packageRoot, options)
    assert.equal(again.ok, false)
    assert.equal(attempts, 1)
    const files = await snapshot(f.cacheRoot)
    assert.equal(Object.keys(files).some(path => path.endsWith('health.txt')), false, 'unverified staging modules must be removed')
  })
}

test('an empty staging directory cannot borrow a working sharp from its ancestor installation', async t => {
  const f = await fixture(t)
  const result = await ensureImageRuntime(f.packageRoot, {
    ...f.options,
    cacheRoot: join(f.packageRoot, 'image runtime cache'),
    install: async () => { await fakeSharp(f.packageRoot, '0.35.5', 'healthy') },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /decoder|version|installation/i)
})

test('a staged decoder with a different version is rejected even if it can decode images', async t => {
  const f = await fixture(t)
  const result = await ensureImageRuntime(f.packageRoot, {
    ...f.options, install: async staging => { await fakeSharp(staging, '0.35.6') },
  })
  assert.equal(result.ok, false)
  assert.equal(Object.keys(await snapshot(f.cacheRoot)).some(path => path.endsWith('health.txt')), false)
})

test('an unusable cache location leaves the shared package intact and never starts an installation', async t => {
  const f = await fixture(t)
  await writeFile(f.cacheRoot, 'fixture: cache directory cannot be created here')
  const before = await snapshot(f.packageRoot)
  const result = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(result.ok, false)
  assert.ok(result.reason)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await snapshot(f.packageRoot), before)
})

test('a successful cached decoder is probed and reused by another installation of the same version', async t => {
  const f = await fixture(t)
  const first = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(first.ok, true)
  const anotherRoot = join(f.root, 'another package')
  await fakeSharp(anotherRoot, '0.35.5', 'broken')
  const next = await ensureImageRuntime(anotherRoot, f.options)
  assert.equal(next.ok, true)
  assert.equal(next.source, 'cache')
  assert.equal(next.modulePath, first.modulePath)
  assert.equal(f.calls.length, 1)
})

test('read-only diagnostics can use a verified cached decoder without changing it or starting another install', async t => {
  const f = await fixture(t)
  const first = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(first.ok, true)
  const anotherRoot = join(f.root, 'read-only package')
  await fakeSharp(anotherRoot, '0.35.5', 'broken')
  const before = await snapshot(f.root)
  const cached = await ensureImageRuntime(anotherRoot, { ...f.options, repair: false })
  assert.equal(cached.ok, true)
  assert.equal(cached.source, 'cache')
  assert.equal(cached.modulePath, first.modulePath)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await snapshot(f.root), before)
})

test('a previously verified cache that becomes corrupt is rejected and repaired before reuse', async t => {
  const f = await fixture(t)
  const first = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(first.ok, true)
  await writeFile(join(await sharpRoot(first.modulePath), 'health.txt'), 'broken')
  const anotherRoot = join(f.root, 'next process installation')
  await fakeSharp(anotherRoot, '0.35.5', 'broken')
  const repaired = await ensureImageRuntime(anotherRoot, f.options)
  assert.equal(repaired.ok, true)
  assert.equal(repaired.source, 'repaired')
  assert.equal(await probe(repaired.modulePath), true)
  assert.equal(f.calls.length, 2)
})

test('corruption recovery publishes a new generation while keeping old decoder files intact for existing readers', async t => {
  const f = await fixture(t)
  const first = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(first.ok, true)
  const oldRoot = await sharpRoot(first.modulePath)
  const oldNative = join(oldRoot, 'native-decoder.node')
  await writeFile(oldNative, 'old native decoder remains usable by an existing reader')
  const reader = await open(oldNative, 'r')
  try {
    await writeFile(join(oldRoot, 'health.txt'), 'broken')
    const oldFiles = await snapshot(oldRoot)
    const anotherRoot = join(f.root, 'another process package')
    await fakeSharp(anotherRoot, '0.35.5', 'broken')
    const updated = await ensureImageRuntime(anotherRoot, f.options)
    assert.equal(updated.ok, true)
    assert.equal(updated.source, 'repaired')
    assert.notEqual(updated.modulePath, first.modulePath)
    assert.deepEqual(await snapshot(oldRoot), oldFiles)
    assert.equal(await reader.readFile('utf8'), 'old native decoder remains usable by an existing reader')
    assert.equal(await probe(updated.modulePath), true)
  } finally { await reader.close() }
})

test('an update to sharp gets a distinct verified cache instead of reusing old native binaries', async t => {
  const f = await fixture(t)
  const old = await ensureImageRuntime(f.packageRoot, f.options)
  await fakeSharp(f.packageRoot, '0.35.6', 'broken')
  const updated = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(updated.ok, true)
  assert.notEqual(updated.modulePath, old.modulePath)
  assert.deepEqual(f.calls.map(call => call.wantedVersion), ['0.35.5', '0.35.6'])
  assert.equal(await probe(old.modulePath), true, 'the previous version remains intact')
})

test('missing sharp can recover the exact locked version without resolving a floating package range', async t => {
  const f = await fixture(t, { installed: false })
  const result = await ensureImageRuntime(f.packageRoot, f.options)
  assert.equal(result.ok, true)
  assert.equal(f.calls[0].wantedVersion, '0.35.5')
})

test('invalid or non-exact decoder versions never reach an installer command', async t => {
  for (const version of ['latest', '^0.35.5', '../../other', '0.35.5 --ignore-scripts=false']) {
    const f = await fixture(t, { version })
    const result = await ensureImageRuntime(f.packageRoot, f.options)
    assert.equal(result.ok, false, version)
    assert.equal(f.calls.length, 0, version)
  }
})

test('npm discovery accepts an absolute JavaScript CLI and ignores a conflicting npm Node executable', async t => {
  const f = await fixture(t)
  const cli = join(f.root, 'npm with spaces', 'bin', 'npm-cli.js')
  const result = findNpmCli({
    env: { npm_execpath: cli, npm_node_execpath: join(f.root, 'Windows node.exe'), PATH: '' },
    nodeExecutable: join(f.root, 'Linux node'),
    fileExists: path => path === cli,
    realpath: path => path,
  })
  assert.equal(result, cli)
})

test('npm discovery does not execute a shell wrapper when no JavaScript CLI can be located', async t => {
  const f = await fixture(t)
  const wrapper = join(f.root, 'npm.cmd')
  assert.equal(findNpmCli({
    env: { npm_execpath: wrapper, PATH: '' },
    nodeExecutable: join(f.root, 'node'),
    fileExists: path => path === wrapper,
    realpath: path => path,
  }), null)
})

test('WSL-style npm discovery ignores a Windows npm path and finds JavaScript beside a PATH wrapper', async t => {
  const f = await fixture(t)
  const directory = join(f.root, 'Windows npm shared through WSL')
  const cli = join(directory, 'node_modules/npm/bin/npm-cli.js')
  assert.equal(findNpmCli({
    env: { npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', PATH: directory },
    nodeExecutable: join(f.root, 'native Linux Node', 'node'),
    platform: 'linux',
    fileExists: path => path === cli,
    realpath: path => path,
  }), cli)
})

test('automatic installation runs the npm JavaScript CLI with the current Node and removes foreign platform flags', async t => {
  const f = await fixture(t)
  const cli = join(f.root, 'npm fixture with spaces', 'bin', 'npm-cli.js')
  const observed = join(f.root, 'npm-observed.json')
  await mkdir(dirname(cli), { recursive: true })
  await writeFile(cli, `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
      executable: process.execPath, platform: process.platform, args,
      os: process.env.npm_config_os, architecture: process.env.NPM_CONFIG_ARCH,
      registry: process.env.npm_config_registry
    }));
    const root = path.join(process.cwd(), 'node_modules/sharp');
    fs.mkdirSync(root, {recursive:true});
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'sharp',version:'0.35.5',main:'index.cjs'}));
    fs.writeFileSync(path.join(root, 'index.cjs'), 'module.exports=()=>{};');
    fs.writeFileSync(path.join(root, 'health.txt'), 'healthy');
  `)
  const result = await ensureImageRuntime(f.packageRoot, {
    ...f.options, install: undefined,
    env: { ...process.env, npm_execpath: cli, npm_node_execpath: join(f.root, 'wrong-node.exe'),
      npm_config_os: 'foreign-os', NPM_CONFIG_ARCH: 'foreign-cpu', npm_config_registry: 'https://registry.fixture.invalid/' },
  })
  assert.equal(result.ok, true, result.reason)
  const invocation = JSON.parse(await readFile(observed, 'utf8'))
  assert.equal(invocation.executable, process.execPath)
  assert.equal(invocation.platform, process.platform)
  assert.equal(invocation.os, undefined)
  assert.equal(invocation.architecture, undefined)
  assert.equal(invocation.registry, 'https://registry.fixture.invalid/')
  assert.ok(invocation.args.includes('sharp@0.35.5'))
  assert.ok(invocation.args.includes('--ignore-scripts=true'))
  assert.ok(invocation.args.includes('--include=optional'))
})

test('a native decoder that hangs is killed in its probe process while the parent event loop stays responsive', async t => {
  const f = await fixture(t)
  await writeFile(join(f.packageRoot, 'node_modules/sharp/index.cjs'), 'for (;;) {}\n')
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  try {
    const result = await ensureImageRuntime(f.packageRoot, {
      ...f.options, probe: undefined, probeTimeoutMs: 150,
      install: async () => { throw new Error('fixture offline') },
    })
    assert.equal(result.ok, false)
    assert.ok(ticks > 0, 'native probing must never block the terminal event loop')
  } finally { clearInterval(timer) }
})

test('a decoder that terminates its native probe process cannot terminate Tau', async t => {
  const f = await fixture(t)
  await writeFile(join(f.packageRoot, 'node_modules/sharp/index.cjs'), 'process.exit(37);\n')
  const result = await ensureImageRuntime(f.packageRoot, {
    ...f.options, probe: undefined, probeTimeoutMs: 5000,
    install: async () => { throw new Error('fixture offline') },
  })
  assert.equal(result.ok, false)
  assert.ok(result.reason)
})

test('an installation process that hangs times out without repeated attempts or a partial cache', async t => {
  const f = await fixture(t)
  const cli = join(f.root, 'npm-timeout', 'npm-cli.js')
  await mkdir(dirname(cli), { recursive: true })
  await writeFile(cli, 'setInterval(() => {}, 1000);\n')
  const options = { ...f.options, install: undefined, installTimeoutMs: 150, env: { ...process.env, npm_execpath: cli } }
  const result = await ensureImageRuntime(f.packageRoot, options)
  assert.equal(result.ok, false)
  assert.match(result.reason, /timed out/i)
  assert.deepEqual(await ensureImageRuntime(f.packageRoot, options), result)
  assert.equal(Object.keys(await snapshot(f.cacheRoot)).some(path => path.endsWith('health.txt')), false)
})

for (const failure of ['error event', 'synchronous throw']) {
  test(`denied child termination (${failure}) retains the private tree, lease and exit guard`, async t => {
    const f = await fixture(t)
    const cli = join(f.root, 'npm-denied-kill', 'npm-cli.js')
    await mkdir(dirname(cli), { recursive: true })
    await writeFile(cli, '// intercepted by the child-process fixture\n')
    const originalSpawn = childProcess.spawn
    const exitListeners = process.listeners('exit')
    const child = new EventEmitter()
    child.pid = process.pid
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.unref = () => {}
    let kills = 0, spawns = 0, staging
    child.kill = () => {
      kills++
      const error = Object.assign(new Error('fixture: termination was denied'), { code: 'EPERM' })
      if (failure === 'synchronous throw') throw error
      queueMicrotask(() => child.emit('error', error))
      return false
    }
    childProcess.spawn = (command, args, options) => {
      assert.equal(command, process.execPath)
      assert.equal(args[0], cli)
      spawns++
      staging = options.cwd
      return child
    }
    syncBuiltinESMExports()
    try {
      const options = { ...f.options, install: undefined, installTimeoutMs: 20, env: { ...process.env, npm_execpath: cli } }
      const result = await ensureImageRuntime(f.packageRoot, options)
      assert.equal(result.ok, false)
      assert.match(result.reason, /could not stop cleanly/)
      assert.ok((await stat(staging)).isDirectory(), 'an unconfirmed live writer must retain its private staging tree')
      assert.ok((await readdir(f.cacheRoot)).some(name => name.endsWith('.lock')), 'its recovery lease must remain held')
      const guards = process.listeners('exit').filter(listener => !exitListeners.includes(listener))
      assert.equal(guards.length, 1, 'the unresolved child must retain an exit kill guard')
      assert.doesNotThrow(() => guards[0](), 'exit must remain safe even when another kill is denied')
      await new Promise(resolve => setImmediate(resolve))
      assert.ok(kills >= 2)
      assert.deepEqual(await ensureImageRuntime(f.packageRoot, options), result)
      assert.equal(spawns, 1, 'a denied kill must not start a second installer')
    } finally {
      // Simulate confirmed termination so this fixture leaves no exit listener.
      child.emit('close', 1)
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
    }
    assert.deepEqual(process.listeners('exit'), exitListeners)
  })
}

test('a child that never spawned releases staging and its lease without retaining an exit guard', async t => {
  const f = await fixture(t)
  const cli = join(f.root, 'npm-spawn-failure', 'npm-cli.js')
  await mkdir(dirname(cli), { recursive: true })
  await writeFile(cli, '// intercepted by the child-process fixture\n')
  const originalSpawn = childProcess.spawn
  const exitListeners = process.listeners('exit')
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  childProcess.spawn = () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('fixture missing executable'), { code: 'ENOENT' })))
    return child
  }
  syncBuiltinESMExports()
  try {
    const result = await ensureImageRuntime(f.packageRoot, {
      ...f.options, install: undefined, env: { ...process.env, npm_execpath: cli },
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /download failed/)
    assert.deepEqual(await readdir(f.cacheRoot), [], 'a failed spawn has no live writer to protect')
    assert.deepEqual(process.listeners('exit'), exitListeners)
  } finally {
    child.stdout.destroy()
    child.stderr.destroy()
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
})

test('real installed sharp passes an isolated image decode and encode without invoking recovery', async t => {
  const f = await fixture(t)
  let attempted = false
  const result = await ensureImageRuntime(repository, {
    cacheRoot: f.cacheRoot,
    install: async () => { attempted = true; throw new Error('healthy install must not contact npm') },
    probeTimeoutMs: 10_000,
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.source, 'installed')
  assert.equal(attempted, false)
})

async function runPostinstall(packageRoot) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(packageRoot, 'scripts/postinstall.mjs')], {
      cwd: packageRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TAU_REPAIR: '1', TAU_SKIP_OLLAMA_PREPULL: '1', TAU_SKIP_NATIVE_TOOLS_POSTINSTALL: '1' },
    })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture postinstall timed out')) }, 10_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', status => { clearTimeout(timeout); resolveResult({ status, stdout, stderr }) })
  })
}

for (const outcome of ['healthy', 'unavailable', 'throw']) {
  test(`real postinstall awaits ${outcome} image verification before marking lifecycle complete`, async t => {
    const f = await fixture(t)
    const scripts = join(f.packageRoot, 'scripts')
    await mkdir(scripts)
    for (const file of ['postinstall.mjs', 'verify-deps.mjs', 'update-lock.mjs']) {
      await copyFile(join(repository, 'scripts', file), join(scripts, file))
    }
    // Isolate the unrelated ripgrep prerequisite without a real download.
    await writeFile(join(scripts, 'platform-support.mjs'), `
      export const isLinuxArm64Musl = () => false;
      export const getRipgrepVersion = () => ${JSON.stringify(RG_VERSION)};
      export const resolveWindowsSystemExecutable = () => null;
    `)
    const marker = join(f.packageRoot, '.tau-lifecycle-complete.json')
    await writeFile(marker, JSON.stringify({ version: 'previous incomplete install' }))
    await writeFile(join(scripts, 'image-runtime.mjs'), `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export async function ensureImageRuntime(packageRoot) {
        const marker = join(packageRoot, '.tau-lifecycle-complete.json');
        const observation = { packageRoot, markerBefore: existsSync(marker) };
        await new Promise(resolve => setTimeout(resolve, 30));
        observation.markerAfterDelay = existsSync(marker);
        writeFileSync(join(packageRoot, 'image-hook-observed.json'), JSON.stringify(observation));
        if (${JSON.stringify(outcome)} === 'throw') throw new Error('fixture unsupported decoder');
        return ${JSON.stringify(outcome)} === 'healthy'
          ? {ok:true, source:'installed', modulePath:join(packageRoot,'node_modules/sharp/index.cjs')}
          : {ok:false, reason:'fixture offline or unsupported runtime'};
      }
    `)
    const before = await snapshot(join(f.packageRoot, 'node_modules'))
    const result = await runPostinstall(f.packageRoot)
    assert.equal(result.status, 0, result.stderr)
    const observation = JSON.parse(await readFile(join(f.packageRoot, 'image-hook-observed.json'), 'utf8'))
    assert.equal(await realpath(observation.packageRoot), await realpath(f.packageRoot))
    assert.equal(observation.markerBefore, false, 'the previous lifecycle marker must be invalidated first')
    assert.equal(observation.markerAfterDelay, false, 'postinstall must await image verification before completing')
    const completed = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(completed.version, '0.0.0')
    assert.deepEqual(await snapshot(join(f.packageRoot, 'node_modules')), before, 'image setup must not reinstall the package dependency tree')
    if (outcome === 'healthy') assert.match(result.stdout, /Image decoder ready/)
    else if (outcome === 'unavailable') assert.match(result.stdout, /Image previews unavailable.*rest of Tau is ready/)
    else assert.match(result.stdout, /Image decoder verification unavailable/)
  })
}
