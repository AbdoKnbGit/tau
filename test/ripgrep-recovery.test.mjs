import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Run the production selector, readiness flow and capability probe against a
// Windows-only installation viewed from Linux. Only process execution and
// unrelated application services are isolated; no test contacts the network.
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tau-rg-recovery-'))
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(root.includes('tau-rg-recovery-'))
    rmSync(root, { recursive: true, force: true })
  })
  const packageRoot = join(root, 'package')
  const vendorRoot = join(packageRoot, 'dist', 'vendor', 'ripgrep')
  const cacheRoot = join(root, 'cache', 'ripgrep')
  const vendorBinary = join(vendorRoot, 'x64-linux', 'rg')
  const cachedBinary = join(cacheRoot, 'x64-linux', 'rg')
  const windowsBinary = join(vendorRoot, 'x64-win32', 'rg.exe')
  const systemBinary = join(root, 'system', 'rg')
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@abdoknbgit/tau', version: '0.0.0' }))
  writeFileSync(join(packageRoot, 'scripts', 'postinstall.mjs'), '// fixture installer; execution is stubbed\n')
  const binary = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  if (options.vendor) binary(vendorBinary, options.vendor)
  if (options.cached) binary(cachedBinary, options.cached)
  if (options.windowsOnly) binary(windowsBinary, 'ripgrep 15.2.0\nWindows fixture\n')
  if (options.systemVersion) binary(systemBinary, `ripgrep ${options.systemVersion}\n`)

  const stateSource = `
    import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    export const state = {
      cacheRoot: ${JSON.stringify(cacheRoot)},
      systemPath: ${JSON.stringify(systemBinary)},
      systemVersion: ${JSON.stringify(options.systemVersion ?? null)},
      embedded: false,
      repairOutcome: 'success', repairGate: null, onRepairStart: null,
      repairs: [], syncProbes: [], versionProbes: [], searches: [], events: [], errors: [],
      searchOutput: 'fixture-image.png\\n',
      probe(command) {
        let stdout = '';
        if (command === 'rg') stdout = this.systemVersion ? 'ripgrep ' + this.systemVersion + '\\n' : '';
        else if (existsSync(command)) stdout = readFileSync(command, 'utf8');
        const working = /^ripgrep \\d+\\.\\d+\\.\\d+/.test(stdout);
        return { status: working ? 0 : null, code: working ? 0 : 1, stdout: working ? stdout : '', stderr: '',
          error: working ? undefined : 'spawn ' + command + ' ENOENT' };
      },
      async repair(command, args, options) {
        this.repairs.push({ command, args, options });
        this.onRepairStart?.();
        if (this.repairGate) await this.repairGate;
        if (this.repairOutcome === 'throw') throw new Error('fixture offline');
        if (this.repairOutcome === 'offline' || this.repairOutcome === 'timeout') return {
          code: 1, stdout: '', stderr: this.repairOutcome === 'offline' ? 'fixture offline' : 'fixture timed out',
          error: this.repairOutcome === 'offline' ? 'download failed' : 'timed out'
        };
        if (this.repairOutcome !== 'missing') {
          const flag = args.indexOf('--ripgrep-vendor-dir');
          const directory = flag < 0 ? this.cacheRoot : args[flag + 1];
          const binary = join(directory, 'x64-linux', 'rg');
          mkdirSync(dirname(binary), { recursive: true });
          writeFileSync(binary, this.repairOutcome === 'corrupt' ? 'invalid executable' : 'ripgrep 15.2.0\\nfixture repaired\\n');
        }
        return { code: 0, stdout: '', stderr: '' };
      }
    };
  `
  const childProcessSource = `
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { state } from 'test:rg-recovery-state';
    export function spawnSync(command, args) {
      state.syncProbes.push({ command, args });
      return state.probe(command);
    }
    export function execFile(command, args, options, callback) {
      state.searches.push({ command, args, options });
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => callback(null, state.searchOutput, ''));
      return child;
    }
    export function spawn(command, args, options) {
      state.searches.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => { child.stdout.end(state.searchOutput); child.emit('close', 0, null); });
      return child;
    }
  `
  const executionSource = `
    import { state } from 'test:rg-recovery-state';
    export async function execFileNoThrow(command, args, options) {
      state.versionProbes.push({ command, args, options });
      return state.probe(command);
    }
    export async function execFileNoThrowWithCwd(command, args, options) {
      return state.repair(command, args, options);
    }
  `
  const stubs = [
    [/^test:rg-recovery-state$/, 'state', stateSource],
    [/^(?:node:)?child_process$/, 'child-process', childProcessSource],
    [/(?:^|\/)execFileNoThrow\.js$/, 'execution', executionSource],
    [/services\/analytics\/index\.js$/, 'analytics', `import { state } from 'test:rg-recovery-state'; export const logEvent = (...args) => state.events.push(args);`],
    [/(?:^|\/)debug\.js$/, 'debug', 'export const logForDebugging = () => {};'],
    [/(?:^|\/)log\.js$/, 'log', `import { state } from 'test:rg-recovery-state'; export const logError = error => state.errors.push(error);`],
    [/(?:^|\/)cachePaths\.js$/, 'cache', `import { state } from 'test:rg-recovery-state'; export const CACHE_PATHS = { ripgrep: () => state.cacheRoot };`],
    [/(?:^|\/)findExecutable\.js$/, 'which', `import { state } from 'test:rg-recovery-state'; export const findExecutable = (cmd, args) => ({ cmd: state.systemVersion ? state.systemPath : cmd, args });`],
    [/(?:^|\/)envUtils\.js$/, 'env', `export const isEnvDefinedFalsy = value => ['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());`],
    [/(?:^|\/)platform\.js$/, 'platform', `export const getPlatform = () => 'wsl';`],
    [/(?:^|\/)bundledMode\.js$/, 'bundled', `import { state } from 'test:rg-recovery-state'; export const isInBundledMode = () => state.embedded;`],
  ]
  const bundled = await build({
    stdin: {
      contents: `export { ensureRipgrepReady, ripgrepCommand, getRipgrepMajorVersion, getRipgrepStatus, ripGrep, ripGrepStream } from './src/utils/ripgrep.ts'; export { state } from 'test:rg-recovery-state';`,
      resolveDir: projectRoot,
      loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22',
    define: {
      'process.platform': '"linux"',
      'process.arch': '"x64"',
      'process.env.NODE_ENV': '"production"',
      'process.env.USE_BUILTIN_RIPGREP': JSON.stringify(options.preferSystem ? '0' : '1'),
      'import.meta.url': JSON.stringify(pathToFileURL(join(packageRoot, 'dist', 'ripgrep.mjs')).href),
    },
    plugins: [{ name: 'isolate-ripgrep-recovery', setup(builder) {
      for (const [filter, name, contents] of stubs) {
        builder.onResolve({ filter }, () => ({ path: name, namespace: 'rg-recovery-test' }))
        builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: 'rg-recovery-test' }, () => ({ contents, loader: 'js', resolveDir: projectRoot }))
      }
    } }],
  })
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  return { ...runtime, root, packageRoot, vendorBinary, cachedBinary, windowsBinary }
}

