// Run after `node build.mjs`. Real interactive session, stub provider. A /resume typed inside a running
// window must leave the conversation it switches into with exactly one skills list: the one that
// conversation saved, or a fresh one when it holds none (transcripts saved before reminders were kept).
// The window's own record of what it already sent belongs to the conversation it left. Before the fix a
// fresh window sent the saved list a second time, and a window that had already chatted sent none.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const SKILLS = 'The following skills are available'
const pause = ms => new Promise(done => setTimeout(done, ms))
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
const count = (text, phrase) => text.split(phrase).length - 1
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

async function checkResume(pty) {
  // Tau works in the resolved folder (macOS /private/var, the long form of a Windows 8.3 TEMP).
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'tau resume skills '))
  const home = join(root, 'home'), project = join(root, 'project'), config = join(root, 'config')
  const saved = randomUUID(), old = randomUUID(), window = randomUUID()
  const key = 'sk-ant-local-resume-skills-' + 'x'.repeat(24)
  mkdirSync(project, { recursive: true })
  write(join(config, '.claude.json'), { theme: 'dark', hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty',
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } })
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') return response.end()
    if (!request.url.includes('/messages') || request.url.includes('count_tokens')) return response.end('{"input_tokens":1}')
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply('ANSWERED', body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  // NODE_ENV=test turns the skills list off, and a sealed home keeps the real one out of it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|CI$|ENABLE_TOOL_SEARCH|NODE_ENV$|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(name)))
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'), NODE_ENV: 'production', TAU_SKIP_PREFLIGHT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false' })
  const common = ['--setting-sources', 'project', '--strict-mcp-config', '--model', 'claude-sonnet-4-6']
  const transcript = session => {
    const projects = join(config, 'projects')
    for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
      const path = join(projects, dir, session + '.jsonl')
      if (existsSync(path)) return path
    }
    return null
  }
  let term
  try {
    // A conversation saved by this build: its skills list is in the transcript.
    const child = spawn(process.execPath, [cli, '-p', 'FIRST-QUESTION', '--session-id', saved, ...common], { cwd: project, env, windowsHide: true, stdio: 'ignore' })
    assert.equal(await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) }), 0, 'saving the first conversation failed')
    const savedPath = transcript(saved)
    const rows = readFileSync(savedPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    const listing = rows.filter(row => row.type === 'attachment' && row.attachment?.type === 'skill_listing')
    assert.equal(listing.length, 1, 'the saved conversation holds its skills list')
    // The same conversation as a transcript saved before reminders were kept: no skills list in it.
    const parentOf = new Map(listing.map(row => [row.uuid, row.parentUuid ?? null]))
    const kept = rows.filter(row => !parentOf.has(row.uuid)).map(row => ({ ...row,
      ...('sessionId' in row ? { sessionId: old } : {}),
      ...(parentOf.has(row.parentUuid) ? { parentUuid: parentOf.get(row.parentUuid) } : {}) }))
    writeFileSync(join(dirname(savedPath), old + '.jsonl'), kept.map(row => JSON.stringify(row)).join('\n') + '\n')

    let raw = '', exited = false
    term = pty.spawn(process.execPath, [cli, '--session-id', window, ...common], { name: 'xterm-256color', cols: 130, rows: 45, cwd: project, env })
    term.onData(value => { raw += value })
    term.onExit(() => { exited = true })
    const submit = async text => { term.write(text); await pause(350); term.write('\r') }
    const ask = async text => {
      await submit(text)
      await waitFor(() => requests.some(body => JSON.stringify(body.messages.at(-1)).includes(text)), text)
      await pause(1500)
      return JSON.stringify(requests.find(body => JSON.stringify(body.messages.at(-1)).includes(text)).messages)
    }
    const ready = replStartupReady(term)
    await waitFor(() => ready(raw), 'REPL')
    await pause(2500)

    // A fresh window, nothing sent yet: the resumed conversation's saved list is the only one.
    await submit('/resume ' + saved)
    await pause(4000)
    const fresh = await ask('AFTER-FRESH-RESUME')
    assert.ok(fresh.includes('FIRST-QUESTION'), 'the request continues the resumed conversation')

    // The window has chatted now. A conversation without a saved list gets one fresh list.
    await submit('/resume ' + old)
    await pause(4000)
    const older = await ask('AFTER-OLD-RESUME')
    assert.ok(older.includes('FIRST-QUESTION') && !older.includes('AFTER-FRESH-RESUME'), 'the request continues the older conversation')

    assert.deepEqual({ freshWindow: count(fresh, SKILLS), olderConversation: count(older, SKILLS) },
      { freshWindow: 1, olderConversation: 1 }, 'each resumed conversation carries exactly one skills list')

    await submit('/exit')
    await waitFor(() => exited, 'exit', 20_000)
    term = undefined
  } finally {
    if (term) { term.kill(); await pause(500) }
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

// ConPTY keeps native handles alive after its terminal exits, so the terminal gets
// its own process and the test worker can finish.
if (process.argv.includes('--interactive-probe')) {
  const pty = await loadPty()
  try { await checkResume(pty); process.exit(0) }
  catch (error) { process.stderr.write(String(error.stack ?? error) + '\n', () => process.exit(1)) }
} else {
  test('/resume inside a window leaves the resumed conversation with exactly one skills list', { timeout: 240_000 }, async t => {
    try {
      await execute(process.execPath, [fileURLToPath(import.meta.url), '--interactive-probe'], { env: process.env, timeout: 230_000, windowsHide: true })
    } catch (error) {
      if (error.code === PTY_MISSING) return t.skip('node-pty is not installed')
      throw new Error(String(error.stderr || error.message))
    }
  })
}
