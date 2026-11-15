// MCP servers across a reload: /clear, /branch, an SDK plugin reload. The
// request sent right after a reload must still carry the servers' tools, a
// server must only restart when its settings changed, and a replaced server's
// process must be closed. Real CLI, real stdio servers, a local provider.
// Run `node build.mjs` first.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'
import { replStartupReady } from './helpers/repl-startup.mjs'

const execute = promisify(execFile)
const cli = resolve(process.env.PROBE_CLI ?? 'dist/cli.mjs')
const fixture = resolve('test/fixtures/slow-mcp-server.mjs')
const pause = ms => new Promise(done => setTimeout(done, ms))
const PTY_MISSING = 77
// Long enough that a request sent while the server restarts goes out first.
const CONNECT_DELAY_MS = '1500'

const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
async function waitFor(check, label, milliseconds, details) {
  const until = Date.now() + milliseconds
  while (Date.now() < until) {
    if (check()) return
    await pause(40)
  }
  throw new Error(`Timed out waiting for ${label}\n${details()}`)
}
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// node-pty is optional, and npm ships its macOS helper without the execute bit.
async function loadPty() {
  let pty
  try {
    const loaded = await import('node-pty')
    pty = loaded.default ?? loaded
  } catch {
    process.exit(PTY_MISSING)
  }
  if (process.platform === 'darwin') {
    const helper = join(
      dirname(createRequire(import.meta.url).resolve('node-pty/package.json')),
      'prebuilds',
      `darwin-${process.arch}`,
      'spawn-helper',
    )
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
  return pty
}

// A sealed config, a project and a fake Anthropic API that records requests.
// Every server process logs `start <marker> <pid>` when it starts.
async function setup(name) {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), `tau mcp reload ${name} `)))
  const project = join(root, 'project'), config = join(root, 'config')
  const lifecycle = join(root, 'servers.log')
  const key = 'sk-ant-reload-fixture-' + 'x'.repeat(24)
  mkdirSync(project, { recursive: true })
  write(lifecycle, '')
  const wrapper = join(root, 'server-wrapper.mjs')
  write(wrapper, [
    "import { appendFileSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    'const [log, marker, server] = process.argv.slice(2)',
    'appendFileSync(log, `start ${marker} ${process.pid}\\n`)',
    'await import(pathToFileURL(server).href)',
  ].join('\n'))
  const serverConfig = marker => ({
    command: process.execPath,
    args: [wrapper, lifecycle, marker, fixture],
    env: { FIXTURE_NAME: 'probe', FIXTURE_TOOL_COUNT: '2', FIXTURE_CONNECT_DELAY_MS: CONNECT_DELAY_MS },
  })
  write(join(project, '.claude', 'settings.json'), {
    promptSuggestionEnabled: false,
    enableAllProjectMcpServers: true,
    cleanupPeriodDays: 30,
  })
  write(join(config, '.claude.json'), {
    theme: 'dark',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    activeProvider: 'firstParty',
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  })
  const requests = [], failures = []
  let step = 'start'
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'HEAD') return response.end()
      if (!request.url.includes('/messages') || request.url.includes('count_tokens'))
        return response.end('{"input_tokens":1}')
      let raw = ''
      for await (const part of request) raw += part
      const body = JSON.parse(raw)
      const main = (body.tools ?? []).length > 0
      requests.push({ step, main, at: Date.now(), tools: (body.tools ?? []).map(tool => tool.name) })
      const value = main ? 'done' : JSON.stringify({ title: 'Reload fixture', name: 'reload-fixture' })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(anthropicReply(value, body.model))
    } catch (error) {
      failures.push(String(error.stack ?? error))
      response.writeHead(500)
      response.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([n]) => !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH)/i.test(n)),
  )
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: config,
    TAU_SKIP_PREFLIGHT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost',
    ENABLE_TOOL_SEARCH: 'false',
    DISABLE_AUTO_COMPACT: '1',
    // A request held past this would time the test out instead of passing late.
    TAU_MCP_LAUNCH_WAIT_MS: '60000',
  })
  const starts = () => readFileSync(lifecycle, 'utf8').split('\n').filter(Boolean)
    .map(line => line.split(' ')).map(([, marker, pid]) => ({ marker, pid: Number(pid) }))
  const pidOf = marker => starts().find(s => s.marker === marker)?.pid
  return {
    root, project, config, env, requests, failures, starts, pidOf, serverConfig,
    setStep: value => { step = value },
    close: async () => {
      for (const { pid } of starts()) if (alive(pid)) try { process.kill(pid) } catch {}
      server.close()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
    },
  }
}