for (const available of ['vendor', 'cached', 'system']) {
  test(`working ${available} ripgrep needs no automatic repair`, async t => {
    const r = await fixture(t, available === 'system' ? { systemVersion: '14.1.1' } : { [available]: 'ripgrep 14.1.1\n' })
    await r.ensureRipgrepReady()
    assert.equal(await r.getRipgrepMajorVersion(), 14)
    assert.equal(r.getRipgrepStatus().working, true)
    assert.equal(r.state.repairs.length, 0)
    assert.equal(r.ripgrepCommand().rgPath, available === 'vendor' ? r.vendorBinary : available === 'cached' ? r.cachedBinary : 'rg')
  })
}

test('an explicitly preferred working system ripgrep keeps priority over the bundled binary', async t => {
  const r = await fixture(t, { vendor: 'ripgrep 15.2.0\n', systemVersion: '14.1.1', preferSystem: true })
  await r.ensureRipgrepReady()
  assert.equal(r.ripgrepCommand().rgPath, 'rg')
  assert.equal(await r.getRipgrepMajorVersion(), 14)
  assert.equal(r.state.repairs.length, 0)
})

for (const initial of ['missing', 'corrupt', 'windows-only']) {
  test(`${initial} Linux ripgrep is recovered into the user cache`, async t => {
    const r = await fixture(t, initial === 'corrupt' ? { vendor: 'incompatible executable' } : { windowsOnly: initial === 'windows-only' })
    await r.ensureRipgrepReady()
    assert.equal(r.ripgrepCommand().rgPath, r.cachedBinary)
    assert.equal(await r.getRipgrepMajorVersion(), 15)
    assert.equal(r.getRipgrepStatus().working, true)
    assert.equal(r.state.repairs.length, 1)
    const repair = r.state.repairs[0]
    assert.equal(repair.command, process.execPath)
    assert.equal(repair.args[0], join(r.packageRoot, 'scripts', 'postinstall.mjs'))
    assert.ok(repair.args.includes('--ripgrep-only'))
    assert.equal(repair.args[repair.args.indexOf('--ripgrep-vendor-dir') + 1], dirname(dirname(r.cachedBinary)))
    assert.ok(repair.options.timeout > 0 && repair.options.timeout <= 120_000)
    assert.ok(!repair.options.shell, 'recovery must not start a shell')
    assert.equal(r.state.syncProbes.some(probe => probe.command === r.windowsBinary), false)
    if (initial === 'windows-only') assert.equal(readFileSync(r.windowsBinary, 'utf8'), 'ripgrep 15.2.0\nWindows fixture\n')
  })
}

