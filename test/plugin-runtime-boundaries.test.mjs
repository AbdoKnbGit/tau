import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import React from 'react'
import { zipSync, strToU8 } from 'fflate'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const cwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-plugin-boundaries-'))
const config = join(root, 'config')
const project = join(root, 'project')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0', CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
  CLAUDE_CODE_SIMPLE: '0', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: ['src/utils/plugins/pluginLoader.ts', 'src/utils/plugins/loadPluginHooks.ts',
    'src/utils/plugins/zipCache.ts', 'src/utils/plugins/cacheUtils.ts', 'src/utils/plugins/marketplaceDownload.ts',
    'src/commands/plugin/ManagePlugins.tsx', 'src/utils/plugins/pluginInstallationHelpers.ts', 'src/utils/plugins/refresh.ts'],
  exports: ['validateOfficialNameSource', 'isBlockedOfficialName', 'PluginManifestSchema',
    'normalizeMarketplaceAliases', 'parseSettingsFile', 'loadSessionOnlyPlugins', 'mergePluginSources',
    'assignPluginHookOwners', 'copyDir', 'createZipFromDirectory', 'extractZipToDirectory',
    'downloadMarketplaceJson', 'isBlockedMarketplaceRedirectHost', 'getRegisteredHooks',
    'clearRegisteredPluginHooks', 'loadAllPluginsCacheOnly', 'clearPluginHookCache',
    'registerLoadedPluginHooks: loadPluginHooks2', 'processOrphanedPluginVersion',
    'getSettingsForSource', 'resetSettingsCache', 'getManagedFilePath', 'isSourceAllowedByPolicy',
    'ManagePlugins', 'MCPConnectionContext', 'installResolvedPlugin', 'clearAllCaches', 'loadAllPlugins', 'setInlinePlugins',
    'setAllowedSettingSources', 'updateSettingsForSource', 'refreshActivePlugins',
    'findPluginByIdentifier', 'uninstallPluginOp'],
})
after(() => {
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test('reserved marketplace names require the actual official host and organization', () => {
  for (const name of ['claude-plugins-official', 'claude-plugins-community', 'healthcare', 'claude-for-legal']) {
    assert.equal(r.isBlockedOfficialName(name), false)
    for (const url of ['https://github.com/anthropics/catalog.git', 'git@github.com:anthropics/catalog.git', 'ssh://git@github.com/anthropics/catalog.git']) {
      assert.equal(r.validateOfficialNameSource(name, { source: 'git', url }), null)
    }
    for (const url of ['https://example.com/github.com/anthropics/catalog.git', 'https://github.com.evil.test/anthropics/catalog', 'https://github.com/another/catalog?path=github.com/anthropics/catalog', 'http://github.com/anthropics/catalog']) {
      assert.ok(r.validateOfficialNameSource(name, { source: 'git', url }))
    }
    assert.ok(r.validateOfficialNameSource(name, { source: 'github', repo: 'another/catalog' }))
  }
})

test('settings aliases normalize before validation and canonical values win per file', () => {
  const path = join(config, 'aliases.json')
  write(path, { allowedMarketplaces: [], additionalMarketplaces: {}, permissions: { allow: ['Read'] } })
  const parsed = r.parseSettingsFile(path)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.settings.strictKnownMarketplaces, [])
  assert.deepEqual(parsed.settings.extraKnownMarketplaces, {})
  assert.deepEqual(r.normalizeMarketplaceAliases({ strictKnownMarketplaces: [], allowedMarketplaces: [{ source: 'github', repo: 'other/*' }] }), { strictKnownMarketplaces: [] })
  write(join(config, 'invalid-alias.json'), { allowedMarketplaces: 'anything' })
  assert.ok(r.parseSettingsFile(join(config, 'invalid-alias.json')).errors.length)
})

test('an alias deny-all policy and GitHub owner wildcard are enforced through settings', () => {
  const managed = join(root, 'managed')
  r.getManagedFilePath.cache.set(undefined, managed)
  const policy = value => {
    write(join(managed, 'managed-settings.json'), value)
    r.resetSettingsCache()
  }
  policy({ allowedMarketplaces: [] })
  assert.equal(r.isSourceAllowedByPolicy({ source: 'github', repo: 'team/catalog' }), false)
  policy({ allowedMarketplaces: [{ source: 'github', repo: 'team/*' }] })
  assert.equal(r.isSourceAllowedByPolicy({ source: 'github', repo: 'team/catalog' }), true)
  assert.equal(r.isSourceAllowedByPolicy({ source: 'github', repo: 'team-other/catalog' }), false)
  policy({ strictKnownMarketplaces: [{ source: 'github', repo: 'team/pre*' }] })
  assert.equal(r.isSourceAllowedByPolicy({ source: 'github', repo: 'team/prefix' }), false)
  policy({})
})

test('parent plugin folders honor inline settings and manifest defaults without shadowing installed plugins', async () => {
  const parent = join(root, 'session plugins')
  for (const [name, extra] of [['one', {}], ['two', { defaultEnabled: false }]]) {
    write(join(parent, name, '.claude-plugin', 'plugin.json'), { name, ...extra })
    write(join(parent, name, 'skills', 'hello', 'SKILL.md'), '---\ndescription: Hello\n---\nHello')
  }
  write(join(config, 'settings.json'), { enabledPlugins: { 'one@inline': false } })
  r.resetSettingsCache()
  const result = await r.loadSessionOnlyPlugins([parent, join(parent, 'one')])
  assert.equal(result.errors.length, 0)
  assert.equal(result.plugins.length, 2)
  assert.ok(result.plugins.every(p => p.enabled === false))
  const installed = { name: 'one', source: 'alias@catalog', enabled: true }
  const merged = r.mergePluginSources({ session: result.plugins, marketplace: [installed], builtin: [] })
  assert.ok(merged.plugins.includes(installed))
  const protectedResult = r.mergePluginSources({ session: [{ ...result.plugins[0], enabled: true }], marketplace: [installed], builtin: [], managedNames: new Set(['alias']) })
  assert.equal(protectedResult.plugins.length, 1)
  assert.equal(protectedResult.errors.length, 1)
})

test('duplicate namespaces register only the managed hook owner and transfer on reload', async () => {
  const plugin = source => ({ name: 'same', source, path: join(root, source), manifest: { name: 'same' }, enabled: true,
    hooksConfig: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `echo ${source}` }] }] } })
  const a = plugin('first@catalog-a'), b = plugin('alias@catalog-b')
  let errors = r.assignPluginHookOwners([a, b], { [b.source]: true })
  assert.equal(a.hooksSuppressedBy, b.source)
  assert.match(errors[0].error, /Its hooks.json hooks do not run/)
  r.loadAllPluginsCacheOnly.cache.set(undefined, Promise.resolve({ enabled: [a, b], disabled: [], errors }))
  r.clearPluginHookCache()
  await r.registerLoadedPluginHooks()
  assert.deepEqual(r.getRegisteredHooks().PreToolUse.map(h => h.pluginId), [b.source])
  b.enabled = false
  errors = r.assignPluginHookOwners([a, b])
  assert.equal(errors.length, 0)
  r.loadAllPluginsCacheOnly.cache.set(undefined, Promise.resolve({ enabled: [a], disabled: [b], errors }))
  r.clearPluginHookCache()
  await r.registerLoadedPluginHooks()
  assert.deepEqual(r.getRegisteredHooks().PreToolUse.map(h => h.pluginId), [a.source])
})

