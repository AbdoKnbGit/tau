// Run after `node build.mjs`. Real interactive sessions on a stub Ollama server:
// on a model on this machine Tau loads the session's prompt into the model while
// the user types (src/utils/model/localModelPreload.ts), and the first message
// then carries the same prompt. -p never preloads, so only the REPL shows this.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { stripVTControlCharacters } from 'node:util'

const execute = promisify(execFile)
const PTY_MISSING = 77
const cli = resolve(process.env.PROBE_CLI ?? 'dist/cli.mjs')
const pause = ms => new Promise(done => setTimeout(done, ms))
async function waitFor(check, label, ms = 90_000, details = () => '') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await pause(100) }
  throw new Error(`timed out waiting for ${label}\n${details()}`)
}

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

// A stub Ollama: every model on it can chat, use tools and think, and is
// loaded with a 32K context; each chat answers "ok".
async function startOllama() {
  const chats = []
  const seen = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    seen.push(`${request.method} ${request.url}`)
    const body = raw ? JSON.parse(raw) : {}
    const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (request.url === '/api/tags') return json({ models: [] })
    if (request.url === '/api/show') return json({ model_info: { 'qwen3.context_length': 40_960 }, capabilities: ['completion', 'tools', 'thinking'] })
    if (request.url === '/api/ps') return json({ models: [{ name: body.model ?? 'stub-model:4b', model: body.model ?? 'stub-model:4b', context_length: 32_768, size: 1, size_vram: 1 }] })
    if (request.url === '/api/generate') return json({ done: true, done_reason: 'load' })
    if (request.url === '/api/chat') {
      chats.push(body)
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end([
        { model: body.model, message: { role: 'assistant', content: 'ok' }, done: false },
        { model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 9000, eval_count: 1 },
      ].map(line => JSON.stringify(line)).join('\n') + '\n')
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { chats, seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) }
}

