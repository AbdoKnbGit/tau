import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import React from 'react'
import { loadBuiltRuntime, mount, KEYS } from './helpers/ink-built-runtime.mjs'

const cwd = process.cwd()
const cli = join(cwd, 'dist', 'cli.mjs')
const root = mkdtempSync(join(tmpdir(), 'tau-local-plugins-'))
const config = join(root, 'config'), project = join(root, 'project'), managed = join(root, 'managed')
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
mkdirSync(project)
Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'), CLAUDE_CODE_PLUGIN_DIRS: '',
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0', CLAUDE_CODE_USE_COWORK_PLUGINS: '0', CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' })
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: ['src/utils/plugins/pluginLoader.ts', 'src/utils/plugins/scaffold.ts', 'src/utils/plugins/details.ts', 'src/utils/plugins/sessionPaths.ts', 'src/services/plugins/pluginOperations.ts', 'src/utils/managedEnv.ts', 'src/components/TrustDialog/TrustDialog.tsx', 'src/commands/plugin/ManagePlugins.tsx', 'src/utils/plugins/refresh.ts'],
  exports: ['loadSessionOnlyPlugins', 'loadAllPlugins', 'loadAllPluginsCacheOnly', 'clearAllCaches', 'setInlinePlugins', 'getPluginSkills', 'getSkillDirCommands',
    'getManagedFilePath', 'resetSettingsCache', 'setAllowedSettingSources', 'setSessionTrustAccepted', 'setOriginalCwd',
    'scaffoldPlugin', 'getPluginDetails', 'setPluginEnabledOp', 'cleanupSessionPluginArchives', 'clearSessionPluginDownloads',
    'resolveSessionPluginPath', 'setSessionPluginUrls', 'getInlinePlugins', 'loadPluginMcpServers', 'addPluginScopeToServers',
    'applyConfigEnvironmentVariables', 'getPendingProjectMcpServers', 'getClaudeCodeMcpConfigs', 'excludeStalePluginClients',
    'setIsInteractive', 'hasExplicitWorkspaceTrust', 'acceptExplicitWorkspaceTrust', 'getGlobalConfig', 'saveGlobalConfig', 'qualifyDependency',
    'recordSkillUsage', 'getPluginLastUsed', 'addPluginScopeToLspServers', 'TrustDialog',
    'ManagePlugins', 'MCPConnectionContext', 'refreshActivePlugins', 'getRegisteredHooks', 'parsePluginArgs', 'getSettingsForSource',
    'setFlagSettingsInline', 'setAdditionalDirectoriesForClaudeMd', 'getPluginEditableScopes'],
})
r.getManagedFilePath.cache.set(undefined, managed)
r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
r.setOriginalCwd(project)
r.setSessionTrustAccepted(false)
const reset = () => { r.resetSettingsCache(); r.clearAllCaches() }
const plugin = (path, name, extra = {}) => {
  write(join(path, '.claude-plugin', 'plugin.json'), { name, version: '1.0.0', ...extra })
  write(join(path, 'skills', 'inspect', 'SKILL.md'), '---\ndescription: Inspect the requested file\n---\nRead the requested file without editing it.\n')
}
const archive = (name, marker = 'first') => zipSync({
  '.claude-plugin/plugin.json': strToU8(JSON.stringify({ name, version: '1.0.0' })),
  'skills/inspect/SKILL.md': strToU8('---\ndescription: Inspect the requested file\n---\nRead the requested file.'),
  'marker.txt': strToU8(marker),
})
async function command(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, ...environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI timed out')) }, 30000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }) })
  })
}
after(async () => { await r.cleanupSessionPluginArchives(); process.chdir(cwd); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })

test('ZIP sessions load valid siblings, reject traversal, and preserve prior extractions across edits', async () => {
  const zip = join(root, 'plugin.zip'), invalid = join(root, 'invalid.zip')
  writeFileSync(zip, archive('archived'))
  writeFileSync(invalid, zipSync({ '../outside.txt': strToU8('escape') }))
  const first = await r.loadSessionOnlyPlugins([invalid, zip])
  assert.equal(first.plugins.length, 1)
  assert.equal(first.plugins[0].source, 'archived@inline')
  assert.equal(first.errors.length, 1)
  assert.equal(existsSync(join(root, 'outside.txt')), false)
  const oldPath = first.plugins[0].path
  writeFileSync(zip, archive('archived', 'second'))
  const next = await r.loadSessionOnlyPlugins([zip])
  assert.notEqual(next.plugins[0].path, oldPath)
  assert.equal(readFileSync(join(oldPath, 'marker.txt'), 'utf8'), 'first')
  assert.equal(readFileSync(join(next.plugins[0].path, 'marker.txt'), 'utf8'), 'second')
})