// A plugin installed from a local marketplace with a "./" source, the way most
// community plugins are installed, that runs the probe server.
function installMarketplacePlugin(lab) {
  const marketplace = join(lab.config, 'plugins', 'marketplaces', 'reload-lab')
  const installed = join(lab.config, 'plugins', 'cache', 'reload-lab', 'reload-probe', '1.0.0')
  write(join(marketplace, '.claude-plugin', 'marketplace.json'), {
    name: 'reload-lab', owner: { name: 'lab' },
    plugins: [{ name: 'reload-probe', source: './', description: 'Probe server' }],
  })
  write(join(marketplace, '.claude-plugin', 'plugin.json'), {
    name: 'reload-probe', version: '1.0.0', description: 'Probe server',
    mcpServers: { probe: lab.serverConfig('plugin') },
  })
  cpSync(marketplace, installed, { recursive: true })
  const now = new Date().toISOString()
  write(join(lab.config, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'reload-probe@reload-lab': [{ scope: 'user', installPath: installed, version: '1.0.0', installedAt: now, lastUpdated: now }] },
  })
  write(join(lab.config, 'plugins', 'known_marketplaces.json'), {
    'reload-lab': { source: { source: 'directory', path: marketplace }, installLocation: marketplace, lastUpdated: now },
  })
  write(join(lab.config, 'settings.json'), {
    enabledPlugins: { 'reload-probe@reload-lab': true },
    extraKnownMarketplaces: { 'reload-lab': { source: { source: 'directory', path: marketplace } } },
  })
}

const probeTools = request => request.tools.filter(name => name.startsWith('mcp__') && name.includes('probe'))

async function interactive(pty, lab, scenario) {
  let raw = '', exited = false
  const details = () => JSON.stringify({
    failures: lab.failures,
    requests: lab.requests.map(r => ({ step: r.step, main: r.main, probe: probeTools(r) })),
    servers: lab.starts().map(s => ({ ...s, alive: alive(s.pid) })),
    screen: stripVTControlCharacters(raw).slice(-2500),
  }, null, 1)
  const term = pty.spawn(process.execPath, [cli, '--model', 'claude-sonnet-4-6'],
    { name: 'xterm-256color', cols: 140, rows: 45, cwd: lab.project, env: lab.env })
  term.onData(value => { raw += value })
  term.onExit(() => { exited = true })
  const submit = async text => { term.write(text); await pause(300); term.write('\r') }
  const mainAfter = step => lab.requests.filter(r => r.main && r.step === step)
  try {
    const ready = replStartupReady(term)
    await waitFor(() => ready(raw), 'REPL startup', 60_000, details)
    await pause(1500)
    lab.setStep('first')
    await submit('Reply with the single word done.')
    await waitFor(() => mainAfter('first').length > 0, 'the first request', 60_000, details)
    await pause(1500)
    await scenario({ submit, mainAfter, details })
  } finally {
    term.write('\x1b')
    await pause(200)
    await submit('/exit').catch(() => {})
    const until = Date.now() + 15_000
    while (!exited && Date.now() < until) await pause(100)
    if (!exited) term.kill()
  }
}

// Each case drives a real terminal; it runs in its own process (see below).
const cases = {
  async plugin(pty) {
    const lab = await setup('plugin')
    try {
      installMarketplacePlugin(lab)
      await interactive(pty, lab, async ({ submit, mainAfter, details }) => {
        assert.equal(probeTools(mainAfter('first')[0]).length, 2, `the plugin's tools before /clear\n${details()}`)
        lab.setStep('after clear')
        await submit('/clear')
        await pause(300)
        const sent = Date.now()
        await submit('Reply with the single word done.')
        await waitFor(() => mainAfter('after clear').length > 0, 'the request after /clear', 60_000, details)
        assert.equal(probeTools(mainAfter('after clear')[0]).length, 2, `the first request after /clear lists the plugin's tools\n${details()}`)
        // A kept server is published again at once: the request is not held
        // until the wait's deadline.
        assert.ok(mainAfter('after clear')[0].at - sent < 20_000, `the request after /clear was not held\n${details()}`)
        assert.deepEqual(lab.starts().map(s => s.marker), ['plugin'], `the plugin's server ran once, from one root\n${details()}`)
      })
    } finally {
      await lab.close()
    }
  },
  clear: pty => changedConfigCase(pty, '/clear'),
  branch: pty => changedConfigCase(pty, '/branch'),
}

