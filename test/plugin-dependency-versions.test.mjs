import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const originalCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-dependency-releases-'))
const config = join(root, 'config')
const cache = join(root, 'cache')
const market = join(root, 'market with spaces')
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  )
}
mkdirSync(market)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: cache,
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
  CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
process.chdir(root)
after(() => {
  process.chdir(originalCwd)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  })
})
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd: market, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
git('init')
const vault = join(market, 'vault')
const entries = [
  { name: 'vault', source: './vault' },
  { name: 'bundle', source: './bundle' },
  { name: 'conflict', source: './conflict' },
  { name: 'overlap', source: './overlap' },
]
write(join(market, '.claude-plugin', 'marketplace.json'), {
  name: 'versions',
  owner: { name: 'Fixture' },
  plugins: entries,
})
write(join(market, 'bundle', '.claude-plugin', 'plugin.json'), {
  name: 'bundle',
  version: '1.0.0',
  dependencies: [{ name: 'vault', version: '~2.1.0' }],
})
write(join(market, 'conflict', '.claude-plugin', 'plugin.json'), {
  name: 'conflict',
  version: '1.0.0',
  dependencies: [{ name: 'vault', version: '^3' }],
})
write(join(market, 'overlap', '.claude-plugin', 'plugin.json'), {
  name: 'overlap',
  version: '1.0.0',
  dependencies: [{ name: 'vault', version: '>=2.1.1' }],
})
function release(version, manifestVersion = version, annotated = false) {
  write(join(vault, '.claude-plugin', 'plugin.json'), {
    name: 'vault',
    version: manifestVersion,
  })
  write(join(vault, 'marker.txt'), version)
  git('add', '.')
  git('commit', '-m', version)
  git('tag', ...(annotated ? ['-a', '-m', version] : []), `vault--v${version}`)
  return git('rev-parse', 'HEAD')
}
release('2.1.0')
const v211 = release('2.1.1', '0.0.1', true)
release('2.2.0')
release('3.0.0')
write(join(cache, 'known_marketplaces.json'), {
  versions: {
    source: { source: 'directory', path: market },
    installLocation: market,
    lastUpdated: new Date().toISOString(),
  },
})
const r = await loadBuiltRuntime({
  paths: [
    'src/utils/plugins/dependencyVersions.ts',
    'src/utils/plugins/pluginInstallationHelpers.ts',
    'src/services/plugins/pluginOperations.ts',
  ],
  exports: [
    'selectDependencyVersion',
    'dependencyRangesOverlap',
    'installResolvedPlugin',
    'loadInstalledPluginsFromDisk',
    'getInMemoryInstalledPlugins',
    'clearInstalledPluginsCache: () => { installedPluginsCacheV2 = null; inMemoryInstalledPlugins = null }',
    'getInstalledDependencyRequirements',
    'updatePluginOp',
    'loadAllPluginsCacheOnly',
    'clearPluginCache',
    'getSettingsForSource',
    'readInstalledPluginDependencies',
    'createZipFromDirectory',
  ],
})
const refs = (...ranges) =>
  ranges.map((range, i) => ({ range, requiredBy: `consumer${i}@versions` }))
const install = name =>
  r.installResolvedPlugin({
    pluginId: `${name}@versions`,
    entry: entries.find(e => e.name === name),
    scope: 'user',
    marketplaceInstallLocation: market,
  })
const registry = () => r.loadInstalledPluginsFromDisk().plugins

test('ZIP installations retain dependency constraints', async () => {
  const zip = join(root, 'bundle.zip')
  writeFileSync(zip, await r.createZipFromDirectory(join(market, 'bundle')))
  assert.deepEqual(await r.readInstalledPluginDependencies(zip), [
    { name: 'vault', version: '~2.1.0', marketplace: undefined },
  ])
})

test('range intersections handle alternatives, exact pins and prerelease exclusions', () => {
  for (const [ranges, expected] of [
    [['~2.1', '~3.0'], false],
    [['^2', '>=2.1'], true],
    [['^2 || ^3', '=3.1.0'], true],
    [['^2', '^2.1.0-0'], true],
    [['^2', '=2.1.0-beta.1'], false],
    [['<2', '>=2'], false],
  ])
    assert.equal(
      r.dependencyRangesOverlap(ranges),
      expected,
      ranges.join(' & '),
    )
})

