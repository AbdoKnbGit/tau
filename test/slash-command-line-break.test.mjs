// "/plan" followed by a line break and more text is the /plan command, as
// "/plan " followed by text is. The parser used to split on spaces only, so
// the whole input went to the model as an ordinary prompt and plan mode stayed
// off. Run `npm run build` first: the second half drives the real CLI.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'
import { replStartupReady } from './helpers/repl-startup.mjs'

const execute = promisify(execFile)
const cli = resolve(process.env.PROBE_CLI ?? 'dist/cli.mjs')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const PTY_MISSING = 77
const PROBE = '--slash-line-break-probe'
const REQUEST = 'Reply with the single word done.'

const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
async function waitFor(check, label, milliseconds, details) {
  const until = Date.now() + milliseconds
  while (Date.now() < until) {
    if (check()) return
    await pause(40)
  }
  throw new Error(`Timed out waiting for ${label}\n${details()}`)
}
async function loadPty() {
  let pty
  try {
    const loaded = await import('node-pty')
    pty = loaded.default ?? loaded
  } catch {
    process.exit(PTY_MISSING)
  }
  if (process.platform === 'darwin') {
    const helper = join(
      dirname(createRequire(import.meta.url).resolve('node-pty/package.json')),
      'prebuilds',
      `darwin-${process.arch}`,
      'spawn-helper',
    )
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
  return pty
}

// A real terminal, the real CLI and a local provider: the user pastes
// "/plan", a line break and a request, then presses Enter.
async function runPastedPlanCommand(pty) {
  const temporaryRoot = realpathSync.native(tmpdir())
  const root = realpathSync.native(
    mkdtempSync(join(temporaryRoot, 'tau slash line break ')),
  )
  const project = join(root, 'project'),
    config = join(root, 'config')
  const key = 'sk-ant-slash-fixture-' + 'x'.repeat(24)
  mkdirSync(project)
  write(join(project, 'input.txt'), 'Read-only fixture input')
  write(join(project, '.claude', 'settings.json'), {
    promptSuggestionEnabled: false,
    permissions: { allow: ['Read'] },
    cleanupPeriodDays: 30,
  })
  write(join(config, '.claude.json'), {
    theme: 'dark',
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    activeProvider: 'firstParty',
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: {
      [project]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  })
  const requests = [],
    failures = []
  // Main-loop requests carry the full tool list; helper calls do not.
  const isMain = (body) =>
    body.tools?.some((tool) => tool.name === 'ExitPlanMode')
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'HEAD') return response.end()
      if (
        !request.url.includes('/messages') ||
        request.url.includes('count_tokens')
      )
        return response.end('{"input_tokens":1}')
      let raw = ''
      for await (const part of request) raw += part
      const body = JSON.parse(raw)
      requests.push(body)
      // The first main reply reads a file, so the same turn makes a second
      // request, which carries the reminders collected after the command ran.
      const value = !isMain(body)
        ? JSON.stringify({ title: 'Slash fixture', name: 'slash-fixture' })
        : requests.filter(isMain).length === 1
          ? [{ name: 'Read', input: { file_path: join(project, 'input.txt') } }]
          : 'SLASH_PLAN_SEEN'
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(anthropicReply(value, body.model))
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 'msg_slash_fixture',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: String(value) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
        )
      }
    } catch (error) {
      failures.push(String(error.stack ?? error))
      response.writeHead(500)
      response.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_)/i.test(name),
    ),
  )
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: config,
    TAU_SKIP_PREFLIGHT: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    NO_PROXY: '127.0.0.1,localhost',
    ENABLE_TOOL_SEARCH: 'false',
    DISABLE_AUTO_COMPACT: '1',
  })
  let term,
    raw = '',
    exited = false
  const screen = () => stripVTControlCharacters(raw).replace(/\s+/g, '')
  const details = () =>
    JSON.stringify({
      failures,
      requests: requests.map((body) => ({
        main: !!isMain(body),
        messages: JSON.stringify(body.messages).slice(0, 600),
      })),
      screen: stripVTControlCharacters(raw).slice(-3000),
    })
  try {
    term = pty.spawn(
      process.execPath,
      [
        cli,
        '--setting-sources',
        'project',
        '--model',
        'claude-sonnet-4-6',
        '--tools',
        'Write,Read,ExitPlanMode',
      ],
      { name: 'xterm-256color', cols: 140, rows: 45, cwd: project, env },
    )
    term.onData((value) => {
      raw += value
    })
    term.onExit(() => {
      exited = true
    })
    const ready = replStartupReady(term)
    await waitFor(() => ready(raw), 'REPL startup', 45_000, details)
    await pause(1500)
    // Bracketed paste, as a terminal sends pasted text with a line break.
    term.write(`\x1b[200~/plan\n${REQUEST}\x1b[201~`)
    await pause(500)
    term.write('\r')
    await waitFor(
      () => requests.some(isMain),
      'the request that follows the command',
      45_000,
      details,
    )
    const sent = JSON.stringify(requests.find(isMain).messages)
    assert.ok(
      sent.includes('<command-name>/plan</command-name>'),
      'the input ran as the /plan command',
    )
    assert.ok(
      sent.includes(`<command-args>${REQUEST}</command-args>`),
      'the text after the line break reached the model as its argument',
    )
    assert.ok(
      sent.includes('Enabled plan mode'),
      'the command turned plan mode on',
    )
    assert.ok(
      !sent.includes(`/plan\\n${REQUEST}`),
      'the input was not sent as an ordinary prompt',
    )
    // Reminders are collected before a command runs, so the plan-mode one
    // arrives with the turn's next request, as it does for "/plan <text>".
    await waitFor(
      () => requests.filter(isMain).length >= 2,
      'the request after the tool call',
      45_000,
      details,
    )
    assert.match(
      JSON.stringify(requests.filter(isMain)[1].messages),
      /You should create your plan at .+? using the Write tool/,
      'the turn runs in plan mode',
    )
    await waitFor(
      () => screen().includes('SLASH_PLAN_SEEN'),
      'the answer',
      45_000,
      details,
    )
    assert.equal(failures.length, 0, details())
    term.write('/exit')
    await pause(250)
    term.write('\r')
    await waitFor(() => exited, 'clean exit', 20_000, details)
    term = undefined
  } finally {
    if (term) {
      term.kill()
      await pause(400)
    }
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    const child = relative(temporaryRoot, root)
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
    // Let ConPTY's asynchronous disposal release the working directory.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
  }
}