test('concurrent readiness, capability and searches share one repair and use the repaired binary', async t => {
  const r = await fixture(t, { windowsOnly: true })
  let finishRepair
  const started = new Promise(resolve => { r.state.onRepairStart = resolve })
  r.state.repairGate = new Promise(resolve => { finishRepair = resolve })
  const lines = []
  const requests = [
    r.ensureRipgrepReady(),
    r.getRipgrepMajorVersion(),
    r.ripGrep(['--files'], r.root, new AbortController().signal),
    r.ripGrepStream(['--files'], r.root, new AbortController().signal, chunk => lines.push(...chunk)),
  ]
  await started
  assert.equal(r.state.repairs.length, 1)
  assert.equal(r.state.searches.length, 0, 'searches wait until a verified binary is ready')
  finishRepair()
  const [, version, matches] = await Promise.all(requests)
  assert.equal(version, 15)
  assert.deepEqual(matches, ['fixture-image.png'])
  assert.deepEqual(lines, ['fixture-image.png'])
  assert.equal(r.state.repairs.length, 1)
  assert.equal(r.state.searches.length, 2)
  assert.ok(r.state.searches.every(search => search.command === r.cachedBinary))
})

for (const outcome of ['offline', 'timeout', 'throw', 'missing', 'corrupt']) {
  test(`failed ${outcome} recovery reports an actionable error without repeated attempts`, async t => {
    const r = await fixture(t)
    r.state.repairOutcome = outcome
    const results = await Promise.allSettled([r.ensureRipgrepReady(), r.getRipgrepMajorVersion()])
    assert.ok(results.every(result => result.status === 'rejected'))
    for (const result of results) {
      assert.match(result.reason.message, /ripgrep|search/i)
      assert.match(result.reason.message, /repair|install|retry|restart/i)
      assert.doesNotMatch(result.reason.message, /^spawn rg ENOENT$/)
    }
    await assert.rejects(r.ensureRipgrepReady())
    assert.equal(r.state.repairs.length, 1)
    assert.equal(r.state.searches.length, 0)
    assert.equal(r.getRipgrepStatus().working, false)
  })
}

test('canceling one waiter returns promptly without canceling the shared repair', async t => {
  const r = await fixture(t)
  let finishRepair
  const started = new Promise(resolve => { r.state.onRepairStart = resolve })
  r.state.repairGate = new Promise(resolve => { finishRepair = resolve })
  const controller = new AbortController()
  const canceled = r.ensureRipgrepReady(controller.signal)
  const rejected = assert.rejects(canceled, error => error.name === 'AbortError' || error.code === 'ABORT_ERR')
  const other = r.getRipgrepMajorVersion()
  await started
  controller.abort()
  await rejected
  assert.equal(r.state.repairs.length, 1)
  assert.equal(r.state.repairs[0].options.abortSignal, undefined, 'one caller must not own the shared installer process')
  finishRepair()
  assert.equal(await other, 15)
  await r.ensureRipgrepReady()
  assert.equal(r.state.repairs.length, 1)
})

test('an already canceled call does not start readiness probes or automatic recovery', async t => {
  const r = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(r.ensureRipgrepReady(controller.signal), error => error.name === 'AbortError' || error.code === 'ABORT_ERR')
  assert.equal(r.state.repairs.length, 0)
  assert.equal(r.state.versionProbes.length, 0)
  assert.equal(r.state.syncProbes.length, 0)
  await r.ensureRipgrepReady()
  assert.equal(r.state.repairs.length, 1, 'a canceled caller must not poison later readiness')
})

test('embedded ripgrep stays on its native dispatch path and never runs standalone setup', async t => {
  const r = await fixture(t)
  r.state.embedded = true
  const previous = globalThis.Bun
  const invocations = []
  globalThis.Bun = { spawn(args, options) {
    invocations.push({ args, options })
    return { stdout: { text: async () => 'ripgrep 15.2.0\nembedded fixture\n' }, exited: Promise.resolve(0), kill() {} }
  } }
  try {
    await r.ensureRipgrepReady()
    assert.equal(await r.getRipgrepMajorVersion(), 15)
    assert.equal(r.ripgrepCommand().argv0, 'rg')
    assert.equal(r.ripgrepCommand().rgPath, process.execPath)
    assert.equal(r.state.repairs.length, 0)
    assert.equal(invocations.length, 1)
  } finally {
    if (previous === undefined) delete globalThis.Bun
    else globalThis.Bun = previous
  }
})
