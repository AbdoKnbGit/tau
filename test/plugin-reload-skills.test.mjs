import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const originalCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-reload-skills-'))
const project = join(root, 'project')
const market = join(root, 'marketplace')
const cache = join(root, 'plugins')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: cache,
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
  CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
const entry = { name: 'review', source: './review' }
write(join(market, '.claude-plugin', 'marketplace.json'), {
  name: 'reload-fixture', owner: { name: 'Fixture' }, plugins: [entry],
})
write(join(market, 'review', '.claude-plugin', 'plugin.json'), { name: 'review', version: '1.0.0' })
write(join(market, 'review', 'skills', 'version', 'SKILL.md'), '---\nname: version\ndescription: Read the current release\n---\nRead version.txt.\n')
write(join(market, 'review', 'skills', 'policy', 'SKILL.md'), '---\nname: policy\ndescription: Source-only policy\npaths:\n  - "src/**"\n---\nCheck quantities.\n')
write(join(cache, 'known_marketplaces.json'), {
  'reload-fixture': { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: new Date().toISOString() },
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: ['src/utils/plugins/refresh.ts', 'src/hooks/useSkillsChange.ts', 'src/utils/plugins/pluginInstallationHelpers.ts'],
  exports: ['refreshActivePlugins', 'useSkillsChange', 'getCommands', 'installResolvedPlugin',
    'skillChangeDetector', 'activateConditionalSkillsForPaths', 'updateSettingsForSource',
    'setAllowedSettingSources', 'getDynamicSkills'],
})
r.setAllowedSettingSources(['projectSettings', 'localSettings'])
after(async () => {
  await r.skillChangeDetector.dispose()
  process.chdir(originalCwd)
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test('explicit plugin reload refreshes mounted slash commands and preserves conditional activation', async () => {
  let visible = await r.getCommands(project)
  function CommandList() {
    const [commands, setCommands] = React.useState(visible)
    r.useSkillsChange(project, setCommands)
    visible = commands
    return null
  }
  const panel = await mount(r, React.createElement(CommandList))
  const has = name => visible.some(command => command.name === name)
  const waitFor = async (predicate, message) => {
    const until = Date.now() + 3000
    while (!predicate() && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 20))
      r.reconciler.flushSyncWork()
    }
    assert.ok(predicate(), message)
  }
  try {
    await r.skillChangeDetector.initialize()
    assert.equal(has('review:version'), false)
    const installed = await r.installResolvedPlugin({
      pluginId: 'review@reload-fixture', entry, scope: 'project', marketplaceInstallLocation: market,
    })
    assert.equal(installed.ok, true, JSON.stringify(installed))
    assert.equal(has('review:version'), false, 'install must retain the explicit reload boundary')

    const result = await r.refreshActivePlugins(panel.store.setState)
    await waitFor(() => has('review:version'), '/reload-plugins left the mounted slash-command list stale')
    assert.equal(result.command_count, 1, 'reload counts available plugin skills too')
    assert.ok(result.pluginCommands.some(command => command.name === 'review:version'))
    assert.equal(has('review:policy'), false)
    assert.deepEqual(r.activateConditionalSkillsForPaths([join(project, 'docs', 'notes.txt')], project), [])
    assert.deepEqual(r.activateConditionalSkillsForPaths([join(project, 'src', 'invoice.js')], project), ['review:policy'])
    await waitFor(() => has('review:policy'), 'the live skill list lost the newly activated conditional plugin skill')
    assert.ok(r.getDynamicSkills().some(command => command.name === 'review:policy'))

    const changed = r.updateSettingsForSource('projectSettings', { enabledPlugins: { 'review@reload-fixture': false } })
    assert.ok(!changed.error, String(changed.error))
    await r.refreshActivePlugins(panel.store.setState)
    await waitFor(() => !has('review:version') && !has('review:policy'), 'disabled plugin skills survived reload')
    assert.ok(!panel.store.getState().plugins.commands.some(command => command.name.startsWith('review:')))
  } finally {
    panel.close()
  }
})
