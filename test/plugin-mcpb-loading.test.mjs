// MCPB and .dxt plugin servers, through the shipped bundle: real manifests go
// through plugin loading, the server starts the way services/mcp/client.ts
// starts it, and each test asserts what a user needs to be true on this OS.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { strToU8, zipSync } from 'fflate'
import { getNodeRuntimeIssue } from '../scripts/node-runtime.mjs'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// On these Node versions a process can die in shutdown after its work is done.
const exitMayCrash = getNodeRuntimeIssue(process.versions.node) === 'windows-shutdown'
const repositoryRoot = process.cwd()
process.env.TAU_MCP_TEST_BUNDLE ??= resolve('dist/tau.mjs')
const helperUrl = new URL('./helpers/mcp-built-runtime.mjs', import.meta.url).href

// A space and an accent, because that is where launch quoting goes wrong.
const root = mkdtempSync(join(tmpdir(), 'tau mcpb é-'))
const config = join(root, 'config')
const project = join(root, 'project')
const emptyDir = join(root, 'empty')
for (const dir of [config, project, emptyDir]) mkdirSync(dir, { recursive: true })
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
})
process.chdir(project)
after(() => {
  process.chdir(repositoryRoot)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const runtimePaths = [
  'src/utils/plugins/mcpbHandler.ts',
  'src/utils/plugins/mcpPluginIntegration.ts',
  'src/types/plugin.ts',
]
const { loadMcpbFile, getPluginMcpServers, getPluginErrorMessage } =
  await loadMcpRuntime({
    paths: runtimePaths,
    exports: ['loadMcpbFile', 'getPluginMcpServers', 'getPluginErrorMessage'],
  })

const isWindows = process.platform === 'win32'
const author = { name: 'Tau Test' }

const NODE_SERVER = `const readline = require('node:readline')
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const shown = ['ECHO_TAG', 'CONN_STR', 'OPT']
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } })
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] } })
  else if (msg.method === 'tools/call') send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ runtime: 'node', file: __filename, argv: process.argv.slice(2), env: Object.fromEntries(shown.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) }) }] } })
  else send({ id: msg.id, error: { code: -32601, message: 'no' } })
})
`
const PYTHON_SERVER = `import json, sys
def send(m):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **m}) + "\\n")
    sys.stdout.flush()
for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    if "id" not in msg:
        continue
    m = msg.get("method")
    if m == "initialize":
        send({"id": msg["id"], "result": {"protocolVersion": msg["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "echo", "version": "1.0.0"}}})
    elif m == "tools/list":
        send({"id": msg["id"], "result": {"tools": [{"name": "echo", "description": "echo", "inputSchema": {"type": "object", "properties": {}}}]}})
    elif m == "tools/call":
        send({"id": msg["id"], "result": {"content": [{"type": "text", "text": json.dumps({"runtime": "python " + sys.version.split()[0], "file": __file__, "argv": sys.argv[1:], "env": {}})}]}})
    else:
        send({"id": msg["id"], "error": {"code": -32601, "message": "no"}})
`
const NODE_FILES = { 'server/index.js': NODE_SERVER }
const PYTHON_FILES = { 'server/main.py': PYTHON_SERVER }

const zip = files =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [
        name,
        typeof data === 'string' ? strToU8(data) : data,
      ]),
    ),
  )

function plugin(id, manifest, files = NODE_FILES, file = 'bundle.mcpb') {
  const dir = join(root, 'plugins', id)
  mkdirSync(join(dir, 'mcp'), { recursive: true })
  const bundlePath = join(dir, 'mcp', file)
  writeFileSync(
    bundlePath,
    zip({ 'manifest.json': JSON.stringify(manifest), ...files }),
  )
  return { id, dir, source: `./mcp/${file}`, pluginId: `${id}@test`, bundlePath }
}

const nodeManifest = (name, extra = {}, launch = {}) => ({
  manifest_version: '0.3',
  name,
  version: '1.0.0',
  author,
  description: name,
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
      env: { ECHO_TAG: name },
      ...launch,
    },
  },
  ...extra,
})
const pythonManifest = (name, command, extra = {}) => ({
  manifest_version: '0.3',
  name,
  version: '1.0.0',
  author,
  description: name,
  server: {
    type: 'python',
    entry_point: 'server/main.py',
    mcp_config: { command, args: ['${__dirname}/server/main.py'], env: {} },
  },
  ...extra,
})