async function changedConfigCase(pty, command) {
  const lab = await setup(command.slice(1))
  try {
    write(join(lab.project, '.mcp.json'), { mcpServers: { probe: lab.serverConfig('old') } })
    await interactive(pty, lab, async ({ submit, mainAfter, details }) => {
      assert.equal(probeTools(mainAfter('first')[0]).length, 2, `tools before the change\n${details()}`)
      const old = lab.pidOf('old')
      assert.ok(old && alive(old), `the first server runs\n${details()}`)
      write(join(lab.project, '.mcp.json'), { mcpServers: { probe: lab.serverConfig('new') } })
      await pause(300)
      lab.setStep('after')
      await submit(command)
      await pause(300)
      await submit('Reply with the single word done.')
      await waitFor(() => mainAfter('after').length > 0, `the request after ${command}`, 60_000, details)
      assert.equal(probeTools(mainAfter('after')[0]).length, 2, `the first request after ${command} waited for the restarted server\n${details()}`)
      await waitFor(() => !alive(old), 'the replaced server to exit', 15_000, details)
      assert.deepEqual(lab.starts().map(s => s.marker), ['old', 'new'], details())
    })
  } finally {
    await lab.close()
  }
}

const probe = process.argv.indexOf('--reload-probe')
if (probe !== -1) {
  // ConPTY keeps native handles alive after its terminal exits, so the
  // terminal gets its own process and the test worker can finish.
  const pty = await loadPty()
  try {
    await cases[process.argv[probe + 1]](pty)
    process.exit(0)
  } catch (error) {
    process.stderr.write(String(error.stack ?? error) + '\n', () => process.exit(1))
  }
} else {
  const names = {
    plugin: 'an installed marketplace plugin keeps its server and tools across /clear',
    clear: 'after /clear, a server whose settings changed is waited for and its old process closed',
    branch: 'after /branch, a server whose settings changed is waited for and its old process closed',
  }
  for (const [key, name] of Object.entries(names)) {
    test(name, { timeout: 200_000 }, async t => {
      try {
        await execute(process.execPath, [fileURLToPath(import.meta.url), '--reload-probe', key],
          { env: process.env, timeout: 190_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      } catch (error) {
        if (error.code !== PTY_MISSING) throw error
        t.skip('node-pty is not installed')
      }
    })
  }

  test('an SDK plugin reload that replaces a startup server closes the old process', { timeout: 180_000 }, async t => {
    const lab = await setup('sdk')
    t.after(lab.close)
    write(join(lab.project, '.mcp.json'), { mcpServers: { probe: lab.serverConfig('old') } })
    const child = spawn(process.execPath, [cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--model', 'claude-sonnet-4-6'], { cwd: lab.project, env: lab.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    const lines = []
    child.stdout.on('data', d => {
      out += d
      let nl
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        try { lines.push(JSON.parse(line)) } catch {}
      }
    })
    child.stderr.on('data', d => { err += d })
    const details = () => JSON.stringify({
      requests: lab.requests.map(r => ({ step: r.step, main: r.main, probe: probeTools(r) })),
      servers: lab.starts().map(s => ({ ...s, alive: alive(s.pid) })),
      stderr: err.slice(-1500),
    }, null, 1)
    const send = value => child.stdin.write(JSON.stringify(value) + '\n')
    const results = () => lines.filter(l => l.type === 'result').length
    try {
      lab.setStep('first')
      send({ type: 'user', message: { role: 'user', content: 'Reply with the single word done.' } })
      await waitFor(() => results() >= 1, 'the first result', 60_000, details)
      const old = lab.pidOf('old')
      assert.ok(old && alive(old), `the startup server runs\n${details()}`)
      write(join(lab.project, '.mcp.json'), { mcpServers: { probe: lab.serverConfig('new') } })
      send({ type: 'control_request', request_id: 'reload-1', request: { subtype: 'reload_plugins' } })
      await waitFor(() => lines.some(l => l.type === 'control_response'), 'the reload response', 60_000, details)
      lab.setStep('after')
      send({ type: 'user', message: { role: 'user', content: 'Reply with the single word done.' } })
      await waitFor(() => results() >= 2, 'the second result', 60_000, details)
      const after = lab.requests.filter(r => r.main && r.step === 'after')
      assert.equal(probeTools(after[0]).length, 2, `the request after the reload lists the server's tools\n${details()}`)
      await waitFor(() => !alive(old), 'the replaced startup server to exit', 15_000, details)
      assert.deepEqual(lab.starts().map(s => s.marker), ['old', 'new'], details())
    } finally {
      child.stdin.end()
      await pause(1000)
      child.kill()
    }
  })
}