test('tag resolution chooses the highest matching release and peels annotated tags', async () => {
  const result = await r.selectDependencyVersion(
    'vault@versions',
    entries[0],
    market,
    refs('^2', '~2.1'),
  )
  assert.equal(result.version, '2.1.1')
  assert.equal(result.sha, v211)
  assert.equal(result.source.path, 'vault')
  assert.equal(result.source.ref, 'vault--v2.1.1')
  assert.equal(result.source.sha, v211)
  await assert.rejects(
    r.selectDependencyVersion(
      'vault@versions',
      entries[0],
      market,
      refs('^2', '^3'),
    ),
    /conflicting version requirements/,
  )
})

test('missing tags fail for dedicated repositories and fall back for local marketplaces', async () => {
  const entry = {
    name: 'vault',
    source: {
      source: 'git-subdir',
      url: pathToFileURL(market).href,
      path: 'vault',
    },
  }
  await assert.rejects(
    r.selectDependencyVersion('vault@versions', entry, market, refs('^9')),
    /no git tag satisfying/,
  )
  assert.equal(
    await r.selectDependencyVersion(
      'vault@versions',
      entries[0],
      market,
      refs('^9'),
    ),
    undefined,
  )
  const plain = join(root, 'plain marketplace')
  mkdirSync(plain)
  assert.equal(
    await r.selectDependencyVersion(
      'vault@versions',
      entries[0],
      plain,
      refs('^9'),
    ),
    undefined,
  )
  assert.equal(
    await r.selectDependencyVersion(
      'vault@versions',
      { name: 'vault', source: { source: 'npm', package: 'vault' } },
      market,
      refs('^9'),
    ),
    undefined,
  )
})

test('install discovers manifest-only dependencies and pins tag content despite a stale manifest version', async () => {
  r.getInMemoryInstalledPlugins()
  const result = await install('bundle')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.closure, ['vault@versions', 'bundle@versions'])
  const installed = registry()['vault@versions'][0]
  assert.equal(installed.version, `2.1.1-${v211.slice(0, 12)}`)
  assert.equal(installed.dependencyVersion, '2.1.1')
  assert.equal(
    readFileSync(join(installed.installPath, 'marker.txt'), 'utf8'),
    '2.1.1',
  )
  assert.equal(
    r.getInMemoryInstalledPlugins().plugins['vault@versions'][0]
      .dependencyVersion,
    '2.1.1',
  )
  r.clearPluginCache()
  const loaded = await r.loadAllPluginsCacheOnly()
  const dependency = loaded.enabled.find(p => p.source === 'vault@versions')
  assert.ok(dependency, JSON.stringify(loaded.errors))
  assert.equal(dependency.manifest.version, '0.0.1')
  assert.equal(dependency.dependencyVersion, '2.1.1')
  assert.ok(loaded.enabled.some(p => p.source === 'bundle@versions'))
})

test('a conflicting new consumer changes neither existing installations nor enabled settings', async () => {
  const before = JSON.stringify(registry())
  const settings = JSON.stringify(r.getSettingsForSource('userSettings'))
  const result = await install('conflict')
  assert.equal(result.ok, false)
  assert.match(result.resolution.message, /conflicting version requirements/)
  assert.equal(JSON.stringify(registry()), before)
  assert.equal(JSON.stringify(r.getSettingsForSource('userSettings')), settings)
  assert.equal((await install('overlap')).ok, true)
})

test('updates stay in the combined range and leave the running session snapshot unchanged', async () => {
  r.clearInstalledPluginsCache()
  const snapshot = r.getInMemoryInstalledPlugins()
  const before = JSON.stringify(snapshot)
  const sha = release('2.1.2')
  release('2.3.0')
  const result = await r.updatePluginOp('vault@versions', 'user')
  assert.equal(result.success, true, result.message)
  const installed = registry()['vault@versions'][0]
  assert.equal(installed.version, `2.1.2-${sha.slice(0, 12)}`)
  assert.equal(installed.dependencyVersion, '2.1.2')
  assert.equal(
    readFileSync(join(installed.installPath, 'marker.txt'), 'utf8'),
    '2.1.2',
  )
  assert.equal(JSON.stringify(r.getInMemoryInstalledPlugins()), before)
})

test('moving a release tag gets a fresh commit and cache directory', async () => {
  write(join(vault, 'marker.txt'), 'moved release')
  git('add', '.')
  git('commit', '-m', 'Move fixture tag')
  git('tag', '-f', 'vault--v2.1.2')
  const sha = git('rev-parse', 'HEAD')
  const result = await r.updatePluginOp('vault@versions', 'user')
  assert.equal(result.success, true, result.message)
  const installed = registry()['vault@versions'][0]
  assert.equal(installed.version, `2.1.2-${sha.slice(0, 12)}`)
  assert.equal(
    readFileSync(join(installed.installPath, 'marker.txt'), 'utf8'),
    'moved release',
  )
})
