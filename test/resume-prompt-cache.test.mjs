// A provider reuses its prompt cache only when a request starts with the same bytes as before, so a
// resumed session has to send the history it already sent. These run the built CLI twice in one
// folder, save a session, resume it, and compare what really went out.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { stopProcessTree } from './helpers/stop-process-tree.mjs'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const cli = resolve('dist/cli.mjs')
const root = mkdtempSync(join(tmpdir(), 'tau resume cache é-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

const SESSION = '44444444-5555-4666-8777-888888888888'
const CONTINUATION = 'Continue from where you left off.'
const FAR_FUTURE = 4102444800000

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}

let caseNumber = 0

function freshFolder(provider, files = {}) {
  const home = join(root, `case-${caseNumber++}`)
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  write(join(home, 'config', '.claude.json'), { hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: provider })
  for (const [path, content] of Object.entries(files)) write(join(workspace, path), content)
  // CI is left out on purpose: it changes which sign-ins are accepted, which is not what this tests.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|CI$|ENABLE_TOOL_SEARCH|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
  return {
    home, workspace,
    env: {
      ...env,
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      CLAUDE_CONFIG_DIR: join(home, 'config'), CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, 'cache'),
      NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1', NO_PROXY: '127.0.0.1,localhost',
    },
  }
}

async function runPrint(place, env, prompt, args) {
  const child = spawn(process.execPath, [cli, '-p', prompt, '--strict-mcp-config', '--setting-sources', 'project', ...args], {
    cwd: place.workspace, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', part => { output += part })
  child.stderr.on('data', part => { output += part })
  const timer = setTimeout(() => stopProcessTree(child), 60_000)
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    assert.equal(code, 0, output.slice(-600))
  } finally {
    clearTimeout(timer)
  }
}

const withoutMarkers = value => {
  if (Array.isArray(value)) return value.map(withoutMarkers)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, withoutMarkers(inner)]))
}

async function saveAndResumeOnAnthropic(files = {}) {
  const place = freshFolder('firstParty', files)
  const bodies = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"input_tokens":1}')
      return
    }
    const body = JSON.parse(raw)
    bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(anthropicReply('ANSWERED', body.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const env = { ...place.env, ANTHROPIC_API_KEY: 'sk-ant-resume-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ENABLE_TOOL_SEARCH: 'false' }
    const flags = ['--model', 'claude-sonnet-4-6']
    await runPrint(place, env, 'FIRST-QUESTION', [...flags, '--session-id', SESSION])
    const original = bodies.at(-1)
    bodies.length = 0
    await runPrint(place, env, 'SECOND-QUESTION', [...flags, '--resume', SESSION])
    return { original, resumed: bodies[0], text: JSON.stringify(bodies[0]) }
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

async function saveAndResumeOnAntigravity(files = {}) {
  const place = freshFolder('antigravity', files)
  write(join(place.home, '.config', 'claude-code', 'provider-keys.json'), {
    version: 1,
    keys: { gemini_oauth_antigravity: JSON.stringify({ accessToken: 'resume-fixture-google-token', refreshToken: 'resume-fixture-refresh', expiresAt: FAR_FUTURE }) },
    metadata: {},
  })
  const bodiesFile = join(place.home, 'bodies.jsonl')
  const env = {
    ...place.env,
    NODE_OPTIONS: `--import=${pathToFileURL(resolve('test/helpers/fake-antigravity-fetch.mjs')).href}`,
    TAU_TEST_FAKE_GOOGLE_RECORD: join(place.home, 'identities.txt'),
    TAU_TEST_FAKE_GOOGLE_BODIES: bodiesFile,
  }
  const read = () => (existsSync(bodiesFile) ? readFileSync(bodiesFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).request) : [])
  const flags = ['--model', 'gemini-3.8-flash-high']
  await runPrint(place, env, 'FIRST-QUESTION', [...flags, '--session-id', SESSION])
  const original = read().at(-1)
  writeFileSync(bodiesFile, '')
  await runPrint(place, env, 'SECOND-QUESTION', [...flags, '--resume', SESSION])
  const resumed = read()[0]
  return { original, resumed, text: JSON.stringify(resumed) }
}

const startsWith = (history, prefix) => assert.deepEqual(withoutMarkers(history.slice(0, prefix.length)), withoutMarkers(prefix))
const count = (text, phrase) => text.split(phrase).length - 1
const SKILLS = 'The following skills are available'

test('resuming on Anthropic sends the same system prompt, tools and history', { timeout: 150_000 }, async () => {
  const { original, resumed, text } = await saveAndResumeOnAnthropic()
  // The very first block carries a fingerprint of the first message, so this also pins that.
  assert.deepEqual(withoutMarkers(resumed.system), withoutMarkers(original.system))
  assert.deepEqual(withoutMarkers(resumed.tools), withoutMarkers(original.tools))
  startsWith(resumed.messages, original.messages)
  assert.match(text, /SECOND-QUESTION/)
  assert.equal(count(text, SKILLS), 1, 'the skills reminder is not sent a second time')
})

test('resuming on Antigravity sends the same system prompt, tools and history', { timeout: 150_000 }, async () => {
  const { original, resumed, text } = await saveAndResumeOnAntigravity()
  assert.deepEqual(resumed.systemInstruction, original.systemInstruction)
  assert.deepEqual(resumed.tools, original.tools)
  startsWith(resumed.contents, original.contents)
  assert.match(text, /SECOND-QUESTION/)
  assert.equal(count(text, SKILLS), 1, 'the skills reminder is not sent a second time')
})

test('context a hook added to a prompt is still in place after resuming', { timeout: 150_000 }, async () => {
  const { original, resumed, text } = await saveAndResumeOnAnthropic({
    'prompt-hook.mjs': "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'HOOK-CONTEXT-MARKER' } }))",
    '.claude/settings.json': { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node prompt-hook.mjs' }] }] } },
  })
  assert.match(JSON.stringify(original.messages), /HOOK-CONTEXT-MARKER/)
  startsWith(resumed.messages, original.messages)
  assert.match(text, /SECOND-QUESTION/)
})

test('a Stop hook that ends the turn does not read as an interruption on resume', { timeout: 150_000 }, async () => {
  const { resumed, text } = await saveAndResumeOnAnthropic({
    'stop-hook.mjs': "process.stdout.write(JSON.stringify({ continue: false, stopReason: 'STOP-HOOK-MARKER' }))",
    '.claude/settings.json': { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop-hook.mjs' }] }] } },
  })
  assert.match(text, /STOP-HOOK-MARKER/, 'the model saw the hook stop the turn, so it stays in the history')
  assert.equal(text.includes(CONTINUATION), false, 'no invented request to carry on')
  assert.match(JSON.stringify(resumed.messages.at(-1)), /SECOND-QUESTION/)
})