async function pipeline(p, source = p.source) {
  const errors = []
  const servers = await getPluginMcpServers(
    {
      name: p.id,
      path: p.dir,
      source: p.pluginId,
      repository: p.pluginId,
      enabled: true,
      manifest: { name: p.id, version: '1.0.0', mcpServers: source },
    },
    errors,
  )
  return {
    config: servers && Object.values(servers)[0],
    messages: errors.map(getPluginErrorMessage),
  }
}

const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref(),
    ),
  ])

async function connect(config) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...config.env },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', data => {
    stderr += data
  })
  const client = new Client({ name: 'tau-mcpb-test', version: '1.0.0' })
  try {
    await withTimeout(client.connect(transport), 60_000, 'connect')
  } catch (error) {
    throw new Error(`${error.message}; stderr: ${stderr.slice(0, 300)}`)
  }
  return client
}

async function launch(config) {
  const client = await connect(config)
  try {
    const { tools } = await withTimeout(client.listTools(), 30_000, 'tools/list')
    const call = await withTimeout(
      client.callTool({ name: tools[0].name, arguments: {} }),
      30_000,
      'tools/call',
    )
    return JSON.parse(call.content[0].text)
  } finally {
    await client.close().catch(() => {})
  }
}

async function loadAndRun(p, source) {
  const { config: serverConfig, messages } = await pipeline(p, source)
  assert.ok(serverConfig, `did not load: ${messages.join(' | ') || 'no error shown'}`)
  return { ...(await launch(serverConfig)), config: serverConfig, messages }
}

async function assertClearError(p, pattern) {
  const { config: serverConfig, messages } = await pipeline(p)
  assert.equal(serverConfig, undefined, 'expected the plugin error before any launch')
  assert.match(messages.join(' | '), pattern)
}

async function withPath(value, fn) {
  const saved = process.env.PATH
  process.env.PATH = value
  try {
    return await fn()
  } finally {
    process.env.PATH = saved
  }
}

const programName = name => (isWindows ? `${name}.exe` : name)
const hasProgram = name =>
  process.env.PATH.split(delimiter).some(dir => existsSync(join(dir, programName(name))))
const pathWithout = name =>
  process.env.PATH.split(delimiter)
    .filter(dir => !existsSync(join(dir, programName(name))))
    .join(delimiter)

function hasRealPython(pathValue = process.env.PATH) {
  const candidates = isWindows
    ? [['python'], ['py', '-3'], ['python3']]
    : [['python3'], ['python']]
  return withPathSync(pathValue, () =>
    candidates.some(([command, ...prefix]) => {
      const result = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' })
      return result.status === 0 && /^Python 3\./m.test(`${result.stdout}\n${result.stderr}`)
    }),
  )
}
function withPathSync(value, fn) {
  const saved = process.env.PATH
  process.env.PATH = value
  try {
    return fn()
  } finally {
    process.env.PATH = saved
  }
}

const pythonInstalled = hasRealPython()
const noPython = 'Python 3 is not installed here'
// Keeps Windows' Store placeholders in the way when this machine has them: the
// case this has to see through.
const noPythonPath = [
  emptyDir,
  ...(isWindows && process.env.LOCALAPPDATA
    ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')]
    : []),
].join(delimiter)

const metadataPathOf = (cacheDir, source) =>
  join(
    cacheDir,
    `${createHash('md5').update(source).digest('hex').substring(0, 8)}.metadata.json`,
  )
const walk = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )

// ── Programs a bundle needs ────────────────────────────────────────────────

test('a bundle asking for python3 runs on every OS', { skip: !pythonInstalled && noPython }, async () => {
  const result = await loadAndRun(plugin('python3', pythonManifest('python3', 'python3'), PYTHON_FILES))
  assert.match(result.runtime, /^python 3\./)
})

test('a bundle asking for python runs on every OS', { skip: !pythonInstalled && noPython }, async () => {
  const result = await loadAndRun(plugin('python', pythonManifest('python', 'python'), PYTHON_FILES))
  assert.match(result.runtime, /^python 3\./)
})

test('a declared Python range in comma form does not block a working Python', { skip: !pythonInstalled && noPython }, async () => {
  const manifest = pythonManifest('python-range', 'python3', {
    compatibility: { runtimes: { python: '>=3.0,<4' } },
  })
  const result = await loadAndRun(plugin('python-range', manifest, PYTHON_FILES))
  assert.match(result.runtime, /^python 3\./)
})

