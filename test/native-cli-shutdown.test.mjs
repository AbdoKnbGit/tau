import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

test('shipped CLI exits cleanly after repeated real native Reads and releases the project directory', { timeout: 120_000 }, async () => {
  const cli = resolve('dist/cli.mjs')
  const root = mkdtempSync(join(tmpdir(), 'tau-native-cli-shutdown-'))
  const project = join(root, 'project with spaces-é'), config = join(root, 'config')
  mkdirSync(project)
  mkdirSync(config)
  const file = join(project, 'receipt.txt'), receipt = randomUUID()
  writeFileSync(file, receipt)
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty',
  }))
  let calls = 0, readMode = false, observedReceipt = false
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') { response.end(); return }
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    if (request.url.includes('count_tokens')) {
      response.setHeader('content-type', 'application/json')
      response.end('{"input_tokens":1}')
      return
    }
    calls++
    if (calls > 1 && JSON.stringify(body.messages).includes(receipt)) observedReceipt = true
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply(readMode && calls === 1
      ? [{ name: 'Read', input: { file_path: file } }]
      : 'SHUTDOWN-COMPLETE', body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    TAU_SKIP_PREFLIGHT: '1', ANTHROPIC_API_KEY: 'sk-ant-local-shutdown-test',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false',
  })
  try {
    for (const mode of ['plain', 'read', 'read', 'read']) {
      readMode = mode === 'read'; calls = 0; observedReceipt = false
      const child = spawn(process.execPath, [cli, '-p', 'Read the receipt when requested and finish.',
        '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--strict-mcp-config',
        '--setting-sources', 'project', '--no-session-persistence', '--dangerously-skip-permissions', '--max-turns', '3'],
      { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', timedOut = false
      child.stdout.on('data', part => { stdout += part })
      child.stderr.on('data', part => { stderr += part })
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 25_000)
      try {
        const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
        assert.equal(timedOut, false, stderr)
        assert.equal(code, 0, stderr + '\n' + stdout)
        assert.match(stdout, /SHUTDOWN-COMPLETE/)
        assert.doesNotMatch(stderr, /UV_HANDLE_CLOSING|Assertion failed/)
        assert.equal(calls, readMode ? 2 : 1)
        assert.equal(observedReceipt, readMode, 'A successful native Read must reach the actual next request')
        assert.equal(readFileSync(file, 'utf8'), receipt)
      } finally { clearTimeout(timer) }
    }
    // Headless IDE detection must not keep the project directory open on Windows.
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    assert.equal(existsSync(project), false)
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
