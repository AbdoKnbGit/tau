import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const originalCwd = process.cwd()
const directory = mkdtempSync(join(tmpdir(), 'tau-settings-hooks-'))
const project = join(directory, 'project')
const config = join(directory, 'config')
mkdirSync(project)
mkdirSync(config)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  TAU_MCP_TEST_BUNDLE: resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs'),
})
process.chdir(project)
const r = await loadMcpRuntime({
  transform(source) {
    const section = source.split('// src/utils/settings/changeDetector.ts\n')[1]?.split('\n// ')[0]
    assert.ok(section, 'missing settings watcher module')
    const change = section.match(/function (handleChange\d*)\(/)?.[1]
    const deletion = section.match(/function (handleDelete\d*)\(/)?.[1]
    assert.ok(change && deletion, 'missing settings watcher handlers')
    return source + `\nconst settingsFileChangedForTest = ${change};\nconst settingsFileDeletedForTest = ${deletion};\n`
  },
  paths: [
    'src/utils/settings/settings.ts', 'src/utils/settings/validation.ts',
    'src/utils/settings/changeDetector.ts', 'src/skills/loadSkillsDir.ts',
    'src/tools/AgentTool/loadAgentsDir.ts',
  ],
  exports: [
    'parseSettingsFile', 'validateSettingsFileContent', 'updateSettingsForSource',
    'getSettingsForSource', 'getSettingsFilePathForSource', 'resetSettingsCache',
    'getSettingsWithErrors',
    'parseSkillFrontmatterFields', 'parseAgentFromMarkdown', 'parseAgentFromJson', 'parseAgentsFromJson',
    'settingsChangeDetector', 'setOriginalCwd', 'clearInternalWrites',
    'settingsFileChanged: settingsFileChangedForTest', 'settingsFileDeleted: settingsFileDeletedForTest',
    'getConfigChangeExecutor: () => executeConfigChangeHooks',
    'setConfigChangeExecutor: fn => { executeConfigChangeHooks = fn }',
  ],
})
r.setOriginalCwd(project)
after(async () => {
  await r.settingsChangeDetector.dispose()
  process.chdir(originalCwd)
  rmSync(directory, { recursive: true, force: true, maxRetries: 10 })
})

const policy = { type: 'command', command: 'echo policy', onFailure: 'block' }
const validHooks = { PreToolUse: [{ matcher: 'Write', hooks: [policy] }] }
const futureHooks = () => ({
  PreToolUse: [{ matcher: 'Write', hooks: [policy, { type: 'future_type', payload: 'keep on disk' }] }],
  FutureEvent: [{ hooks: [{ type: 'command', command: 'echo future' }] }],
})
const settingsPath = join(config, 'settings.json')
function writeSettings(settings) {
  writeFileSync(settingsPath, JSON.stringify(settings))
  r.resetSettingsCache()
  r.clearInternalWrites()
}

test('settings preserve valid hooks and non-hook fields while reporting future extensions', () => {
  const raw = { model: 'fixture-model', env: { KEEP: 'yes' }, hooks: futureHooks() }
  writeSettings(raw)
  const parsed = r.parseSettingsFile(settingsPath)
  assert.equal(parsed.settings.model, 'fixture-model')
  assert.deepEqual(parsed.settings.env, { KEEP: 'yes' })
  assert.deepEqual(parsed.settings.hooks, validHooks)
  assert.deepEqual(parsed.errors.map(error => error.path), [
    'hooks.PreToolUse[0].hooks[1]', 'hooks.FutureEvent',
  ])
  assert.ok(parsed.errors.every(error => error.message.includes('not supported and was skipped')))
  assert.ok(parsed.errors.every(error => error.severity === 'warning'))
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), raw)
  assert.equal(r.validateSettingsFileContent(JSON.stringify(raw)).isValid, true)
})

test('an unrelated settings write preserves unknown events and handler data on disk', () => {
  const hooks = futureHooks()
  writeSettings({ hooks, model: 'before' })
  assert.equal(r.updateSettingsForSource('userSettings', { model: 'after' }).error, null)
  const stored = JSON.parse(readFileSync(settingsPath, 'utf8'))
  assert.equal(stored.model, 'after')
  assert.deepEqual(stored.hooks, hooks)
  assert.deepEqual(r.parseSettingsFile(settingsPath).settings.hooks, validHooks)
})

