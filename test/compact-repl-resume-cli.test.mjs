// Run after `node build.mjs`. Real interactive session, instant stub provider. The
// answer arrives while the compaction rows are still being saved, and resume must
// follow the new chain. -p cannot show this: only the REPL writes through useLogMessages.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'
import { replStartupReady } from './helpers/repl-startup.mjs'

const execute = promisify(execFile)
const PTY_MISSING = 77
const cli = resolve(process.env.PROBE_CLI ?? 'dist/cli.mjs')
const pause = ms => new Promise(done => setTimeout(done, ms))
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
async function waitFor(check, label, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await pause(100) }
  throw new Error('timed out waiting for ' + label)
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

async function checkResume(pty, mode) {
  const root = mkdtempSync(join(tmpdir(), 'tau repl resume '))
  const project = join(root, 'project'), config = join(root, 'config'), plugin = join(root, 'plugin')
  const session = randomUUID(), keep = 'KEEP-' + randomUUID(), key = 'sk-ant-local-resume-' + 'x'.repeat(24)
  mkdirSync(project)
  write(join(project, 'input.txt'), keep)
  write(join(config, '.claude.json'), { theme: 'dark', hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty',
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } })
  write(join(project, '.claude/settings.json'), { permissions: { allow: ['Read'] } })
  write(join(plugin, '.claude-plugin/plugin.json'), { name: 'history-review', version: '1.0.0' })
  write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(plugin, 'hooks/register.ts'), `export function register(on) {
    on('session.compact', async ($, e) => {
      const tools = e.messages.filter(row => row.toolUses.length || row.toolResults?.length)
      if (!tools.length) return { skip: 'nothing to keep yet' }
      return { messages: [{ role: 'user', text: 'Replacement summary', toolUses: [] }, ...tools] }
    })
  }`)
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') return response.end()
    if (!request.url.includes('/messages') || request.url.includes('count_tokens')) return response.end('{"input_tokens":1}')
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    requests.push(body)
    const summarizing = JSON.stringify(body.messages).includes('create a detailed summary')
    const firstMain = !summarizing && !requests.slice(0, -1).some(item => !JSON.stringify(item.messages).includes('create a detailed summary'))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply(summarizing ? 'Native summary text' : firstMain ? [{ name: 'Read', input: { file_path: join(project, 'input.txt') } }] : 'answer', body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_)/i.test(name)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'), TAU_SKIP_PREFLIGHT: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '0.001' })
  const common = [...(mode === 'replacement' ? ['--plugin-dir', plugin] : []), '--setting-sources', 'project', '--strict-mcp-config', '--model', 'claude-sonnet-4-6', '--tools', 'Read']
  const rows = () => {
    const projects = join(config, 'projects')
    if (!existsSync(projects)) return []
    for (const dir of readdirSync(projects)) {
      const path = join(projects, dir, session + '.jsonl')
      if (existsSync(path)) return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    }
    return []
  }
  const answers = () => rows().filter(row => row.type === 'assistant' && row.message.content.some(block => block.type === 'text' && block.text === 'answer')).length
  let term
  try {
    let raw = '', exited = false
    term = pty.spawn(process.execPath, [cli, '--session-id', session, ...common], { name: 'xterm-256color', cols: 130, rows: 45, cwd: project, env })
    term.onData(value => { raw += value })
    term.onExit(() => { exited = true })
    const submit = async text => { term.write(text); await pause(350); term.write('\r') }
    const ready = replStartupReady(term)
    await waitFor(() => ready(raw), 'REPL')
    await pause(2500)
    await submit('first question')
    await waitFor(() => answers() >= 1, 'first answer')
    await pause(800)
    await submit('second question')
    await waitFor(() => answers() >= 2, 'second answer')
    await pause(1500)
    // The renderer only draws changed cells, so the raw screen stream cannot be matched
    // reliably. System rows at level info stay hidden unless the session is verbose.
    if (mode === 'replacement') {
      const veto = rows().find(row => row.subtype === 'informational' && String(row.content).includes('nothing to keep yet'))
      assert.equal(veto?.level, 'warning', 'the veto line is one the user can see')
    }
    await submit('/exit')
    await waitFor(() => exited, 'exit', 20_000)
    term = undefined

    const last = rows().filter(row => row.uuid).findLast(row => row.type === 'assistant')
    const byUuid = new Map(rows().filter(row => row.uuid).map(row => [row.uuid, row]))
    let walker = last, reachedBoundary = false
    const seen = new Set()
    while (walker && !seen.has(walker.uuid)) {
      seen.add(walker.uuid)
      if (walker.subtype === 'compact_boundary') reachedBoundary = true
      walker = walker.parentUuid ? byUuid.get(walker.parentUuid) : undefined
    }
    if (mode === 'native') assert.ok(reachedBoundary, 'the answer chains from the summary, not from the rows behind the boundary')

    await execute(process.execPath, [cli, '-p', 'after resume', '--resume', session, ...common, '--dangerously-skip-permissions'],
      { cwd: project, env: { ...env, CI: 'true', DISABLE_AUTO_COMPACT: '1' }, timeout: 90_000, windowsHide: true })
    const text = JSON.stringify(requests.at(-1).messages)
    assert.ok(text.includes('after resume'))
    if (mode === 'native') assert.ok(text.includes('Native summary text'), 'resume carries the summary')
    else {
      assert.ok(text.includes('Replacement summary'), 'resume carries the replacement')
      assert.ok(text.includes(keep), 'resume carries the kept tool result')
    }
  } finally {
    if (term) { term.kill(); await pause(500) }
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

// ConPTY keeps native handles alive after its terminal exits, so the terminal gets
// its own process and the test worker can finish.
const probe = process.argv.indexOf('--interactive-probe')
if (probe !== -1) {
  const pty = await loadPty()
  try { await checkResume(pty, process.argv[probe + 1]); process.exit(0) }
  catch (error) { process.stderr.write(String(error.stack ?? error) + '\n', () => process.exit(1)) }
} else {
  for (const mode of ['native', 'replacement']) {
    test(`${mode} automatic compaction in the REPL resumes from its new chain with a fast provider`, { timeout: 240_000 }, async t => {
      try {
        await execute(process.execPath, [fileURLToPath(import.meta.url), '--interactive-probe', mode], { env: process.env, timeout: 230_000, windowsHide: true })
      } catch (error) {
        if (error.code !== PTY_MISSING) throw error
        t.skip('node-pty is not installed')
      }
    })
  }
}
