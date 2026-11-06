// Local model speed in /statistics, through the built CLI and a fake local
// server, so no model or local server has to be installed. The fake server's
// timing is the ground truth. The Ollama case with Ollama's own figures is
// exact; cases timed with Tau's clock leave room for timer jitter on shared CI
// machines. DeepSeek, a cloud provider on the same lane, is the control: its
// /statistics must not gain the section.
//
// TAU_LOCAL_SPEED_CLI runs the cases against another build (for example a
// scratch bundle) instead of dist/cli.mjs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { startFakeLocalModelServer } from './helpers/fake-local-model-server.mjs'
import { stopProcessTree } from './helpers/stop-process-tree.mjs'

const cli = resolve(process.env.TAU_LOCAL_SPEED_CLI ?? 'dist/cli.mjs')
const root = mkdtempSync(join(tmpdir(), 'tau-local-speed-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

const MODEL = 'local-speed-test:1b'
const MARKER = 'local-speed-run'
const RATE = 40

let caseNumber = 0

function freshCase(activeProvider) {
  const home = join(root, `case-${caseNumber++}`)
  const workspace = join(home, 'workspace')
  const configDir = join(home, 'config')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    activeProvider,
  }))
  return { home, workspace, configDir }
}

function cleanEnv({ home, configDir }, extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|OLLAMA|LMSTUDIO|LM_STUDIO|DEEPSEEK|CI$|ENABLE_TOOL_SEARCH|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  return {
    ...env,
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, 'cache'),
    NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1', NO_PROXY: '127.0.0.1,localhost',
    ...extra,
  }
}

