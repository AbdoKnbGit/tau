import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

// Through the real CLI: a guard mod above an app mod sees and refuses the
// app's host calls, a glob observer names each event it saw, and the app's
// timer runs in a print-mode session without holding the process open.
test('real CLI: host calls are events for the mods above, globs observe them, and timers run without holding -p open', { timeout: 300_000 }, async () => {
  const cli = resolve(process.env.TAU_TEST_CLI ?? 'dist/cli.mjs'), root = mkdtempSync(join(tmpdir(), 'tau-op-events-cli-'))
  const project = join(root, 'workspace'), config = join(root, 'config')
  const guard = join(root, 'guard'), app = join(root, 'app')
  const secret = 'secret-' + randomUUID()
  mkdirSync(project)
  write(join(config, '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' })
  // The guard lists the app as a dependency, so it runs first: above the app.
  write(join(guard, '.claude-plugin/plugin.json'), { name: 'op-guard', version: '1.0.0', dependencies: ['op-app@inline'] })
  write(join(guard, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(guard, 'hooks/register.ts'), `
const seen = new Set()
export function register(on) {
  on('*', async ($, e, next) => { seen.add(next.event); return next(e) })
  on('fs.write', { path: /secret/ }, async () => ({ deny: 'secrets stay out of the workspace' }))
  on('session.end', async ($, e, next) => { await $.fs.write('guard-seen.json', JSON.stringify([...seen])); return next(e) })
}`)
  write(join(app, '.claude-plugin/plugin.json'), { name: 'op-app', version: '1.0.0' })
  write(join(app, 'hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(app, 'hooks/register.ts'), `
let ticks = 0
export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.every(10, async () => { ticks++; await $.fs.write('ticks.txt', String(ticks)) })
    // A long wait that must not keep the finished run alive.
    $.clock.after(600_000, () => {})
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    try { await $.fs.write('${secret}.txt', 'leak') } catch (error) { await $.fs.write('denied.txt', error.message) }
    return { text: 'turn observed' }
  })
  // The count at session.end: a tick's own write may still be in flight when
  // a fast run exits, but this hook settles before the process does.
  on('session.end', async ($, e, next) => { await $.fs.write('ticks.txt', String(ticks)); return next(e) })
}`)
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') { response.end(); return }
    let raw = ''
    for await (const part of request) raw += part
    if (request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return }
    const body = JSON.parse(raw)
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply('ANSWER-READY', body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: 'sk-ant-local-op-events-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false' })
  try {
    const child = spawn(process.execPath, [cli, '-p', 'say ready', '--plugin-dir', guard, '--plugin-dir', app,
      '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--strict-mcp-config', '--setting-sources', 'project',
      '--no-session-persistence', '--dangerously-skip-permissions', '--max-turns', '2'],
    { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
    // Only guards against a hang; a pending ten-minute timer must not cause one.
    const timer = setTimeout(() => child.kill(), 120_000)
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    clearTimeout(timer)
    assert.equal(code, 0, stdout + stderr)
    assert.match(stdout, /ANSWER-READY/)
    assert.equal(requests.length, 1)
    assert.equal(existsSync(join(project, `${secret}.txt`)), false, 'the guard must refuse the write')
    assert.equal(readFileSync(join(project, 'denied.txt'), 'utf8'), 'op-app: $.fs.write: secrets stay out of the workspace')
    assert.ok(Number(readFileSync(join(project, 'ticks.txt'), 'utf8')) >= 1, 'the timer never fired')
    const seen = JSON.parse(readFileSync(join(project, 'guard-seen.json'), 'utf8'))
    for (const event of ['session.start', 'turn.complete', 'clock.every', 'clock.after', 'fs.write', 'session.end'])
      assert.ok(seen.includes(event), `the glob observer missed ${event}: ${seen}`)
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