test('malformed known hook handlers and matchers still fail settings validation', () => {
  for (const hooks of [
    { PreToolUse: [{ hooks: [{ type: 'command', onFailure: 'block' }, { type: 'future_type' }] }] },
    { PreToolUse: [{ matcher: 17, hooks: [policy, { type: 'future_type' }] }] },
    { PreToolUse: [{ hooks: [{ command: 'missing type' }] }] },
    null,
  ]) {
    writeSettings({ model: 'retained-only-if-valid', hooks })
    const parsed = r.parseSettingsFile(settingsPath)
    assert.equal(parsed.settings, null)
    assert.ok(parsed.errors.length > 0)
    assert.equal(r.validateSettingsFileContent(JSON.stringify({ hooks })).isValid, false)
  }
})

test('skill and agent frontmatter retain known hooks alongside future extensions', () => {
  const frontmatter = { name: 'fixture', description: 'fixture description', hooks: futureHooks() }
  const fields = r.parseSkillFrontmatterFields(frontmatter, 'skill body', 'fixture')
  assert.equal(fields.description, 'fixture description')
  assert.deepEqual(fields.hooks, validHooks)
  const agent = r.parseAgentFromMarkdown(join(project, 'fixture.md'), project, frontmatter, 'agent body', 'projectSettings')
  assert.ok(agent)
  assert.equal(agent.getSystemPrompt(), 'agent body')
  assert.deepEqual(agent.hooks, validHooks)
  const definition = { description: 'fixture', prompt: 'agent body', hooks: futureHooks() }
  assert.deepEqual(r.parseAgentFromJson('fixture', definition).hooks, validHooks)
  assert.deepEqual(r.parseAgentsFromJson({ fixture: definition }).map(agent => agent.hooks), [validHooks])
})

test('malformed known frontmatter hooks cannot silently remove the policy and run the body', () => {
  for (const hooks of [
    { PreToolUse: [{ hooks: [{ type: 'command', onFailure: 'block' }, { type: 'future_type' }] }] },
    null,
  ]) {
    const frontmatter = { name: 'fixture', description: 'fixture', hooks }
    assert.throws(() => r.parseSkillFrontmatterFields(frontmatter, 'skill body', 'fixture'), /Invalid hooks/)
    assert.equal(r.parseAgentFromMarkdown(join(project, 'fixture.md'), project, frontmatter, 'agent body', 'projectSettings'), null)
    assert.equal(r.parseAgentFromJson('fixture', { description: 'fixture', prompt: 'body', hooks }), null)
  }
})

test('blocked config changes and deletions notify with the reason and keep the cached settings', async () => {
  await r.settingsChangeDetector.resetForTesting({ deletionGrace: 5 })
  writeSettings({ model: 'old-model' })
  assert.equal(r.getSettingsForSource('userSettings').model, 'old-model')
  writeFileSync(settingsPath, JSON.stringify({ model: 'new-model' }))
  const seen = []
  const changes = []
  const offBlocked = r.settingsChangeDetector.subscribeBlocked(change => seen.push(change))
  const offChanged = r.settingsChangeDetector.subscribe(source => changes.push(source))
  const original = r.getConfigChangeExecutor()
  r.setConfigChangeExecutor(async (source, path) => {
    assert.equal(source, 'user_settings')
    assert.equal(path, settingsPath)
    return [{ command: 'policy', succeeded: true, output: '', blocked: true, blockingReason: 'LAB-CONFIG-LOCKED' }]
  })
  try {
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(seen.length, 1)
    assert.equal(seen[0].operation, 'change')
    assert.equal(seen[0].source, 'userSettings')
    assert.equal(seen[0].path, settingsPath)
    assert.match(seen[0].message, /LAB-CONFIG-LOCKED/)
    assert.equal(r.getSettingsForSource('userSettings').model, 'old-model')
    assert.deepEqual(changes, [])

    r.settingsFileDeleted(settingsPath)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(seen.length, 2)
    assert.equal(seen[1].operation, 'delete')
    assert.match(seen[1].message, /LAB-CONFIG-LOCKED/)
    assert.equal(r.getSettingsForSource('userSettings').model, 'old-model')
    assert.deepEqual(changes, [])

    r.setConfigChangeExecutor(async () => [{ command: 'policy', succeeded: true, output: '', blocked: false }])
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(seen.length, 2)
    assert.deepEqual(changes, ['userSettings'])
    assert.equal(r.getSettingsForSource('userSettings').model, 'new-model')
  } finally {
    offBlocked()
    offChanged()
    r.setConfigChangeExecutor(original)
  }
})

test('disposing the settings watcher removes blocked-change subscribers', async () => {
  let count = 0
  r.settingsChangeDetector.subscribeBlocked(() => count++)
  await r.settingsChangeDetector.dispose()
  await r.settingsChangeDetector.resetForTesting()
  r.clearInternalWrites()
  const original = r.getConfigChangeExecutor()
  r.setConfigChangeExecutor(async () => [{ command: 'policy', succeeded: false, output: 'denied', blocked: true }])
  try {
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(count, 0)
  } finally {
    r.setConfigChangeExecutor(original)
  }
})

