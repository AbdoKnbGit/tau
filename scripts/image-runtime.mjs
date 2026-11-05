// Image decoding is optional. Keep recovery separate from Tau's dependency
// repair: reinstalling a shared Windows/WSL tree can prune the other OS's files.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { acquireSynchronousUpdateLease, releaseSynchronousUpdateLease } from './update-lock.mjs'

const attempts = new Map()
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

export function findImagePackageRoot(startDirectory) {
  let directory = resolve(startDirectory)
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name === '@abdoknbgit/tau') return directory
    } catch { /* Try the parent of a source file, bundled file or bin symlink. */ }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Cannot locate Tau image dependencies')
    directory = parent
  }
}

export function resolveImageRuntimeTarget({ platform = process.platform, arch = process.arch, glibc } = {}) {
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) throw new Error('Invalid image runtime target')
  if (platform !== 'linux') return `${platform}-${arch}`
  if (glibc === undefined) {
    const header = process.report?.getReport?.()?.header
    if (!header) throw new Error('Cannot determine Linux image runtime compatibility')
    glibc = header.glibcVersionRuntime ?? ''
  }
  return `linux${glibc ? '' : 'musl'}-${arch}`
}

export function findNpmCli({ env = process.env, nodeExecutable = process.execPath, platform = process.platform, fileExists = existsSync, realpath = realpathSync } = {}) {
  // Run npm's JS with OUR Node. WSL's `npm` wrapper can otherwise invoke
  // node.exe and silently install Windows binaries into a Linux recovery.
  const candidates = []
  const addNear = executable => {
    if (!executable || !isAbsolute(executable)) return
    let actual = executable
    try { actual = realpath(executable) } catch { /* Also inspect the wrapper directory. */ }
    for (const directory of new Set([dirname(executable), dirname(actual)])) {
      candidates.push(join(directory, 'npm-cli.js'), join(directory, 'node_modules/npm/bin/npm-cli.js'),
        join(directory, '../lib/node_modules/npm/bin/npm-cli.js'), join(directory, '../share/nodejs/npm/bin/npm-cli.js'))
    }
  }
  if (env.npm_execpath && /\.[cm]?js$/i.test(env.npm_execpath)) candidates.push(env.npm_execpath)
  addNear(nodeExecutable)
  addNear(env.npm_execpath)
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (isAbsolute(directory)) addNear(join(directory, platform === 'win32' ? 'npm.cmd' : 'npm'))
  }
  return candidates.find(path => isAbsolute(path) && /(?:^|[\\/])npm-cli\.js$/i.test(path) && fileExists(path)) ?? null
}

export function imageRuntimeCacheRoot(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return join(env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData/Local'), 'Tau/Cache/image-runtime')
  if (platform === 'darwin') return join(home, 'Library/Caches/tau/image-runtime')
  return join(env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache'), 'tau/image-runtime')
}

function runNode(args, { timeout, cwd, env = process.env }) {
  return new Promise(resolveResult => {
    let child, timer, finished = false, timedOut = false, output = ''
    const stopOnExit = () => {
      try { child?.kill('SIGKILL') } catch { /* Exit must remain safe if termination is denied. */ }
    }
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (result.stopped !== false) process.off('exit', stopOnExit)
      resolveResult(result)
    }
    try {
      child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      process.once('exit', stopOnExit)
      child.stdout.on('data', bytes => { if (output.length < 32_768) output += bytes.toString() })
      child.stderr.resume()
      child.on('error', () => {
        // A spawn failure has no PID. Later errors can instead mean a failed
        // kill of a live child: retain its timeout and termination fallback.
        // Keep listening so another kill error cannot become unhandled.
        if (!child.pid) finish({ code: -1, output })
      })
      child.once('close', code => {
        process.off('exit', stopOnExit)
        finish({ code, output, timedOut })
      })
      timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* The fallback below retains its lease. */ }
        // Wait for pipe closure before releasing a repair lease. Otherwise an
        // npm process still exiting could write into the next repair's tree.
        timer = setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          finish({ code: -1, output, timedOut: true, stopped: false })
        }, 2000)
      }, timeout)
    } catch { finish({ code: -1, output }) }
  })
}

