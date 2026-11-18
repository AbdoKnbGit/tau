// Marketplace catalogs are read entry by entry, renames move a user's plugin
// to its new name, and the validator reports what the loader ignores.
// Runs the built CLI (`node build.mjs` first) in a sealed config directory.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'dist', 'cli.mjs')

// A source type no Tau build knows, so these tests stay valid as real source
// types (archive, command, ...) gain support.
const UNKNOWN_SOURCE = 'tau-test-unknown-source'

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'tau-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configDir = join(root, 'config')
  const pluginsDir = join(root, 'plugins')
  const work = join(root, 'work')
  await mkdir(work, { recursive: true })
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginsDir,
    CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
    CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT

  async function tau(...args) {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [cliPath, ...args],
        { cwd: work, env, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      )
      return { code: 0, stdout, stderr }
    } catch (error) {
      if (typeof error.code !== 'number') throw error
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
    }
  }

  async function listInstalled() {
    const { code, stdout, stderr } = await tau('plugin', 'list', '--json')
    assert.equal(code, 0, stderr)
    return JSON.parse(stdout)
  }

  return { root, configDir, pluginsDir, tau, listInstalled }
}

async function writePlugin(marketplaceRoot, dir, name) {
  const pluginRoot = join(marketplaceRoot, 'plugins', dir)
  await writeJson(join(pluginRoot, '.claude-plugin', 'plugin.json'), {
    name,
    version: '1.0.0',
    description: `Fixture plugin ${name}`,
  })
  await mkdir(join(pluginRoot, 'skills', 'hello'), { recursive: true })
  await writeFile(
    join(pluginRoot, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Fixture skill\n---\n\nSay hello.\n',
    'utf8',
  )
}

async function writeCatalog(marketplaceRoot, catalog) {
  await writeJson(
    join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    catalog,
  )
}

const owner = { name: 'Tau catalog test' }

test(
  'an entry this build cannot use leaves the rest of its marketplace working',
  { timeout: 180_000 },
  async t => {
    const box = await sandbox(t)
    const marketplace = join(box.root, 'marketplace')
    await writePlugin(marketplace, 'p1', 'p1')
    await writeCatalog(marketplace, {
      name: 'catalog-fixture',
      owner,
      description: 'Catalog with one entry this build cannot use',
      plugins: [
        { name: 'p1', source: './plugins/p1' },
        { name: 'later', source: { source: UNKNOWN_SOURCE, url: 'x' } },
      ],
    })

    const added = await box.tau('plugin', 'marketplace', 'add', marketplace)
    assert.equal(added.code, 0, added.stdout + added.stderr)

    const installed = await box.tau(
      'plugin', 'install', 'p1@catalog-fixture', '--scope', 'user',
    )
    assert.equal(installed.code, 0, installed.stdout + installed.stderr)

    const [p1] = (await box.listInstalled()).filter(
      p => p.id === 'p1@catalog-fixture',
    )
    assert.ok(p1, 'p1 is listed')
    assert.equal(p1.enabled, true)
    assert.equal(p1.errors, undefined)

    const refused = await box.tau(
      'plugin', 'install', 'later@catalog-fixture', '--scope', 'user',
    )
    assert.notEqual(refused.code, 0)
    assert.match(
      refused.stdout + refused.stderr,
      new RegExp(`source type "${UNKNOWN_SOURCE}" isn't supported`),
    )

    const updated = await box.tau(
      'plugin', 'marketplace', 'update', 'catalog-fixture',
    )
    assert.equal(updated.code, 0, updated.stdout + updated.stderr)
  },
)

test(
  'a renamed plugin moves to its new name with its settings and data',
  { timeout: 180_000 },
  async t => {
    const box = await sandbox(t)
    const marketplace = join(box.root, 'marketplace')
    await writePlugin(marketplace, 'p1', 'p1')
    await writeCatalog(marketplace, {
      name: 'rename-fixture',
      owner,
      plugins: [{ name: 'p1', source: './plugins/p1' }],
    })
    assert.equal(
      (await box.tau('plugin', 'marketplace', 'add', marketplace)).code,
      0,
    )
    assert.equal(
      (await box.tau('plugin', 'install', 'p1@rename-fixture', '--scope', 'user'))
        .code,
      0,
    )

    // Saved options and plugin data stored under the old ID.
    const settingsPath = join(box.configDir, 'settings.json')
    const settings = await readJson(settingsPath)
    settings.pluginConfigs = { 'p1@rename-fixture': { options: { mode: 'kept' } } }
    await writeJson(settingsPath, settings)
    const oldData = join(box.pluginsDir, 'data', 'p1-rename-fixture')
    await mkdir(oldData, { recursive: true })
    await writeFile(join(oldData, 'state.txt'), 'kept\n', 'utf8')

    await writeCatalog(marketplace, {
      name: 'rename-fixture',
      owner,
      plugins: [{ name: 'p1-renamed', source: './plugins/p1' }],
      renames: { p1: 'p1-renamed' },
    })

    const first = await box.listInstalled()
    const old = first.find(p => p.id === 'p1@rename-fixture')
    assert.ok(old, 'the old ID is listed once, with its notice')
    assert.equal(old.errors, undefined)
    assert.deepEqual(old.notices, [
      'Renamed to "p1-renamed" in the "rename-fixture" marketplace',
    ])

    const migrated = await readJson(settingsPath)
    assert.equal(migrated.enabledPlugins['p1-renamed@rename-fixture'], true)
    assert.equal('p1@rename-fixture' in migrated.enabledPlugins, false)
    assert.deepEqual(migrated.pluginConfigs['p1-renamed@rename-fixture'], {
      options: { mode: 'kept' },
    })
    assert.equal('p1@rename-fixture' in migrated.pluginConfigs, false)

    const records = await readJson(join(box.pluginsDir, 'installed_plugins.json'))
    assert.ok(records.plugins['p1-renamed@rename-fixture'])
    assert.equal('p1@rename-fixture' in records.plugins, false)

    const newData = join(box.pluginsDir, 'data', 'p1-renamed-rename-fixture')
    assert.equal(await readFile(join(newData, 'state.txt'), 'utf8'), 'kept\n')
    assert.equal(existsSync(oldData), false)

    const second = await box.listInstalled()
    const renamed = second.find(p => p.id === 'p1-renamed@rename-fixture')
    assert.ok(renamed, 'the new ID is installed')
    assert.equal(renamed.enabled, true)
    assert.equal(renamed.errors, undefined)
    assert.equal(renamed.notices, undefined)
  },
)

test(
  'a plugin renamed to null is dropped but its data is kept',
  { timeout: 180_000 },
  async t => {
    const box = await sandbox(t)
    const marketplace = join(box.root, 'marketplace')
    await writePlugin(marketplace, 'p1', 'p1')
    await writePlugin(marketplace, 'other', 'other')
    await writeCatalog(marketplace, {
      name: 'removal-fixture',
      owner,
      plugins: [
        { name: 'p1', source: './plugins/p1' },
        { name: 'other', source: './plugins/other' },
      ],
    })
    assert.equal(
      (await box.tau('plugin', 'marketplace', 'add', marketplace)).code,
      0,
    )
    assert.equal(
      (await box.tau('plugin', 'install', 'p1@removal-fixture', '--scope', 'user'))
        .code,
      0,
    )
    const data = join(box.pluginsDir, 'data', 'p1-removal-fixture')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'state.txt'), 'kept\n', 'utf8')

    await writeCatalog(marketplace, {
      name: 'removal-fixture',
      owner,
      plugins: [{ name: 'other', source: './plugins/other' }],
      renames: { p1: null },
    })

    const listed = await box.listInstalled()
    const old = listed.find(p => p.id === 'p1@removal-fixture')
    assert.ok(old)
    assert.deepEqual(old.notices, [
      'Removed from the "removal-fixture" marketplace',
    ])

    const settings = await readJson(join(box.configDir, 'settings.json'))
    assert.equal('p1@removal-fixture' in (settings.enabledPlugins ?? {}), false)
    const records = await readJson(join(box.pluginsDir, 'installed_plugins.json'))
    assert.equal('p1@removal-fixture' in records.plugins, false)
    assert.equal(await readFile(join(data, 'state.txt'), 'utf8'), 'kept\n')
  },
)