test('blocked settings survive unrelated reloads and cache invalidation until that file is accepted', async () => {
  await r.settingsChangeDetector.resetForTesting()
  const localDirectory = join(project, '.claude')
  mkdirSync(localDirectory, { recursive: true })
  const localPath = join(localDirectory, 'settings.local.json')
  writeFileSync(localPath, '{}')
  writeSettings({ model: 'accepted-model' })
  assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
  const original = r.getConfigChangeExecutor()
  r.setConfigChangeExecutor(async source => [{ succeeded: true, output: '', blocked: source === 'user_settings' }])
  try {
    writeFileSync(settingsPath, JSON.stringify({ model: 'refused-model' }))
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    writeFileSync(localPath, JSON.stringify({ effortLevel: 'low' }))
    r.settingsFileChanged(localPath)
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
    assert.equal(r.getSettingsWithErrors().settings.model, 'accepted-model')
    assert.equal(r.getSettingsForSource('localSettings').effortLevel, 'low')
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).model, 'refused-model')

    r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: false }])
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.getSettingsForSource('userSettings').model, 'refused-model')
  } finally {
    r.setConfigChangeExecutor(original)
    unlinkSync(localPath)
  }
})

test('internal writes update the accepted snapshot without activating or erasing refused disk values', async () => {
  await r.settingsChangeDetector.resetForTesting()
  writeSettings({ model: 'accepted-model', effortLevel: 'medium' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: true }])
  try {
    writeFileSync(settingsPath, JSON.stringify({ model: 'refused-model', effortLevel: 'medium' }))
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.updateSettingsForSource('userSettings', { effortLevel: 'low' }).error, null)
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { model: 'refused-model', effortLevel: 'low' })
    assert.deepEqual(r.getSettingsForSource('userSettings'), { model: 'accepted-model', effortLevel: 'low' })
    r.resetSettingsCache()
    assert.equal(r.getSettingsWithErrors().settings.model, 'accepted-model')
  } finally {
    r.setConfigChangeExecutor(original)
  }
})

test('an older allow decision cannot release a newer rejected edit', async () => {
  await r.settingsChangeDetector.resetForTesting()
  writeSettings({ model: 'accepted-model' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  const decisions = []
  r.setConfigChangeExecutor(() => new Promise(resolve => decisions.push(resolve)))
  try {
    writeFileSync(settingsPath, JSON.stringify({ model: 'first-edit' }))
    r.settingsFileChanged(settingsPath)
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model', 'Pending decisions must retain the last accepted settings')
    writeFileSync(settingsPath, JSON.stringify({ model: 'second-edit' }))
    r.settingsFileChanged(settingsPath)
    decisions[1]([{ succeeded: true, output: '', blocked: true }])
    await new Promise(resolve => setImmediate(resolve))
    decisions[0]([{ succeeded: true, output: '', blocked: false }])
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
  } finally {
    r.setConfigChangeExecutor(original)
  }
})

test('a refused deletion retains settings across invalidation and an allowed recreation replaces them', async () => {
  await r.settingsChangeDetector.resetForTesting({ deletionGrace: 5 })
  writeSettings({ model: 'accepted-model' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: true }])
  try {
    unlinkSync(settingsPath)
    r.settingsFileDeleted(settingsPath)
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
    await new Promise(resolve => setTimeout(resolve, 20))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
    writeFileSync(settingsPath, JSON.stringify({ model: 'recreated-model' }))
    r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: false }])
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(r.getSettingsForSource('userSettings').model, 'recreated-model')
  } finally {
    r.setConfigChangeExecutor(original)
  }
})

test('a successful internal write is the retained baseline before any later reader', async () => {
  await r.settingsChangeDetector.resetForTesting()
  writeSettings({ model: 'first-model' })
  r.getSettingsForSource('userSettings')
  assert.equal(r.updateSettingsForSource('userSettings', { model: 'internal-model' }).error, null)
  r.clearInternalWrites()
  const original = r.getConfigChangeExecutor()
  r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: true }])
  try {
    writeFileSync(settingsPath, JSON.stringify({ model: 'refused-model' }))
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'internal-model')
  } finally { r.setConfigChangeExecutor(original) }
})

test('an allowed external change is the baseline for the next rejection without a reader', async () => {
  await r.settingsChangeDetector.resetForTesting()
  writeSettings({ model: 'first-model' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  try {
    r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: false }])
    writeFileSync(settingsPath, JSON.stringify({ model: 'allowed-model' }))
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: true }])
    writeFileSync(settingsPath, JSON.stringify({ model: 'refused-model' }))
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'allowed-model')
  } finally { r.setConfigChangeExecutor(original) }
})

