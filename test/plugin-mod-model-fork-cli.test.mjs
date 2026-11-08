import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}
const textOf = content => typeof content === 'string' ? content
  : (content ?? []).map(block => block.text ?? (block.type === 'tool_result' ? textOf(block.content) : '')).join('')
/** A request as the prompt cache sees it: breakpoints are not content. */
const bare = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item))

// Two turns over stream-json. After the first, a mod's turn.complete hook
// forks the conversation with $.model.fork; the fork must resend the main
// request's own system prompt, tools and messages (so it reads their cache),
// and the main conversation must send the same bytes as a run without it.
async function session(root, cli, project, fork) {
  const requests = []
  const server = createServer(async (request, response) => {
    if (request.method === 'HEAD') { response.end(); return }
    let raw = ''
    for await (const part of request) raw += part
    if (request.url.includes('count_tokens')) { response.end('{"input_tokens":1}'); return }
    const body = JSON.parse(raw)
    requests.push(body)
    const last = textOf(body.messages.at(-1)?.content)
    const answer = last.includes('FORK-QUESTION') ? 'FORK-ANSWER' : last.includes('TURN-TWO') ? 'ANSWER-TWO' : 'ANSWER-ONE'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply(answer, body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  Object.assign(env, { CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
    CI: 'true', NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1',
    ANTHROPIC_API_KEY: 'sk-ant-local-model-fork-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost', ENABLE_TOOL_SEARCH: 'false', MOD_FORK: fork ? '1' : '0' })
  const child = spawn(process.execPath, [cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--plugin-dir', join(root, 'forker'), '--model', 'claude-sonnet-4-6', '--tools', 'Read', '--strict-mcp-config',
    '--setting-sources', 'project', '--no-session-persistence', '--dangerously-skip-permissions'],
  { cwd: project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const entries = []
  let stdout = '', stderr = '', buffer = '', closed = false
  child.stdout.on('data', chunk => {
    stdout += chunk
    buffer += chunk
    for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
      try { entries.push(JSON.parse(buffer.slice(0, end))) } catch { /* plain text stays in stdout */ }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  const finished = new Promise(done => child.on('close', code => { closed = true; done(code) }))
  const timer = setTimeout(() => child.kill(), 120_000)
  const detail = () => `${stderr.slice(-2000)}\n${stdout.slice(-2500)}`
  const waitFor = async predicate => {
    const deadline = Date.now() + 90_000
    while (!predicate() && !closed && Date.now() < deadline) await delay(50)
    assert.ok(predicate(), detail())
  }
  const send = entry => child.stdin.write(JSON.stringify(entry) + '\n')
  try {
    send({ type: 'control_request', request_id: 'fork-initialize', request: { subtype: 'initialize' } })
    await waitFor(() => entries.some(entry => entry.type === 'control_response' && entry.response?.request_id === 'fork-initialize'))
    for (const [index, prompt] of ['TURN-ONE: say one', 'TURN-TWO: say two'].entries()) {
      send({ type: 'user', session_id: '', message: { role: 'user', content: prompt }, parent_tool_use_id: null })
      await waitFor(() => entries.filter(entry => entry.type === 'result').length > index)
      assert.equal(entries.filter(entry => entry.type === 'result')[index].is_error, false, detail())
    }
    child.stdin.end()
    assert.equal(await finished, 0, detail())
    return { requests, results: entries.filter(entry => entry.type === 'result').map(entry => entry.result) }
  } finally {
    clearTimeout(timer)
    if (!closed) child.kill()
    await finished
    server.closeAllConnections(); await new Promise(done => server.close(done))
  }
}

test('real CLI: $.model.fork resends the main request\'s prefix and leaves the conversation\'s own requests untouched', { timeout: 300_000 }, async () => {
  const cli = resolve(process.env.TAU_TEST_CLI ?? 'dist/cli.mjs'), root = mkdtempSync(join(tmpdir(), 'tau-model-fork-cli-'))
  const project = join(root, 'workspace')
  mkdirSync(project)
  write(join(root, 'config/.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty' })
  write(join(root, 'forker/.claude-plugin/plugin.json'), { name: 'forker', version: '1.0.0' })
  write(join(root, 'forker/hooks/hooks.json'), { modules: ['./register.ts'] })
  write(join(root, 'forker/hooks/register.ts'), `
let turns = 0
export function register(on) {
  on('turn.complete', async ($, e, next) => {
    const fork = await $.env.get('MOD_FORK')
    await $.fs.write('turn-' + (++turns) + '.txt', String(fork))
    if (turns === 1 && fork === '1') {
      let forked
      try { forked = await $.model.fork({ prompt: 'FORK-QUESTION: what did you say?' }) } catch (error) { forked = { error: error.message } }
      await $.fs.write('fork.json', JSON.stringify(forked))
    }
    return next(e)
  })
}`)
  try {
    const plain = await session(root, cli, project, false)
    assert.equal(readFileSync(join(project, 'turn-2.txt'), 'utf8'), '0', 'the mod saw both turns')
    assert.equal(existsSync(join(project, 'fork.json')), false)
    const forked = await session(root, cli, project, true)
    assert.equal(readFileSync(join(project, 'turn-1.txt'), 'utf8'), '1')
    const answer = JSON.parse(readFileSync(join(project, 'fork.json'), 'utf8'))
    assert.equal(answer.text, 'FORK-ANSWER')
    assert.equal(typeof answer.usage.input_tokens, 'number')
    assert.deepEqual(forked.results, ['ANSWER-ONE', 'ANSWER-TWO'])
    assert.equal(plain.requests.length, 2, JSON.stringify(plain.requests.map(body => textOf(body.messages.at(-1)?.content))))
    assert.equal(forked.requests.length, 3, JSON.stringify(forked.requests.map(body => textOf(body.messages.at(-1)?.content))))
    const [main1, fork, main2] = forked.requests
    assert.match(textOf(fork.messages.at(-1).content), /FORK-QUESTION/)
    // The fork resends the main request's prefix, byte for byte.
    assert.equal(fork.model, main1.model)
    assert.deepEqual(bare(fork.system), bare(main1.system))
    assert.deepEqual(bare(fork.tools), bare(main1.tools))
    assert.deepEqual(bare(fork.messages.slice(0, -1)), bare(main2.messages.slice(0, -1)),
      'the fork sends the conversation as the next main request sends it')
    // Its breakpoint sits on the shared prefix: it reads the conversation's
    // cache and writes no entry of its own.
    assert.match(JSON.stringify(fork.messages.at(-2)), /cache_control/)
    assert.doesNotMatch(JSON.stringify(fork.messages.at(-1)), /cache_control/)
    // The main conversation never sees the fork, and sends what it sends
    // without one.
    assert.doesNotMatch(JSON.stringify(main2), /FORK-(QUESTION|ANSWER)/)
    const comparable = body => { const { metadata, ...rest } = body; return rest }
    assert.deepEqual(comparable(main1), comparable(plain.requests[0]))
    assert.deepEqual(comparable(main2), comparable(plain.requests[1]))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
