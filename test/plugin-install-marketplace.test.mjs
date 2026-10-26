import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import React from 'react'
import { KEYS, loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-install-marketplace-'))
const configDir = join(root, 'config')
const cacheDir = join(root, 'plugins')
const project = join(root, 'project')
const writeJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}
mkdirSync(project)
mkdirSync(configDir)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDir,
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
  CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
  CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
writeJson(join(cacheDir, 'install-counts-cache.json'), {
  version: 1, fetchedAt: new Date().toISOString(), counts: [],
})
process.chdir(project)
after(() => {
  process.chdir(repo)
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
const runtime = await loadBuiltRuntime({
  paths: ['src/commands/plugin/PluginSettings.tsx', 'src/utils/plugins/pluginLoader.ts',
    'src/utils/plugins/loadPluginHooks.ts', 'src/utils/plugins/loadPluginCommands.ts', 'src/utils/plugins/validatePlugin.ts'],
  exports: ['PluginSettings', 'parsePluginArgs', 'resolveInstallMarketplace', 'loadPluginHooks: readPluginHooksFile',
    'parseMarketplaceInput', 'addInstallMarketplace', 'getMarketplace', 'cachePlugin', 'PluginSourceSchema', 'calculatePluginVersion',
    'execFileNoThrowWithCwd', 'preferredGitHubPluginUrl', 'resolveGitSubdirUrl',
    'createPluginFromPath', 'convertPluginHooksToMatchers', 'HOOK_EVENTS', 'loadSkillsFromDirectory',
    'validateHooksJson', 'validatePluginManifest',
    'getSshProbe: () => isGitHubSshLikelyConfigured',
    'setSshProbe: probe => { isGitHubSshLikelyConfigured = probe }'],
})

function fixture(folder, name, pluginName = 'shared-plugin', description = name) {
  const path = join(root, folder)
  writeJson(join(path, '.claude-plugin', 'marketplace.json'), {
    name, owner: { name: 'Tau regression tests' },
    plugins: [{ name: pluginName, description, source: './' }],
  })
  writeJson(join(path, '.claude-plugin', 'plugin.json'), { name: pluginName, version: '1.0.0' })
  return path
}
const wrong = fixture('wrong', 'wrong-market', 'shared-plugin', 'Wrong marketplace marker')
const right = fixture('repository with spaces', 'actual-market', 'shared-plugin', 'Requested marketplace marker')
writeJson(join(cacheDir, 'known_marketplaces.json'), {
  'wrong-market': {
    source: { source: 'directory', path: wrong }, installLocation: wrong,
    lastUpdated: new Date().toISOString(),
  },
})

async function open(args) {
  const completions = []
  const panel = await mount(runtime, React.createElement(runtime.PluginSettings, {
    args, onComplete: result => completions.push(result),
  }), { columns: 110, rows: 40 })
  return Object.assign(panel, { completions })
}

test('slash install parses marketplace flags, quoting, aliases and source refs', () => {
  for (const args of [
    'install cc-stretch --marketplace pro-vi/cc-stretch',
    'i --marketplace pro-vi/cc-stretch cc-stretch',
    'install cc-stretch --marketplace=pro-vi/cc-stretch',
  ]) {
    assert.deepEqual(runtime.parsePluginArgs(args), {
      type: 'install', plugin: 'cc-stretch', marketplace: 'pro-vi/cc-stretch',
    })
  }
  assert.equal(runtime.parsePluginArgs(`install shared-plugin --marketplace "${right}"`).marketplace, right)
  assert.equal(runtime.parsePluginArgs(`marketplace add "${right}"`).target, right)
  assert.equal(runtime.parsePluginArgs(`validate "${right}"`).path, right)
  assert.deepEqual(runtime.parsePluginArgs('install shared-plugin@actual-market'), {
    type: 'install', plugin: 'shared-plugin', marketplace: 'actual-market',
  })
  for (const source of ['git@github.com:owner/repo.git', 'owner/repo@v2', 'owner/repo#v2']) {
    assert.deepEqual(runtime.parsePluginArgs(`install ${source}`), { type: 'install', marketplace: source })
  }
  for (const args of [
    'install cc-stretch --marketplace', 'install cc-stretch --marketplace=',
    'install cc-stretch --marketplace --scope user',
    'install cc-stretch@a --marketplace b', 'install cc-stretch --typo value',
    'install --marketplace owner/repo', 'install cc-stretch extra',
    'install cc-stretch --marketplace a --marketplace b',
    'install cc-stretch --marketplace "unfinished',
    'install cc-stretch --marketplace ""',
  ]) assert.equal(runtime.parsePluginArgs(args).type, 'error', args)
})

test('unknown source asks to add it; Escape makes no marketplace or plugin changes', async () => {
  const before = readFileSync(join(cacheDir, 'known_marketplaces.json'), 'utf8')
  const panel = await open(`install shared-plugin --marketplace "${right}"`)
  try {
    await panel.waitFor(/Add marketplace\?/)
    assert.match(panel.frame(), /Only add marketplaces you trust/)
    assert.equal(readFileSync(join(cacheDir, 'known_marketplaces.json'), 'utf8'), before)
    assert.equal(existsSync(join(cacheDir, 'installed_plugins.json')), false)
    await panel.press(KEYS.esc)
    assert.equal(readFileSync(join(cacheDir, 'known_marketplaces.json'), 'utf8'), before)
  } finally { panel.close() }
})

test('confirming add resolves the manifest name and opens the requested plugin for review', async () => {
  const panel = await open(`install shared-plugin --marketplace "${right}"`)
  try {
    await panel.waitFor(/Add marketplace\?/)
    await panel.press(KEYS.enter)
    await panel.waitFor(/Requested marketplace marker/)
    assert.doesNotMatch(panel.frame(), /Wrong marketplace marker/)
    assert.equal(existsSync(join(cacheDir, 'installed_plugins.json')), false, 'adding a catalog must not install the plugin')
    const known = JSON.parse(readFileSync(join(cacheDir, 'known_marketplaces.json'), 'utf8'))
    assert.ok(known['actual-market'])
    assert.ok(known['wrong-market'])
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    assert.equal(settings.extraKnownMarketplaces['actual-market'].source.path, right)
  } finally { panel.close() }
})

test('already added source and plugin@marketplace select the correct duplicate', async () => {
  for (const args of [
    `install shared-plugin --marketplace "${right}"`,
    'install shared-plugin@actual-market',
    'install shared-plugin --marketplace actual-market',
  ]) {
    const panel = await open(args)
    try {
      await panel.waitFor(/Requested marketplace marker/)
      assert.doesNotMatch(panel.frame(), /Add marketplace\?|Wrong marketplace marker/)
    } finally { panel.close() }
  }
})

test('a missing plugin or marketplace never falls back to a different catalog', async () => {
  const empty = fixture('empty', 'empty-market', 'another-plugin')
  const panel = await open(`install shared-plugin --marketplace "${empty}"`)
  try {
    await panel.waitFor(/Add marketplace\?/)
    await panel.press(KEYS.enter)
    await panel.waitFor(/not found in marketplace "empty-market"/)
    assert.doesNotMatch(panel.frame(), /Wrong marketplace marker/)
  } finally { panel.close() }
  const missing = await open('install shared-plugin@missing-market')
  try {
    await missing.waitFor(/Marketplace "missing-market" is not configured/)
  } finally { missing.close() }
})

test('source parsing accepts github display prefixes and local file URLs without downloading', async () => {
  assert.deepEqual(await runtime.resolveInstallMarketplace('github:pro-vi/cc-stretch'), {
    source: { source: 'github', repo: 'pro-vi/cc-stretch' },
  })
  assert.deepEqual(await runtime.resolveInstallMarketplace(pathToFileURL(right).href), { name: 'actual-market' })
})

test('GitHub URL and shorthand edge cases retain the intended repository and ref', async () => {
  for (const url of ['https://github.com/obra/superpowers-marketplace/', 'https://github.com/obra/superpowers-marketplace']) {
    assert.deepEqual(await runtime.parseMarketplaceInput(url + '#v1'), {
      source: 'git', url: 'https://github.com/obra/superpowers-marketplace.git', ref: 'v1',
    })
  }
  for (const input of ['obra/superpowers-marketplace/', 'obra/superpowers-marketplace.git', 'github:obra/superpowers-marketplace']) {
    assert.deepEqual(await runtime.parseMarketplaceInput(input + '@dev'), {
      source: 'github', repo: 'obra/superpowers-marketplace', ref: 'dev',
    })
  }
  assert.match((await runtime.parseMarketplaceInput('https://github.com/obra/superpowers/tree/main')).error, /#branch/)
  assert.equal(await runtime.parseMarketplaceInput('owner/repo/invalid'), null)
})

test('GitHub plugin sources choose HTTPS without SSH and preserve explicit SSH URLs', async () => {
  const originalProbe = runtime.getSshProbe()
  const originalRemote = process.env.CLAUDE_CODE_REMOTE
  try {
    delete process.env.CLAUDE_CODE_REMOTE
    runtime.setSshProbe(async () => false)
    assert.equal(await runtime.preferredGitHubPluginUrl('owner/repo'), 'https://github.com/owner/repo.git')
    assert.equal(await runtime.resolveGitSubdirUrl('owner/repo'), 'https://github.com/owner/repo.git')
    assert.equal(await runtime.resolveGitSubdirUrl('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git')
    runtime.setSshProbe(async () => true)
    assert.equal(await runtime.preferredGitHubPluginUrl('owner/repo'), 'git@github.com:owner/repo.git')
    process.env.CLAUDE_CODE_REMOTE = '1'
    assert.equal(await runtime.preferredGitHubPluginUrl('owner/repo'), 'https://github.com/owner/repo.git')
  } finally {
    runtime.setSshProbe(originalProbe)
    if (originalRemote === undefined) delete process.env.CLAUDE_CODE_REMOTE
    else process.env.CLAUDE_CODE_REMOTE = originalRemote
  }
})

test('replacing a catalog invalidates the manifest already read in this session', async () => {
  const first = fixture('replace-first', 'replace-market', 'old-plugin')
  await runtime.addInstallMarketplace({ source: 'directory', path: first })
  assert.equal((await runtime.getMarketplace('replace-market')).plugins[0].name, 'old-plugin')
  const second = fixture('replace-second', 'replace-market', 'new-plugin')
  await runtime.addInstallMarketplace({ source: 'directory', path: second })
  assert.equal((await runtime.getMarketplace('replace-market')).plugins[0].name, 'new-plugin')
})

test('failed marketplace add stays in the confirmation UI and can be retried', async () => {
  const invalid = join(root, 'invalid-catalog')
  mkdirSync(invalid)
  const panel = await open(`install shared-plugin --marketplace "${invalid}"`)
  try {
    await panel.waitFor(/Add marketplace\?/)
    await panel.press(KEYS.enter)
    await panel.waitFor(/Marketplace file not found/)
    assert.equal(panel.completions.length, 0)
    fixture('invalid-catalog', 'retry-market', 'shared-plugin', 'Retry succeeded marker')
    await panel.press(KEYS.enter)
    await panel.waitFor(/Retry succeeded marker/)
  } finally { panel.close() }
})

test('URL plugin subdirectories preserve pinned SHA and distinguish cache paths', async () => {
  const gitRepo = join(root, 'monorepo')
  mkdirSync(gitRepo)
  const git = (...args) => execFileSync('git', ['-C', gitRepo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init')
  git('config', 'user.name', 'Tau fixture')
  git('config', 'user.email', 'tau@example.invalid')
  for (const path of ['plugins/one', 'plugins/two']) {
    writeJson(join(gitRepo, path, '.claude-plugin', 'plugin.json'), { name: 'subdir-fixture' })
    writeFileSync(join(gitRepo, path, 'payload.txt'), path)
  }
  writeJson(join(gitRepo, '.claude-plugin', 'plugin.json'), { name: 'wrong-root-plugin' })
  git('add', '--all')
  git('commit', '-m', 'pinned release')
  const sha = git('rev-parse', 'HEAD')
  writeFileSync(join(gitRepo, 'plugins/one/payload.txt'), 'unpublished HEAD')
  git('add', '--all')
  git('commit', '-m', 'unpublished')
  const versions = []
  for (const path of ['plugins/one', 'plugins/two']) {
    const source = runtime.PluginSourceSchema().parse({ source: 'url', url: pathToFileURL(gitRepo).href, path, sha })
    assert.equal(source.path, path, 'schema must not strip the subdirectory')
    const cached = await runtime.cachePlugin(source)
    assert.equal(cached.manifest.name, 'subdir-fixture')
    assert.equal(cached.gitCommitSha, sha)
    assert.equal(readFileSync(join(cached.path, 'payload.txt'), 'utf8'), path)
    versions.push(await runtime.calculatePluginVersion('subdir-fixture@test', source, cached.manifest, cached.path, undefined, cached.gitCommitSha))
  }
  assert.notEqual(versions[0], versions[1], 'same SHA at different subdirectories must not share a version key')
})

test('CLI install adds a source, installs by its manifest name and honors project scope', () => {
  const cliSource = fixture('cli-source', 'cli-actual', 'cli-fixture')
  const cliConfig = join(root, 'cli-config')
  const cliCache = join(root, 'cli-cache')
  const run = (...args) => execFileSync(process.execPath, [resolve(repo, 'dist/cli.mjs'), ...args], {
    cwd: project, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: cliConfig, CLAUDE_CODE_PLUGIN_CACHE_DIR: cliCache },
  })
  const output = run('plugin', 'install', 'cli-fixture', '--marketplace', cliSource, '--scope', 'project')
  assert.match(output, /Successfully installed plugin: cli-fixture@cli-actual/)
  const installed = JSON.parse(readFileSync(join(cliCache, 'installed_plugins.json'), 'utf8'))
  assert.equal(installed.plugins['cli-fixture@cli-actual'][0].scope, 'project')
  assert.equal(existsSync(join(installed.plugins['cli-fixture@cli-actual'][0].installPath, '.claude-plugin', 'plugin.json')), true)
  assert.match(run('plugin', 'install', 'cli-fixture', '--marketplace', 'cli-actual'), /Successfully installed/)
})

test('standalone declarative loader reports modules when no mod collector is supplied', async () => {
  const hooks = join(root, 'module-hooks.json')
  writeJson(hooks, { modules: ['./register.tsx'] })
  const issues = []
  assert.deepEqual(await runtime.loadPluginHooks(hooks, 'cc-stretch', message => issues.push(message)), {})
  assert.match(issues.join('\n'), /hook modules.*Tau does not support/)
  assert.match(issues.join('\n'), /will not run/)
  writeJson(hooks, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo test' }] }] } })
  assert.ok((await runtime.loadPluginHooks(hooks, 'normal-hooks')).SessionStart)
})

test('mixed hook files collect modules without execution and report unsupported declarative events and types', async () => {
  const path = fixture('mixed-hooks', 'mixed-hooks-market', 'mixed-hooks')
  const standard = join(path, 'hooks/hooks.json')
  const additional = join(path, 'extra-hooks.json')
  writeJson(join(path, '.claude-plugin/plugin.json'), {
    name: 'mixed-hooks', hooks: ['./extra-hooks.json', {
      SessionStart: [{ hooks: [{ type: 'future', future: true }, { type: 'command', command: 'echo inline' }] }],
      FutureInlineEvent: [{ hooks: [{ type: 'command', command: 'echo unknown' }] }],
    }],
  })
  writeJson(standard, {
    modules: ['./register.tsx'], hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo standard' }, { type: 'future', future: true }] }],
      FutureEvent: [{ hooks: [{ type: 'command', command: 'echo unknown' }] }],
    },
  })
  writeJson(additional, { modules: ['./second.ts'], hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo additional' }] }],
  } })
  writeFileSync(join(path, 'hooks/register.tsx'), "throw new Error('must not execute during discovery'); export function register(on) {}")
  writeFileSync(join(path, 'second.ts'), 'export function register(on) {}')
  const { plugin, errors } = await runtime.createPluginFromPath(path, 'mixed-hooks@test', true, 'mixed-hooks')
  assert.deepEqual(plugin.hooksConfig.SessionStart.flatMap(m => m.hooks.map(h => h.command)), [
    'echo standard', 'echo additional', 'echo inline',
  ])
  assert.equal(plugin.modEntries.length, 2)
  assert.equal(errors.length, 4, JSON.stringify(errors))
  assert.ok(errors.every(error => error.type === 'hook-load-failed'))
  assert.match(errors.map(error => error.reason).join('\n'), /FutureInlineEvent/)
  assert.match(errors.map(error => error.reason).join('\n'), /FutureEvent/)
  assert.match(errors.map(error => error.reason).join('\n'), /type "future"/)
  const validated = await runtime.validateHooksJson(standard, path)
  assert.equal(validated.success, true)
  assert.equal(validated.warnings.length, 3)
  const manifestValidated = await runtime.validatePluginManifest(join(path, '.claude-plugin/plugin.json'))
  assert.equal(manifestValidated.success, true, JSON.stringify(manifestValidated))
  assert.equal(manifestValidated.warnings.filter(w => /not supported/.test(w.message)).length, 2)
})

test('malformed supported hooks still fail instead of being silently discarded', async () => {
  const hooks = join(root, 'malformed-hooks.json')
  for (const config of [
    { hooks: { SessionStart: [{ hooks: [{ type: 'command' }] }] } },
    { hooks: { SessionStart: [{ hooks: [{ command: 'echo missing type' }] }] } },
    { modules: ['./module.ts'], hooks: null },
    {},
  ]) {
    writeJson(hooks, config)
    await assert.rejects(runtime.loadPluginHooks(hooks, 'malformed', () => {}))
  }
})

test('plugin registration includes every supported event and keeps plugin identity', () => {
  const plugin = {
    name: 'events', path: '/plugins/events', source: 'events@test',
    hooksConfig: Object.fromEntries(runtime.HOOK_EVENTS.map(event => [event, [
      { matcher: 'target', hooks: [{ type: 'command', command: `echo ${event}` }] },
    ]])),
  }
  const matchers = runtime.convertPluginHooksToMatchers(plugin)
  for (const event of runtime.HOOK_EVENTS) {
    assert.equal(matchers[event].length, 1, `${event} must register`)
    assert.equal(matchers[event][0].pluginRoot, plugin.path)
    assert.equal(matchers[event][0].pluginId, plugin.source)
    assert.equal(matchers[event][0].hooks[0].command, `echo ${event}`)
  }
})

test('root skills have stable names and manifest paths supplement standard directories', async () => {
  const path = fixture('version-4.5.6', 'root-skill-market', 'stable-skill')
  writeJson(join(path, '.claude-plugin/plugin.json'), {
    name: 'stable-skill', skills: '.', commands: './more-commands', agents: './more-agents.md',
    outputStyles: './more-styles',
  })
  for (const folder of ['skills', 'commands', 'agents', 'output-styles', 'more-commands', 'more-styles']) {
    mkdirSync(join(path, folder), { recursive: true })
  }
  writeFileSync(join(path, 'more-agents.md'), '---\nname: other\ndescription: Other agent\n---\nOther agent.')
  writeFileSync(join(path, 'SKILL.md'), '---\nname: stable-skill\ndescription: Root skill fixture\n---\nRoot skill instructions.')
  const { plugin, errors } = await runtime.createPluginFromPath(path, 'stable-skill@test', true, 'stable-skill')
  assert.deepEqual(errors, [])
  assert.equal(plugin.skillsPath, join(path, 'skills'))
  assert.deepEqual(plugin.skillsPaths, [path])
  assert.equal(plugin.commandsPath, join(path, 'commands'))
  assert.deepEqual(plugin.commandsPaths, [join(path, 'more-commands')])
  assert.equal(plugin.agentsPath, join(path, 'agents'))
  assert.equal(plugin.outputStylesPath, join(path, 'output-styles'))
  const skills = await runtime.loadSkillsFromDirectory(path, plugin.name, plugin.source, plugin.manifest, path, new Set())
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'stable-skill:stable-skill')
})

test('process-tree clone timeouts retain the reason even when stderr is partial', async () => {
  const result = await runtime.execFileNoThrowWithCwd(process.execPath, [
    '-e', 'process.stderr.write("Cloning into fixture..."); setTimeout(() => {}, 10000)',
  ], { timeout: 500, killTreeOnTimeout: true, cwd: project })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Cloning into fixture/)
  assert.match(result.error, /timed out/)
})

test('reviewed plugin installs from the requested catalog through the interactive UI', async () => {
  const panel = await open('install shared-plugin@actual-market')
  try {
    await panel.waitFor(/Requested marketplace marker/)
    await panel.press(KEYS.enter)
    const started = Date.now()
    while (!panel.completions.some(message => message?.includes('Installed shared-plugin'))) {
      assert.ok(Date.now() - started < 10_000, panel.frame())
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const installed = JSON.parse(readFileSync(join(cacheDir, 'installed_plugins.json'), 'utf8'))
    assert.equal(installed.plugins['shared-plugin@actual-market'][0].scope, 'user')
    assert.equal(installed.plugins['shared-plugin@wrong-market'], undefined)
  } finally { panel.close() }
})