if (process.argv.includes(PROBE)) {
  const pty = await loadPty()
  try {
    await runPastedPlanCommand(pty)
    process.exit(0)
  } catch (error) {
    process.stderr.write(String(error.stack ?? error) + '\n', () =>
      process.exit(1),
    )
  }
} else {
  const { build } = await import('esbuild')
  const built = await build({
    entryPoints: ['src/utils/slashCommandParsing.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  })
  const module = { exports: {} }
  Function('module', 'exports', built.outputFiles[0].text)(
    module,
    module.exports,
  )
  const { parseSlashCommand } = module.exports
  const known = (name) => name === 'plan' || name === 'review'
  const plan = (args) => ({ commandName: 'plan', args, isMcp: false })

  test('a line break or tab after a real command name ends the name', () => {
    for (const input of [
      '/plan\nAdd a login page',
      '/plan\r\nAdd a login page',
      '/plan\tAdd a login page',
      '  /plan\nAdd a login page\n',
    ]) {
      assert.deepEqual(
        parseSlashCommand(input, known),
        plan('Add a login page'),
        JSON.stringify(input),
      )
    }
    // Only the first line break belongs to the command; the rest is its text.
    assert.deepEqual(
      parseSlashCommand('/plan\n\n## Problem\nTwo lines', known),
      plan('\n## Problem\nTwo lines'),
    )
    assert.deepEqual(parseSlashCommand('/plan\n', known), plan(''))
  })

  test('input that only starts with a slash keeps its old reading', () => {
    // Not a command: the caller still sees a name that cannot be a command
    // and sends the text as an ordinary prompt.
    for (const input of [
      '/health\nendpoint is down',
      '/var/log\nsee the last lines',
      '/\nplan',
    ]) {
      assert.deepEqual(
        parseSlashCommand(input, known),
        parseSlashCommand(input),
        JSON.stringify(input),
      )
    }
    assert.equal(
      parseSlashCommand('/health\nendpoint is down', known).commandName,
      'health\nendpoint',
    )
    // Without a way to ask what is a command, nothing changes at all.
    assert.equal(
      parseSlashCommand('/plan\nAdd a login page').commandName,
      'plan\nAdd',
    )
  })

  test('commands written with a space are read as before', () => {
    for (const check of [known, undefined]) {
      assert.deepEqual(
        parseSlashCommand('/plan Add a login page', check),
        plan('Add a login page'),
      )
      assert.deepEqual(parseSlashCommand('/plan open', check), plan('open'))
      assert.deepEqual(parseSlashCommand('/plan', check), plan(''))
      assert.deepEqual(parseSlashCommand('/plan a\nb', check), plan('a\nb'))
      assert.deepEqual(parseSlashCommand('/mcp:tool (MCP) a b', check), {
        commandName: 'mcp:tool (MCP)',
        args: 'a b',
        isMcp: true,
      })
      assert.equal(parseSlashCommand('plan this', check), null)
      assert.equal(parseSlashCommand('/', check), null)
    }
  })

  test(
    'real REPL runs /plan when a line break follows it',
    { timeout: 150_000 },
    async (t) => {
      try {
        await execute(
          process.execPath,
          [fileURLToPath(import.meta.url), PROBE],
          {
            env: process.env,
            timeout: 140_000,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
          },
        )
      } catch (error) {
        if (error.code !== PTY_MISSING) throw error
        t.skip('node-pty is not installed')
      }
    },
  )
}
