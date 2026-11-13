// Real terminal + real CLI + local HTTP provider. In particular, do not replace
// the approval controller, query loop, command queue, or permission callbacks.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'
import { replStartupReady } from './helpers/repl-startup.mjs'

const execute = promisify(execFile)
const cli = resolve(process.env.PROBE_CLI ?? 'dist/cli.mjs')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const PTY_MISSING = 77
// Cache markers may move to a newer boundary; model-visible historical content
// and the static system/tools prefix must remain unchanged.
function withoutCacheMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, nested]) => [key, withoutCacheMarkers(nested)]),
  )
}
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
async function waitFor(
  check,
  label,
  milliseconds = 45_000,
  details = () => '',
) {
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
function allRows(config) {
  const directory = join(config, 'projects')
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((project) => {
    const path = join(directory, project)
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .flatMap((entry) =>
        readFileSync(join(path, entry.name), 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)]
            } catch {
              return []
            }
          }),
      )
  })
}

// keep/clear: the title arrives while the post-approval tool stream is open.
// idle: it arrives after that turn has ended and the REPL is waiting for input.
async function runApproval(pty, mode) {
  const clearContext = mode === 'clear'
  const idle = mode === 'idle'
  // The CLI works in the resolved directory (on macOS /var is /private/var),
  // so paths expected here must start from it too.
  const temporaryRoot = realpathSync.native(tmpdir())
  const root = realpathSync.native(
    mkdtempSync(join(temporaryRoot, 'tau real plan approval ')),
  )
  const project = join(root, 'project with spaces'),
    config = join(root, 'config')
  const plans = join(project, 'plans with spaces')
  const session = randomUUID(),
    key = 'sk-ant-plan-fixture-' + 'x'.repeat(24)
  const title = `${mode}-plan-execution`
  const plan =
    '# Preserve approval execution\r\n\r\nRead input.txt, then report APPROVAL_CONTINUED.\r\n'
  const expectedHash = createHash('sha256').update(plan).digest('hex')
  mkdirSync(project)
  write(join(project, 'input.txt'), 'Read-only fixture input\n')
  write(join(project, '.claude', 'settings.json'), {
    plansDirectory: 'plans with spaces',
    showClearContextOnPlanAccept: clearContext,
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
  // A real stdio MCP server, as most users have. /clear resets MCP state, and
  // a clear-context approval sends its first request right after that reset.
  // Listing tools takes a moment, like a real server starting its runtime.
  const mcpConfig = join(root, 'mcp.json')
  write(mcpConfig, {
    mcpServers: {
      'plan-fixture': {
        type: 'stdio',
        command: process.execPath,
        args: [resolve('test/fixtures/slow-mcp-server.mjs')],
        env: { FIXTURE_LIST_DELAY_MS: '2500', FIXTURE_TOOL_COUNT: '1' },
      },
    },
  })
  let phase = 0,
    titleResponse,
    titleBody,
    mainStream,
    oldPath,
    planningRequest,
    titleAllowed = !idle,
    prematureClose = false
  const requests = [],
    failures = []
  // Main-loop requests carry the full tool list; helper calls do not.
  const mainRequests = () =>
    requests.filter((body) =>
      body.tools?.some((tool) => tool.name === 'ExitPlanMode'),
    )
  const reply = (response, body, value) => {
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(anthropicReply(value, body.model))
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: `msg_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: value }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      )
    }
  }
  const releaseTitle = () => {
    if (titleResponse && (idle ? titleAllowed : mainStream)) {
      reply(titleResponse, titleBody, JSON.stringify({ name: title }))
      titleResponse = undefined
    }
  }
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
      const system = JSON.stringify(body.system)
      if (system.includes('Generate a short kebab-case name')) {
        titleResponse = response
        titleBody = body
        releaseTitle()
        return
      }
      if (!body.tools?.some((tool) => tool.name === 'ExitPlanMode')) {
        reply(
          response,
          body,
          JSON.stringify({ title: 'Plan fixture', name: 'plan-fixture' }),
        )
        return
      }
      if (phase === 0) {
        const messages = body.messages
          .flatMap((message) =>
            typeof message.content === 'string'
              ? [message.content]
              : message.content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text),
          )
          .join('\n')
        oldPath = messages.match(
          /You should create your plan at (.+?) using the Write tool/,
        )?.[1]
        assert.ok(
          oldPath,
          'the real model request must advertise its plan path',
        )
        assert.equal(dirname(oldPath), plans)
        phase++
        reply(response, body, [
          { name: 'Write', input: { file_path: oldPath, content: plan } },
        ])
      } else if (phase === 1) {
        phase++
        planningRequest = body
        reply(response, body, [{ name: 'ExitPlanMode', input: {} }])
      } else if (phase === 2 && idle) {
        phase++
        reply(response, body, [
          { name: 'Read', input: { file_path: join(project, 'input.txt') } },
        ])
      } else if (phase === 2) {
        phase++
        const wire = anthropicReply(
          [{ name: 'Read', input: { file_path: join(project, 'input.txt') } }],
          body.model,
        )
        const split = wire.indexOf('event: message_delta')
        assert.ok(split > 0)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(wire.slice(0, split))
        mainStream = {
          response,
          tail: wire.slice(split),
          released: false,
          request: body,
        }
        response.once('close', () => {
          if (!mainStream.released) prematureClose = true
        })
        releaseTitle()
      } else {
        reply(response, body, 'APPROVAL_CONTINUED')
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
  const details = () =>
    JSON.stringify({
      phase,
      failures,
      requests: requests.map((body) => ({
        model: body.model,
        system: JSON.stringify(body.system).slice(0, 120),
      })),
      screen: stripVTControlCharacters(raw).slice(-6000),
      rows: allRows(config).slice(-4),
    })
  const submit = async (text) => {
    term.write(text)
    await pause(250)
    term.write('\r')
  }
  try {
    term = pty.spawn(
      process.execPath,
      [
        cli,
        '--session-id',
        session,
        '--permission-mode',
        'plan',
        '--setting-sources',
        'project',
        '--strict-mcp-config',
        '--mcp-config',
        mcpConfig,
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
    await submit('Create the read-only fixture plan, then ask for approval.')
    await waitFor(
      () =>
        stripVTControlCharacters(raw)
          .replace(/\s+/g, '')
          .includes('auto-acceptedits'),
      'plan approval dialog',
      45_000,
      details,
    )
    assert.equal(exited, false)
    assert.equal(readFileSync(oldPath, 'utf8'), plan)
    // Both configurations put the requested auto-accept option first. Clear
    // context is an explicit separate scenario, not inferred from a label.
    term.write('1')
    const answered = () =>
      allRows(config).some(
        (row) =>
          row.type === 'assistant' &&
          row.message?.content?.some(
            (block) => block.text === 'APPROVAL_CONTINUED',
          ),
      )
    let beforeNotice
    if (idle) {
      await waitFor(answered, 'post-approval turn end', 45_000, details)
      // Let the REPL finish the turn and return to waiting for input.
      await pause(1500)
      const settled = mainRequests().length
      beforeNotice = mainRequests().at(-1)
      titleAllowed = true
      releaseTitle()
      await waitFor(
        () => existsSync(join(plans, `${title}.md`)),
        'background title rename',
        45_000,
        details,
      )
      await pause(3000)
      assert.equal(
        mainRequests().length,
        settled,
        'a rename after the turn ended must not start a model turn by itself',
      )
      await submit('Continue with the saved plan.')
      await waitFor(
        () => mainRequests().length > settled,
        'follow-up request',
        45_000,
        details,
      )
      await waitFor(
        () =>
          allRows(config).filter(
            (row) =>
              row.type === 'assistant' &&
              row.message?.content?.some(
                (block) => block.text === 'APPROVAL_CONTINUED',
              ),
          ).length >= 2,
        'follow-up answer',
        45_000,
        details,
      )
    } else {
      await waitFor(
        () => mainStream !== undefined,
        'post-approval active model stream',
        45_000,
        details,
      )
      await waitFor(
        () => existsSync(join(plans, `${title}.md`)),
        'background title rename',
        45_000,
        details,
      )
      await pause(750)
      assert.equal(
        prematureClose,
        false,
        'the path notification must not abort a live model stream',
      )
      assert.equal(mainStream.response.destroyed, false)
      mainStream.released = true
      mainStream.response.end(mainStream.tail)
      await waitFor(answered, 'continued assistant answer', 45_000, details)
      beforeNotice = mainStream.request
    }
    const rows = allRows(config)
    const reference = rows.findLast((row) => row.type === 'plan-file-reference')
    assert.ok(reference)
    assert.equal(reference.planFileReference.filename, `${title}.md`)
    assert.equal(reference.planFileReference.planId, basename(oldPath, '.md'))
    assert.equal(
      reference.sessionId === session,
      !clearContext,
      'only clear-context approval changes session ID',
    )
    const executionRows = rows.filter(
      (row) => row.sessionId === reference.sessionId,
    )
    assert.ok(
      !executionRows.some((row) =>
        /Interrupted by user/.test(JSON.stringify(row.message?.content)),
      ),
      'execution must not be cancelled by naming',
    )
    assert.equal(fsHash(join(plans, `${title}.md`)), expectedHash)
    assert.equal(existsSync(oldPath), false)
    assert.equal(failures.length, 0, details())
    const notifiedRequest = requests.find((body) =>
      JSON.stringify(body.messages).includes(
        'Use the new path for future reads or edits',
      ),
    )
    assert.ok(
      notifiedRequest,
      'the real query loop must consume the new-path notice',
    )
    assert.ok(
      JSON.stringify(notifiedRequest.messages).includes(
        JSON.stringify(`to ${join(plans, `${title}.md`)}.`).slice(1, -1),
      ),
      'the model receives the current path as written',
    )
    assert.deepEqual(
      withoutCacheMarkers(notifiedRequest.system),
      withoutCacheMarkers(beforeNotice.system),
      'background naming and its reminder must preserve the static system prefix',
    )
    assert.deepEqual(
      withoutCacheMarkers(notifiedRequest.tools),
      withoutCacheMarkers(beforeNotice.tools),
      'background naming and its reminder must preserve tool definitions and order',
    )
    assert.deepEqual(
      withoutCacheMarkers(
        notifiedRequest.messages.slice(0, beforeNotice.messages.length),
      ),
      withoutCacheMarkers(beforeNotice.messages),
      'the reminder must append conversation content without rewriting the earlier request prefix',
    )
    assert.equal(
      JSON.stringify(notifiedRequest.messages).split(
        'Use the new path for future reads or edits',
      ).length - 1,
      1,
      'the same rename notice must enter model history only once',
    )
    const hasMcpTool = (body) =>
      (body.tools ?? []).some(
        (tool) => tool.name.startsWith('mcp__') && tool.name.endsWith('tool_0'),
      )
    assert.ok(hasMcpTool(planningRequest), 'the planning session has MCP tools')
    assert.ok(
      hasMcpTool(beforeNotice),
      'MCP tools stay available from the first request after approval',
    )
    if (clearContext)
      assert.deepEqual(
        withoutCacheMarkers(beforeNotice.tools),
        withoutCacheMarkers(planningRequest.tools),
        'clear-context approval keeps the tool list, so its first request can reuse the cached tools prefix',
      )
    const screen = stripVTControlCharacters(raw)
    // Like the checks above, ignore spacing: with NO_COLOR some gaps are drawn
    // as cursor moves, which leave no space once escape codes are stripped.
    assert.match(
      screen.replace(/\s+/g, ''),
      /Planrenamedto/,
      'the user sees a one-line rename notice',
    )
    assert.doesNotMatch(
      screen,
      /<system-reminder>/,
      'model-only reminder markup must not appear as a user prompt',
    )
    await submit('/exit')
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
    // Let ConPTY's asynchronous disposal release the working directory between
    // retries; a synchronous delete can keep those close callbacks from running.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
  }
}
const fsHash = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

const probe = process.argv.indexOf('--plan-approval-probe')
if (probe !== -1) {
  const pty = await loadPty()
  try {
    await runApproval(pty, process.argv[probe + 1])
    process.exit(0)
  } catch (error) {
    process.stderr.write(String(error.stack ?? error) + '\n', () =>
      process.exit(1),
    )
  }
} else {
  for (const mode of ['keep', 'clear', 'idle']) {
    test(
      mode === 'idle'
        ? 'real REPL rename after the turn ends waits for the next prompt instead of starting a turn'
        : `real REPL ${mode}-context approval survives naming while model tools stream`,
      { timeout: 150_000 },
      async (t) => {
        try {
          await execute(
            process.execPath,
            [fileURLToPath(import.meta.url), '--plan-approval-probe', mode],
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
}