const PROBE = `
const sharp = require(process.argv[1]);
(async () => {
  const png = await sharp(Buffer.from([23,45,67,255]), {raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const {data,info} = await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if (info.width!==1 || info.height!==1 || data.length!==4 || data[0]!==23) process.exit(1);
  process.stdout.write('tau-image-ok');
})().catch(() => process.exit(1));
`

export async function probeImageRuntime(modulePath, { probeTimeoutMs = 5000, env = process.env } = {}) {
  const result = await runNode(['-e', PROBE, modulePath], { timeout: probeTimeoutMs, env })
  return result.code === 0 && result.output === 'tau-image-ok'
}

function moduleAt(root, version, ownOnly = false) {
  try {
    const require_ = createRequire(join(root, 'package.json'))
    if (ownOnly) {
      const manifest = JSON.parse(readFileSync(join(root, 'node_modules/sharp/package.json'), 'utf8'))
      if (manifest.name !== 'sharp' || manifest.version !== version) return null
      return require_.resolve(join(root, 'node_modules/sharp'))
    }
    return require_.resolve('sharp')
  } catch { return null }
}

function cachedEntry(directory, version) {
  try {
    const { generation } = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'))
    if (!/^runtime-[0-9a-f-]{36}$/.test(generation)) return null
    return moduleAt(join(directory, generation), version, true)
  } catch { return null }
}

function sharpVersion(packageRoot) {
  const require_ = createRequire(join(packageRoot, 'package.json'))
  try {
    let directory = dirname(require_.resolve('sharp'))
    for (;;) {
      try {
        // Read bytes rather than require(JSON): updates must not inherit a
        // manifest cached by an earlier probe in this process.
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        if (manifest.name === 'sharp' && EXACT_VERSION.test(manifest.version)) return manifest.version
      } catch { /* The entry can be nested under dist or lib. */ }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch { /* A missing package can still be restored from the production lock. */ }
  for (const file of ['npm-shrinkwrap.json', 'release/npm-shrinkwrap.production.json', 'package-lock.json']) {
    try {
      const version = JSON.parse(readFileSync(join(packageRoot, file), 'utf8')).packages?.['node_modules/sharp']?.version
      if (EXACT_VERSION.test(version ?? '')) return version
    } catch { /* Try the next canonical lock. Never install a range or latest. */ }
  }
  throw new Error('Cannot determine the installed image decoder version')
}

function repairEnvironment(env) {
  const result = { ...env }
  // Preserve registry/proxy/CA credentials, but discard install-shaping flags
  // inherited from the parent installer or a Windows npm used before WSL.
  for (const key of Object.keys(result)) {
    if (/^npm_config_(?:arch|cpu|os|platform|libc|target_arch|prefix|global|omit|include|optional|production|ignore_scripts|dry_run|package_lock_only|workspace|workspaces|user_agent)$/i.test(key.replaceAll('-', '_'))) delete result[key]
  }
  return result
}

async function installSharp(staging, version, options) {
  const env = repairEnvironment(options.env ?? process.env)
  const cli = findNpmCli({ env })
  if (!cli) throw new Error('Image recovery needs npm installed for the current Node runtime')
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'tau-image-runtime', version: '1.0.0', private: true }))
  const result = await runNode([cli, 'install', `sharp@${version}`, '--prefix', staging,
    `--os=${process.platform}`, `--cpu=${process.arch}`,
    ...(process.platform === 'linux' ? [`--libc=${resolveImageRuntimeTarget().startsWith('linuxmusl-') ? 'musl' : 'glibc'}`] : []),
    '--global=false', '--ignore-scripts=true', '--include=optional', '--bin-links=false', '--workspaces=false',
    '--dry-run=false', '--package-lock-only=false', '--package-lock=false', '--no-audit', '--no-fund',
    '--fetch-retries=0', '--fetch-timeout=20000'], { cwd: staging, env, timeout: options.installTimeoutMs ?? 60_000 })
  if (result.code !== 0) {
    const error = new Error(result.timedOut ? 'Image recovery timed out' : 'Image dependency download failed; check npm network access')
    error.retainLease = result.stopped === false
    throw error
  }
}

/**
 * Single attempt per process. Failed repairs never poison the next launch.
 * @returns {Promise<{ok: true, modulePath: string, source: 'installed'|'cache'|'repaired'} | {ok: false, reason: string}>}
 */