test('with no Python at all the plugin says so instead of failing to connect', async t => {
  if (hasRealPython(noPythonPath)) return t.skip('this PATH still reaches a real Python')
  const p = plugin('no-python', pythonManifest('no-python', 'python3'), PYTHON_FILES)
  await withPath(noPythonPath, () => assertClearError(p, /needs Python.*\/reload-plugins/))
})

test('installing Python after a failure works without extracting again', { skip: !pythonInstalled && noPython }, async t => {
  if (hasRealPython(noPythonPath)) return t.skip('this PATH still reaches a real Python')
  const p = plugin('python-later', pythonManifest('python-later', 'python3'), PYTHON_FILES)
  await withPath(noPythonPath, () => assertClearError(p, /needs Python/))
  const metadata = JSON.parse(readFileSync(metadataPathOf(join(p.dir, '.mcpb-cache'), p.source), 'utf8'))
  const marker = join(metadata.extractedPath, 'server', 'main.py')
  const before = statSync(marker).mtimeMs
  const result = await loadAndRun(p)
  assert.match(result.runtime, /^python 3\./)
  assert.equal(statSync(marker).mtimeMs, before)
})

test('node falls back to the runtime running Tau when PATH has none', async () => {
  const p = plugin('node-fallback', nodeManifest('node-fallback'))
  const result = await withPath(pathWithout('node'), () => loadAndRun(p))
  assert.equal(result.runtime, 'node')
  assert.equal(result.config.command, process.execPath)
})

test('uv runs when installed and is explained when it is not', async () => {
  const manifest = pythonManifest('uv-server', 'uv')
  manifest.manifest_version = '0.4'
  manifest.server = {
    type: 'uv',
    entry_point: 'server/main.py',
    mcp_config: {
      command: 'uv',
      args: ['run', '--no-project', '--directory', '${__dirname}', 'server/main.py'],
      env: {},
    },
  }
  const p = plugin('uv-server', manifest, PYTHON_FILES)
  if (hasProgram('uv')) {
    assert.match((await loadAndRun(p)).runtime, /^python 3\./)
  } else {
    await assertClearError(p, /needs "uv".*\/reload-plugins/)
  }
})

test('a missing program is named before any launch', async () => {
  const p = plugin('missing-program', nodeManifest('missing-program', {}, { command: 'tau-test-not-installed', args: ['run'] }))
  await assertClearError(p, /needs "tau-test-not-installed"/)
})

test('a program built for another OS is explained', async () => {
  const foreign =
    process.platform === 'darwin'
      ? Buffer.from('4d5a9000', 'hex')
      : Buffer.from('cffaedfe07000001', 'hex')
  const p = plugin('foreign-program', nodeManifest('foreign-program', {}, { command: '${__dirname}/bin/server', args: [] }), { 'bin/server': foreign })
  await assertClearError(p, /only ships a (macOS|Windows) program/)
})

test('a launcher in the bundle runs without an exec bit in the zip', async () => {
  const files = isWindows
    ? { ...NODE_FILES, 'bin/server.cmd': '@echo off\r\nnode "%~dp0..\\server\\index.js" %*\r\n' }
    : { ...NODE_FILES, 'bin/server': '#!/bin/sh\nexec node "$(dirname "$0")/../server/index.js" "$@"\n' }
  const command = isWindows ? '${__dirname}/bin/server.cmd' : '${__dirname}/bin/server'
  const result = await loadAndRun(plugin('launcher', nodeManifest('launcher', {}, { command, args: ['--flag', 'value with spaces'] }), files))
  assert.deepEqual(result.argv, ['--flag', 'value with spaces'])
})

test('platform overrides and the ${/} separator launch through a shell', async () => {
  const files = {
    ...NODE_FILES,
    'run.bat': '@echo off\r\nnode "%~dp0server\\index.js"\r\n',
    'run.sh': '#!/bin/sh\nexec node "$(dirname "$0")/server/index.js"\n',
  }
  const manifest = nodeManifest('overrides', {}, {
    command: 'sh',
    args: ['${__dirname}${/}run.sh'],
    platform_overrides: {
      win32: { command: 'cmd', args: ['/c', '${__dirname}${/}run.bat'] },
    },
  })
  assert.equal((await loadAndRun(plugin('overrides', manifest, files))).runtime, 'node')
})

