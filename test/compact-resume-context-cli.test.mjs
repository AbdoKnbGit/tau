// Run after `node build.mjs`. Real CLI, stub provider: what /compact restored must
// reach every later resumed turn, and each request must extend the one before it.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const execute = promisify(execFile)
const cli = resolve(process.env.PROBE_CLI ?? 'dist/cli.mjs')
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}
// The prompt cache sees text, not its encoding or the marker that moves with each request.
const comparable = message => {
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
  return JSON.stringify({ role: message.role, content: content.map(({ cache_control, ...block }) => block) })
    .replace(/toolu_[\w-]+/g, '<id>')
}
const count = (text, part) => text.split(part).length - 1

test('context restored by /compact reaches every later resumed turn and each request extends the last', { timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau compact context '))
  const project = join(root, 'project'), config = join(root, 'config')
  const session = randomUUID(), hookMarker = 'HOOK-' + randomUUID(), fileMarker = 'FILE-' + randomUUID()
  write(join(config, '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' })
  write(join(project, 'notes.txt'), fileMarker + '\n')
  write(join(project, 'context.cjs'), 'process.stdout.write(' + JSON.stringify(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: hookMarker },
  })) + ')')
  write(join(project, '.claude/settings.json'), { hooks: { SessionStart: [{ matcher: 'compact', hooks: [{
    type: 'command', command: process.execPath, args: [join(project, 'context.cjs')],
  }] }] } })
  const requests = [], toolReplies = [[{ name: 'Read', input: { file_path: join(project, 'notes.txt') } }]]
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') return response.end()
    if (request.url.includes('count_tokens')) return response.end('{"input_tokens":1}')
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw)
    requests.push(body)
    const reply = JSON.stringify(body.messages).includes('create a detailed summary') ? 'Summary text' : toolReplies.shift() ?? 'answer'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply(reply, body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_)/i.test(key)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'), CI: 'true', TAU_SKIP_PREFLIGHT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_API_KEY: 'sk-ant-local-compact', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false' })
  const run = (prompt, resume = true) => execute(process.execPath, [cli, '-p', prompt, resume ? '--resume' : '--session-id', session,
    '--setting-sources', 'project', '--strict-mcp-config', '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--dangerously-skip-permissions'],
  { cwd: project, env, timeout: 90_000, windowsHide: true })
  try {
    await run('first question', false)
    await run('/compact')
    const turns = []
    for (const prompt of ['second question', 'third question', 'fourth question']) {
      await run(prompt)
      turns.push(requests.at(-1).messages)
      const text = JSON.stringify(turns.at(-1))
      assert.ok(text.includes(prompt), 'the request is for this turn')
      assert.equal(count(text, hookMarker), 1, `${prompt}: SessionStart context reaches the model once`)
      assert.equal(count(text, fileMarker), 1, `${prompt}: the restored file reaches the model once`)
      assert.equal(count(text, 'No response requested.'), 1, `${prompt}: resuming adds no second sentinel`)
    }
    for (let turn = 1; turn < turns.length; turn++) {
      assert.deepEqual(turns[turn].slice(0, turns[turn - 1].length).map(comparable), turns[turn - 1].map(comparable), `turn ${turn} extends the one before it`)
    }
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