export async function ensureImageRuntime(packageRoot, options = {}) {
  let version, target, base
  try {
    if (globalThis.Bun?.embeddedFiles?.length) throw new Error('This standalone build has no Node image recovery runtime')
    version = sharpVersion(packageRoot)
    target = options.target ?? resolveImageRuntimeTarget()
    if (!/^[a-z0-9-]+$/.test(target)) throw new Error('Invalid image runtime target')
    base = resolve(options.cacheRoot ?? imageRuntimeCacheRoot(options.env))
  } catch (error) { return { ok: false, reason: error.message } }
  const key = JSON.stringify([resolve(packageRoot), base, target, process.versions.modules, version])
  if (options.repair === false) return recover(packageRoot, base, version, target, options).catch(error => ({ ok: false, reason: error.message }))
  if (!attempts.has(key)) attempts.set(key, recover(packageRoot, base, version, target, options).catch(error => ({ ok: false, reason: error.message })))
  return attempts.get(key)
}

async function recover(packageRoot, base, version, target, options) {
  const probe = options.probe ?? (path => probeImageRuntime(path, options))
  const installed = moduleAt(packageRoot)
  if (installed && await probe(installed)) return { ok: true, modulePath: installed, source: 'installed' }
  const fingerprint = createHash('sha256').update(JSON.stringify([target, process.versions.modules, version])).digest('hex').slice(0, 20)
  const directory = join(base, `${target}-${version}-${fingerprint}`)
  const cached = cachedEntry(directory, version)
  if (cached && await probe(cached)) return { ok: true, modulePath: cached, source: 'cache' }
  if (options.repair === false) return { ok: false, reason: 'The image decoder is unavailable for this OS and Node runtime' }

  await mkdir(base, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + (options.lockTimeoutMs ?? 65_000)
  let lease, staging, unpublishedDirectory, retainLease = false
  try {
    while (!lease) {
      const acquired = acquireSynchronousUpdateLease({ lockPath: `${directory}.lock`, env: {}, staleMs: 120_000 })
      if (acquired.status === 'acquired') { lease = acquired.lease; break }
      if (Date.now() >= deadline) throw new Error('Another image recovery is still running; retry on the next launch')
      await pause(100)
    }
    // Another Tau process may have completed recovery while we waited.
    const ready = cachedEntry(directory, version)
    if (ready && await probe(ready)) return { ok: true, modulePath: ready, source: 'cache' }
    staging = await mkdtemp(join(base, '.image-install-'))
    await (options.install ?? ((path, v) => installSharp(path, v, options)))(staging, version)
    const entry = moduleAt(staging, version, true)
    if (!entry || !await probe(entry)) throw new Error('Recovered image decoder cannot run on this OS and Node runtime')
    // Immutable generations keep loaded Windows DLLs and other live readers
    // untouched. Only a small pointer file changes after full verification.
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const generation = `runtime-${randomUUID()}`
    const publishedDirectory = join(directory, generation)
    await rename(staging, publishedDirectory)
    unpublishedDirectory = publishedDirectory
    staging = undefined
    const published = moduleAt(publishedDirectory, version, true)
    if (!published || !await probe(published)) throw new Error('Image decoder verification failed after installation')
    const pointer = join(directory, `${generation}.json`)
    try {
      await writeFile(pointer, JSON.stringify({ generation }), { flag: 'wx', mode: 0o600 })
      await rename(pointer, join(directory, 'ready.json'))
    } finally { await rm(pointer, { force: true }).catch(() => {}) }
    unpublishedDirectory = undefined
    return { ok: true, modulePath: published, source: 'repaired' }
  } catch (error) {
    retainLease = error.retainLease === true
    if (retainLease) return { ok: false, reason: 'Image recovery could not stop cleanly; retry on the next launch' }
    throw error
  } finally {
    // If termination could not be confirmed, leave its private tree and lock
    // alone. A later launch can recover a stale dead-owner lease safely.
    if (!retainLease) {
      if (unpublishedDirectory) await rm(unpublishedDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => {})
      if (staging) await rm(staging, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => {})
      if (lease) releaseSynchronousUpdateLease(lease)
    }
  }
}