test('a platforms list that omits this OS only warns, the script still runs', async () => {
  const other = process.platform === 'darwin' ? 'linux' : 'darwin'
  const p = plugin('platforms', nodeManifest('platforms', { compatibility: { platforms: [other] } }))
  assert.equal((await loadAndRun(p)).runtime, 'node')
})

// ── Settings ───────────────────────────────────────────────────────────────

test('a required setting with a ${HOME} default loads without asking', async () => {
  const manifest = nodeManifest('with-default', {
    user_config: {
      docs: { type: 'directory', title: 'Docs', description: 'Docs', required: true, default: '${HOME}/tau-docs' },
    },
  }, { args: ['${__dirname}/server/index.js', '--docs', '${user_config.docs}'] })
  const result = await loadAndRun(plugin('with-default', manifest))
  assert.ok(result.argv[1].startsWith(homedir()), result.argv[1])
  assert.ok(!result.argv.join(' ').includes('${'))
})

test('a secret with $$ and $& reaches the server unchanged', async () => {
  const secret = 'postgres://u:pa$$w0rd$&x@host/db'
  const manifest = nodeManifest('secret', {
    user_config: {
      conn: { type: 'string', title: 'Conn', description: 'Conn', required: true, sensitive: true },
    },
  }, { env: { CONN_STR: '${user_config.conn}' } })
  const p = plugin('secret', manifest)
  await loadMcpbFile(p.source, p.dir, p.pluginId, undefined, { conn: secret })
  assert.equal((await loadAndRun(p)).env.CONN_STR, secret)
})

test('a list setting expands into separate arguments', async () => {
  const manifest = nodeManifest('list', {
    user_config: {
      tags: { type: 'string', title: 'Tags', description: 'Tags', multiple: true },
    },
  }, { args: ['${__dirname}/server/index.js', '--tags', '${user_config.tags}'] })
  const p = plugin('list', manifest)
  await loadMcpbFile(p.source, p.dir, p.pluginId, undefined, { tags: ['alpha', 'beta'] })
  assert.deepEqual((await loadAndRun(p)).argv, ['--tags', 'alpha', 'beta'])
})

test('an unset optional setting never reaches the server as text', async () => {
  const manifest = nodeManifest('optional', {
    user_config: { opt: { type: 'string', title: 'Opt', description: 'Opt' } },
  }, { args: ['${__dirname}/server/index.js', '${user_config.opt}'], env: { OPT: '${user_config.opt}' } })
  const result = await loadAndRun(plugin('optional', manifest))
  assert.deepEqual(result.argv, [])
  assert.equal(result.env.OPT, undefined)
  assert.deepEqual(result.messages, [])
})

test('$ and & in a folder name do not corrupt the launch path', async () => {
  assert.equal((await loadAndRun(plugin('odd-$&-name', nodeManifest('odd')))).runtime, 'node')
})

// ── Manifest versions ──────────────────────────────────────────────────────

test('an unknown extra key does not reject a bundle', async () => {
  const p = plugin('extra-key', nodeManifest('extra-key', { x_vendor: { a: 1 } }))
  assert.equal((await loadAndRun(p)).runtime, 'node')
})

test('old .dxt and every known manifest version load', async () => {
  const { manifest_version: _version, ...base } = nodeManifest('dxt')
  const dxt = await loadAndRun(plugin('dxt', { ...base, dxt_version: '0.1' }, NODE_FILES, 'old.dxt'))
  assert.equal(dxt.env.ECHO_TAG, 'dxt')
  for (const version of ['0.2', '0.3', '0.4']) {
    const name = `manifest-${version}`
    const result = await loadAndRun(plugin(name, { ...nodeManifest(name), manifest_version: version }))
    assert.equal(result.env.ECHO_TAG, name)
  }
})

test('a future manifest loads when it can still be read', async () => {
  const future = { ...nodeManifest('future'), manifest_version: '9.1', capabilities: { x: true } }
  future.server = { ...future.server, type: 'wasm' }
  assert.equal((await loadAndRun(plugin('future', future))).runtime, 'node')
})

test('a future manifest that moved its launch info asks to update Tau', async () => {
  const future = { ...nodeManifest('future-unreadable'), manifest_version: '9.2' }
  future.server = { type: 'wasm', entry_point: 'a.wasm' }
  await assertClearError(plugin('future-unreadable', future), /Update Tau/)
})

