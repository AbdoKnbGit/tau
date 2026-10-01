import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test, { after } from 'node:test'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(path.join(tmpdir(), 'tau-lsp-lifecycle-'))
after(() => rmSync(temp, { recursive: true, force: true }))
const bundle = path.join(temp, 'runtime.mjs')
const fixture = path.join(root, 'test/fixtures/lsp-lifecycle-server.mjs')
const stubs = {
  'config.js': `export const getAllLspServers = () => globalThis.__lspTest.loadConfig()`,
  'debug.js': 'export const logForDebugging = () => {}',
  'log.js': 'export const logError = () => {}',
  'envUtils.js': 'export const isBareMode = () => false',
  'settings.js':
    'export const getInitialSettings = () => globalThis.__lspTest.settings',
  'errors.js':
    'export const errorMessage = e => String(e?.message ?? e); export const toError = e => e instanceof Error ? e : new Error(String(e))',
  'cwd.js': 'export const getCwd = () => globalThis.__lspTest.cwd',
  'which.js': 'export const whichSync = () => undefined',
  'subprocessEnv.js': 'export const subprocessEnv = () => process.env',
  'slowOperations.js': 'export const jsonStringify = JSON.stringify',
  'projectFiles.js':
    'export const listProjectFiles = async () => globalThis.__lspTest.files; export const byDepth = () => () => 0',
  'execFileNoThrow.js': `import { win32 } from 'node:path'; export const resolveWindowsTaskkillPath = env => env.SystemRoot ? win32.join(env.SystemRoot, 'System32', 'taskkill.exe') : null`,
}
await build({
  stdin: {
    contents: `export * from './src/services/lsp/manager.ts'; export * from './src/services/lsp/LSPServerManager.ts'; export * from './src/services/lsp/LSPServerInstance.ts'; export * from './src/services/lsp/passiveFeedback.ts'; export * from './src/services/lsp/prime.ts'; export * from './src/services/lsp/LSPDiagnosticRegistry.ts'`,
    resolveDir: root,
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  banner: {
    js: `import { createRequire as testRequire } from 'node:module'; const require = testRequire(${JSON.stringify(path.join(root, 'package.json'))});`,
  },
  plugins: [
    {
      name: 'isolate-external-services',
      setup(builder) {
        builder.onResolve({ filter: /\.js$/ }, args => {
          if (!args.path.startsWith('.')) return
          const name = path.basename(args.path)
          if (stubs[name]) return { path: name, namespace: 'stub' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: stubs[args.path],
          loader: 'js',
        }))
      },
    },
  ],
})

let sequence = 0
const deferred = () => {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}
async function until(predicate, message) {
  const deadline = Date.now() + 8_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await delay(20)
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function runtime(t, mode = 'normal') {
  const id = ++sequence
  const log = path.join(temp, `events-${id}.jsonl`)
  writeFileSync(log, '')
  const state = {
    cwd: temp,
    files: [],
    settings: { lspEnabled: true },
    servers: {},
  }
  state.loadConfig = async () => ({ servers: structuredClone(state.servers) })
  globalThis.__lspTest = state
  const r = await import(`${pathToFileURL(bundle)}?test=${id}`)
  const config = {
    command: process.execPath,
    args: [fixture, log, mode],
    extensionToLanguage: { '.ts': 'typescript' },
    workspaceFolder: temp,
    alwaysOn: true,
  }
  state.servers = { typescript: config }
  const events = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  const managers = []
  const instances = []
  t.after(async () => {
    await r.shutdownLspServerManager()
    await Promise.allSettled(managers.map(m => m.shutdown()))
    await Promise.allSettled(instances.map(s => s.stop()))
  })
  return {
    ...r,
    state,
    config,
    events,
    manager() {
      const m = r.createLSPServerManager()
      managers.push(m)
      return m
    },
    instance() {
      const s = r.createLSPServerInstance('fixture', config)
      instances.push(s)
      return s
    },
  }
}

test('startup plus repeated plugin refresh keeps one server and working diagnostics', async t => {
  const r = await runtime(t, 'slow')
  r.initializeLspServerManager()
  r.reinitializeLspServerManager()
  r.reinitializeLspServerManager()
  await r.waitForInitialization()
  const manager = r.getLspServerManager()
  const server = await manager.ensureServerStarted(path.join(temp, 'sample.ts'))
  await manager.openFile(path.join(temp, 'sample.ts'), 'const x = 1')
  await until(
    () => r.getPendingLSPDiagnosticCount() === 1,
    'diagnostics must reach Tau',
  )
  r.reinitializeLspServerManager()
  await r.waitForInitialization()
  assert.equal(manager, r.getLspServerManager())
  assert.equal(manager.getServerForFile('sample.ts'), server)
  assert.equal(manager.isFileOpen(path.join(temp, 'sample.ts')), true)
  assert.equal(r.events().filter(e => e.event === 'spawn').length, 1)
  assert.deepEqual(
    await manager.sendRequest('sample.ts', 'textDocument/hover', {}),
    { contents: 'fixture hover' },
  )
})

test('changed/removed configuration stops old processes and preserves unchanged servers', async t => {
  const r = await runtime(t)
  r.state.servers.other = {
    ...r.config,
    extensionToLanguage: { '.js': 'javascript' },
  }
  const manager = r.manager()
  await manager.initialize()
  await Promise.all([
    manager.ensureServerStarted('a.ts'),
    manager.ensureServerStarted('a.js'),
  ])
  const kept = manager.getServerForFile('a.js')
  const old = manager.getServerForFile('a.ts')
  r.state.servers.typescript = {
    ...r.config,
    initializationOptions: { changed: true },
  }
  await manager.initialize()
  assert.equal(old.state, 'stopped')
  assert.equal(manager.getServerForFile('a.js'), kept)
  assert.notEqual(await manager.ensureServerStarted('a.ts'), old)
  delete r.state.servers.typescript
  await manager.initialize()
  assert.equal(manager.getServerForFile('a.ts'), undefined)
  assert.deepEqual(
    await manager.sendRequest('a.js', 'textDocument/hover', {}),
    { contents: 'fixture hover' },
  )
})

test('shutdown during config discovery never launches late servers', async t => {
  const r = await runtime(t)
  const gate = deferred()
  let entered = false
  r.state.loadConfig = () => {
    entered = true
    return gate.promise
  }
  const manager = r.manager()
  const initializing = manager.initialize()
  await until(() => entered, 'configuration load must begin')
  const stopping = manager.shutdown()
  gate.resolve({ servers: r.state.servers })
  await Promise.all([initializing, stopping])
  await manager.initialize()
  assert.equal(manager.getAllServers().size, 0)
  assert.equal(r.events().length, 0)
})

test('shutdown cancels a hung initialize and removes its descendant process', async t => {
  const r = await runtime(t, 'hung-initialize')
  const manager = r.manager()
  await manager.initialize()
  await until(
    () => r.events().some(e => e.event === 'worker'),
    'fixture must create a descendant',
  )
  const { pid, workerPid } = r.events().find(e => e.event === 'worker')
  const server = manager.getServerForFile('a.ts')
  await manager.shutdown()
  await until(
    () => !alive(pid) && !alive(workerPid),
    'entire LSP process tree must exit',
  )
  assert.equal(server.state, 'stopped')
  assert.equal(manager.getAllServers().size, 0)
})

test('stop immediately after spawn cancels startup and permits a clean restart', async t => {
  const r = await runtime(t, 'slow')
  const server = r.instance()
  const starting = server.start()
  const cancelled = assert.rejects(starting, /cancelled|disposed|closed/i)
  await Promise.all([server.stop(), server.stop(), cancelled])
  assert.equal(server.state, 'stopped')
  await server.start()
  assert.equal(server.state, 'running')
  assert.deepEqual(await server.sendRequest('textDocument/hover', {}), {
    contents: 'fixture hover',
  })
})

test('unresponsive shutdown is bounded and the instance can restart', async t => {
  const r = await runtime(t, 'hung-shutdown')
  const server = r.instance()
  await server.start()
  const pid = r.events().find(e => e.event === 'spawn').pid
  await server.stop()
  assert.equal(alive(pid), false)
  assert.equal(server.state, 'stopped')
  await server.start()
  assert.equal(server.state, 'running')
})

test(
  'Windows shutdown kills descendants before their parent can orphan them',
  { skip: process.platform !== 'win32' },
  async t => {
    const r = await runtime(t, 'orphan-on-exit')
    const server = r.instance()
    await server.start()
    const { pid, workerPid } = r.events().find(e => e.event === 'worker')
    await server.stop()
    await until(
      () => !alive(pid) && !alive(workerPid),
      'a clean protocol exit must not strand descendants',
    )
  },
)

test('singleton shutdown invalidates pending initialization and allows immediate reinit', async t => {
  const r = await runtime(t)
  r.initializeLspServerManager()
  const old = r.getLspServerManager()
  const stopping = r.shutdownLspServerManager()
  r.initializeLspServerManager()
  await Promise.all([stopping, r.waitForInitialization()])
  const current = r.getLspServerManager()
  assert.notEqual(current, old)
  assert.equal(old.getAllServers().size, 0)
  assert.equal(r.getInitializationStatus().status, 'success')
  await current.ensureServerStarted('sample.ts')
  assert.equal(r.events().filter(e => e.event === 'spawn').length, 1)
})

test('refresh preserves the warm index without priming or suppressing diagnostics again', async t => {
  const r = await runtime(t)
  const file = path.join(temp, 'warm.ts')
  writeFileSync(file, 'const value = 1')
  r.state.files = [file]
  r.initializeLspServerManager()
  await r.waitForInitialization()
  await until(
    () => r.events().some(e => e.event === 'textDocument/didOpen'),
    'startup must still warm the project',
  )
  r.reinitializeLspServerManager()
  await r.waitForInitialization()
  await r.primeLspServers(r.getLspServerManager())
  assert.equal(
    r.events().filter(e => e.event === 'textDocument/didOpen').length,
    1,
  )
  assert.equal(r.events().filter(e => e.event === 'spawn').length, 1)
})

test('default and explicit-off startup never discover or spawn language servers', async t => {
  const r = await runtime(t)
  let discoveries = 0
  r.state.loadConfig = async () => {
    discoveries++
    return { servers: r.state.servers }
  }
  for (const settings of [
    {},
    { lspEnabled: false },
    { powerMode: 'full' },
    { lspEnabled: true, powerMode: 'cheap' },
  ]) {
    r.state.settings = settings
    r.initializeLspServerManager()
    r.reinitializeLspServerManager()
    r.syncLspServerManagerWithSettings()
    await r.waitForInitialization()
    assert.equal(r.getLspServerManager(), undefined)
    assert.equal(r.getInitializationStatus().status, 'not-started')
  }
  assert.equal(discoveries, 0)
  assert.equal(r.events().length, 0)
})

test('settings notifications cannot start LSP before the explicit startup boundary', async t => {
  const r = await runtime(t)
  r.syncLspServerManagerWithSettings()
  await r.waitForInitialization()
  assert.equal(r.getLspServerManager(), undefined)
  assert.equal(r.events().length, 0)
})

test('off/on resets processes, open documents, pending diagnostics, and deduplication', async t => {
  const r = await runtime(t)
  const file = path.join(temp, 'toggle.ts')
  r.initializeLspServerManager()
  await r.waitForInitialization()
  const old = r.getLspServerManager()
  await old.openFile(file, 'const x = 1')
  await until(() => r.getPendingLSPDiagnosticCount() > 0, 'first diagnostics')
  assert.equal(r.checkForLSPDiagnostics().length, 1)
  await old.openFile(path.join(temp, 'second.ts'), 'const y = 1')
  await until(() => r.getPendingLSPDiagnosticCount() > 0, 'pending diagnostics')
  r.suppressLSPDiagnosticsForFile(file)
  r.state.settings.lspEnabled = false
  r.syncLspServerManagerWithSettings()
  await old.shutdown()
  assert.equal(r.getLspServerManager(), undefined)
  assert.equal(old.getAllServers().size, 0)
  assert.equal(old.isFileOpen(file), false)
  assert.equal(r.getPendingLSPDiagnosticCount(), 0)
  r.state.settings.lspEnabled = true
  r.syncLspServerManagerWithSettings()
  await r.waitForInitialization()
  const current = r.getLspServerManager()
  assert.notEqual(current, old)
  await current.openFile(file, 'const x = 1')
  await until(
    () => r.getPendingLSPDiagnosticCount() > 0,
    'fresh diagnostics after enabling',
  )
  assert.equal(
    r.checkForLSPDiagnostics().length,
    1,
    'old deduplication/suppression must not hide fresh results',
  )
})

test('late notifications from retired servers cannot repopulate diagnostic state', async t => {
  const r = await runtime(t)
  let receive
  const server = {
    onNotification(_method, callback) {
      receive = callback
    },
  }
  const servers = new Map([['fixture', server]])
  r.registerLSPNotificationHandlers({ getAllServers: () => servers })
  servers.clear()
  receive({
    uri: pathToFileURL(path.join(temp, 'late.ts')).href,
    diagnostics: [
      {
        message: 'late',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
    ],
  })
  assert.equal(r.getPendingLSPDiagnosticCount(), 0)
})

test('an old warmup timer cannot unsuppress a new session and reset clears suppression', async t => {
  const r = await runtime(t)
  const file = path.join(temp, 'suppression.ts')
  const diagnostic = {
    serverName: 'fixture',
    files: [{ uri: file, diagnostics: [{ message: 'current' }] }],
  }
  const oldToken = r.suppressLSPDiagnosticsForFile(file)
  r.resetAllLSPDiagnosticState()
  const token = r.suppressLSPDiagnosticsForFile(file)
  r.unsuppressLSPDiagnosticsForFile(file, oldToken)
  r.registerPendingLSPDiagnostic(diagnostic)
  assert.equal(r.getPendingLSPDiagnosticCount(), 0)
  r.unsuppressLSPDiagnosticsForFile(file, token)
  r.registerPendingLSPDiagnostic(diagnostic)
  assert.equal(r.checkForLSPDiagnostics().length, 1)
  r.suppressLSPDiagnosticsForFile(file)
  r.resetAllLSPDiagnosticState()
  r.registerPendingLSPDiagnostic(diagnostic)
  assert.equal(r.checkForLSPDiagnostics().length, 1)
})
