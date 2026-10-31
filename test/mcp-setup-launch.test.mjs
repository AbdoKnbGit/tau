// Run directly: node test/mcp-setup-launch.test.mjs (also used by CI).
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'tau-mcp-setup-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.DISABLE_TELEMETRY = '1'
const r = await loadMcpRuntime({
  paths: ['src/services/mcp/config.ts', 'src/services/mcp/stdioLaunch.ts'],
  exports: ['parseMcpConfig', 'resolveStdioLaunch'],
})
const fixture = resolve('test/fixtures/mcp-launch-server.mjs')
let sequence = 0
const config = (extra = {}) => ({ type: 'stdio', command: process.execPath, args: [fixture], scope: 'local', ...extra })
const clients = []
test.after(async () => {
  await Promise.all(clients.map(c => c.cleanup()))
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})
async function connect(server, name = `setup_${++sequence}`) {
  const client = await r.connectToServer(name, server)
  if (client.type === 'connected') clients.push(client)
  return client
}
async function inspect(client) {
  assert.equal(client.type, 'connected', client.error)
  const tools = await client.client.listTools()
  assert.equal(tools.tools[0].name, 'inspect')
  const result = await client.client.callTool({ name: 'inspect', arguments: {} })
  return JSON.parse(result.content[0].text)
}

for (const scope of ['local', 'project', 'user', 'dynamic', 'enterprise', 'managed']) {
  test(`parsing ${scope} configs does not invent launcher requirements or mutate argv`, () => {
    const servers = Object.fromEntries(['npx', 'npx.cmd', 'uvx', 'python', 'java', 'docker', '/opt/tools/server', 'C:\\Tools With Spaces\\server.cmd']
      .map((command, i) => [`server${i}`, { command, args: ['-x', 'space here', '/c', '%PATH%', '$HOME', 'a&b'] }]))
    const before = structuredClone(servers)
    const result = r.parseMcpConfig({ configObject: { mcpServers: servers }, scope, expandVars: false })
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.config.mcpServers, before)
    assert.deepEqual(servers, before)
  })
}

test('invalid schemas and missing environment variables still produce diagnostics', () => {
  const invalid = r.parseMcpConfig({ configObject: { mcpServers: { bad: { command: '', args: 'not-an-array' } } }, scope: 'project', expandVars: false })
  assert.equal(invalid.config, null)
  assert.ok(invalid.errors.some(e => e.mcpErrorMetadata.severity === 'fatal'))
  delete process.env.TAU_MCP_SETUP_MISSING_TEST
  const missing = r.parseMcpConfig({ configObject: { mcpServers: { server: { command: 'runtime', env: { TOKEN: '${TAU_MCP_SETUP_MISSING_TEST}' } } } }, scope: 'user', expandVars: true })
  assert.ok(missing.errors.some(e => e.message.includes('TAU_MCP_SETUP_MISSING_TEST')))
})

test('native stdio launch preserves literal arguments, environment, config and cache identity', async () => {
  const args = ['space here', '', 'quoted "value"', 'a&b|c>d<e', '%PATH%', '$HOME', '$(echo unsafe)', '/c', 'unicode-你好', 'trailing\\']
  const server = config({ args: [fixture, ...args], env: { MCP_LAUNCH_FIXTURE: 'first' } })
  const before = structuredClone(server)
  const name = `setup_${++sequence}`
  const first = await connect(server, name)
  const value = await inspect(first)
  assert.deepEqual(value.args, args)
  assert.equal(value.value, 'first')
  assert.deepEqual(server, before)
  assert.equal(await r.connectToServer(name, server), first)
  for (const changed of [
    { ...server, args: [fixture, 'changed'] },
    { ...server, env: { MCP_LAUNCH_FIXTURE: 'second' } },
    { ...server, scope: 'user' },
  ]) assert.notEqual(r.getServerCacheKey(name, changed), r.getServerCacheKey(name, server))
  const replacement = await connect({ ...server, env: { MCP_LAUNCH_FIXTURE: 'second' } }, name)
  assert.notEqual(replacement, first)
  assert.equal((await inspect(replacement)).value, 'second')
  await first.cleanup()
  assert.equal(await r.connectToServer(name, replacement.config), replacement)
})

test('missing commands and non-MCP executables cannot report connected', async () => {
  assert.equal((await connect(config({ command: join(root, 'does-not-exist') }))).type, 'failed')
  assert.equal((await connect(config({ args: ['-e', 'process.exit(0)'] }))).type, 'failed')
})

