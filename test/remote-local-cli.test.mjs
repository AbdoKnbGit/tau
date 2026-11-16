// Run after `node build.mjs`: node --test test/remote-local-cli.test.mjs
// `tau --remote-local` in a real terminal, with a WebSocket client playing the
// phone page (it sends the Origin header a browser would):
//  - without the flag nothing listens, and --print refuses the flag;
//  - with it, the listener starts with the session and a phone remembered
//    earlier signs in with no QR code, while unknown phones and stale links
//    are told why they cannot;
//  - a new phone pairs through /remote local, is remembered with Y, and
//    /remote devices forgets it again, signing it out at once.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import xterm from '@xterm/headless'
import { WebSocket } from 'ws'
import { replStartupReady } from './helpers/repl-startup.mjs'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const execute = promisify(execFile)
const PTY_MISSING = 77
const cli = resolve(process.env.PROBE_CLI ?? 'dist/cli.mjs')
// Must match PROOF_CONTEXT in src/services/remote/pageCrypto.ts.
const PROOF_CONTEXT = 'tau-remote-auth|'
const pause = ms => new Promise(done => setTimeout(done, ms))
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }

// node-pty is optional, and npm ships its macOS helper without the execute bit.
async function loadPty() {
  let pty
  try {
    const loaded = await import('node-pty')
    pty = loaded.default ?? loaded
  } catch { process.exit(PTY_MISSING) }
  if (process.platform === 'darwin') {
    const helper = join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
  return pty
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createNetServer()
    server.once('error', fail)
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

// The phone page, minus the page.
function phone(port, query, origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { Origin: origin } })
  const messages = []
  let closedWith
  ws.on('message', raw => messages.push(JSON.parse(String(raw))))
  ws.on('close', code => { closedWith = code })
  ws.on('error', () => {})
  return {
    ws,
    got: type => messages.find(message => message.t === type),
    closed: () => closedWith,
    send: message => ws.send(JSON.stringify(message)),
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'tau remote local '))
  const project = join(root, 'project'), config = join(root, 'config')
  const key = 'sk-ant-local-remote-' + 'x'.repeat(24)
  mkdirSync(project)
  write(join(config, '.claude.json'), { theme: 'dark', hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty',
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } })
  return { root, project, config, key }
}

function sealedEnv({ config, root, key }, modelPort, remotePort) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_)/i.test(name)))
  return Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'), TAU_SKIP_PREFLIGHT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`, NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false',
    // Loopback keeps the test off the real network; a fixed port keeps the
    // origin a remembered phone was paired on.
    TAU_REMOTE_HOST: '127.0.0.1', TAU_REMOTE_PORT: String(remotePort) })
}