test(
  'validate warns about unknown keys and rejects a renames loop',
  { timeout: 120_000 },
  async t => {
    const box = await sandbox(t)
    const marketplace = join(box.root, 'marketplace')
    await writePlugin(marketplace, 'a', 'a')
    await writeCatalog(marketplace, {
      name: 'validate-fixture',
      owner,
      description: 'Top-level description is an official key',
      extraField: true,
      plugins: [{ name: 'a', source: './plugins/a' }],
      renames: { x: 'y', y: 'x' },
    })

    const result = await box.tau('plugin', 'validate', marketplace)
    const output = result.stdout + result.stderr
    assert.match(output, /Unknown field 'extraField'/)
    assert.match(output, /renames\.x: chain does not resolve/)
    assert.doesNotMatch(output, /Unrecognized key: "description"/)
  },
)

test(
  'a URL marketplace is cached as published, keys and entries included',
  { timeout: 120_000 },
  async t => {
    const box = await sandbox(t)
    const published = {
      name: 'url-fixture',
      owner,
      plugins: [
        { name: 'remote', source: { source: 'github', repo: 'owner/repo' } },
        { name: 'later', source: { source: UNKNOWN_SOURCE } },
      ],
      renames: { old: 'remote' },
    }
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(published))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const url = `http://127.0.0.1:${server.address().port}/marketplace.json`

    const added = await box.tau('plugin', 'marketplace', 'add', url)
    assert.equal(added.code, 0, added.stdout + added.stderr)

    const known = await readJson(join(box.pluginsDir, 'known_marketplaces.json'))
    const cached = await readJson(known['url-fixture'].installLocation)
    assert.deepEqual(cached.renames, { old: 'remote' })
    assert.deepEqual(
      cached.plugins.map(p => p.name),
      ['remote', 'later'],
    )
  },
)
