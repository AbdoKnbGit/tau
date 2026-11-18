// The `command` plugin source and the shell consent that guards it, through
// the built CLI (`node build.mjs` first) in a sealed config directory, plus
// the source module's own helpers.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'dist', 'cli.mjs')

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'tau-command-'))
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
    NO_COLOR: '1',
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  // A Windows session's markers make Tau treat piped stdin as a terminal.
  delete env.SESSIONNAME
  delete env.WT_SESSION

  async function tau(...args) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
        cwd: work, env, maxBuffer: 10 * 1024 * 1024, timeout: 90_000,
      })
      return { code: 0, output: stdout + stderr, stdout }
    } catch (error) {
      if (typeof error.code !== 'number') throw error
      return { code: error.code, output: `${error.stdout}${error.stderr}`, stdout: error.stdout }
    }
  }

  // The tool a command source asks: a script printing the plugin directory.
  const tool = join(root, 'tool')
  const pluginDir = join(tool, 'rendered-plugin')
  await writeJson(join(pluginDir, '.claude-plugin', 'plugin.json'), {
    name: 'rendered',
    description: 'Plugin a local tool renders',
  })
  await mkdir(join(pluginDir, 'skills', 'hello'), { recursive: true })
  await writeFile(join(pluginDir, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Fixture\n---\n\nSay hello.\n', 'utf8')

  async function script(name, body) {
    const path = join(tool, name)
    await writeFile(path, body, 'utf8')
    return `"${process.execPath}" "${path}"`
  }
  const printPlugin = await script('print.mjs', `console.log(${JSON.stringify(pluginDir)})\n`)

  const marketplace = join(root, 'marketplace')
  async function catalog(source) {
    await writeJson(join(marketplace, '.claude-plugin', 'marketplace.json'), {
      name: 'command-fixture',
      owner: { name: 'Tau command test' },
      description: 'Command sources',
      plugins: [{ name: 'rendered', source: { source: 'command', ...source } }],
    })
  }
  await catalog({ command: printPlugin })
  assert.equal((await tau('plugin', 'marketplace', 'add', marketplace)).code, 0)

  const installed = async () =>
    (await readJson(join(pluginsDir, 'installed_plugins.json'))).plugins['rendered@command-fixture']

  return { root, configDir, pluginsDir, pluginDir, tau, script, catalog, installed, printPlugin }
}

const shaIn = output => /SHA-256: ([0-9a-f]{64})/.exec(output)?.[1]

test('an install shows the command and runs it only once accepted', { timeout: 300_000 }, async t => {
  const box = await sandbox(t)

  const refused = await box.tau('plugin', 'install', 'rendered@command-fixture')
  assert.notEqual(refused.code, 0)
  assert.match(refused.output, /installed by running this command from its marketplace/)
  assert.ok(refused.output.includes(box.printPlugin), 'the exact command is shown')
  assert.match(refused.output, /Re-run with --yes/)
  const sha = shaIn(refused.output)
  assert.ok(sha, 'the SHA-256 is shown')
  const recordsPath = join(box.pluginsDir, 'installed_plugins.json')
  assert.equal(existsSync(recordsPath) ? await box.installed() : undefined, undefined, 'nothing installed')

  const wrong = await box.tau('plugin', 'install', 'rendered@command-fixture', '--accept-command', 'f'.repeat(64))
  assert.notEqual(wrong.code, 0)
  assert.match(wrong.output, /Nothing was run/)

  const accepted = await box.tau('plugin', 'install', 'rendered@command-fixture', '--accept-command', sha)
  assert.equal(accepted.code, 0, accepted.output)
  const [record] = await box.installed()
  assert.match(record.version, /^[0-9a-f]{12}$/, 'version is the output hash')
  assert.ok(existsSync(join(record.installPath, 'skills', 'hello', 'SKILL.md')), 'copied into the cache')

  // Identical output is up to date; changed output is a new version.
  const same = await box.tau('plugin', 'update', 'rendered@command-fixture', '--yes')
  assert.match(same.output, /already at the latest version/)
  await writeFile(join(box.pluginDir, 'skills', 'hello', 'SKILL.md'), 'changed\n', 'utf8')
  const changed = await box.tau('plugin', 'update', 'rendered@command-fixture', '--yes')
  assert.equal(changed.code, 0, changed.output)
  const [next] = await box.installed()
  assert.notEqual(next.version, record.version)

  // An update asks again: no terminal and no flag means no run.
  const again = await box.tau('plugin', 'update', 'rendered@command-fixture')
  assert.notEqual(again.code, 0)
  assert.match(again.output, /needs your approval/)
})

test('a manifest version is joined to the output hash', { timeout: 180_000 }, async t => {
  const box = await sandbox(t)
  const manifest = join(box.pluginDir, '.claude-plugin', 'plugin.json')
  await writeJson(manifest, { ...(await readJson(manifest)), version: '2.1.0' })
  assert.equal((await box.tau('plugin', 'install', 'rendered@command-fixture', '--yes')).code, 0)
  const [record] = await box.installed()
  assert.match(record.version, /^2\.1\.0-[0-9a-f]{12}$/)
})

test('settings can turn command sources off', { timeout: 180_000 }, async t => {
  const box = await sandbox(t)
  const settingsPath = join(box.configDir, 'settings.json')
  await writeJson(settingsPath, { ...(await readJson(settingsPath)), disableCommandPluginSources: true })
  const result = await box.tau('plugin', 'install', 'rendered@command-fixture', '--yes')
  assert.notEqual(result.code, 0)
  assert.match(result.output, /Command-sourced plugins are disabled by your settings \(disableCommandPluginSources\)/)
})

test('output that is not one absolute plugin directory fails the install', { timeout: 300_000 }, async t => {
  const box = await sandbox(t)
  const cases = [
    [await box.script('relative.mjs', 'console.log("relative/dir")\n'), /is not an absolute path/],
    [await box.script('two.mjs', `console.log(${JSON.stringify(box.pluginDir)}); console.log("x")\n`), /exactly one line/],
    [await box.script('empty-dir.mjs', `console.log(${JSON.stringify(box.root)})\n`), /no plugin content at its top level/],
    [await box.script('fail.mjs', 'console.error("tool broke"); process.exit(3)\n'), /exited with code 3: tool broke/],
  ]
  for (const [command, expected] of cases) {
    await box.catalog({ command })
    const result = await box.tau('plugin', 'install', 'rendered@command-fixture', '--yes')
    assert.notEqual(result.code, 0, command)
    assert.match(result.output, expected)
  }
  await box.catalog({ command: await box.script('slow.mjs', 'setTimeout(() => {}, 30000)\n'), timeout: 1 })
  const slow = await box.tau('plugin', 'install', 'rendered@command-fixture', '--yes')
  assert.match(slow.output, /ran longer than its 1-second timeout/)
  assert.equal(readdirSync(join(box.pluginsDir, 'cache')).filter(n => n.startsWith('temp_')).length, 0,
    'failed runs leave no temporary entries')
})

test('link mode is refused on Windows and loads in place elsewhere', { timeout: 180_000 }, async t => {
  const box = await sandbox(t)
  await box.catalog({ command: box.printPlugin, mode: 'link' })
  const result = await box.tau('plugin', 'install', 'rendered@command-fixture', '--yes')
  if (process.platform === 'win32') {
    assert.notEqual(result.code, 0)
    assert.match(result.output, /not supported on Windows/)
    return
  }
  assert.equal(result.code, 0, result.output)
  const [record] = await box.installed()
  const { lstatSync, realpathSync } = await import('node:fs')
  assert.ok(lstatSync(join(record.installPath, 'skills')).isSymbolicLink())
  assert.equal(realpathSync(join(record.installPath, 'skills')), realpathSync(join(box.pluginDir, 'skills')))
})

test('a command changed in the catalog does not run until accepted again', { timeout: 300_000 }, async t => {
  const box = await sandbox(t)
  assert.equal((await box.tau('plugin', 'install', 'rendered@command-fixture', '--yes')).code, 0)
  const [record] = await box.installed()

  // The cached version disappears; startup re-runs the accepted command.
  await rm(record.installPath, { recursive: true, force: true })
  const listed = JSON.parse((await box.tau('plugin', 'list', '--json')).stdout)
  const entry = listed.find(p => p.id === 'rendered@command-fixture')
  assert.equal(entry.errors, undefined, JSON.stringify(entry))
  assert.ok(existsSync(join(record.installPath, 'skills')), 'restored by re-running the command')

  // A changed command is not run at startup; the error says how to review it.
  await rm(record.installPath, { recursive: true, force: true })
  await box.catalog({ command: `${box.printPlugin} --changed` })
  const after = JSON.parse((await box.tau('plugin', 'list', '--json')).stdout)
  const changed = after.find(p => p.id === 'rendered@command-fixture')
  assert.match(changed.errors.join('\n'), /changed in its marketplace and was not run\. Review it with: tau plugin update rendered@command-fixture/)
  assert.equal(existsSync(record.installPath), false)
})

// The source module's helpers, bundled on their own.
const bundle = await build({
  entryPoints: [join(repoRoot, 'src/utils/plugins/commandSource.ts')],
  bundle: true,
  packages: 'external',
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
})
const source = (() => {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports)
  return module.exports
})()