test('a known version that is really broken is still refused', async () => {
  const { server: _server, ...broken } = nodeManifest('broken')
  await assertClearError(plugin('broken', broken), /Invalid manifest/)
})

// ── The on-disk cache ──────────────────────────────────────────────────────

test('a bundle replaced by one with an older timestamp is picked up', async () => {
  const p = plugin('replaced', nodeManifest('replaced-old'))
  await loadMcpbFile(p.source, p.dir, p.pluginId)
  const before = statSync(p.bundlePath).mtime
  writeFileSync(p.bundlePath, zip({ 'manifest.json': JSON.stringify(nodeManifest('replaced-new')), ...NODE_FILES }))
  const older = new Date(before.getTime() - 3_600_000)
  utimesSync(p.bundlePath, older, older)
  const result = await loadMcpbFile(p.source, p.dir, p.pluginId)
  assert.equal(result.manifest.name, 'replaced-new')
})

test('re-copying a bundle while its program runs does not fail', async () => {
  const holder = readFileSync(isWindows ? join(process.env.SystemRoot, 'System32', 'PING.EXE') : '/bin/sh')
  const name = isWindows ? 'bin/holder.exe' : 'bin/holder'
  const p = plugin('running', nodeManifest('running'), { ...NODE_FILES, [name]: holder })
  const first = await loadMcpbFile(p.source, p.dir, p.pluginId)
  const program = join(first.extractedPath, name)
  if (!isWindows) chmodSync(program, 0o755)
  const child = spawn(program, isWindows ? ['-n', '20', '127.0.0.1'] : ['-c', 'sleep 20'], { stdio: 'ignore' })
  child.on('error', () => {})
  await new Promise(done => setTimeout(done, 700))
  try {
    const later = new Date(Date.now() + 60_000)
    utimesSync(p.bundlePath, later, later)
    const second = await loadMcpbFile(p.source, p.dir, p.pluginId)
    assert.equal(second.extractedPath, first.extractedPath)
  } finally {
    child.kill()
    await new Promise(done => setTimeout(done, 200))
  }
})

// fs.cpSync crashes Node 22.23 on Windows when a path has a non-ASCII character, as this test folder does on purpose.
function copyFolder(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const [source, target] = [join(from, entry.name), join(to, entry.name)]
    if (entry.isDirectory()) {
      copyFolder(source, target)
    } else {
      copyFileSync(source, target)
      const { atime, mtime } = statSync(source)
      utimesSync(target, atime, mtime)
    }
  }
}

test('a plugin folder copied with its cache runs from its own copy', async () => {
  const p = plugin('copied', nodeManifest('copied'))
  await loadMcpbFile(p.source, p.dir, p.pluginId)
  const copy = join(root, 'plugins', 'copied-elsewhere')
  copyFolder(p.dir, copy)
  const result = await loadMcpbFile(p.source, copy, p.pluginId)
  assert.ok(result.extractedPath.startsWith(copy), result.extractedPath)
})

test('metadata naming another OS path still finds the cache', async () => {
  const p = plugin('foreign-metadata', nodeManifest('foreign-metadata'))
  const first = await loadMcpbFile(p.source, p.dir, p.pluginId)
  const metadataPath = metadataPathOf(join(p.dir, '.mcpb-cache'), p.source)
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  metadata.extractedPath = isWindows ? `/home/someone/${first.contentHash}` : `C:\\Users\\someone\\${first.contentHash}`
  writeFileSync(metadataPath, JSON.stringify(metadata))
  const marker = join(first.extractedPath, 'server', 'index.js')
  const before = statSync(marker).mtimeMs
  const result = await loadMcpbFile(p.source, p.dir, p.pluginId)
  assert.equal(result.extractedPath, first.extractedPath)
  assert.equal(statSync(marker).mtimeMs, before)
})

test('files removed from the cache are restored', async () => {
  const p = plugin('repair', nodeManifest('repair'))
  const first = await loadMcpbFile(p.source, p.dir, p.pluginId)
  rmSync(join(first.extractedPath, 'manifest.json'))
  await loadMcpbFile(p.source, p.dir, p.pluginId)
  assert.ok(existsSync(join(first.extractedPath, 'manifest.json')))
  rmSync(join(first.extractedPath, 'server', 'index.js'))
  assert.equal((await loadAndRun(p)).runtime, 'node')
})