async function session(pty, { model, env: extra = {} }, script) {
  const ollama = await startOllama()
  // The real path: a temp folder behind a symlink (macOS's /var) would start
  // Tau with a second working directory, as it does for any symlinked folder.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau local preload ')))
  const project = join(root, 'project'), config = join(root, 'config')
  mkdirSync(project)
  mkdirSync(config)
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0',
    activeProvider: 'ollama', ollamaCloudModelsPrimedAt: 1, projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  // As the other local-model CLI tests do: a user's session, so no CI (which
  // makes Tau ask for an Anthropic key at startup) and no provider settings
  // from the machine running the test.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|OLLAMA|LMSTUDIO|LM_STUDIO|DEEPSEEK|CI$|ENABLE_TOOL_SEARCH|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(name)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'), TAU_SKIP_PREFLIGHT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NO_PROXY: '127.0.0.1,localhost',
    // Every Ollama address is the stub's: nothing depends on an Ollama installed on the machine.
    OLLAMA_HOST: ollama.url, OLLAMA_BASE_URL: `${ollama.url}/v1`, PWD: project, ...extra })
  let term
  try {
    let raw = '', handled = 0, exited = false, declinedBash = false, trusted = false
    term = pty.spawn(process.execPath, [cli, '--setting-sources', 'project', '--strict-mcp-config', '--tools', 'Read', '--model', model],
      { name: 'xterm-256color', cols: 130, rows: 45, cwd: project, env })
    term.onData(value => { raw += value })
    term.onExit(() => { exited = true })
    const details = () => JSON.stringify({ exited, ollama: ollama.seen, screen: stripVTControlCharacters(raw).slice(-2500) }, null, 1)
    await waitFor(() => {
      const screen = stripVTControlCharacters(raw.slice(handled)).replace(/\s+/g, '')
      if (!declinedBash && screen.includes('SetupbashforTau') && screen.includes('No,skipandcontinue')) {
        declinedBash = true; handled = raw.length; term.write('\x1b'); return false
      }
      if (!trusted && screen.includes('Yes,Itrustthisfolder')) {
        trusted = true; handled = raw.length; term.write('\r'); return false
      }
      return /Ollama|stub-model/.test(stripVTControlCharacters(raw).replace(/\s+/g, ''))
    }, 'the REPL', 150_000, details)
    const ask = async text => { term.write(text); await pause(350); term.write('\r') }
    await script({ chats: ollama.chats, ask, details })
    term.write('/exit')
    await pause(350)
    term.write('\r')
    await waitFor(() => exited, 'exit', 20_000)
    term = undefined
  } finally {
    if (term) { term.kill(); await pause(500) }
    await ollama.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const cases = {
  async preload(pty) {
    await session(pty, { model: 'stub-model:4b' }, async ({ chats, ask, details }) => {
      await waitFor(() => chats.length >= 1, 'the preload', 90_000, details)
      await pause(1500)
      assert.equal(chats.length, 1, 'one preload, and nothing after it: no retry, no hook, no tool')
      const [early] = chats
      assert.equal(early.options.num_predict, 1)
      await ask('What is 17 + 25?')
      await waitFor(() => chats.length >= 2, 'the first message', 90_000, details)
      const first = chats[1]
      assert.ok(first.options.num_predict > 1)
      assert.equal(first.options.num_ctx, early.options.num_ctx, 'the same context, so the model is not reloaded')
      assert.deepEqual(first.tools, early.tools, 'the same tools')
      assert.equal(first.keep_alive, early.keep_alive)
      // Everything before the newest message is the same; the newest is the
      // session context with a placeholder in the preload, and the user's own
      // message, with what Tau attaches to it, in the first request.
      assert.equal(first.messages.length, early.messages.length)
      // Where a message differs, show that spot in both: a long prompt's
      // diff otherwise hides it past the shown characters.
      const text = message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      const differences = early.messages.slice(0, -1).flatMap((message, index) => {
        const a = text(message), b = text(first.messages[index])
        if (a === b) return []
        let at = 0
        while (at < a.length && at < b.length && a[at] === b[at]) at++
        return [`message ${index} (${message.role}) differs at ${at} of ${a.length} / ${b.length}\n  preload: ${JSON.stringify(a.slice(Math.max(0, at - 150), at + 300))}\n  first:   ${JSON.stringify(b.slice(Math.max(0, at - 150), at + 300))}`]
      })
      assert.deepEqual(differences, [], `the same messages up to the newest\n${differences.join('\n')}`)
      assert.match(early.messages.at(-1).content, /following context[\s\S]*\.$/)
      assert.match(first.messages.at(-1).content, /What is 17 \+ 25\?/)
      await pause(1500)
      assert.equal(chats.length, 2)
    })
  },
  async off(pty) {
    await session(pty, { model: 'stub-model:4b', env: { TAU_LOCAL_PRELOAD: '0' } }, async ({ chats, ask, details }) => {
      await pause(6000)
      assert.equal(chats.length, 0)
      await ask('What is 17 + 25?')
      await waitFor(() => chats.length >= 1, 'the first message', 90_000, details)
      assert.ok(chats[0].options.num_predict > 1)
    })
  },
  async cloud(pty) {
    await session(pty, { model: 'stub-model:cloud' }, async ({ chats, ask, details }) => {
      await pause(6000)
      assert.equal(chats.length, 0)
      await ask('What is 17 + 25?')
      await waitFor(() => chats.length >= 1, 'the first message', 90_000, details)
    })
  },
}

// ConPTY keeps native handles alive after its terminal exits, so each terminal
// gets its own process and the test worker can finish.
const probe = process.argv.indexOf('--interactive-probe')
if (probe !== -1) {
  const pty = await loadPty()
  try { await cases[process.argv[probe + 1]](pty); process.exit(0) }
  catch (error) { process.stderr.write(String(error.stack ?? error) + '\n', () => process.exit(1)) }
} else {
  const titles = {
    preload: 'a model on this machine gets the prompt while the user types, and the first message carries the same prompt',
    off: 'TAU_LOCAL_PRELOAD=0 sends nothing before the first message',
    cloud: 'a cloud model is never preloaded',
  }
  for (const [name, title] of Object.entries(titles)) {
    test(title, { timeout: 300_000 }, async t => {
      try {
        await execute(process.execPath, [fileURLToPath(import.meta.url), '--interactive-probe', name], { env: process.env, timeout: 290_000, windowsHide: true })
      } catch (error) {
        if (error.code !== PTY_MISSING) throw error
        t.skip('node-pty is not installed')
      }
    })
  }
}
