import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

function loadSource(file, dependencies, context = {}) {
  const module = { exports: {} }
  const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code
  runInNewContext(code, { module, exports: module.exports, Buffer, process, require: name => {
    if (name in dependencies) return dependencies[name]
    throw new Error(`Unexpected dependency: ${name}`)
  }, ...context }, { filename: file })
  return module.exports
}

const { win32 } = await import('node:path')
const helper = loadSource('src/utils/windowsClipboardText.ts', { buffer: { Buffer }, 'node:path': { win32 } })
const sample = '┌─┐\n│ User Request │\n└─┘ ▼ café — مرحبا — 東京 — ✓ — 😀'

function clipboard(platform, environment = {}, exec = async () => ({ code: 0 })) {
  const calls = []
  const runtime = loadSource('src/ink/termio/osc.ts', {
    buffer: { Buffer },
    '../../utils/env.js': { env: { terminal: 'other' } },
    '../../utils/windowsClipboardText.js': helper,
    '../../utils/execFileNoThrow.js': { execFileNoThrow: (...args) => { calls.push(args); return exec(...args) } },
    './ansi.js': { BEL: '\x07', ESC: '\x1b', ESC_TYPE: { OSC: 0x5d }, SEP: ';' },
  }, { process: { platform, env: { ...environment } } })
  return { runtime, calls }
}

test('Windows payload is locale-independent and never interpolated into commands', () => {
  const fixtures = [sample, '', 'a\r\nb\nc', '"; $(Write-Output injected); `exit` & | < >', 'a'.repeat(100000)]
  const baseline = helper.windowsClipboardTextCommand('', { SystemRoot: 'D:\\OS' })
  for (const text of fixtures) {
    const command = helper.windowsClipboardTextCommand(text, { SystemRoot: 'D:\\OS' })
    assert.equal(command.file, 'D:\\OS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(Array.from(command.args), Array.from(baseline.args))
    assert.match(command.input, /^[A-Za-z0-9+/=]*$/)
    assert.equal(Buffer.from(command.input, 'base64').toString('utf8'), text)
    assert.ok(command.args.includes('-STA'))
    assert.match(command.args.at(-1), /UnicodeText/)
  }
})

test('Windows program path follows environment without a hardcoded drive', () => {
  assert.equal(helper.windowsClipboardTextCommand('x', { systemroot: 'E:\\Windows' }).file, 'E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(helper.windowsClipboardTextCommand('x', { WINDIR: 'F:\\OS' }).file, 'F:\\OS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  for (const root of ['relative', 'C:\\Windows\nother', '\\\\remote\\share']) {
    assert.equal(helper.windowsClipboardTextCommand('x', { SystemRoot: root }).file, 'powershell.exe')
  }
})

test('local Windows awaits bounded native copying while preserving UTF-8 OSC52', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { runtime, calls } = clipboard('win32', { SystemRoot: 'D:\\OS' }, () => pending)
  let completed = false
  const result = runtime.setClipboard(sample).then(value => { completed = true; return value })
  await new Promise(setImmediate)
  assert.equal(completed, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].timeout, 2000)
  assert.equal(calls[0][2].useCwd, false)
  assert.equal(Buffer.from(calls[0][2].input, 'base64').toString('utf8'), sample)
  release({ code: 0 })
  const sequence = await result
  assert.equal(Buffer.from(sequence.split(';')[2].slice(0, -1), 'base64').toString('utf8'), sample)
})

test('SSH bypasses native Windows clipboard and tmux still receives original text', async () => {
  const remote = clipboard('win32', { SSH_CONNECTION: 'remote' })
  assert.ok((await remote.runtime.setClipboard(sample)).includes(']52;c;'))
  assert.equal(remote.calls.length, 0)
  const tmux = clipboard('win32', { SSH_CONNECTION: 'remote', TMUX: '/session' })
  const sequence = await tmux.runtime.setClipboard(sample)
  assert.equal(tmux.calls.length, 1)
  assert.equal(tmux.calls[0][0], 'tmux')
  assert.equal(tmux.calls[0][2].input, sample)
  assert.ok(sequence.startsWith('\x1bPtmux;'))
})