test('corrupt metadata and a half-written folder repair themselves', async () => {
  const data = 'x'.repeat(5000)
  const p = plugin('half-written', nodeManifest('half-written'), { ...NODE_FILES, 'data/a.txt': data })
  const first = await loadMcpbFile(p.source, p.dir, p.pluginId)
  writeFileSync(metadataPathOf(join(p.dir, '.mcpb-cache'), p.source), '{ not json')
  rmSync(join(first.extractedPath, 'server', 'index.js'))
  truncateSync(join(first.extractedPath, 'data', 'a.txt'), 100)
  assert.equal((await loadAndRun(p)).runtime, 'node')
  assert.equal(readFileSync(join(first.extractedPath, 'data', 'a.txt'), 'utf8'), data)
})

test('several real sessions can extract the same bundle at once', async () => {
  const files = { ...NODE_FILES }
  for (let i = 0; i < 200; i++) files[`data/f${i}.txt`] = `file ${i} `.repeat(50)
  const p = plugin('concurrent', nodeManifest('concurrent'), files)
  const childSource = `
    import { loadMcpRuntime } from ${JSON.stringify(helperUrl)}
    const { loadMcpbFile } = await loadMcpRuntime({
      paths: ${JSON.stringify(runtimePaths)},
      exports: ['loadMcpbFile'],
    })
    await loadMcpbFile(...JSON.parse(process.env.MCPB_TEST_ARGS))
    process.exit(0)
  `
  const env = { ...process.env, MCPB_TEST_ARGS: JSON.stringify([p.source, p.dir, p.pluginId]) }
  const results = await Promise.all(
    [1, 2, 3].map(
      () =>
        new Promise(done => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], { env, stdio: ['ignore', 'ignore', 'pipe'] })
          let stderr = ''
          child.stderr.on('data', data => {
            stderr += data
          })
          child.on('exit', code => done({ code, stderr }))
        }),
    ),
  )
  if (!exitMayCrash) {
    for (const { code, stderr } of results) assert.equal(code, 0, stderr.slice(0, 500))
  }
  const result = await loadMcpbFile(p.source, p.dir, p.pluginId)
  for (const [name, text] of Object.entries(files)) {
    assert.equal(readFileSync(join(result.extractedPath, name), 'utf8'), text, name)
  }
  assert.ok(!walk(result.extractedPath).some(file => file.endsWith('.tmp')), 'temporary files left behind')
})

test('extracted files match the bundle byte for byte', async () => {
  const binary = {
    'data/latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    'data/bom.json': Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    'data/binary.js': Buffer.from([0xff, 0xfe, 0x00, 0x41]),
  }
  const p = plugin('bytes', nodeManifest('bytes'), { ...NODE_FILES, ...binary })
  const result = await loadMcpbFile(p.source, p.dir, p.pluginId)
  for (const [name, data] of Object.entries(binary)) {
    assert.equal(Buffer.compare(readFileSync(join(result.extractedPath, name)), data), 0, name)
  }
})

test('a zip with backslash paths extracts into real folders', async () => {
  const p = plugin('backslashes', nodeManifest('backslashes'), { 'server\\index.js': NODE_SERVER })
  assert.equal((await loadAndRun(p)).runtime, 'node')
})

test('a backslash entry point stays cached on every OS', async () => {
  const manifest = nodeManifest('backslash-entry')
  manifest.server.entry_point = 'server\\index.js'
  const p = plugin('backslash-entry', manifest, { ...NODE_FILES, 'extra.txt': 'original' })
  const first = await loadMcpbFile(p.source, p.dir, p.pluginId)
  // Extracting again would put this back, so it shows whether the cache was used.
  const extra = join(first.extractedPath, 'extra.txt')
  writeFileSync(extra, 'changed in the cache')
  await loadMcpbFile(p.source, p.dir, p.pluginId)
  assert.equal(readFileSync(extra, 'utf8'), 'changed in the cache')
})

test('a zip entry climbing out with backslashes or slashes is refused', async () => {
  for (const name of ['a\\..\\..\\..\\escaped.txt', '..\\escaped.txt', 'a/../../../escaped.txt']) {
    const p = plugin(`climb-${name.length}`, nodeManifest('climb'), { [name]: 'escaped' })
    await assert.rejects(loadMcpbFile(p.source, p.dir, p.pluginId), /Unsafe file path/)
    assert.equal(existsSync(join(p.dir, 'escaped.txt')), false)
    assert.equal(existsSync(join(p.dir, '.mcpb-cache', 'escaped.txt')), false)
  }
})

