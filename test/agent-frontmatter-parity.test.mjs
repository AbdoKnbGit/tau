import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

// Agent fields Claude Code 2.1.329 reads: when_to_use, autoCompactWindow and
// experimental.cacheTtl, parsed the same way by every loader.
const cwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-agent-fields-'))
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
delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
process.chdir(project)
after(async () => {
  process.chdir(cwd)
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const r = await loadBuiltRuntime({
  paths: ['src/tools/AgentTool/loadAgentsDir.ts', 'src/utils/plugins/loadPluginAgents.ts',
    'src/utils/plugins/cacheUtils.ts', 'src/utils/plugins/mods/actionsApi.ts',
    'src/services/compact/autoCompact.ts'],
  exports: ['parseAgentFromMarkdown', 'parseAgentFromJson', 'loadPluginAgents', 'setInlinePlugins',
    'clearAllCaches', 'registerModAgent', 'withModAgents', 'forgetModAgents',
    'getAutoCompactThreshold', 'describeAutoCompaction'],
})

const agentFile = (lines, body = 'Do the task.') => `---\n${lines.join('\n')}\n---\n${body}\n`

test('plugin agents read when_to_use, autoCompactWindow and experimental.cacheTtl like Claude Code', async () => {
  const plugin = join(root, 'fields plugin')
  write(join(plugin, '.claude-plugin', 'plugin.json'), { name: 'fields' })
  write(join(plugin, 'agents', 'audit.md'), agentFile([
    'when_to_use: Use for audits', 'autoCompactWindow: 150000', 'experimental:', '  cacheTtl: 1h']))
  write(join(plugin, 'agents', 'review.md'), agentFile([
    'description: Review code', 'autoCompactWindow: "200000"', 'experimental:', '  cache_ttl: 5m']))
  // Invalid values and fields Tau does not apply leave the agent loaded.
  write(join(plugin, 'agents', 'loose.md'), agentFile([
    'description: Loose fields', 'autoCompactWindow: 99999', 'experimental:', '  cacheTtl: 2h',
    'observer: watcher', 'initialPrompt: hello', 'max_turns: 3']))
  write(join(plugin, 'agents', 'odd.md'), agentFile([
    'description: Odd value', 'autoCompactWindow:', '  toString: invalid', 'experimental: 1h']))
  // Claude Code skips an agent file over 1 MiB.
  write(join(plugin, 'agents', 'huge.md'), agentFile(['description: Too big'], 'x'.repeat(1_048_577)))
  r.setInlinePlugins([plugin])
  r.clearAllCaches()
  const agents = Object.fromEntries((await r.loadPluginAgents()).map(agent => [agent.agentType, agent]))
  assert.deepEqual(Object.keys(agents).sort(), ['fields:audit', 'fields:loose', 'fields:odd', 'fields:review'])
  assert.equal(agents['fields:audit'].whenToUse, 'Use for audits')
  assert.equal(agents['fields:audit'].autoCompactWindow, 150000)
  assert.equal(agents['fields:audit'].cacheTtl, '1h')
  assert.equal(agents['fields:review'].autoCompactWindow, 200000)
  assert.equal(agents['fields:review'].cacheTtl, '5m')
  for (const name of ['fields:loose', 'fields:odd']) {
    assert.equal(agents[name].autoCompactWindow, undefined)
    assert.equal(agents[name].cacheTtl, undefined)
  }
  assert.equal(agents['fields:loose'].initialPrompt, undefined)
})

test('project agents read the same fields; --agents JSON takes autoCompactWindow only', () => {
  const agent = r.parseAgentFromMarkdown(join(root, 'reader.md'), root, Object.freeze({
    name: 'reader', description: 'Read source', autoCompactWindow: 120000,
    experimental: { CacheTTL: '1h' },
  }), 'Read and report.', 'projectSettings')
  assert.equal(agent.autoCompactWindow, 120000)
  assert.equal(agent.cacheTtl, '1h')
  const plain = r.parseAgentFromMarkdown(join(root, 'plain.md'), root,
    { name: 'plain', description: 'Plain' }, 'Plain.', 'projectSettings')
  assert.equal('autoCompactWindow' in plain, false)
  assert.equal('cacheTtl' in plain, false)

  const json = definition => r.parseAgentFromJson('worker', { description: 'Work', prompt: 'Do it.', ...definition })
  assert.equal(json({ autoCompactWindow: 300000 }).autoCompactWindow, 300000)
  // As in Claude Code, a bad value rejects a JSON agent, and JSON has no cacheTtl.
  assert.equal(json({ autoCompactWindow: 5000 }), null)
  assert.equal(json({ autoCompactWindow: '300000' }), null)
  assert.equal(json({ experimental: { cacheTtl: '1h' } }).cacheTtl, undefined)
})

test('mods agent.register accepts autoCompactWindow of at least 100,000', () => {
  const owner = {}
  try {
    r.registerModAgent({ name: 'compact', description: 'Compacts early', prompt: 'Work.', autoCompactWindow: 100000 },
      { name: 'modplug', root }, owner)
    const [registered] = r.withModAgents([]).filter(agent => agent.agentType === 'modplug:compact')
    assert.equal(registered.autoCompactWindow, 100000)
    for (const autoCompactWindow of [99999, 1.5e5 + 0.5, '200000']) {
      assert.throws(() => r.registerModAgent(
        { name: 'bad', description: 'Bad', prompt: 'Work.', autoCompactWindow }, { name: 'modplug', root }, owner),
      /autoCompactWindow/)
    }
  } finally {
    r.forgetModAgents(owner)
  }
})

test("a subagent's autoCompactWindow lowers its compaction point and never raises it", () => {
  const model = 'claude-sonnet-4-6'
  const session = r.getAutoCompactThreshold(model)
  assert.ok(r.getAutoCompactThreshold(model, 150000) < session)
  assert.equal(r.getAutoCompactThreshold(model, 10_000_000), session)
  assert.equal(r.describeAutoCompaction(model, 150000).windowCap, 150000)
  assert.equal(r.describeAutoCompaction(model).threshold, session)
})
