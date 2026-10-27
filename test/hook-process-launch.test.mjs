import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const previous = process.cwd()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-hook-launch-')))
const project = join(root, 'project with spaces é')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/hooks.ts', 'src/utils/cwd.ts', 'src/utils/hooks/shellResolution.ts', 'src/utils/hooks/commandProcess.ts', 'src/utils/executablePath.ts'],
  exports: ['execCommandHook', 'runWithCwdOverride', 'setOriginalCwd', 'getOriginalCwd', 'setIsInteractive', 'getHookGitBashPath', 'getHookPowerShellPath', 'startHookProcess', 'executablePaths'],
})
r.setIsInteractive(false)
r.setOriginalCwd(project)
after(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true, maxRetries: 10 }) })
const run = (hook, event = 'PostToolUse', skillRoot) => r.execCommandHook(
  { type: 'command', timeout: 5, ...hook }, event, 'launch regression',
  JSON.stringify({ hook_event_name: event, cwd: project, tool_name: 'Read', unicode: '漢字' }),
  new AbortController().signal, 'launch-regression', 0, undefined, undefined, skillRoot,
)
const node = script => ({ command: process.execPath, args: ['-e', script] })
const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`
const shellNode = shellQuote(process.execPath.replaceAll('\\', '/'))

test('missing executable fails before a background hook can claim success', async () => {
  for (const async of [false, true]) {
    await assert.rejects(run({ command: join(project, 'absent-program'), args: ['private-argument'], async }), error => {
      assert.match(error.message, /ENOENT/)
      assert.ok(error.message.includes(project), error.message)
      assert.match(error.message, /working directory/i)
      assert.ok(!error.message.includes('private-argument'))
      return true
    })
  }
})

test('a missing or file-valued agent cwd falls back to the original directory', async () => {
  const file = join(project, 'not a directory')
  writeFileSync(file, 'file')
  for (const cwd of [join(project, 'removed worktree'), file]) {
    const result = await r.runWithCwdOverride(cwd, () => run(node('console.log(process.cwd())')))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(realpathSync(result.stdout.trim()), project)
  }
})

test('two invalid working directories produce a cwd diagnosis without launching', async () => {
  r.setOriginalCwd(join(root, 'missing original'))
  try {
    await assert.rejects(r.runWithCwdOverride(join(root, 'missing agent'), () => run(node('process.exit(2)'))), /working directory.*unavailable/i)
  } finally { r.setOriginalCwd(project) }
})

test('a shell argument ending in .sh does not change the executable', async () => {
  const result = await run({ command: `${shellNode} -e ${shellQuote('console.log(process.argv[1])')} -- "report.sh"` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'report.sh')
})

test('quoted bare shell scripts still launch from directories with spaces', async () => {
  const script = join(project, 'hook script.sh')
  writeFileSync(script, '#!/bin/sh\nprintf "SCRIPT-OK\\n"\n')
  chmodSync(script, 0o755)
  const result = await run({ command: shellQuote(script.replaceAll('\\', '/')) })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'SCRIPT-OK')
})

test('skill root interpolation applies before the final shell command is built', async () => {
  const result = await run({ command: "printf '%s' '${CLAUDE_SKILL_DIR}'" }, 'PostToolUse', project)
  assert.equal(result.status, 0, result.stderr)
  const expected = process.platform === 'win32' ? project.replace(/^([A-Z]):/i, (_, drive) => '/' + drive.toLowerCase()).replaceAll('\\', '/') : project
  assert.equal(result.stdout, expected)
})

test('exec hooks keep literal argv, JSON stdin, native roots and an environment file independently of shell choice', async () => {
  const values = ['a b', '"quotes"', '& echo not-a-command', '$(false)', '', '漢字', 'line\nbreak', 'report.sh']
  const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({argv:process.argv.slice(1),input:JSON.parse(input),root:process.env.CLAUDE_SKILL_DIR,envFile:process.env.CLAUDE_ENV_FILE})))`
  for (const shell of ['bash', 'powershell']) {
    const result = await run({ command: process.execPath, args: ['-e', script, '--', ...values], shell }, 'SessionStart', project)
    assert.equal(result.status, 0, result.stderr)
    const data = JSON.parse(result.stdout)
    assert.deepEqual(data.argv, values)
    assert.equal(data.input.unicode, '漢字')
    assert.equal(data.root, project)
    assert.ok(data.envFile, 'exec form must not depend on an unused shell setting')
  }
})