test('URL flags use the shared loader, download once, and refresh only on explicit invalidation', async () => {
  let requests = 0, marker = 'before'
  const server = createServer((req, res) => { requests++; res.end(req.url === '/bad.zip' ? 'invalid ZIP' : archive('remote', marker)) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/plugin.zip`
  try {
    r.setSessionPluginUrls([`${url} ${url}`])
    assert.equal(r.getInlinePlugins().filter(p => p === url).length, 1)
    const before = await r.resolveSessionPluginPath(url)
    marker = 'after'
    assert.equal(await r.resolveSessionPluginPath(url), before)
    assert.equal(requests, 1)
    r.clearSessionPluginDownloads()
    const updated = await r.resolveSessionPluginPath(url)
    assert.notEqual(updated, before)
    assert.equal(readFileSync(join(before, 'marker.txt'), 'utf8'), 'before')
    assert.equal(readFileSync(join(updated, 'marker.txt'), 'utf8'), 'after')
    const result = await command(['--setting-sources', 'project,local', '--plugin-url', `${url} http://127.0.0.1:${server.address().port}/bad.zip`, 'plugin', 'list', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const list = JSON.parse(result.stdout)
    assert.ok(list.some(p => p.id === 'remote@inline' && p.enabled))
    assert.equal(existsSync(list.find(p => p.id === 'remote@inline').installPath), false, 'CLI exit removes its extraction')
    assert.ok(list.some(p => p.errors?.some(e => /zip/i.test(e))))
  } finally { r.setSessionPluginUrls([]); server.closeAllConnections(); await new Promise(done => server.close(done)) }
})

test('personal and explicitly trusted project plugins load with normal skills and precedence', async () => {
  const personal = join(config, 'skills', 'personal'), repository = join(project, '.claude', 'skills', 'repository')
  plugin(personal, 'personal')
  write(join(personal, 'SKILL.md'), '---\nname: personal\ndescription: Personal root skill\n---\nExplain the request.\n')
  plugin(repository, 'repository')
  reset()
  let result = await r.loadAllPlugins()
  assert.ok(result.enabled.some(p => p.source === 'personal@skills-dir'))
  assert.ok(!result.enabled.some(p => p.source === 'repository@skills-dir'))
  r.setSessionTrustAccepted(true)
  reset()
  assert.ok(!(await r.loadAllPlugins()).enabled.some(p => p.source === 'repository@skills-dir'), 'inherited interactive trust is insufficient')
  let accepted = false
  const screen = await mount(r, React.createElement(r.TrustDialog, { requireExplicitTrust: true, commands: [], onDone: () => { accepted = true } }))
  try {
    await screen.waitFor(/Yes, I trust this folder/)
    assert.equal(accepted, false, 'inherited trust cannot auto-close the explicit dialog')
    await screen.press(KEYS.enter)
    assert.equal(accepted, true)
    assert.equal(r.hasExplicitWorkspaceTrust(), true)
  } finally { screen.close() }
  reset()
  result = await r.loadAllPlugins()
  assert.equal(result.enabled.find(p => p.source === 'repository@skills-dir').discoveryScope, 'project')
  assert.ok((await r.getPluginSkills()).some(p => p.name === 'personal:inspect'))
  assert.ok((await r.getSkillDirCommands(project)).some(p => p.name === 'personal'))
  const inline = join(root, 'override')
  plugin(inline, 'personal')
  r.setInlinePlugins([inline]); reset()
  result = await r.loadAllPlugins()
  assert.ok(result.enabled.some(p => p.source === 'personal@inline'))
  assert.ok(!result.enabled.some(p => p.source === 'personal@skills-dir'))
  assert.ok(result.errors.some(e => e.source === 'personal@skills-dir' && /precedence/.test(e.error)))
  write(join(config, 'settings.json'), { enabledPlugins: { 'personal@inline': false } }); reset()
  assert.ok((await r.loadAllPlugins()).enabled.some(p => p.source === 'personal@skills-dir'))
  r.setInlinePlugins([])
})

test('details inventories conditional skills without activating or executing their bodies', async () => {
  const path = join(config, 'skills', 'conditional')
  plugin(path, 'conditional')
  write(join(path, 'skills', 'inspect', 'SKILL.md'), '---\ndescription: Conditional inspection\npaths: ["src/**"]\n---\n!`node -e "process.exit(99)"`\nRead the requested source.\n')
  reset()
  assert.ok(!(await r.getPluginSkills()).some(s => s.name === 'conditional:inspect'))
  assert.match(await r.getPluginDetails('conditional'), /conditional:inspect/)
  assert.ok(!(await r.getPluginSkills()).some(s => s.name === 'conditional:inspect'))
})

test('managed source policy applies before discovery, scaffolding, or session downloads', async () => {
  for (const policy of [{ allowedMarketplaces: [] }, { blockedMarketplaces: [{ source: 'skills-dir' }] }, { strictPluginOnlyCustomization: ['mcp'] }]) {
    write(join(managed, 'managed-settings.json'), policy); reset()
    assert.ok(!(await r.loadAllPlugins()).enabled.some(p => p.source.endsWith('@skills-dir')))
    await assert.rejects(r.scaffoldPlugin('blocked'), /blocked/)
    assert.equal(existsSync(join(config, 'skills', 'blocked')), false)
  }
  write(join(managed, 'managed-settings.json'), { allowedMarketplaces: [{ source: 'skills-dir' }] }); reset()
  assert.ok((await r.loadAllPlugins()).enabled.some(p => p.source === 'personal@skills-dir'))
  write(join(managed, 'managed-settings.json'), { enabledPlugins: { 'personal@skills-dir': true } }); reset()
  assert.ok((await r.loadAllPlugins()).enabled.some(p => p.source === 'personal@skills-dir'), 'managed copy does not shadow itself')
  write(join(managed, 'managed-settings.json'), { disableSideloadFlags: true }); reset()
  await assert.rejects(r.loadSessionOnlyPlugins(['http://127.0.0.1:1/never.zip']), /disabled/)
  write(join(managed, 'managed-settings.json'), {}); reset()
})

test('skills-directory dependencies resolve from the loaded inventory, not a synthetic marketplace', () => {
  assert.equal(r.qualifyDependency('shared', 'consumer@skills-dir'), 'shared')
  assert.equal(r.qualifyDependency('shared@catalog', 'consumer@skills-dir'), 'shared@catalog')
  assert.equal(r.qualifyDependency('shared', 'consumer@catalog'), 'shared@catalog')
})

test('usage stays local, distinguishes catalog owners, and inspection does not count as invocation', async () => {
  assert.equal(r.getPluginLastUsed('personal@skills-dir'), 'No recorded use')
  await r.getPluginDetails('personal')
  assert.equal(r.getPluginLastUsed('personal@skills-dir'), 'No recorded use')
  r.recordSkillUsage('dispatch:inspect', 'shipping@north')
  assert.match(r.getPluginLastUsed('shipping@north'), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(r.getPluginLastUsed('shipping@south'), 'No recorded use')
  const servers = r.addPluginScopeToLspServers({ server: { command: 'language-server', extensionToLanguage: { '.x': 'x' } } }, 'dispatch', 'shipping@south')
  assert.equal(servers['plugin:dispatch:server'].pluginSource, 'shipping@south')
  write(join(managed, 'managed-settings.json'), { strictKnownMarketplaces: [] }); reset()
  assert.equal(r.getPluginLastUsed('shipping@north'), undefined)
  write(join(managed, 'managed-settings.json'), {}); reset()
})

test('project plugin MCP files stay within their root and use project approval scope', async () => {
  const path = join(project, '.claude', 'skills', 'repository')
  write(join(path, '.mcp.json'), { mcpServers: { safe: { command: 'example-safe-server' } } })
  write(join(project, 'outside-mcp.json'), { mcpServers: { outside: { command: 'outside-server' } } })
  const p = { path, name: 'repository', source: 'repository@skills-dir', discoveryScope: 'project', manifest: { mcpServers: ['../../../outside-mcp.json', './outside.mcpb'] } }
  const servers = await r.loadPluginMcpServers(p)
  assert.deepEqual(Object.keys(servers), ['safe'])
  assert.equal(r.addPluginScopeToServers(servers, p.name, p.source, true)['plugin:repository:safe'].scope, 'project')
  r.setIsInteractive(true)
  write(join(project, '.claude', 'settings.local.json'), {})
  reset()
  assert.ok((await r.getPendingProjectMcpServers()).includes('plugin:repository:safe'))
  assert.equal((await r.getClaudeCodeMcpConfigs()).servers['plugin:repository:safe'], undefined)
  write(join(project, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['plugin:repository:safe'] }); reset()
  const approved = (await r.getClaudeCodeMcpConfigs()).servers['plugin:repository:safe']
  assert.ok(approved)
  assert.ok(!(await r.getPendingProjectMcpServers()).includes('plugin:repository:safe'))
  const stale = r.excludeStalePluginClients({ clients: [{ name: 'plugin:repository:safe', type: 'pending', config: approved }], tools: [], commands: [], resources: {} }, {})
  assert.equal(stale.stale.length, 1)
  assert.equal(stale.clients.length, 0)
  write(join(project, '.claude', 'settings.local.json'), { disabledMcpjsonServers: ['plugin:repository:safe'] }); reset()
  assert.equal((await r.getClaudeCodeMcpConfigs()).servers['plugin:repository:safe'], undefined)
  write(join(project, '.claude', 'settings.local.json'), {}); reset()
})

test('public init, details, disable and enable work without marketplace installation', async () => {
  let result = await command(['plugin', 'init', 'created', '--with', 'skills', 'agents', 'hooks', 'mcp', 'lsp', 'output-style', 'channel', '--author', 'Fixture'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /created@skills-dir/)
  const serverResponses = execFileSync(process.execPath, [join(config, 'skills', 'created', 'server.mjs')], {
    input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  }).trim().split('\n').map(JSON.parse)
  assert.equal(serverResponses[0].result.protocolVersion, '2025-03-26')
  assert.deepEqual(serverResponses[0].result.capabilities.experimental, { 'claude/channel': {} })
  assert.deepEqual(serverResponses[1].result.tools, [])
  result = await command(['plugin', 'list', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.ok(JSON.parse(result.stdout).some(p => p.id === 'created@skills-dir' && p.enabled))
  result = await command(['plugin', 'details', 'created'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Projected token cost/)
  assert.match(result.stdout, /created:example/)
  assert.match(result.stdout, /reviewer/)
  assert.match(result.stdout, /MCP servers \(1\)/)
  result = await command(['plugin', 'disable', 'created@skills-dir'])
  assert.equal(result.code, 0, result.stderr)
  result = await command(['plugin', 'details', 'created'])
  assert.equal(result.code, 1)
  result = await command(['plugin', 'enable', 'created@skills-dir'])
  assert.equal(result.code, 0, result.stderr)
  const original = readFileSync(join(config, 'skills', 'created', 'SKILL.md'), 'utf8')
  result = await command(['plugin', 'init', 'created'])
  assert.equal(result.code, 1)
  result = await command(['plugin', 'init', 'created', '--force', '--description', 'Updated description'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(readFileSync(join(config, 'skills', 'created', 'SKILL.md'), 'utf8'), original)
  assert.equal(JSON.parse(readFileSync(join(config, 'skills', 'created', '.claude-plugin', 'plugin.json'), 'utf8')).description, 'Updated description')
  assert.equal(existsSync(join(root, 'cache', 'installed_plugins.json')), false)
})

test('scaffolding rejects traversal, unknown components and symlinks without overwriting files', async () => {
  await assert.rejects(r.scaffoldPlugin('../escape'), /plugin name/)
  await assert.rejects(r.scaffoldPlugin('unknown-components', { with: ['unsupported'] }), /Unknown component/)
  assert.equal(existsSync(join(config, 'skills', 'unknown-components')), false)
  const outside = join(root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(config, 'skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(r.scaffoldPlugin('linked', { force: true }), /symbolic link/)
  assert.equal(existsSync(join(outside, '.claude-plugin')), false)
  const nested = join(config, 'skills', 'nested-link')
  mkdirSync(nested)
  symlinkSync(outside, join(nested, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(r.scaffoldPlugin('nested-link', { with: ['skills'] }), /symbolic link/)
  assert.equal(existsSync(join(nested, 'SKILL.md')), false, 'preflight rejects before creating any component')
  assert.equal(existsSync(join(outside, 'example')), false)
})

test('desktop worktrees discover the main checkout while terminal worktrees and subdirectories stay local', async () => {
  const main = join(root, 'main-checkout'), worktree = join(root, 'worktree')
  mkdirSync(main)
  execFileSync('git', ['init', main], { windowsHide: true, stdio: 'ignore' })
  execFileSync('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Fixture'], { windowsHide: true, stdio: 'ignore' })
  execFileSync('git', ['-C', main, 'worktree', 'add', '--detach', worktree], { windowsHide: true, stdio: 'ignore' })
  plugin(join(main, '.claude', 'skills', 'from-main'), 'from-main')
  plugin(join(worktree, '.claude', 'skills', 'from-worktree'), 'from-worktree')
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  try {
    r.setOriginalCwd(worktree); r.setSessionTrustAccepted(true, true)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'; reset()
    let result = await r.loadAllPlugins()
    assert.ok(result.enabled.some(p => p.name === 'from-worktree'))
    assert.ok(!result.enabled.some(p => p.name === 'from-main'))
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'; reset()
    result = await r.loadAllPlugins()
    assert.ok(result.enabled.some(p => p.name === 'from-main'))
    assert.ok(!result.enabled.some(p => p.name === 'from-worktree'))
    const nested = join(worktree, 'nested')
    mkdirSync(nested); r.setOriginalCwd(nested); r.setSessionTrustAccepted(true, true); reset()
    result = await r.loadAllPlugins()
    assert.ok(!result.enabled.some(p => p.name === 'from-main' || p.name === 'from-worktree'))
    r.acceptExplicitWorkspaceTrust(true)
    r.setSessionTrustAccepted(false)
    assert.equal(r.hasExplicitWorkspaceTrust(), true, 'explicit consent survives a new session')
    r.setOriginalCwd(join(nested, 'child'))
    assert.equal(r.hasExplicitWorkspaceTrust(), false, 'parent consent does not trust a child')
  } finally {
    if (entrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = entrypoint
    r.setOriginalCwd(project); r.setSessionTrustAccepted(true, true); reset()
  }
})

test('project environment cannot introduce session plugins', () => {
  process.env.CLAUDE_CODE_PLUGIN_DIRS = 'original'
  write(join(project, '.claude', 'settings.json'), { env: { CLAUDE_CODE_PLUGIN_DIRS: 'untrusted' } }); reset()
  r.applyConfigEnvironmentVariables()
  assert.equal(process.env.CLAUDE_CODE_PLUGIN_DIRS, 'original')
  process.env.CLAUDE_CODE_PLUGIN_DIRS = ''
})

test('interactive disable respects active settings sources and reload removes repository skills and hooks', async () => {
  const path = join(project, '.claude', 'skills', 'toggle-fixture')
  const id = 'toggle-fixture@skills-dir'
  plugin(path, 'toggle-fixture')
  write(join(path, 'hooks', 'hooks.json'), { hooks: { PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo fixture' }] }] } })
  const userSettings = join(config, 'settings.json')
  const before = existsSync(userSettings) ? readFileSync(userSettings, 'utf8') : null
  r.setAllowedSettingSources(['projectSettings', 'localSettings'])
  r.setSessionTrustAccepted(true, true)
  reset()
  const app = r.createStore(r.getDefaultAppState())
  await r.refreshActivePlugins(app.setState)
  assert.ok((await r.getPluginSkills()).some(c => c.name === 'toggle-fixture:inspect'))
  assert.ok(r.getRegisteredHooks().PostToolUse.some(h => h.pluginId === id))
  const execute = async action => {
    const messages = []
    const parsed = r.parsePluginArgs(`${action} ${id}`)
    const panel = await mount(r, React.createElement(r.MCPConnectionContext.Provider, { value: { toggleMcpServer: () => {} } }, React.createElement(r.ManagePlugins, {
      setViewState: () => {}, setResult: message => messages.push(message), targetPlugin: parsed.plugin, action: parsed.type,
    })), { columns: 110, rows: 40 })
    try {
      const deadline = Date.now() + 5000
      while (!messages.length) {
        assert.ok(Date.now() < deadline, panel.frame())
        await new Promise(resolve => setTimeout(resolve, 20))
        r.reconciler.flushSyncWork()
      }
      return messages[0]
    } finally { panel.close() }
  }
  try {
    assert.match(await execute('disable'), /^✓ Disabled toggle-fixture\./)
    assert.equal(r.getSettingsForSource('localSettings').enabledPlugins[id], false)
    assert.equal(existsSync(userSettings) ? readFileSync(userSettings, 'utf8') : null, before, 'ignored user settings stay unchanged')
    await r.refreshActivePlugins(app.setState)
    assert.ok(!(await r.getPluginSkills()).some(c => c.name === 'toggle-fixture:inspect'))
    assert.ok(!(r.getRegisteredHooks().PostToolUse ?? []).some(h => h.pluginId === id))
    assert.match(await execute('enable'), /^✓ Enabled toggle-fixture\./)
    await r.refreshActivePlugins(app.setState)
    assert.ok((await r.getPluginSkills()).some(c => c.name === 'toggle-fixture:inspect'))
    assert.equal(r.getRegisteredHooks().PostToolUse.filter(h => h.pluginId === id).length, 1)
  } finally { r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings']); reset() }
})

test('toggles ignore excluded settings and refuse unavailable scopes without writing', async () => {
  const id = 'scope-fixture@inline', path = join(root, 'scope-fixture')
  plugin(path, 'scope-fixture')
  const userPath = join(config, 'settings.json')
  const previous = existsSync(userPath) ? readFileSync(userPath, 'utf8') : null
  const settings = previous ? JSON.parse(previous) : {}
  write(userPath, { ...settings, enabledPlugins: { ...settings.enabledPlugins, [id]: false } })
  const untouchedUser = readFileSync(userPath, 'utf8')
  r.setInlinePlugins([path])
  r.setAllowedSettingSources(['projectSettings', 'localSettings']); reset()
  try {
    assert.ok((await r.loadAllPlugins()).enabled.some(p => p.source === id), 'excluded user false has no effect')
    const result = await r.setPluginEnabledOp(id, false)
    assert.equal(result.success, true, result.message)
    assert.equal(result.scope, 'local')
    assert.equal(r.getSettingsForSource('localSettings').enabledPlugins[id], false)
    assert.equal(readFileSync(userPath, 'utf8'), untouchedUser)
    const localPath = join(project, '.claude', 'settings.local.json')
    const beforeLocal = readFileSync(localPath, 'utf8')
    const excluded = await r.setPluginEnabledOp(id, true, 'user')
    assert.equal(excluded.success, false)
    assert.match(excluded.message, /excludes that settings source/)
    assert.equal(readFileSync(userPath, 'utf8'), untouchedUser)
    assert.equal(readFileSync(localPath, 'utf8'), beforeLocal)
    r.setAllowedSettingSources([]); reset()
    assert.equal(r.getPluginEditableScopes().has(id), false)
    const unavailable = await r.setPluginEnabledOp(id, false)
    assert.equal(unavailable.success, false)
    assert.match(unavailable.message, /no writable settings source/)
    assert.equal(readFileSync(localPath, 'utf8'), beforeLocal)
    r.setAllowedSettingSources(['projectSettings']); reset()
    const projectOnly = await r.setPluginEnabledOp(id, false)
    assert.equal(projectOnly.success, true, projectOnly.message)
    assert.equal(projectOnly.scope, 'project')
    assert.equal(readFileSync(localPath, 'utf8'), beforeLocal)
    assert.ok((await r.loadAllPlugins()).disabled.some(p => p.source === id))
    const builtin = await r.setPluginEnabledOp('scope-fixture@builtin', false)
    assert.equal(builtin.success, true, builtin.message)
    assert.equal(builtin.scope, 'project')
    assert.equal(readFileSync(userPath, 'utf8'), untouchedUser)
  } finally {
    if (previous === null) rmSync(userPath, { force: true }); else writeFileSync(userPath, previous)
    r.setInlinePlugins([]); r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings']); reset()
  }
})

test('toggles respect read-only settings precedence and additional-directory enabled plugins', async () => {
  const id = 'enforced@inline', builtin = 'enforced@builtin', path = join(root, 'enforced')
  plugin(path, 'enforced'); r.setInlinePlugins([path])
  const policyPath = join(managed, 'managed-settings.json')
  const previous = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : null
  const settingPaths = [join(config, 'settings.json'), join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json')]
  const snapshot = () => settingPaths.map(p => existsSync(p) ? readFileSync(p, 'utf8') : null)
  try {
    const before = snapshot()
    r.setFlagSettingsInline({ enabledPlugins: { [id]: true, [builtin]: true } }); reset()
    for (const target of [id, builtin]) {
      const result = await r.setPluginEnabledOp(target, false)
      assert.equal(result.success, false)
      assert.match(result.message, /command-line settings/)
    }
    assert.deepEqual(snapshot(), before)
    write(policyPath, { enabledPlugins: { [id]: true, [builtin]: true } })
    r.setFlagSettingsInline({ enabledPlugins: { [id]: false, [builtin]: false } }); reset()
    for (const target of [id, builtin]) {
      const result = await r.setPluginEnabledOp(target, false)
      assert.equal(result.success, false)
      assert.match(result.message, /managed settings/)
    }
    assert.deepEqual(snapshot(), before)
    const enableBuiltin = await r.setPluginEnabledOp(builtin, true)
    assert.equal(enableBuiltin.success, true, 'managed true overrides command-line false')
    write(policyPath, {}); r.setFlagSettingsInline(null)
    const additional = join(root, 'additional-directory')
    const inherited = 'inherited@catalog'
    write(join(additional, '.claude', 'settings.json'), { enabledPlugins: { [inherited]: true } })
    r.setAdditionalDirectoriesForClaudeMd([additional]); reset()
    const result = await r.setPluginEnabledOp(inherited, false)
    assert.equal(result.success, true, result.message)
    assert.equal(r.getSettingsForSource('userSettings').enabledPlugins[inherited], false)
    assert.equal(JSON.parse(readFileSync(join(additional, '.claude', 'settings.json'))).enabledPlugins[inherited], true)
  } finally {
    if (previous === null) rmSync(policyPath, { force: true }); else writeFileSync(policyPath, previous)
    r.setFlagSettingsInline(null); r.setAdditionalDirectoriesForClaudeMd([]); r.setInlinePlugins([]); reset()
  }
})

test('Space toggle shows a rejected operation without claiming a pending change', async () => {
  const path = join(root, 'space-fixture')
  plugin(path, 'space-fixture')
  r.setInlinePlugins([path]); r.setAllowedSettingSources([]); reset()
  const panel = await mount(r, React.createElement(r.MCPConnectionContext.Provider, { value: { toggleMcpServer: () => {} } }, React.createElement(r.ManagePlugins, {
    setViewState: () => {}, setResult: () => {},
  })), { columns: 120, rows: 40 })
  try {
    await panel.waitFor(/space-fixture/)
    await panel.press('/')
    await panel.type('space-fixture')
    await panel.press(KEYS.down)
    await panel.press(KEYS.space)
    await panel.waitFor(/no writable settings source/, 2000)
    assert.doesNotMatch(panel.frame(), /Run \/reload-plugins to apply changes/)
    r.setAllowedSettingSources(['localSettings']); reset()
    await panel.press(KEYS.space)
    await panel.waitFor(/Run \/reload-plugins to apply changes/)
    assert.equal(r.getSettingsForSource('localSettings').enabledPlugins['space-fixture@inline'], false)
    await panel.press(KEYS.space)
    const deadline = Date.now() + 2000
    while (r.getSettingsForSource('localSettings').enabledPlugins['space-fixture@inline'] !== true) {
      assert.ok(Date.now() < deadline, panel.frame())
      await new Promise(resolve => setTimeout(resolve, 20))
      r.reconciler.flushSyncWork()
    }
    assert.doesNotMatch(panel.frame(), /Run \/reload-plugins to apply changes/)
  } finally {
    panel.close(); r.setInlinePlugins([]); r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings']); reset()
  }
})
