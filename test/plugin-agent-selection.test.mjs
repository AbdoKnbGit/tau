import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau agent selection '))
const project = join(root, 'project')
const config = join(root, 'config')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
  CLAUDE_CODE_USE_COWORK_PLUGINS: '0', CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: ['src/utils/plugins/pluginLoader.ts', 'src/utils/plugins/loadPluginAgents.ts',
    'src/utils/plugins/cacheUtils.ts', 'src/utils/plugins/refresh.ts'],
  exports: ['createPluginFromPath', 'finishLoadingPluginFromPath', 'loadPluginAgents',
    'clearAllCaches', 'refreshActivePlugins', 'setInlinePlugins', 'setOriginalCwd',
    'setSessionTrustAccepted', 'setAllowedSettingSources', 'updateSettingsForSource'],
})
r.setOriginalCwd(project)
r.setAllowedSettingSources(['projectSettings', 'localSettings'])
r.setSessionTrustAccepted(true, true)
after(async () => {
  process.chdir(repo)
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

let fixtures = 0
function fixture(fields = {}, manifest = true) {
  const name = `selection-${fixtures++}`
  const path = join(root, `${name} with spaces é`)
  const manifestPath = join(path, '.claude-plugin', 'plugin.json')
  if (manifest) write(manifestPath, { name, ...fields })
  write(join(path, 'agents', 'reviewer.md'), '---\ndescription: Default reviewer\n---\nReview the project.')
  write(join(path, 'agents', 'nested', 'audit.md'), '---\ndescription: Nested auditor\n---\nAudit the project.')
  write(join(path, 'custom', 'security.md'), '---\ndescription: Explicit security agent\n---\nReview security.')
  return { name, path, manifestPath }
}
const names = agents => agents.map(agent => agent.agentType).sort()
async function load(f) {
  r.setInlinePlugins([f.path])
  r.clearAllCaches()
  return r.loadPluginAgents()
}

test('default agents recurse, while explicit files replace discovery and keep flat names', async () => {
  const defaults = fixture()
  assert.deepEqual(names(await load(defaults)), [`${defaults.name}:nested:audit`, `${defaults.name}:reviewer`])
  const explicit = fixture({ agents: './custom/security.md' })
  assert.deepEqual(names(await load(explicit)), [`${explicit.name}:security`])
  const nested = fixture({ agents: ['./agents/nested/audit.md'] })
  assert.deepEqual(names(await load(nested)), [`${nested.name}:audit`])
})

test('empty or unusable selections never fall back to default agents', async () => {
  for (const agents of [[], ['./missing.md'], ['./not-a-file.md']]) {
    const f = fixture({ agents })
    mkdirSync(join(f.path, 'not-a-file.md'))
    write(join(f.path, 'not-a-file.md', 'hidden.md'), '---\ndescription: Must not load\n---\nHidden.')
    const { plugin, errors } = await r.createPluginFromPath(f.path, `${f.name}@inline`, true, f.name)
    assert.equal(plugin.agentsPath, undefined)
    assert.deepEqual(plugin.agentsPaths, [])
    assert.equal(errors.length, agents.length)
    assert.deepEqual(await load(f), [])
  }
})

test('mixed selections keep valid files, reject missing files and load duplicate paths once', async () => {
  const f = fixture({ agents: ['./custom/security.md', './missing.md', './custom/security.md'] })
  const { errors } = await r.createPluginFromPath(f.path, `${f.name}@inline`, true, f.name)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].component, 'agents')
  assert.deepEqual(names(await load(f)), [`${f.name}:security`])
})

test('malformed declarations reject the manifest instead of exposing default agents', async () => {
  for (const agents of [null, './custom', 1, [null]]) {
    const f = fixture({ agents })
    await assert.rejects(r.createPluginFromPath(f.path, `${f.name}@inline`, true, f.name), /invalid manifest/)
    assert.deepEqual(await load(f), [])
  }
})