test('a hook that exits before consuming a large stdin cannot crash the parent', async () => {
  const result = await r.execCommandHook(
    { type: 'command', ...node('process.exit(0)'), timeout: 5, async: true },
    'PostToolUse', 'early exit', JSON.stringify({ body: 'x'.repeat(2_000_000) }),
    new AbortController().signal, 'early-exit',
  )
  assert.equal(result.status, 0, result.stderr)
  // Let late pipe errors arrive before the test process shuts down.
  await new Promise(resolve => setTimeout(resolve, 150))
})

test('PATH and relative executable lookup preserve stdin and argument boundaries', async () => {
  const script = join(project, 'read input.cjs')
  writeFileSync(script, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({input:JSON.parse(input),args:process.argv.slice(2)})))`)
  const arguments_ = ['a b', 'é漢字', '& ignored', '%PATH%', '']
  const result = await run({ command: 'node', args: [script, ...arguments_] })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.deepEqual(data.args, arguments_)
  assert.equal(data.input.unicode, '漢字')
  if (process.platform !== 'win32') {
    const launcher = join(project, 'relative-hook')
    writeFileSync(launcher, '#!/bin/sh\nprintf "RELATIVE-OK\\n"\n'); chmodSync(launcher, 0o755)
    const relative = await run({ command: './relative-hook', args: [] })
    assert.equal(relative.status, 0, relative.stderr)
    assert.equal(relative.stdout.trim(), 'RELATIVE-OK')
  }
})

test('Python hooks receive the same JSON protocol without Node-specific rewriting', async t => {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const probe = spawnSync(python, ['--version'], { timeout: 5000, windowsHide: true })
  if (probe.error || probe.status !== 0) return t.skip('Python is not installed')
  const script = join(project, 'python hook.py')
  writeFileSync(script, 'import json, sys\ndata = json.load(sys.stdin)\nprint(json.dumps({"input": data, "args": sys.argv[1:]}))\n')
  const result = await run({ command: python, args: [script, 'a b', '; literal', '漢字'] })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.input.unicode, '漢字')
  assert.deepEqual(data.args, ['a b', '; literal', '漢字'])
})

test('PowerShell hooks launch with explicit shell selection and native skill paths', async t => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 5000, windowsHide: true })
  if (probe.error || probe.status !== 0) return t.skip('PowerShell 7 is not installed')
  const result = await run({ shell: 'powershell', command: '$data = [Console]::ReadLine() | ConvertFrom-Json; @{root = $env:CLAUDE_SKILL_DIR; unicode = $data.unicode} | ConvertTo-Json -Compress' }, 'PostToolUse', project)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {root: project, unicode: '漢字'})
  for (const command of [
    "param([string]$value='default'); [Console]::Write($value)",
    "using namespace System.Text; param([string]$value='default'); [Console]::Write($value)",
    "begin { $value='default' } end { [Console]::Write($value) }",
    "begin <# { comment, not the opening brace #> { $value='default' } end { [Console]::Write($value) }",
    "end { [Console]::Write('default') }",
  ]) {
    const result = await run({ shell: 'powershell', command })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, 'default')
  }
  const pipeline = await run({ shell: 'powershell', command: '$input | ForEach-Object { $_ }' })
  assert.equal(pipeline.status, 0, pipeline.stderr)
  assert.equal(JSON.parse(pipeline.stdout).tool_name, 'Read')
  assert.equal(JSON.parse(pipeline.stdout).unicode, '漢字')
  const denied = await run({ shell: 'powershell', command: 'exit 2' })
  assert.equal(denied.status, 2)
})

test('Windows batch hooks require explicit shell invocation and report direct-exec errors', { skip: process.platform !== 'win32' }, async () => {
  const script = join(project, 'batch hook.cmd')
  writeFileSync(script, '@echo off\r\necho BATCH-OK\r\n')
  await assert.rejects(run({ command: script, args: [] }), /Batch scripts require an explicit/)
  const result = await run({ shell: 'powershell', command: `& '${script.replaceAll("'", "''")}'` })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'BATCH-OK')
})

