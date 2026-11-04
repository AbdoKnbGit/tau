import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import { replStartupReady } from './helpers/repl-startup.mjs'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'
import xterm from '@xterm/headless'

// ConPTY can retain native handles on exit. Run the terminal in a child so
// the test worker still exits normally. The provider and config are local.
async function runTerminal() {
  const require = createRequire(import.meta.url)
  let pty
  try { pty = require('node-pty') } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && error.message.startsWith("Cannot find module 'node-pty'")) process.exit(77)
    throw error
  }
  if (process.platform === 'darwin') {
    const helper = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds', 'darwin-' + process.arch, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
  const root = mkdtempSync(join(tmpdir(), 'tau-mermaid-launch-'))
  const project = join(root, 'project')
  const config = join(root, 'config')
  const key = 'sk-ant-mermaid-local-test-00000000000000000000'
  mkdirSync(project)
  mkdirSync(config)
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', theme: 'dark', activeProvider: 'firstParty',
    projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
  }))
  const reply = Array.from({ length: 45 }, (_, i) => 'Checkpoint ' + (i + 1)).join('\n\n') +
    '\n\n\x60\x60\x60mermaid\nflowchart TD\n A[Start] --> B[End]\n\x60\x60\x60\n\nDiagramTail'
  const prompts = []
  let finishFirstReply
  const resized = new Promise(resolve => { finishFirstReply = resolve })
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/messages') || req.url.includes('count_tokens')) {
      res.end('{"input_tokens":1}')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    prompts.push(request)
    if (JSON.stringify(request.messages).includes('Draw a small flowchart')) await resized
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(anthropicReply(JSON.stringify(request.messages).includes('SecondDiagramCheck') ? 'SettingConfirmed' : reply, request.model))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|USER_TYPE$|TMUX|TERM$|TERM_PROGRAM|CI$)/i.test(name)))
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: config, TAU_SKIP_PREFLIGHT: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    NO_PROXY: '127.0.0.1,localhost',
  })
  let term, raw = '', exited = false
  const display = new xterm.Terminal({ cols: 110, rows: 32, allowProposedApi: true })
  async function until(check, label, timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline && !exited) {
      if (check()) return
      await pause(100)
    }
    throw new Error(label + '\nTerminal screen: ' + screenText())
  }
  const screenText = () => Array.from({ length: display.rows }, (_, i) =>
    display.buffer.active.getLine(display.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n')
  const visible = () => screenText().replace(/\s+/g, '')
  const resize = (columns, rows) => { display.resize(columns, rows); term.resize(columns, rows) }
  try {
    term = pty.spawn(process.execPath, [resolve('dist/cli.mjs'), '--strict-mcp-config', '--model', 'claude-sonnet-4-6'], {
      cwd: project, env, name: 'xterm-256color', cols: 110, rows: 32,
    })
    term.onData(data => { raw += data; display.write(data) })
    term.onExit(() => { exited = true })
    const ready = replStartupReady(term)
    await until(() => ready(raw), 'REPL startup')
    await pause(1200)
    term.write('Draw a small flowchart')
    await pause(350)
    term.write('\r')
    await until(() => prompts.some(request => JSON.stringify(request.messages).includes('Choose flowchart TD')), 'first request in flight')
    const waitForSpinner = async label => {
      const from = raw.length
      await until(() => new Set(raw.slice(from).match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu)).size >= 4, label, 5000)
    }
    await waitForSpinner('spinner advances while the provider sends no bytes')
    resize(86, 22)
    await pause(150)
    resize(110, 32)
    await waitForSpinner('spinner keeps advancing after resize without user input')
    finishFirstReply()
    // No scroll or keyboard event to wake the display after completion.
    await until(() => visible().includes('Copydiagramart') && visible().includes('DiagramTail'), 'normal launch renders diagram controls')
    assert.ok(prompts.some(request => JSON.stringify(request.messages).includes('Choose flowchart TD')), 'the model received the enabled diagram guidance')
    await pause(500)
    let from = raw.length
    term.write('\x1b[5~') // Page Up
    await until(() => visible(from).includes('Jumptobottom'), 'scrolling up reveals Jump to bottom')
    from = raw.length
    term.write('\x1b[1;5F') // Ctrl+End
    await until(() => visible(from).includes('DiagramTail'), 'Ctrl+End restores the diagram at the bottom')
    const submit = async text => { term.write(text); await pause(350); term.write('\r') }
    from = raw.length
    await submit('/config')
    await until(() => visible(from).includes('Searchsettings'), 'open /config')
    from = raw.length
    term.write('Draw diagrams')
    await until(() => visible(from).includes('Drawdiagrams'), 'find Draw diagrams')
    term.write('\x1b[B')
    await pause(150)
    term.write(' ')
    const settingsFile = join(project, '.claude', 'settings.local.json')
    await until(() => existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, 'utf8')).mermaidDiagrams === false, 'save explicit false')
    term.write('\r')
    await pause(500)
    from = raw.length
    await submit('SecondDiagramCheck')
    await until(() => visible(from).includes('SettingConfirmed'), 'reply after turning diagrams off')
    const first = prompts.find(request => JSON.stringify(request.messages).includes('Choose flowchart TD'))
    const next = prompts.find(request => JSON.stringify(request.messages).includes('SecondDiagramCheck'))
    const guides = messages => messages.flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.map(block => block.text))
      .filter(text => text?.includes('Choose flowchart TD'))
    assert.equal(guides(first.messages).length, 1)
    assert.deepEqual(guides(next.messages), guides(first.messages), 'existing guidance survives a /config switch byte-for-byte')
    assert.match(JSON.stringify(next.messages), /Diagram drawing is now off/)
    await submit('/rewind')
    await until(() => visible().includes('(current)') && visible().includes('Esctoexit'), 'Rewind selected entry and footer are visible on opening')
    term.write('\x1b')
    await until(() => !visible().includes('Restorethecode'), 'Rewind closes')
    // The current session is intentionally excluded by /resume. Clone its
    // local fixture transcript under another id to exercise the real picker.
    const projects = join(config, 'projects')
    const savedId = randomUUID()
    const files = readdirSync(projects, { recursive: true }).filter(file => file.endsWith('.jsonl') && !file.includes('subagents'))
    assert.ok(files.length, 'the local conversation was persisted')
    const transcript = join(projects, files[0])
    const oldId = JSON.parse(readFileSync(transcript, 'utf8').trim().split('\n').find(line => JSON.parse(line).sessionId)).sessionId
    writeFileSync(join(dirname(transcript), savedId + '.jsonl'), readFileSync(transcript, 'utf8').replaceAll(oldId, savedId))
    await submit('/resume')
    await until(() => visible().includes('ResumeSession') && visible().includes('tocancel'), 'Resume opens with its controls visible')
    term.write('\x1b')
    await until(() => !visible().includes('ResumeSession'), 'Resume closes')
    await submit('/clear')
    // Nothing is sent to the terminal while waiting for the fresh session.
    await until(() => visible().includes('Tauv') && !visible().includes('SettingConfirmed') && !visible().includes('Drizzling'), '/clear restores welcome without scrolling or typing')
    assert.ok(!visible().includes('Jumptobottom'), 'fresh session has no stale scroll pill')
  } finally {
    finishFirstReply()
    if (term && !exited) { term.kill(); await pause(500) }
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    display.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

if (process.argv.includes('--pty-probe')) {
  try { await runTerminal(); process.exit(0) }
  catch (error) { process.stderr.write(String(error.stack) + '\n', () => process.exit(1)) }
} else {
  test('interactive Tau draws Mermaid and scrolls back to it without feature flags', { timeout: 140000 }, async t => {
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--pty-probe'], { timeout: 135000, windowsHide: true })
    } catch (error) {
      if (error.code === 77) t.skip('node-pty is not installed')
      else throw error
    }
  })
}