test('marketplace-as-manifest replaces defaults; strict additions preserve manifest selection', async () => {
  for (const agents of [[], ['./custom/security.md'], ['./missing.md']]) {
    const f = fixture({}, false)
    const errors = []
    const plugin = await r.finishLoadingPluginFromPath(
      { name: f.name, source: './', agents, strict: true }, `${f.name}@catalog`, true, errors, f.path)
    assert.equal(plugin.agentsPath, undefined)
    assert.deepEqual(plugin.agentsPaths, agents.includes('./custom/security.md') ? [join(f.path, 'custom', 'security.md')] : [])
    assert.equal(errors.length, agents.includes('./missing.md') ? 1 : 0)
  }
  for (const selected of [undefined, [], ['./agents/nested/audit.md']]) {
    const f = fixture(selected === undefined ? {} : { agents: selected })
    const errors = []
    const entry = { name: f.name, source: './', agents: ['./custom/security.md'], strict: true }
    const plugin = await r.finishLoadingPluginFromPath(entry, `${f.name}@catalog`, true, errors, f.path)
    assert.deepEqual(errors, [])
    assert.equal(plugin.agentsPath, selected === undefined ? join(f.path, 'agents') : undefined)
    assert.deepEqual(plugin.agentsPaths, [
      ...(selected?.length ? [join(f.path, 'agents', 'nested', 'audit.md')] : []),
      join(f.path, 'custom', 'security.md'),
    ])
    const conflicts = []
    assert.equal(await r.finishLoadingPluginFromPath({ ...entry, strict: false }, `${f.name}@catalog`, true, conflicts, f.path), null)
    assert.ok(conflicts.some(error => /conflicting manifests/.test(error.error)))
  }
})

test('explicit reload updates selection and metadata; disable/enable and a fresh process see current state', async () => {
  const f = fixture()
  await load(f)
  const app = r.createStore(r.getDefaultAppState())
  const active = result => result.agentDefinitions.activeAgents.filter(agent => agent.plugin === `${f.name}@inline`)
  let result = await r.refreshActivePlugins(app.setState)
  assert.equal(active(result).length, 2)
  const selected = { name: f.name, agents: ['./custom/security.md'] }
  write(f.manifestPath, selected)
  write(join(f.path, 'custom', 'security.md'), '---\ndescription: Selected agent\nomitClaudeMd: true\n---\nSecurity instructions.')
  assert.equal((await r.loadPluginAgents()).length, 2, 'active memoized definitions remain stable until reload')
  result = await r.refreshActivePlugins(app.setState)
  assert.deepEqual(names(active(result)), [`${f.name}:security`])
  assert.equal(active(result)[0].omitClaudeMd, true)
  assert.equal(app.getState().agentDefinitions.activeAgents.find(agent => agent.agentType === `${f.name}:security`).omitClaudeMd, true)
  write(f.manifestPath, { name: f.name })
  assert.deepEqual(names(await r.loadPluginAgents()), [`${f.name}:security`], 'the old selection stays active until reload')
  result = await r.refreshActivePlugins(app.setState)
  assert.deepEqual(names(active(result)), [`${f.name}:nested:audit`, `${f.name}:reviewer`], 'omitting agents restores default discovery on reload')
  write(f.manifestPath, selected)
  assert.deepEqual(names(active(await r.refreshActivePlugins(app.setState))), [`${f.name}:security`])
  assert.equal(r.updateSettingsForSource('projectSettings', { enabledPlugins: { [`${f.name}@inline`]: false } }).error, null)
  assert.deepEqual(active(await r.refreshActivePlugins(app.setState)), [])
  assert.equal(r.updateSettingsForSource('projectSettings', { enabledPlugins: { [`${f.name}@inline`]: true } }).error, null)
  assert.deepEqual(names(active(await r.refreshActivePlugins(app.setState))), [`${f.name}:security`])
  const helperUrl = pathToFileURL(join(repo, 'test', 'helpers', 'ink-built-runtime.mjs')).href
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { loadBuiltRuntime } = await import(${JSON.stringify(helperUrl)});
    const r = await loadBuiltRuntime({paths:['src/utils/plugins/loadPluginAgents.ts'], exports:['setInlinePlugins','loadPluginAgents']});
    r.setInlinePlugins([process.env.TAU_SELECTION_FIXTURE]);
    const agents = await r.loadPluginAgents();
    console.log('AGENT_SELECTION=' + JSON.stringify(agents.map(a => ({name:a.agentType, omit:a.omitClaudeMd}))));
  `], { cwd: project, env: { ...process.env, TAU_SELECTION_FIXTURE: f.path }, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  const startup = JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('AGENT_SELECTION=')).slice('AGENT_SELECTION='.length))
  assert.deepEqual(startup, [{ name: `${f.name}:security`, omit: true }])
  assert.deepEqual(JSON.parse(readFileSync(f.manifestPath, 'utf8')), selected, 'loading never rewrites plugin files')
})
