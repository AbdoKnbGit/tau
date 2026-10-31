// What print mode really sends, through the built CLI. The sign-in cases read the credentials off the
// wire. The Antigravity cases run against a stand-in that refuses the identity Google refuses.
import assert from 'node:assert/strict'
import { stopProcessTree } from './helpers/stop-process-tree.mjs'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const cli = resolve('dist/cli.mjs')
const root = mkdtempSync(join(tmpdir(), 'tau print requests é-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

const envKey = 'sk-ant-print-mode-fixture-key'
const loginToken = 'print-mode-fixture-login-token'
const sdkIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
const tauIdentity = 'You are Tau, a multi-provider AI coding CLI.'

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

let caseNumber = 0

function freshCase(config) {
  const home = join(root, `case-${caseNumber++}`)
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  write(join(home, 'config', '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', ...config })
  return { home, workspace, configDir: join(home, 'config') }
}

// CI is left out on purpose: under CI the key always wins, which is not what these cases are about.
function cleanEnv({ home, configDir }, extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|CI$|ENABLE_TOOL_SEARCH|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  return {
    ...env,
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, 'cache'),
    NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1', NO_PROXY: '127.0.0.1,localhost',
    ...extra,
  }
}

async function runPrint(workspace, env, args) {
  const child = spawn(process.execPath, [cli, '-p', 'hello', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--tools', 'Read', ...args], {
    cwd: workspace, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', part => { stdout += part })
  child.stderr.on('data', part => { stderr += part })
  const timer = setTimeout(() => stopProcessTree(child), 60_000)
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

async function anthropicRun({ decision, login, env = {}, args = [] }) {
  const place = freshCase({
    activeProvider: 'firstParty',
    customApiKeyResponses: { approved: decision === 'approved' ? [envKey.slice(-20)] : [], rejected: decision === 'rejected' ? [envKey.slice(-20)] : [] },
  })
  if (login) {
    write(join(place.configDir, '.credentials.json'), {
      claudeAiOauth: { accessToken: loginToken, refreshToken: 'print-mode-fixture-refresh', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null },
    })
  }
  const seen = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"input_tokens":1}')
      return
    }
    const body = JSON.parse(raw)
    seen.push({ authorization: request.headers.authorization, apiKey: request.headers['x-api-key'], system: body.system })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply('ANSWERED', body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const result = await runPrint(place.workspace, cleanEnv(place, {
      ANTHROPIC_API_KEY: envKey,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ENABLE_TOOL_SEARCH: 'false',
      ...env,
    }), ['--model', 'claude-sonnet-4-6', ...args])
    assert.equal(result.code, 0, `stdout: ${result.stdout.slice(-400)}\nstderr: ${result.stderr.slice(-800)}`)
    assert.match(result.stdout, /ANSWERED/)
    assert.ok(seen.length > 0, 'no model request reached the server')
    return { ...seen.at(-1), stdout: result.stdout, stderr: result.stderr }
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

test('a key refused at the prompt gives way to the subscription login', { timeout: 90_000 }, async () => {
  const sent = await anthropicRun({ decision: 'rejected', login: true })
  assert.equal(sent.authorization, `Bearer ${loginToken}`)
  assert.equal(sent.apiKey, undefined)
})

test('a key never answered at the prompt is still used, which is what CI relies on', { timeout: 90_000 }, async () => {
  const sent = await anthropicRun({ decision: 'none', login: true })
  assert.equal(sent.apiKey, envKey)
  assert.equal(sent.authorization, undefined)
})

test('an approved key is still used over the login', { timeout: 90_000 }, async () => {
  const sent = await anthropicRun({ decision: 'approved', login: true })
  assert.equal(sent.apiKey, envKey)
  assert.equal(sent.authorization, undefined)
})

test('a refused key is still used when there is no login to fall back on', { timeout: 90_000 }, async () => {
  const sent = await anthropicRun({ decision: 'rejected', login: false })
  assert.equal(sent.apiKey, envKey)
  assert.equal(sent.authorization, undefined)
})

test('print mode on Anthropic keeps its identity', { timeout: 90_000 }, async () => {
  const sent = await anthropicRun({ decision: 'none', login: false })
  assert.ok(sent.system.some(block => block.text === sdkIdentity), 'the SDK identity line was not sent')
})

test('piped output stays clean in a Windows terminal session', { timeout: 90_000 }, async () => {
  // Windows sets these in every terminal, and JSON piped into another program has to stay parseable.
  const terminal = { SESSIONNAME: 'Console', WT_SESSION: '11111111-1111-4111-8111-111111111111' }
  const { stdout, stderr } = await anthropicRun({ decision: 'none', login: false, env: terminal, args: ['--output-format', 'json'] })
  assert.equal(JSON.parse(stdout).result, 'ANSWERED')
  assert.doesNotMatch(stderr, /\u001b/)
})

async function antigravityRun(args = []) {
  const place = freshCase({ activeProvider: 'antigravity' })
  write(join(place.home, '.config', 'claude-code', 'provider-keys.json'), {
    version: 1,
    keys: { gemini_oauth_antigravity: JSON.stringify({ accessToken: 'print-mode-fixture-google-token', refreshToken: 'print-mode-fixture-google-refresh', expiresAt: Date.now() + 86_400_000 }) },
    metadata: {},
  })
  const record = join(place.home, 'system-prompts.txt')
  writeFileSync(record, '')
  const fake = pathToFileURL(resolve('test/helpers/fake-antigravity-fetch.mjs')).href
  const result = await runPrint(place.workspace, cleanEnv(place, {
    NODE_OPTIONS: `--import=${fake}`,
    TAU_TEST_FAKE_GOOGLE_RECORD: record,
    ANTHROPIC_API_KEY: envKey,
  }), ['--model', 'gemini-3.8-flash-high', ...args])
  return { ...result, identities: readFileSync(record, 'utf8').split('\n').filter(Boolean) }
}

test('print mode on Antigravity gets an answer, with the identity the interactive CLI sends', { timeout: 90_000 }, async () => {
  const { code, stdout, stderr, identities } = await antigravityRun()
  assert.equal(code, 0, `stdout: ${stdout.slice(-400)}\nstderr: ${stderr.slice(-800)}`)
  assert.match(stdout, /ANSWERED/)
  assert.doesNotMatch(stdout, /429/)
  assert.ok(identities.length > 0, 'no model request was made')
  for (const line of identities) assert.equal(line, tauIdentity)
})

test('print mode on Antigravity with an appended prompt keeps the identity Google accepts', { timeout: 90_000 }, async () => {
  const { code, stdout, stderr, identities } = await antigravityRun(['--append-system-prompt', 'Be brief.'])
  assert.equal(code, 0, `stdout: ${stdout.slice(-400)}\nstderr: ${stderr.slice(-800)}`)
  assert.match(stdout, /ANSWERED/)
  assert.ok(identities.length > 0, 'no model request was made')
  for (const line of identities) assert.equal(line, `${tauIdentity.slice(0, -1)}, running within the Claude Agent SDK.`)
})
