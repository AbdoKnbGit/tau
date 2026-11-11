import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const cwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-agent-omit-claudemd-'))
const project = join(root, 'project')
const config = join(root, 'config')
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
}
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(config)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
  CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
after(async () => {
  process.chdir(cwd)
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const r = await loadBuiltRuntime({
  paths: ['src/tools/AgentTool/loadAgentsDir.ts', 'src/utils/plugins/loadPluginAgents.ts',
    'src/utils/plugins/cacheUtils.ts', 'src/tools/AgentTool/runAgent.ts'],
  exports: ['parseAgentFromJson', 'parseAgentsFromJson', 'parseAgentFromMarkdown',
    'loadPluginAgents', 'setInlinePlugins', 'clearAllCaches', 'resetSettingsCache',
    'resolveAgentUserContext', 'getUserContext', 'getMemoryFiles', 'getClaudeMds'],
})

test('Markdown agents accept only explicit true/false without mutating their frontmatter', () => {
  for (const [raw, expected] of [[true, true], ['true', true], [false, false], ['false', false],
    [undefined, undefined], [1, undefined], ['yes', undefined], [[], undefined], [{ enabled: true }, undefined],
    [{ toString: 'invalid' }, undefined]]) {
    const frontmatter = Object.freeze({ name: 'reader', description: 'Read source', omitClaudeMd: raw })
    const agent = r.parseAgentFromMarkdown(join(root, 'reader.md'), root,
      frontmatter, 'Read and report.', 'projectSettings')
    assert.ok(agent)
    assert.equal(agent.omitClaudeMd, expected)
    assert.equal(agent.getSystemPrompt(), 'Read and report.')
    assert.equal(frontmatter.omitClaudeMd, raw)
  }
})

test('--agents JSON retains booleans and rejects nonboolean omission values', () => {
  for (const raw of [true, false, undefined]) {
    const definition = Object.freeze({ description: 'Read source', prompt: 'Read and report.',
      ...(raw === undefined ? {} : { omitClaudeMd: raw }) })
    const agent = r.parseAgentFromJson('reader', definition)
    assert.ok(agent)
    assert.equal(agent.omitClaudeMd, raw)
    assert.equal(agent.getSystemPrompt(), definition.prompt)
    assert.equal(definition.omitClaudeMd, raw)
    const multiple = r.parseAgentsFromJson({ reader: definition })
    assert.equal(multiple.length, 1)
    assert.equal(multiple[0].omitClaudeMd, raw)
  }
  for (const raw of ['true', 'false', 1, null, [], {}]) {
    assert.equal(r.parseAgentFromJson('reader', {
      description: 'Read source', prompt: 'Read and report.', omitClaudeMd: raw,
    }), null)
  }
})

test('agent context omits personal/project instructions, retains managed policy and leaves the parent cache intact', async () => {
  const files = Object.freeze(['Managed', 'User', 'Project', 'Local'].map(type => Object.freeze({
    path: join(root, type, 'CLAUDE.md'), type, content: `INSTRUCTIONS-${type}`,
  })))
  const parent = Object.freeze({ claudeMd: r.getClaudeMds(files), currentDate: 'Today',
    otherContext: 'Keep this context' })
  const savedMemory = { present: r.getMemoryFiles.cache.has(undefined), value: r.getMemoryFiles.cache.get(undefined) }
  const savedContext = { present: r.getUserContext.cache.has(undefined), value: r.getUserContext.cache.get(undefined) }
  r.getMemoryFiles.cache.set(undefined, Promise.resolve(files))
  r.getUserContext.cache.set(undefined, Promise.resolve(parent))
  try {
    for (const source of ['plugin', 'projectSettings', 'userSettings', 'built-in']) {
      const selected = await r.resolveAgentUserContext(parent, { source, omitClaudeMd: true }, false)
      assert.equal(selected.claudeMd, r.getClaudeMds(files, type => type === 'Managed'))
      assert.equal(selected.currentDate, parent.currentDate)
      assert.equal(selected.otherContext, parent.otherContext)
      for (const type of ['User', 'Project', 'Local']) assert.ok(!selected.claudeMd.includes(`INSTRUCTIONS-${type}`))
      assert.equal(await r.getUserContext(), parent, 'parent memoized context must retain its original identity')
      for (const type of ['Managed', 'User', 'Project', 'Local']) assert.ok(parent.claudeMd.includes(`INSTRUCTIONS-${type}`))
    }
    for (const omitClaudeMd of [false, undefined]) {
      assert.equal(await r.resolveAgentUserContext(parent, { source: 'plugin', omitClaudeMd }, false), parent)
    }
    assert.equal(await r.resolveAgentUserContext(parent, { source: 'plugin', omitClaudeMd: true }, true), parent,
      'explicit caller context must not be filtered')
    assert.deepEqual(await r.resolveAgentUserContext(parent, { source: 'policySettings', omitClaudeMd: true }, false),
      { currentDate: parent.currentDate, otherContext: parent.otherContext })
    r.getMemoryFiles.cache.set(undefined, Promise.resolve(files.filter(file => file.type !== 'Managed')))
    assert.deepEqual(await r.resolveAgentUserContext(parent, { source: 'plugin', omitClaudeMd: true }, false),
      { currentDate: parent.currentDate, otherContext: parent.otherContext })
    const noInstructions = Object.freeze({ currentDate: 'Today' })
    assert.deepEqual(await r.resolveAgentUserContext(noInstructions, { source: 'plugin', omitClaudeMd: true }, false), noInstructions)
  } finally {
    if (savedMemory.present) r.getMemoryFiles.cache.set(undefined, savedMemory.value)
    else r.getMemoryFiles.cache.delete(undefined)
    if (savedContext.present) r.getUserContext.cache.set(undefined, savedContext.value)
    else r.getUserContext.cache.delete(undefined)
  }
})

test('plugin omission flag reloads through the existing cache reset without mutating earlier definitions', async () => {
  const plugin = join(root, 'plugin with spaces')
  const path = join(plugin, 'agents', 'reader.md')
  write(join(plugin, '.claude-plugin', 'plugin.json'), { name: 'context-reader' })
  const contents = flag => `---\nname: reader\ndescription: Read source\n${flag}---\nRead and report.\n`
  write(path, contents('omitClaudeMd: true\n'))
  r.setInlinePlugins([plugin])
  r.clearAllCaches()
  const load = async () => {
    const agents = await r.loadPluginAgents()
    const agent = agents.find(a => a.agentType === 'context-reader:reader')
    assert.ok(agent)
    return agent
  }
  const original = await load()
  assert.equal(original.omitClaudeMd, true)

  // Cached definitions stay stable within a loaded plugin generation.
  write(path, contents('omitClaudeMd: false\n'))
  assert.equal((await load()).omitClaudeMd, true)
  r.clearAllCaches()
  const reloaded = await load()
  assert.equal(reloaded.omitClaudeMd, false)
  assert.equal(original.omitClaudeMd, true, 'reload must not mutate a running agent definition')

  for (const flag of ['', 'omitClaudeMd: yes\n', 'omitClaudeMd: 1\n',
    'omitClaudeMd:\n  toString: invalid\n']) {
    write(path, contents(flag))
    r.clearAllCaches()
    assert.equal((await load()).omitClaudeMd, undefined)
    assert.equal(readFileSync(path, 'utf8'), contents(flag), 'loading must not rewrite the source')
  }

  write(join(config, 'settings.json'), { enabledPlugins: { 'context-reader@inline': false } })
  r.resetSettingsCache()
  r.clearAllCaches()
  assert.equal((await r.loadPluginAgents()).some(a => a.agentType === 'context-reader:reader'), false)
})