test('an internal patch invalidates an older pending allow without accepting the external edit', async () => {
  await r.settingsChangeDetector.resetForTesting()
  writeSettings({ model: 'accepted-model', effortLevel: 'medium' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  let decide
  r.setConfigChangeExecutor(() => new Promise(resolve => { decide = resolve }))
  try {
    const disk = { model: 'pending-model', effortLevel: 'medium', futureSetting: { keep: true }, hooks: futureHooks() }
    writeFileSync(settingsPath, JSON.stringify(disk))
    r.settingsFileChanged(settingsPath)
    assert.equal(r.updateSettingsForSource('userSettings', { effortLevel: 'low' }).error, null)
    decide([{ succeeded: true, output: '', blocked: false }])
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.deepEqual(r.getSettingsForSource('userSettings'), { model: 'accepted-model', effortLevel: 'low' })
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { ...disk, effortLevel: 'low' })
    // Its watcher echo also cannot release the retained snapshot.
    r.settingsFileChanged(settingsPath)
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
  } finally { r.setConfigChangeExecutor(original) }
})

test('late decisions from a disposed watcher cannot change a restarted watcher', async () => {
  await r.settingsChangeDetector.resetForTesting()
  writeSettings({ model: 'first-session' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  const decisions = []
  r.setConfigChangeExecutor(() => new Promise(resolve => decisions.push(resolve)))
  try {
    writeFileSync(settingsPath, JSON.stringify({ model: 'old-pending' }))
    r.settingsFileChanged(settingsPath)
    await r.settingsChangeDetector.dispose()
    await r.settingsChangeDetector.resetForTesting()
    writeSettings({ model: 'second-session' })
    r.getSettingsForSource('userSettings')
    writeFileSync(settingsPath, JSON.stringify({ model: 'new-pending' }))
    r.settingsFileChanged(settingsPath)
    decisions[1]([{ succeeded: true, output: '', blocked: true }])
    await new Promise(resolve => setImmediate(resolve))
    decisions[0]([{ succeeded: true, output: '', blocked: false }])
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'second-session')
  } finally { r.setConfigChangeExecutor(original) }
})

test('an older deletion decision cannot override an accepted recreation', async () => {
  await r.settingsChangeDetector.resetForTesting({ deletionGrace: 5 })
  writeSettings({ model: 'accepted-model' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  let decideDelete
  r.setConfigChangeExecutor(() => new Promise(resolve => { decideDelete = resolve }))
  try {
    unlinkSync(settingsPath)
    r.settingsFileDeleted(settingsPath)
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(settingsPath, JSON.stringify({ model: 'recreated-model' }))
    r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: false }])
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    decideDelete([{ succeeded: true, output: '', blocked: true }])
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'recreated-model')
  } finally { r.setConfigChangeExecutor(original) }
})

test('an allow decision cannot approve newer disk bytes before their watcher event arrives', async () => {
  await r.settingsChangeDetector.resetForTesting()
  writeSettings({ model: 'accepted-model' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  let decide
  r.setConfigChangeExecutor(() => new Promise(resolve => { decide = resolve }))
  try {
    writeFileSync(settingsPath, JSON.stringify({ model: 'first-edit' }))
    r.settingsFileChanged(settingsPath)
    // Another process writes again, but chokidar has not emitted its event.
    writeFileSync(settingsPath, JSON.stringify({ model: 'second-edit' }))
    decide([{ succeeded: true, output: '', blocked: false }])
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
    r.setConfigChangeExecutor(async () => [{ succeeded: true, output: '', blocked: true }])
    r.settingsFileChanged(settingsPath)
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
    assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).model, 'second-edit')
  } finally { r.setConfigChangeExecutor(original) }
})

test('a pending deletion cannot approve a recreation before its watcher event', async () => {
  await r.settingsChangeDetector.resetForTesting({ deletionGrace: 5 })
  writeSettings({ model: 'accepted-model' })
  r.getSettingsForSource('userSettings')
  const original = r.getConfigChangeExecutor()
  let decideDelete
  r.setConfigChangeExecutor(() => new Promise(resolve => { decideDelete = resolve }))
  try {
    unlinkSync(settingsPath)
    r.settingsFileDeleted(settingsPath)
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(settingsPath, JSON.stringify({ model: 'recreated-model' }))
    decideDelete([{ succeeded: true, output: '', blocked: false }])
    await new Promise(resolve => setImmediate(resolve))
    r.resetSettingsCache()
    assert.equal(r.getSettingsForSource('userSettings').model, 'accepted-model')
  } finally { r.setConfigChangeExecutor(original) }
})