test('Windows PATH/PATHEXT resolves a generic command shim with spaces', { skip: process.platform !== 'win32' }, async () => {
  const bin = join(root, 'tools with spaces', 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  // Match npm's shim contract: cross-spawn deliberately escapes these shims
  // twice because the endLocal/goto dispatch reparses the command.
  writeFileSync(join(bin, 'fixture-launch.cmd'), `@echo off\r\nsetlocal\r\nset "_prog=${process.execPath}"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${fixture}" %*\r\n`)
  // The first group is short enough for cmd.exe. The last is too long for it on Windows 11 build 26300,
  // which hangs on a line with 50 or more carets, so the line has to reach cmd.exe another way.
  const groups = [
    ['space here', '', 'quoted "value"'],
    ['space here', '', 'quoted "value"', 'a&b', 'literal|pipe', 'unicode-你好', 'trailing\\', 'nine', 'ten', '--eleven=12'],
  ]
  // What npm itself writes, with the program found relative to the shim.
  copyFileSync(fixture, join(bin, '..', '..', 'fixture-server.mjs'))
  writeFileSync(join(bin, 'fixture-npm.cmd'), ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\..\\fixture-server.mjs" %*', ''].join('\r\n'))
  const env = { PATH: `${bin};${process.env.PATH}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  for (const command of ['fixture-launch', join(bin, 'fixture-launch.cmd'), 'fixture-npm', join(bin, 'fixture-npm.cmd')]) {
    for (const args of groups) {
      const client = await connect(config({ command, args, env }))
      const result = await inspect(client)
      assert.deepEqual(result.args, args)
      await client.cleanup()
    }
  }
})

test('any other batch file takes as many arguments as it is given', { skip: process.platform !== 'win32' }, async () => {
  const bin = join(root, 'plain tools')
  mkdirSync(bin, { recursive: true })
  // No npm shape to read here, and outside node_modules/.bin cross-spawn writes one caret, not three.
  for (const name of ['fixture-plain.cmd', 'fixture-plain.bat']) {
    writeFileSync(join(bin, name), `@"${process.execPath}" "${fixture}" %*\r\n`)
  }
  const many = Array.from({ length: 30 }, (_, i) => (i % 2 ? `with space ${i}` : `a&b|${i}`))
  const env = { PATH: `${bin};${process.env.PATH}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  for (const command of ['fixture-plain', join(bin, 'fixture-plain.cmd'), join(bin, 'fixture-plain.bat')]) {
    for (const args of [['space here', 'a&b'], many]) {
      const client = await connect(config({ command, args, env }))
      assert.deepEqual((await inspect(client)).args, args)
      await client.cleanup()
    }
  }
})

test('a line too long for cmd.exe reaches it through a variable that is emptied first', { skip: process.platform !== 'win32' }, () => {
  const shim = join(root, 'plain tools', 'fixture-unit.cmd')
  mkdirSync(join(root, 'plain tools'), { recursive: true })
  writeFileSync(shim, '@echo off\r\n')
  const env = { PATH: process.env.PATH, ComSpec: process.env.ComSpec }
  const short = r.resolveStdioLaunch(shim, ['a'], env)
  assert.deepEqual(short, { command: shim, args: ['a'], env })
  const long = r.resolveStdioLaunch(shim, Array.from({ length: 30 }, () => 'a b'), env)
  assert.match(long.command, /cmd\.exe$/i)
  assert.deepEqual(long.args, ['/d', '/s', '/c', 'set', 'TAU_STDIO_LINE=&%TAU_STDIO_LINE%'])
  assert.ok(long.env.TAU_STDIO_LINE.includes('fixture-unit'))
  assert.equal(env.TAU_STDIO_LINE, undefined, 'the caller\'s env is not changed')
})

test('a short line, or a program that needs no cmd.exe, goes through unchanged', () => {
  const env = process.env
  const direct = r.resolveStdioLaunch(process.execPath, ['a', 'b'], env)
  assert.deepEqual(direct, { command: process.execPath, args: ['a', 'b'], env })
  const missing = r.resolveStdioLaunch('tau-no-such-command', ['a'], env)
  assert.deepEqual(missing, { command: 'tau-no-such-command', args: ['a'], env })
})

test('POSIX executable scripts retain their interpreter and argv', { skip: process.platform === 'win32' }, async () => {
  const script = join(root, 'fixture-script')
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  chmodSync(script, 0o700)
  const args = ['space here', '', 'a&b', '$HOME', '$(echo unsafe)']
  assert.deepEqual((await inspect(await connect(config({ command: script, args })))).args, args)
})
