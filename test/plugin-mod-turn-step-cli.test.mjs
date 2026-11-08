import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

/** One `tau -p` run with the given mods against a mock API answering
 * `reply` (text, or a function of the request and its number); `files` are
 * the workspace files to read back, `setup` prepares the workspace. */
async function runWithMods(mods, reply, { files: wanted = ['step.json'], setup } = {}) {
  const cli = resolve(process.env.TAU_TEST_CLI ?? 'dist/cli.mjs'), root = mkdtempSync(join(tmpdir(), 'tau-turn-step-cli-'))
  const project = join(root, 'workspace'), config = join(root, 'config')
  mkdirSync(project)
  setup?.(project)
  write(join(config, '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' })
  const dirs = Object.entries(mods).map(([name, { source, dependencies = [] }]) => {
    const dir = join(root, name)
    write(join(dir, '.claude-plugin/plugin.json'), { name, version: '1.0.0', dependencies: dependencies.map(item => `${item}@inline`) })
    write(join(dir, 'hooks/hooks.json'), { modules: ['./register.ts'] })
    write(join(dir, 'hooks/register.ts'), source)
    return dir
  })
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') { response.end(); return }
    let raw = ''
    for await (const part of request) raw += part
    if (request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return }
    const body = JSON.parse(raw)
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply(typeof reply === 'function' ? reply(body, requests.length - 1, project) : reply, body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: 'sk-ant-local-turn-step-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false' })
  try {
    const child = spawn(process.execPath, [cli, '-p', 'say ready', ...dirs.flatMap(dir => ['--plugin-dir', dir]),
      '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--strict-mcp-config', '--setting-sources', 'project',
      '--no-session-persistence', '--dangerously-skip-permissions', '--max-turns', '2'],
    { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', part => { stdout += part }); child.stderr.on('data', part => { stderr += part })
    const timer = setTimeout(() => child.kill(), 120_000)
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    clearTimeout(timer)
    // Read before the workspace is removed below.
    const files = {}
    for (const name of wanted) { try { files[name] = JSON.parse(readFileSync(join(project, name), 'utf8')) } catch {} }
    return { code, stdout, stderr, requests, read: name => files[name] }
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('real CLI: a turn.step hook rewrites the streamed text, sends another model, and reads the result and next.trace', { timeout: 300_000 }, async () => {
  const run = await runWithMods({
    redact: { source: `export function register(on) {
  on('turn.step', async function* ($, e, next) {
    const stream = next({ ...e, model: 'claude-haiku-4-5' })
    for await (const chunk of stream) {
      if (chunk.kind === 'text') yield { ...chunk, text: chunk.text.replaceAll('SECRET', '[redacted]') }
      else yield chunk
    }
    const result = await stream.result
    await $.fs.write('step.json', JSON.stringify({ input: e, result, trace: next.trace }))
    return { ...result, answer: result.answer.replaceAll('SECRET', '[redacted]') }
  })
}` },
  }, 'ANSWER SECRET-123 DONE')
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /ANSWER \[redacted\]-123 DONE/)
  assert.doesNotMatch(run.stdout, /SECRET/)
  assert.equal(run.requests.length, 1)
  assert.match(run.requests[0].model, /^claude-haiku-4-5/)
  const seen = run.read('step.json')
  assert.equal(typeof seen.input.turnId, 'string')
  assert.equal(seen.input.index, 0)
  assert.match(seen.input.model, /sonnet-4-6/)
  assert.ok(seen.input.messageCount >= 1)
  assert.match(seen.result.answer, /ANSWER SECRET-123 DONE/)
  assert.deepEqual(seen.result.toolUses, [])
  assert.equal(seen.result.stopReason, 'end_turn')
  const engine = seen.trace.find(entry => entry.plugin === 'engine')
  assert.equal(engine?.outcome, 'returned')
  assert.ok(engine.chunks > 0, 'the engine link counts the chunks it streamed')
})

test('real CLI: a turn.step hook answers without the model; a plain function above it passes the stream through', { timeout: 300_000 }, async () => {
  const run = await runWithMods({
    plain: { dependencies: ['canned'], source: `export function register(on) {
  on('turn.step', async ($, e, next) => next(e))
}` },
    canned: { source: `export function register(on) {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'CANNED ' }
    yield { kind: 'text', index: 0, text: 'ANSWER' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'CANNED ANSWER', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}` },
  }, 'MODEL WAS CALLED')
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /CANNED ANSWER/)
  assert.doesNotMatch(run.stdout, /MODEL WAS CALLED/)
  assert.equal(run.requests.length, 0, 'an answer without next sends no request')
})

test('real CLI: a tool call streams through a turn.step hook and runs; each request of the turn is a step of its own', { timeout: 300_000 }, async () => {
  const run = await runWithMods({
    steps: { source: `export function register(on) {
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    await $.fs.write('step-' + e.index + '.json', JSON.stringify({ turnId: e.turnId, toolUses: result.toolUses, stopReason: result.stopReason }))
    return result
  })
}` },
  }, (body, n, project) => n === 0 ? [{ name: 'Read', input: { file_path: join(project, 'note.txt') } }] : 'READ DONE', {
    files: ['step-0.json', 'step-1.json'],
    setup: project => writeFileSync(join(project, 'note.txt'), 'NOTE-CONTENTS-42'),
  })
  assert.equal(run.code, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /READ DONE/)
  assert.equal(run.requests.length, 2)
  assert.match(JSON.stringify(run.requests[1].messages), /NOTE-CONTENTS-42/, 'the tool ran and its result went back to the model')
  const first = run.read('step-0.json'), second = run.read('step-1.json')
  assert.equal(first.stopReason, 'tool_use')
  assert.deepEqual(first.toolUses.map(use => use.name), ['Read'])
  assert.equal(second.stopReason, 'end_turn')
  assert.equal(first.turnId, second.turnId, 'both requests are steps of one turn')
})