test('Windows PowerShell 5.1 fallback preserves Unicode JSON and script syntax', { skip: process.platform !== 'win32' }, async t => {
  const path = r.executablePaths('powershell')[0]
  if (!path) return t.skip('Windows PowerShell is not installed')
  const previous = process.env.PATH
  try {
    process.env.PATH = dirname(path)
    const result = await run({ shell: 'powershell', command: "param([string]$value='漢字'); $data = $input | ConvertFrom-Json; @{expected=$value; actual=$data.unicode; root=$env:CLAUDE_SKILL_DIR} | ConvertTo-Json -Compress" }, 'PostToolUse', project)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), {expected: '漢字', actual: '漢字', root: project})
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})

test('non-executable scripts report permissions instead of looking like policy decisions', { skip: process.platform === 'win32' }, async () => {
  const script = join(project, 'not executable.sh')
  writeFileSync(script, '#!/bin/sh\nexit 2\n'); chmodSync(script, 0o644)
  await assert.rejects(run({ command: script, args: [] }), /EACCES.*permissions/)
})

test('already cancelled hooks never start a child process', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(r.execCommandHook(
    { type: 'command', ...node('process.exit(2)') }, 'PostToolUse', 'cancelled', '{}', controller.signal, 'cancelled',
  ), error => error.name === 'AbortError')
})

test('cancellation while the child is starting stops it before ownership transfer', async () => {
  const controller = new AbortController()
  const marker = join(project, 'cancelled-child-marker')
  const pending = r.startHookProcess(process.execPath, ['-e', `setTimeout(()=>require('fs').writeFileSync(process.argv[1],'ran'),200)`, marker], { cwd: project, windowsHide: true }, controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(existsSync(marker), false)
})

test('Git Bash hook resolution observes changed overrides and a removed executable', { skip: process.platform !== 'win32' }, () => {
  const prior = process.env.CLAUDE_CODE_GIT_BASH_PATH
  const first = join(project, 'bash first.exe'), second = join(project, 'bash second.exe')
  // Resolution only: these files must never be executed.
  writeFileSync(first, 'lookup fixture'); writeFileSync(second, 'lookup fixture')
  try {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = first
    assert.equal(r.getHookGitBashPath(), first)
    process.env.CLAUDE_CODE_GIT_BASH_PATH = second
    assert.equal(r.getHookGitBashPath(), second)
    rmSync(second)
    assert.notEqual(r.getHookGitBashPath(), second)
    writeFileSync(second, 'reinstalled')
    process.env.CLAUDE_CODE_GIT_BASH_PATH = first
    assert.equal(r.getHookGitBashPath(), first)
    process.env.CLAUDE_CODE_GIT_BASH_PATH = second
    assert.equal(r.getHookGitBashPath(), second)
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    else process.env.CLAUDE_CODE_GIT_BASH_PATH = prior
  }
})

test('PowerShell hook resolution observes PATH changes, removals and reinstalls', async () => {
  const prior = process.env.PATH
  const first = join(project, 'shell one'), second = join(project, 'shell two')
  mkdirSync(first); mkdirSync(second)
  const name = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
  const separator = process.platform === 'win32' ? ';' : ':'
  const a = join(first, name), b = join(second, name)
  writeFileSync(a, 'lookup fixture'); writeFileSync(b, 'lookup fixture')
  chmodSync(a, 0o755); chmodSync(b, 0o755)
  const canonical = path => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)
  const samePath = (actual, expected) => assert.equal(canonical(actual), canonical(expected))
  try {
    process.env.PATH = first + separator + prior
    samePath(await r.getHookPowerShellPath(), a)
    process.env.PATH = second + separator + first + separator + prior
    samePath(await r.getHookPowerShellPath(), b)
    rmSync(b)
    samePath(await r.getHookPowerShellPath(), a)
    rmSync(a)
    process.env.PATH = second
    assert.equal(await r.getHookPowerShellPath(), null)
    writeFileSync(b, 'reinstalled'); chmodSync(b, 0o755)
    samePath(await r.getHookPowerShellPath(), b)
  } finally {
    if (prior === undefined) delete process.env.PATH
    else process.env.PATH = prior
  }
})