test('cache copies preserve internal targets, copy marketplace shares, and skip external links', async () => {
  const market = join(root, 'market'), plugin = join(market, 'plugin'), cache = join(root, 'copied')
  write(join(plugin, 'policy', 'marker.txt'), 'internal')
  write(join(market, 'shared', 'marker.txt'), 'shared')
  write(join(root, 'outside', 'marker.txt'), 'outside')
  mkdirSync(join(plugin, 'assets'))
  const link = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  link(join(plugin, 'policy'), join(plugin, 'assets', 'policy'))
  link(join(market, 'shared'), join(plugin, 'shared'))
  link(join(root, 'outside'), join(plugin, 'external'))
  await r.copyDir(plugin, cache, market)
  assert.equal(existsSync(join(cache, 'external')), false)
  assert.equal(readFileSync(join(cache, 'shared', 'marker.txt'), 'utf8'), 'shared')
  const local = join(root, 'local-copy')
  await r.copyDir(plugin, local)
  assert.equal(existsSync(join(local, 'shared')), false)
  rmSync(market, { recursive: true, force: true })
  assert.equal(readFileSync(join(cache, 'assets', 'policy', 'marker.txt'), 'utf8'), 'internal')
  const zip = join(root, 'plugin.zip')
  writeFileSync(zip, await r.createZipFromDirectory(cache))
  const extracted = join(root, 'extracted')
  await r.extractZipToDirectory(zip, extracted)
  rmSync(cache, { recursive: true, force: true })
  assert.equal(readFileSync(join(extracted, 'assets', 'policy', 'marker.txt'), 'utf8'), 'internal')
})

