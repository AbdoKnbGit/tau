// Run directly: node test/mcp-setup-launch.test.mjs (also used by CI).
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'tau-mcp-setup-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.DISABLE_TELEMETRY = '1'
const r = await loadMcpRuntime({
  paths: ['src/services/mcp/config.ts', 'src/services/mcp/stdioLaunch.ts'],
  exports: ['parseMcpConfig', 'resolveStdioLaunch', 'readNpmShim'],
})
const fixture = resolve('test/fixtures/mcp-launch-server.mjs')
let sequence = 0
const config = (extra = {}) => ({ type: 'stdio', command: process.execPath, args: [fixture], scope: 'local', ...extra })
const clients = []
test.after(async () => {
  await Promise.all(clients.map(c => c.cleanup()))
  rmSync(root, { recursive: true, force: true })
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
  // which hangs on a line with 50 or more carets, so Tau has to start this shim's program without cmd.exe.
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

test('an npm shim is read for what it runs, and any other batch file is left alone', { skip: process.platform !== 'win32' }, () => {
  const shimPath = 'C:\\project\\node_modules\\.bin\\server.cmd'
  const npm = readFileSync(join(resolve('node_modules/.bin'), 'esbuild.cmd'), 'utf8')
  const launch = r.readNpmShim(shimPath, npm)
  assert.equal(launch.command, 'node')
  assert.deepEqual(launch.args, ['C:\\project\\node_modules\\.bin\\..\\esbuild\\bin\\esbuild'])
  assert.equal(r.readNpmShim(shimPath, '@echo off\r\nnode server.js %*\r\n'), null)
  assert.equal(r.readNpmShim(shimPath, '@echo off\r\nset "_prog=node"\r\n"%_prog%" "%OTHER%\\x.js" %*\r\n'), null)
  assert.equal(r.readNpmShim(shimPath, '@echo off\r\nset "_prog=C:\\missing\\node.exe"\r\n"%_prog%" "x.js" %*\r\n'), null)
})

test('a short line, or a program that needs no cmd.exe, goes through unchanged', () => {
  const env = process.env
  const direct = r.resolveStdioLaunch(process.execPath, ['a', 'b'], env)
  assert.deepEqual(direct, { command: process.execPath, args: ['a', 'b'] })
  const missing = r.resolveStdioLaunch('tau-no-such-command', ['a'], env)
  assert.deepEqual(missing, { command: 'tau-no-such-command', args: ['a'] })
})

test('POSIX executable scripts retain their interpreter and argv', { skip: process.platform === 'win32' }, async () => {
  const script = join(root, 'fixture-script')
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  chmodSync(script, 0o700)
  const args = ['space here', '', 'a&b', '$HOME', '$(echo unsafe)']
  assert.deepEqual((await inspect(await connect(config({ command: script, args })))).args, args)
})