test('printed output: one absolute path, no network paths on Windows', () => {
  assert.equal(source.parsePrintedDirectory('/opt/plugin\n', 'linux'), '/opt/plugin')
  assert.equal(source.parsePrintedDirectory('C:\\tool\\plugin\r\n', 'win32'), 'C:\\tool\\plugin')
  assert.throws(() => source.parsePrintedDirectory('\\\\server\\share\\plugin\n', 'win32'), /network path/)
  assert.throws(() => source.parsePrintedDirectory('C:\\x\n', 'linux'), /not an absolute path/)
  assert.throws(() => source.parsePrintedDirectory('', 'linux'), /exactly one line/)
})

test('a declared command runs without credential-like variables', () => {
  const env = source.withoutCredentials({
    PATH: '/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'x', MY_REGISTRY_TOKEN: 'y',
    db_password: 'z', ANTHROPIC_CUSTOM_HEADERS: 'h', GIT_CONFIG_KEY_0: 'core.x',
  })
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_KEY_0', 'HOME', 'PATH'])
})

test('a command source runs without credential-like variables', { timeout: 180_000 }, async t => {
  // Set before the sandbox copies the environment, so the CLI really has it.
  process.env.ANTHROPIC_API_KEY = 'secret-for-test'
  t.after(() => { delete process.env.ANTHROPIC_API_KEY })
  const box = await sandbox(t)
  const marker = join(box.root, 'command-env.json')
  const command = await box.script('env-check.mjs', [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ sawApiKey: 'ANTHROPIC_API_KEY' in process.env, hasPath: Boolean(process.env.PATH || process.env.Path) }))`,
    `console.log(${JSON.stringify(box.pluginDir)})`,
    '',
  ].join('\n'))
  await box.catalog({ command })
  const result = await box.tau('plugin', 'install', 'rendered@command-fixture', '--yes')
  assert.equal(result.code, 0, result.output)
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { sawApiKey: false, hasPath: true })
})