test('native failure retains OSC52 and other platforms keep existing clipboard routing', async () => {
  const failed = clipboard('win32', {}, async () => ({ code: 1 }))
  assert.ok((await failed.runtime.setClipboard(sample)).includes(']52;c;'))
  assert.equal(failed.calls.length, 1)
  const mac = clipboard('darwin')
  await mac.runtime.setClipboard(sample)
  assert.equal(mac.calls[0][0], 'pbcopy')
  assert.equal(mac.calls[0][2].input, sample)
  assert.equal(mac.calls[0][2].env.LC_ALL, 'en_US.UTF-8')
  const linux = clipboard('linux')
  await linux.runtime.setClipboard(sample)
  assert.equal(linux.calls[0][0], 'wl-copy')
  assert.equal(linux.calls[0][2].input, sample)
  assert.deepEqual(Array.from(linux.calls[0][1]), ['--type', 'text/plain;charset=utf-8'])
})

test('copy reports confirmed native success and retries a stale Linux backend', async () => {
  let available = 'xclip'
  const { runtime, calls } = clipboard('linux', {}, async file => ({ code: file === available ? 0 : 1 }))
  assert.equal((await runtime.copyClipboardText(sample)).path, 'native')
  assert.deepEqual(calls.map(([file]) => file), ['wl-copy', 'xclip'])
  assert.ok(calls[1][1].includes('UTF8_STRING'))
  assert.equal(calls[1][2].discardOutput, true)
  available = 'wl-copy'
  assert.equal((await runtime.copyClipboardText(sample)).path, 'native')
  assert.deepEqual(calls.slice(2).map(([file]) => file), ['xclip', 'wl-copy'])
  available = ''
  assert.equal((await runtime.copyClipboardText(sample)).path, 'osc52')
  available = 'xsel'
  assert.equal((await runtime.copyClipboardText(sample)).path, 'native')
})

// Hosted macOS runners have a disposable pasteboard. Never replace the
// mixed-format clipboard of a developer running the normal test suite.
test('hosted macOS copies Unicode through the real pasteboard under a C locale', {
  skip: process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted',
}, async () => {
  const { runtime } = clipboard('darwin', { LC_ALL: 'C' }, async (file, args, opts) => {
    execFileSync(file, args, { input: opts.input, env: { ...process.env, LC_ALL: 'C', ...opts.env }, timeout: opts.timeout })
    return { code: 0 }
  })
  assert.equal((await runtime.copyClipboardText(sample)).path, 'native')
  assert.equal(execFileSync('pbpaste', [], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' }, timeout: 2000 }), sample)
})

function runCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Clipboard helper timed out')) }, 5000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Clipboard helper failed: ${stderr}`)) })
    child.stdin.end(command.input)
  })
}

test('live Windows clipboard round trip preserves glyphs and restores prior contents', {
  skip: process.platform !== 'win32' || process.env.TAU_CLIPBOARD_E2E !== '1', timeout: 30000,
}, async () => {
  const command = helper.windowsClipboardTextCommand('', process.env)
  const supervisorScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$saved = [Windows.Forms.Clipboard]::GetDataObject()
try {
  [Console]::Out.WriteLine('ready')
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line -eq 'stop') { break }
    $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    # Clipboard listeners can briefly hold the global clipboard after a write.
    # GetText can return empty during that interval. Only retry the read.
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
      $actual = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
      if ($actual -ceq $expected) { break }
      Start-Sleep -Milliseconds 30
    } while ($deadline.ElapsedMilliseconds -lt 900)
    [Console]::Out.WriteLine($(if ($actual -ceq $expected) { 'match' } elseif ($actual.Replace("\`r\`n", "\`n") -ceq $expected.Replace("\`r\`n", "\`n")) { 'newline mismatch' } else { 'mismatch (read ' + $actual.Length + ' UTF-16 units, expected ' + $expected.Length + ')' }))
  }
} finally {
  if ($null -eq $saved) { [Windows.Forms.Clipboard]::Clear() } else { [Windows.Forms.Clipboard]::SetDataObject($saved, $true) }
}
`
  const supervisor = spawn(command.file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(supervisorScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  supervisor.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const closed = new Promise(resolve => supervisor.once('close', code => resolve(code)))
  const lines = createInterface({ input: supervisor.stdout })[Symbol.asyncIterator]()
  try {
    assert.equal((await lines.next()).value, 'ready', stderr)
    for (const [name, text] of Object.entries({ unicode: sample, newlines: 'a\r\nb\nc', literal: 'literal $() ` & | < >', empty: '' })) {
      await runCommand(helper.windowsClipboardTextCommand(text, process.env))
      supervisor.stdin.write(Buffer.from(text, 'utf8').toString('base64') + '\n')
      assert.equal((await lines.next()).value, 'match', name)
    }
  } finally {
    supervisor.stdin.end('stop\n')
    assert.equal(await closed, 0, stderr)
  }
})