async function scenario(pty, name) {
  const box = sandbox()
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const devicesFile = join(box.config, 'remote', 'devices.json')
  const seeded = { id: randomBytes(16).toString('hex'), key: randomBytes(32).toString('hex'), name: 'Seeded Phone', origin, pairedAt: new Date().toISOString() }
  if (name !== 'pair') write(devicesFile, { version: 1, devices: [seeded] })

  const model = createServer(async (request, response) => {
    if (request.method === 'HEAD') return response.end()
    if (!request.url.includes('/messages') || request.url.includes('count_tokens')) return response.end('{"input_tokens":1}')
    let raw = ''
    for await (const part of request) raw += part
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply('ok', JSON.parse(raw).model))
  })
  await new Promise(done => model.listen(0, '127.0.0.1', done))
  const env = sealedEnv(box, model.address().port, port)
  const args = ['--setting-sources', 'project', '--strict-mcp-config', '--model', 'claude-sonnet-4-6', '--tools', 'Read', ...(name === 'off' ? [] : ['--remote-local'])]

  const display = new xterm.Terminal({ cols: 160, rows: 50, allowProposedApi: true })
  const screen = () => Array.from({ length: display.rows }, (_, i) =>
    display.buffer.active.getLine(display.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n')
  const squeezed = () => screen().replace(/\s+/g, '')
  let term, raw = '', exited = false
  async function until(check, label, ms = 30_000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await check()) return
      await pause(100)
    }
    throw new Error(`timed out waiting for ${label}\nScreen:\n${screen()}`)
  }
  const listening = () => fetch(`${origin}/`).then(r => r.status === 200, () => false)
  const submit = async text => { term.write(text); await pause(350); term.write('\r') }
  const answer = (p, device) => {
    const { nonce } = p.got('challenge')
    p.send({ t: 'auth', proof: createHmac('sha256', Buffer.from(device.key, 'hex')).update(PROOF_CONTEXT + nonce).digest('hex') })
  }

  try {
    term = pty.spawn(process.execPath, [cli, ...args], { name: 'xterm-256color', cols: 160, rows: 50, cwd: box.project, env })
    term.onData(data => { raw += data; display.write(data) })
    term.onExit(() => { exited = true })
    const ready = replStartupReady(term)
    await until(() => ready(raw), 'REPL')
    await pause(2000)

    if (name === 'off') {
      await pause(3000)
      assert.equal(await listening(), false, 'no listener without --remote-local')
    }

    if (name === 'remembered') {
      await until(listening, 'the listener --remote-local starts')
      await until(() => squeezed().includes('Remotelocalon'), 'startup notice')
      const p = phone(port, `d=${seeded.id}`, origin)
      await until(() => p.got('challenge'), 'challenge')
      answer(p, seeded)
      await until(() => p.got('hello'), 'remembered phone signed in')
      assert.ok(String(p.got('hello').cwd).endsWith('project'), `the session's own folder: ${p.got('hello').cwd}`)
      await until(() => squeezed().includes('1deviceconnected'), 'footer counts the phone')
      const stranger = phone(port, `d=${randomBytes(16).toString('hex')}`, origin)
      await until(() => stranger.closed() === 4004, 'unknown phone refused')
      const stale = phone(port, 't=from-an-earlier-session', origin)
      await until(() => stale.closed() === 4003, 'stale link refused')
      // The address straight into "/ ·": no #token in a line the model reads.
      await submit('/remote status')
      await until(() => squeezed().includes(`remote:local·http://127.0.0.1:${port}/·1device(s)·1rememberedphone`), '/remote status')
      assert.ok(!/127\.0\.0\.1:\d+\/#/.test(screen()), '/remote status keeps the session token out of the transcript')
      await pause(800)
    }

    if (name === 'pair') {
      await until(listening, 'the listener --remote-local starts')
      await submit('/remote local')
      let token
      await until(() => (token = screen().match(new RegExp(`127\\.0\\.0\\.1:${port}/#([A-Za-z0-9_-]{43})`))?.[1]), 'scan link in the dialog')
      const p = phone(port, `t=${token}&n=${encodeURIComponent('Test Phone')}`, origin)
      await until(() => p.got('hello'), 'phone in by the link')
      await until(() => screen().includes('Remember this phone?'), 'asked to remember it')
      term.write('y')
      await until(() => p.got('trusted'), 'key sent to the phone')
      const trusted = p.got('trusted')
      p.send({ t: 'trust-saved', id: trusted.id })
      const onDisk = () => existsSync(devicesFile) ? JSON.parse(readFileSync(devicesFile, 'utf8')).devices : []
      await until(() => onDisk().some(d => d.id === trusted.id && d.name === 'Test Phone' && d.origin === origin), 'remembered on disk')
      await until(() => squeezed().includes('TestPhoneremembered'), 'confirmed in the terminal')
      await pause(1500)
      await submit('/remote devices')
      await until(() => screen().includes('remembered phones') && screen().includes('Test Phone'), '/remote devices')
      term.write('\r')
      await until(() => screen().includes('Forget Test Phone?'), 'asked to confirm')
      term.write('y')
      await until(() => p.closed() === 4006, 'phone signed out at once')
      await until(() => onDisk().length === 0, 'forgotten on disk')
      term.write('\x1b')
      await until(() => !screen().includes('remembered phones'), 'dialog closed')
      await pause(800)
    }

    await submit('/exit')
    await until(() => exited, 'exit', 20_000)
    term = undefined
    if (name !== 'off') assert.equal(await listening(), false, 'the listener ends with the session')
  } finally {
    if (term) { term.kill(); await pause(500) }
    model.closeAllConnections()
    await new Promise(done => model.close(done))
    rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

// ConPTY keeps native handles alive after its terminal exits, so the terminal gets
// its own process and the test worker can finish.
const probe = process.argv.indexOf('--interactive-probe')
if (probe !== -1) {
  const pty = await loadPty()
  try { await scenario(pty, process.argv[probe + 1]); process.exit(0) }
  catch (error) { process.stderr.write(String(error.stack ?? error) + '\n', () => process.exit(1)) }
} else {
  test('--remote-local refuses --print, which has no session to serve', async () => {
    const box = sandbox()
    try {
      const env = sealedEnv(box, 9, await freePort())
      const result = await execute(process.execPath, [cli, '--remote-local', '-p', 'hi'], { cwd: box.project, env, timeout: 60_000, windowsHide: true })
        .then(() => ({ code: 0, stderr: '' }), error => ({ code: error.code, stderr: String(error.stderr) }))
      assert.equal(result.code, 1)
      assert.match(result.stderr, /--remote-local needs an interactive session/)
    } finally {
      rmSync(box.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })

  const scenarios = {
    off: 'without --remote-local, nothing listens for phones',
    remembered: '--remote-local lets a remembered phone in with no QR code, and nobody else',
    pair: 'a new phone pairs through /remote local, is remembered with Y, and /remote devices forgets it',
  }
  for (const [name, title] of Object.entries(scenarios)) {
    test(title, { timeout: 240_000 }, async t => {
      try {
        await execute(process.execPath, [fileURLToPath(import.meta.url), '--interactive-probe', name], { env: process.env, timeout: 230_000, windowsHide: true })
      } catch (error) {
        if (error.code !== PTY_MISSING) throw error
        t.skip('node-pty is not installed')
      }
    })
  }
}