test('orphaned cache versions survive ten days and expire after fourteen', async () => {
  const version = join(root, 'old-version'), marker = join(version, '.orphaned_at')
  write(marker, '')
  const now = Date.now(), day = 86400000
  utimesSync(marker, new Date(now - 10 * day), new Date(now - 10 * day))
  await r.processOrphanedPluginVersion(version, now)
  assert.ok(existsSync(version))
  await r.processOrphanedPluginVersion(version, now + 5 * day)
  assert.equal(existsSync(version), false)
})

test('ZIP cache refuses links that escape the extraction directory', async () => {
  const zip = join(root, 'unsafe.zip')
  writeFileSync(zip, zipSync({
    'marker.txt': strToU8('normal'),
    'escape': [strToU8('../outside'), { os: 3, attrs: 0o120777 << 16 }],
  }))
  await assert.rejects(r.extractZipToDirectory(zip, join(root, 'unsafe-extracted')), /escapes cache/)
})

test('environment plugin paths use the normal loader and reject relative paths', async () => {
  const parent = join(root, 'session plugins')
  process.env.CLAUDE_CODE_PLUGIN_DIRS = [parent, 'relative-is-not-loaded'].join(process.platform === 'win32' ? ';' : ':')
  r.setInlinePlugins([])
  r.clearAllCaches()
  const result = await r.loadAllPlugins()
  assert.deepEqual(result.disabled.filter(p => p.source.endsWith('@inline')).map(p => p.name).sort(), ['one', 'two'])
  assert.equal(result.errors.some(e => JSON.stringify(e).includes('relative-is-not-loaded')), false)
  delete process.env.CLAUDE_CODE_PLUGIN_DIRS
  r.clearAllCaches()
})