test('the cache format stays readable by other clients sharing the folder', async () => {
  const p = plugin('shared-write', nodeManifest('shared-write'))
  await loadMcpbFile(p.source, p.dir, p.pluginId)
  const metadata = JSON.parse(readFileSync(metadataPathOf(join(p.dir, '.mcpb-cache'), p.source), 'utf8'))
  for (const field of ['source', 'contentHash', 'extractedPath', 'cachedAt', 'lastChecked', 'sourceMtimeMs']) {
    assert.ok(metadata[field] !== undefined, `missing ${field}`)
  }
})

test('a cache written by another client is reused without rewriting files', async () => {
  const p = plugin('shared-read', nodeManifest('shared-read'))
  const first = await loadMcpbFile(p.source, p.dir, p.pluginId)
  const stamp = new Date().toISOString()
  writeFileSync(
    metadataPathOf(join(p.dir, '.mcpb-cache'), p.source),
    JSON.stringify({
      source: p.source,
      contentHash: first.contentHash,
      extractedPath: first.extractedPath,
      cachedAt: stamp,
      lastChecked: stamp,
      sourceMtimeMs: Math.floor(statSync(p.bundlePath).mtimeMs),
    }),
  )
  const marker = join(first.extractedPath, 'server', 'index.js')
  const before = statSync(marker).mtimeMs
  await new Promise(done => setTimeout(done, 30))
  await loadMcpbFile(p.source, p.dir, p.pluginId)
  assert.equal(statSync(marker).mtimeMs, before)
})

test('a URL bundle downloads once and keeps working offline', async () => {
  const bytes = zip({ 'manifest.json': JSON.stringify(nodeManifest('from-url')), ...NODE_FILES })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
    response.end(bytes)
  }).listen(0, '127.0.0.1')
  await new Promise(done => server.once('listening', done))
  const url = `http://127.0.0.1:${server.address().port}/from-url.mcpb`
  const dir = join(root, 'plugins', 'from-url')
  mkdirSync(dir, { recursive: true })
  const p = { id: 'from-url', dir, source: url, pluginId: 'from-url@test' }
  try {
    await loadAndRun(p)
  } finally {
    server.close()
    server.closeAllConnections()
  }
  assert.equal((await loadAndRun(p)).env.ECHO_TAG, 'from-url')
})

test('secrets stay out of the cache and new settings apply without extracting', async () => {
  const manifest = nodeManifest('secret-cache', {
    user_config: {
      conn: { type: 'string', title: 'Conn', description: 'Conn', required: true, sensitive: true },
    },
  }, { env: { CONN_STR: '${user_config.conn}' } })
  const p = plugin('secret-cache', manifest)
  const first = await loadMcpbFile(p.source, p.dir, p.pluginId, undefined, { conn: 'secret-one-abc' })
  for (const file of walk(join(p.dir, '.mcpb-cache'))) {
    assert.ok(!readFileSync(file, 'latin1').includes('secret-one-abc'), `secret written to ${file}`)
  }
  const marker = join(first.extractedPath, 'server', 'index.js')
  const before = statSync(marker).mtimeMs
  const second = await loadMcpbFile(p.source, p.dir, p.pluginId, undefined, { conn: 'secret-two-xyz' })
  assert.equal(second.mcpConfig.env.CONN_STR, 'secret-two-xyz')
  assert.equal(statSync(marker).mtimeMs, before)
})

test('a read-only plugin folder falls back to the plugin data folder', { skip: (isWindows || process.getuid?.() === 0) && 'needs POSIX permissions' }, async () => {
  const p = plugin('read-only', nodeManifest('read-only'))
  chmodSync(p.dir, 0o555)
  try {
    const result = await loadAndRun(p)
    assert.ok(!result.file.startsWith(p.dir), result.file)
  } finally {
    chmodSync(p.dir, 0o755)
  }
})

// ── Stability: the server's config hash decides whether it reconnects ──────

test('every load gives the same config, so a reload does not reconnect', { skip: !pythonInstalled && noPython }, async () => {
  const p = plugin('stable', pythonManifest('stable', 'python3'), PYTHON_FILES)
  const first = await pipeline(p)
  const second = await pipeline(p)
  assert.ok(first.config)
  assert.equal(JSON.stringify(first.config), JSON.stringify(second.config))
})