// One print-mode session: a prompt the fake server answers from its script,
// then /statistics.
async function runSession(place, env, model) {
  const child = spawn(process.execPath, [
    cli, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--tools', 'Read',
    '--model', model,
  ], {
    cwd: place.workspace, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', part => { stdout += part })
  child.stderr.on('data', part => { stderr += part })
  const send = content => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
  // /statistics goes out only after the reply has finished, as a person would
  // send it. Queued while a turn runs, print mode can fold it into that turn.
  let statisticsSent = false
  child.stdout.on('data', () => {
    if (statisticsSent || !stdout.includes('"type":"result"')) return
    statisticsSent = true
    send('/statistics')
    child.stdin.end()
  })
  send(`Reply with a few words. ${MARKER}`)
  const timer = setTimeout(() => stopProcessTree(child), 120_000)
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function statisticsText(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.type !== 'assistant') continue
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    const text = content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
    if (text.includes('Session statistics')) return text
  }
  return null
}

const ROW = /^\s*(.+?) \((Ollama|LM Studio)\): (~?)([\d.]+) tok\/s \| first token ([\d.]+) s \| (\d+) repl(?:y|ies)\s*$/

function speedRows(stats) {
  return stats.split(/\r?\n/).flatMap(line => {
    const match = ROW.exec(line)
    return match
      ? [{ model: match[1], provider: match[2], estimated: match[3] === '~', rate: Number(match[4]), wait: Number(match[5]), replies: Number(match[6]) }]
      : []
  })
}

function explain(result, server) {
  return [
    `exit ${result.code}`,
    `chat requests: ${server?.chatRequests().length ?? 'n/a'}, scripted replies used: ${server?.scriptedRepliesUsed() ?? 'n/a'}`,
    `stdout tail: ${result.stdout.slice(-2000)}`,
    `stderr tail: ${result.stderr.slice(-2000)}`,
  ].join('\n')
}

// A slow machine can only make Tau's clock read slower, so the lower bound is
// loose and the upper one tight. Both still fail if the window were measured
// over the wrong stretch: counting the wait would read about half the rate.
function assertRate(rate, context) {
  assert.ok(rate >= RATE * 0.6 && rate <= RATE * 1.25, `rate ${rate} tok/s is not between ${RATE * 0.6} and ${RATE * 1.25}\n${context}`)
}

// The scripts wait 1.5 s before the first piece. Request overhead can add to
// that on a slow machine; timing from the wrong event adds far more.
function assertWait(wait, context) {
  assert.ok(wait >= 1.4 && wait <= 3.8, `first token after ${wait} s, expected about 1.5 s\n${context}`)
}

async function localCase({ provider, envName, reply }) {
  const server = await startFakeLocalModelServer({ model: MODEL, marker: MARKER, replies: [reply] })
  try {
    const place = freshCase(provider)
    const result = await runSession(place, cleanEnv(place, { [envName]: server.baseUrl }), MODEL)
    const context = explain(result, server)
    assert.equal(server.scriptedRepliesUsed(), 1, `the scripted reply was not requested\n${context}`)
    const stats = statisticsText(result.stdout)
    assert.ok(stats, `no /statistics output\n${context}`)
    return { server, stats, rows: speedRows(stats), context }
  } finally {
    await server.close()
  }
}

test("Ollama: its own figures are shown exactly, even with thinking Tau doesn't display", async () => {
  // Ollama streams 40 thinking pieces in message.thinking (Tau's Ollama path
  // does not show them) and 30 answer pieces, then reports 70 tokens in
  // 1.4 s after 0.3 s loading and 0.9 s prompt processing. Tau's own clock
  // would see a much later first token and a much higher rate.
  const { server, stats, rows, context } = await localCase({
    provider: 'ollama',
    envName: 'OLLAMA_BASE_URL',
    reply: {
      waitMs: 500, tokensPerSecond: RATE, thinkingTokens: 40, textTokens: 30, sendUsage: true,
      ollamaTimings: { loadMs: 300, promptMs: 900, evalMs: 1400 },
    },
  })
  assert.deepEqual(rows, [{ model: MODEL, provider: 'Ollama', estimated: false, rate: 50, wait: 1.2, replies: 1 }], `${stats}\n${context}`)
  assert.ok(stats.includes(`${MODEL} (Ollama): 50 tok/s | first token 1.2 s | 1 reply`), stats)
  assert.ok(!stats.includes('estimated from text length'), stats)
  // Tau still talks to Ollama's native endpoint, as before.
  assert.ok(server.chatRequests().length >= 1 && server.chatRequests().every(request => request.path === '/api/chat'), context)
})

test("Ollama without its own figures: Tau's clock and an estimate, marked with a tilde", async () => {
  const { stats, rows, context } = await localCase({
    provider: 'ollama',
    envName: 'OLLAMA_BASE_URL',
    reply: { waitMs: 1500, tokensPerSecond: RATE, textTokens: 61, sendUsage: false },
  })
  assert.equal(rows.length, 1, `${stats}\n${context}`)
  const [row] = rows
  assert.deepEqual([row.model, row.provider, row.estimated, row.replies], [MODEL, 'Ollama', true, 1], stats)
  assertRate(row.rate, stats)
  assertWait(row.wait, stats)
  assert.ok(stats.includes('~ estimated from text length: the server sent no token counts'), stats)
})

test('LM Studio without token counts: estimated speed, marked with a tilde', async () => {
  const { server, stats, rows, context } = await localCase({
    provider: 'lmstudio',
    envName: 'LMSTUDIO_BASE_URL',
    reply: { waitMs: 1500, tokensPerSecond: RATE, textTokens: 61, sendUsage: false },
  })
  assert.equal(rows.length, 1, `${stats}\n${context}`)
  assert.deepEqual([rows[0].provider, rows[0].estimated], ['LM Studio', true], stats)
  assertRate(rows[0].rate, stats)
  assert.ok(stats.includes('~ estimated from text length: the server sent no token counts'), stats)
  // The feature only reads timings: LM Studio still gets the request it got
  // before, with no stream_options.
  for (const request of server.chatRequests()) {
    assert.equal(request.body?.stream_options, undefined, 'stream_options must stay off for LM Studio')
  }
})

test('LM Studio thinking first: the wait ends at the first thinking token, and thinking counts', async () => {
  // 140 thinking pieces at 40 per second take 3.5 s. Timing from the first
  // answer token instead would report a wait of about 5 s.
  const { server, stats, rows, context } = await localCase({
    provider: 'lmstudio',
    envName: 'LMSTUDIO_BASE_URL',
    reply: { waitMs: 1500, tokensPerSecond: RATE, thinkingTokens: 140, thinkingField: 'reasoning', textTokens: 40, sendUsage: true },
  })
  assert.equal(rows.length, 1, `${stats}\n${context}`)
  const [row] = rows
  assert.deepEqual([row.model, row.provider, row.estimated], [MODEL, 'LM Studio', false], stats)
  assertRate(row.rate, stats)
  assertWait(row.wait, stats)
  for (const request of server.chatRequests()) {
    assert.equal(request.body?.stream_options, undefined, 'stream_options must stay off for LM Studio')
  }
})

test('a cloud provider on the same lane gets no local speed section', async () => {
  const server = await startFakeLocalModelServer({
    model: 'deepseek-chat',
    marker: MARKER,
    replies: [{ waitMs: 300, tokensPerSecond: RATE, textTokens: 20, sendUsage: true }],
  })
  try {
    const place = freshCase('deepseek')
    const result = await runSession(place, cleanEnv(place, {
      DEEPSEEK_API_KEY: 'sk-local-speed-fixture',
      DEEPSEEK_BASE_URL: server.baseUrl,
    }), 'deepseek-chat')
    const context = explain(result, server)
    assert.equal(server.scriptedRepliesUsed(), 1, `the scripted reply was not requested\n${context}`)
    const stats = statisticsText(result.stdout)
    assert.ok(stats, `no /statistics output\n${context}`)
    assert.ok(!stats.includes('Local speed'), stats)
    assert.deepEqual(speedRows(stats), [], stats)
  } finally {
    await server.close()
  }
})