test('install and management UI use the catalog ID when the manifest namespace differs', async () => {
  const market = join(root, 'identity-market'), plugin = join(market, 'plugin')
  const entry = { name: 'install-alias', source: './plugin' }
  write(join(market, '.claude-plugin', 'marketplace.json'), { name: 'identity', owner: { name: 'Fixture' }, plugins: [entry] })
  write(join(plugin, '.claude-plugin', 'plugin.json'), { name: 'namespace', version: '1.0.0' })
  write(join(plugin, 'skills', 'check', 'SKILL.md'), '---\ndescription: Check\n---\nRead policy.')
  write(join(market, 'shared', 'marker.txt'), 'installed-shared')
  symlinkSync(join(market, 'shared'), join(plugin, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
  write(join(root, 'cache', 'known_marketplaces.json'), {
    identity: { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: new Date().toISOString() },
  })
  r.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
  r.clearAllCaches()
  const installed = await r.installResolvedPlugin({ pluginId: 'install-alias@identity', entry, scope: 'user', marketplaceInstallLocation: market })
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const record = JSON.parse(readFileSync(join(root, 'cache', 'installed_plugins.json'), 'utf8')).plugins['install-alias@identity'][0]
  assert.equal(readFileSync(join(record.installPath, 'shared', 'marker.txt'), 'utf8'), 'installed-shared')
  const messages = []
  const panel = await mount(r, React.createElement(r.MCPConnectionContext.Provider, { value: { toggleMcpServer: () => {} } }, React.createElement(r.ManagePlugins, {
    setViewState: () => {}, setResult: message => messages.push(message), targetPlugin: 'install-alias@identity', action: 'disable',
  })), { columns: 110, rows: 40 })
  try {
    const deadline = Date.now() + 5000
    while (!messages.some(m => m?.includes('Disabled namespace'))) {
      assert.ok(Date.now() < deadline, JSON.stringify(messages) + '\n' + panel.frame())
      await new Promise(resolve => setTimeout(resolve, 20))
      r.reconciler.flushSyncWork()
    }
    const settings = JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8'))
    assert.equal(settings.enabledPlugins['install-alias@identity'], false)
    assert.equal(settings.enabledPlugins['namespace@identity'], undefined)
  } finally { panel.close() }
  const registryPath = join(root, 'cache', 'installed_plugins.json')
  const settingsPath = join(config, 'settings.json')
  const beforeRegistry = readFileSync(registryPath, 'utf8')
  const beforeSettings = readFileSync(settingsPath, 'utf8')
  const missing = await r.uninstallPluginOp('install-alias@missing-catalog', 'user')
  assert.equal(missing.success, false, 'A qualified uninstall must not fall back to another catalog')
  assert.equal(readFileSync(registryPath, 'utf8'), beforeRegistry)
  assert.equal(readFileSync(settingsPath, 'utf8'), beforeSettings)
  const removed = await r.uninstallPluginOp('install-alias@identity', 'user')
  assert.equal(removed.success, true, JSON.stringify(removed))
  assert.equal(JSON.parse(readFileSync(join(root, 'cache', 'installed_plugins.json'), 'utf8')).plugins['install-alias@identity'], undefined)
})

test('uninstall lookup never selects a same-named plugin from another catalog', () => {
  const first = { name: 'same', source: 'same@first' }
  const second = { name: 'same', source: 'same@second' }
  const alias = { name: 'namespace', source: 'alias@second' }
  assert.equal(r.findPluginByIdentifier('same@second', [first, second, alias]), second)
  assert.equal(r.findPluginByIdentifier('alias', [first, second, alias]), alias)
  assert.equal(r.findPluginByIdentifier('same@missing', [first, second, alias]), undefined)
})

test('URL catalogs retain same-origin headers, reject local cross-origin redirects, and enforce size limits', async () => {
  const received = []
  const server = createServer((req, res) => {
    received.push({ path: req.url, token: req.headers['x-fixture-token'] })
    if (req.url === '/same') { res.writeHead(302, { Location: '/ok' }); res.end(); return }
    if (req.url === '/cross') { res.writeHead(302, { Location: `https://127.0.0.1:${server.address().port}/never` }); res.end(); return }
    if (req.url === '/large') { res.end('x'.repeat(5 * 1024 * 1024 + 1)); return }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.deepEqual((await r.downloadMarketplaceJson(base + '/same', { 'X-Fixture-Token': 'synthetic' })).data, { ok: true })
    assert.equal(received.at(-1).token, 'synthetic')
    await assert.rejects(r.downloadMarketplaceJson(base + '/cross', {}), /non-local/)
    assert.equal(received.some(r => r.path === '/never'), false)
    await assert.rejects(r.downloadMarketplaceJson(base + '/large', {}), /maxContentLength/)
    for (const host of ['127.1.2.3', '[::1]', '[::ffff:127.0.0.1]', '169.254.169.254', 'metadata.google.internal', 'localhost']) {
      assert.equal(r.isBlockedMarketplaceRedirectHost(host), true, host)
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
})
