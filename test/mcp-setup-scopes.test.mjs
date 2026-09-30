import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs')
const fixture = resolve('test/fixtures/mcp-launch-server.mjs')
const root = mkdtempSync(join(process.env.TAU_MCP_SETUP_TEST_ROOT ?? tmpdir(), 'tau-setup-scopes-'))
const project = join(root, 'project with spaces')
const other = join(root, 'other project')
const configDir = join(root, 'config')
for (const dir of [project, other, configDir]) mkdirSync(dir, { recursive: true })
// Stop project discovery at our own roots; never inherit the user's .mcp.json.
for (const dir of [project, other]) mkdirSync(join(dir, '.git'))
const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, DISABLE_TELEMETRY: '1' }
function run(args, cwd = project) {
  return execFileSync(process.execPath, [cli, 'mcp', ...args], {
    cwd, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
}
const globalFile = join(configDir, '.claude.json')
const projectFile = join(project, '.mcp.json')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
test.after(() => rmSync(root, { recursive: true, force: true }))

test('CLI round-trips exact argv and scopes; local > project > user; unrelated config survives', () => {
  const args = ['space here', '', '/c', 'C:/', 'a&b', '%PATH%', '$HOME', 'quoted "text"']
  const expected = { type: 'stdio', command: process.execPath, args: [fixture, ...args], env: {} }
  writeFileSync(projectFile, JSON.stringify({ mcpServers: { unrelated: { command: 'not-launched', args: [] } } }))
  for (const scope of ['user', 'project', 'local']) {
    const output = run(['add', 'same_name', '-s', scope, '--', process.execPath, fixture, ...args])
    assert.match(output, new RegExp(`to ${scope} config`))
    const global = read(globalFile)
    const stored = scope === 'user' ? global.mcpServers.same_name
      : scope === 'project' ? read(projectFile).mcpServers.same_name
        : Object.values(global.projects).find(p => p.mcpServers?.same_name)?.mcpServers.same_name
    assert.deepEqual(stored, expected)
    assert.match(run(['get', 'same_name']), new RegExp(`Scope: ${scope === 'user' ? 'User' : scope === 'project' ? 'Project' : 'Local'} config`))
  }
  assert.match(run(['get', 'same_name'], other), /Scope: User config/)
  assert.deepEqual(read(projectFile).mcpServers.unrelated, { command: 'not-launched', args: [] })
  assert.throws(() => run(['add', 'same_name', '-s', 'local', '--', 'runtime']), /already exists/)
  for (const [scope, effective] of [['local', 'Project'], ['project', 'User']]) {
    run(['remove', 'same_name', '-s', scope])
    assert.match(run(['get', 'same_name']), new RegExp(`Scope: ${effective} config`))
  }
  run(['remove', 'same_name', '-s', 'user'])
  assert.throws(() => run(['get', 'same_name']), /No MCP server found/)
  assert.deepEqual(read(projectFile).mcpServers.unrelated, { command: 'not-launched', args: [] })
})

test('add-json preserves structured arguments and schema failures do not replace configuration', () => {
  const config = { command: process.execPath, args: [fixture, 'literal "quote"', '/c', 'C:/', 'a&b'] }
  run(['add-json', 'structured', '-s', 'project', JSON.stringify(config)])
  assert.deepEqual(read(projectFile).mcpServers.structured, config)
  const before = readFileSync(projectFile, 'utf8')
  assert.throws(() => run(['add-json', 'bad', '-s', 'project', JSON.stringify({ command: '', args: 'bad' })]))
  assert.equal(readFileSync(projectFile, 'utf8'), before)
  assert.throws(() => run(['add-json', 'damaged', '-s', 'project', '{"token":"fixture-secret"']), error => {
    assert.match(error.stderr, /JSON object as one argument.*Check the calling shell/)
    assert.doesNotMatch(error.stderr, /fixture-secret/)
    return true
  })
  assert.equal(readFileSync(projectFile, 'utf8'), before)
})

test('managed deny policy still rejects an add without changing the target', () => {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ deniedMcpServers: [{ serverName: 'blocked' }] }))
  const before = readFileSync(projectFile, 'utf8')
  assert.throws(() => run(['add', 'blocked', '-s', 'project', '--', process.execPath, fixture]), /blocked by enterprise policy/)
  assert.equal(readFileSync(projectFile, 'utf8'), before)
})

test('MSYS setup preserves argv and JSON using invocation-local conversion control', {
  skip: !process.env.TAU_MCP_SETUP_BASH,
}, () => {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  function bash(args, protect) {
    const shellEnv = { ...env }
    delete shellEnv.MSYS_NO_PATHCONV
    delete shellEnv.MSYS2_ARG_CONV_EXCL
    if (protect) shellEnv.MSYS2_ARG_CONV_EXCL = '*'
    // Feed a script, as an interactive shell/tool does. Passing this through
    // Windows -> bash -c would introduce a second, unrelated quoting boundary.
    return execFileSync(process.env.TAU_MCP_SETUP_BASH, ['--noprofile', '--norc'], {
      cwd: project, env: shellEnv, encoding: 'utf8', timeout: 30_000,
      input: [process.execPath, cli, 'mcp', ...args].map(quote).join(' ') + '\n',
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
  const args = [fixture, '/c', 'space here', 'a&b', '$HOME']
  bash(['add', 'converted', '-s', 'project', '--', process.execPath, ...args], false)
  assert.notEqual(read(projectFile).mcpServers.converted.args[1], '/c', 'unprotected MSYS must reproduce the incoming argv corruption')
  bash(['add', 'protected', '-s', 'project', '--', process.execPath, ...args], true)
  assert.deepEqual(read(projectFile).mcpServers.protected.args, args)
  const jsonArgs = ['add-json', 'json_shell', '-s', 'project', JSON.stringify({ command: process.execPath, args })]
  bash(jsonArgs, false)
  assert.deepEqual(read(projectFile).mcpServers.json_shell.args, args)
  assert.match(run(['get', 'protected']), /Connected/)
  assert.match(run(['get', 'json_shell']), /Connected/)
})
