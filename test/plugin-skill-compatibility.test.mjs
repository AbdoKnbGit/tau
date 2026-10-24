import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const originalCwd = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-plugin-skills-'))
const project = join(root, 'project with spaces')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'plugins'),
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
after(() => {
  process.chdir(originalCwd)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  })
})
// The bundle path is absolute because module initialization must see the fixture cwd.
process.env.TAU_MCP_TEST_BUNDLE ??= join(originalCwd, 'dist', 'tau.mjs')
const r = await loadMcpRuntime({
  paths: [
    'src/utils/plugins/loadPluginCommands.ts',
    'src/utils/plugins/dependencyResolver.ts',
    'src/utils/hooks/registerSkillHooks.ts',
    'src/utils/plugins/pluginLoader.ts',
    'src/utils/forkedAgent.ts',
  ],
  exports: [
    'PluginManifestSchema',
    'qualifyDependency',
    'verifyAndDemote',
    'resolveDependencyClosure',
    'findReverseDependents',
    'getPluginErrorMessage',
    'loadSkillsFromDirectory',
    'getCommandNameFromFile',
    'registerSkillHooks',
    'getSessionHooks',
    'clearSessionHooks',
    'getSessionHookCallback',
    'executeHooks',
    'executeHooksOutsideREPL',
    'getMatchingHooks',
    'getSessionId',
    'execCommandHook',
    'registerConditionalSkills',
    'activateConditionalSkillsForPaths',
    'getDynamicSkills',
    'clearDynamicSkills',
    'clearConditionalPluginSkills',
    'finishLoadingPluginFromPath',
    'prepareForkedCommandContext',
    'getBuiltInAgents',
    'getIsInteractive',
    'setIsInteractive',
  ],
})

const plugin = (source, version, dependencies = [], enabled = true) => ({
  source,
  name: source.split('@')[0],
  enabled,
  repository: source,
  path: project,
  manifest: {
    name: source.split('@')[0],
    ...(version === undefined ? {} : { version }),
    dependencies,
  },
})
const parseDependencies = dependencies =>
  r.PluginManifestSchema().parse({ name: 'consumer', dependencies })
    .dependencies

test('dependency parsing preserves ranges, qualifiers and legacy caret references', () => {
  const dependencies = parseDependencies([
    'plain',
    'qualified@tools',
    'legacy@tools@^2.1',
    { name: 'vault', marketplace: 'tools', version: '~2.1.0' },
  ])
  assert.equal(dependencies[0], 'plain')
  assert.equal(dependencies[1], 'qualified@tools')
  assert.deepEqual(dependencies[2], {
    name: 'legacy',
    marketplace: 'tools',
    version: '^2.1',
  })
  assert.deepEqual(dependencies[3], {
    name: 'vault',
    marketplace: 'tools',
    version: '~2.1.0',
  })
  assert.equal(
    r.qualifyDependency(dependencies[3], 'consumer@main'),
    'vault@tools',
  )
  assert.equal(
    r.qualifyDependency({ name: 'vault', version: '^2' }, 'consumer@main'),
    'vault@main',
  )
  assert.equal(
    r.qualifyDependency({ name: 'vault', version: '^2' }, 'consumer@inline'),
    'vault',
  )
  for (const invalid of [
    'legacy@^',
    'legacy@^nonsense',
    { name: 'vault', version: '' },
    { name: 'vault', version: 'latest' },
  ]) {
    assert.throws(() => parseDependencies([invalid]))
  }
})

test('object dependencies retain closure ordering and cross-marketplace protections', async () => {
  const entries = {
    'consumer@main': {
      dependencies: parseDependencies([{ name: 'vault', version: '~2.1' }]),
    },
    'vault@main': {
      dependencies: parseDependencies([
        { name: 'audit', marketplace: 'other' },
      ]),
    },
    'audit@other': {},
  }
  const lookup = async id => entries[id] ?? null
  const blocked = await r.resolveDependencyClosure(
    'consumer@main',
    lookup,
    new Set(),
  )
  assert.equal(blocked.reason, 'cross-marketplace')
  const allowed = await r.resolveDependencyClosure(
    'consumer@main',
    lookup,
    new Set(),
    new Set(['other']),
  )
  assert.deepEqual(allowed.closure, [
    'audit@other',
    'vault@main',
    'consumer@main',
  ])
  entries['audit@other'] = {
    dependencies: [{ name: 'consumer', marketplace: 'main' }],
  }
  assert.equal(
    (
      await r.resolveDependencyClosure(
        'consumer@main',
        lookup,
        new Set(),
        new Set(['other']),
      )
    ).reason,
    'cycle',
  )
})

test('load-time ranges use semver, including prerelease opt-in and unversioned dependencies', () => {
  for (const [range, version, accepted] of [
    ['~2.1.0', '2.1.8', true],
    ['~2.1.0', '2.2.0', false],
    ['^2.0', '2.9.0', true],
    ['>=1.4', '1.3.9', false],
    ['=2.1.0', '2.1.0', true],
    ['=2.1.0', '2.1.1', false],
    ['^2 || ^3', '3.1.0', true],
    ['^2.0', '2.1.0-beta.1', false],
    ['^2.1.0-0', '2.1.0-beta.1', true],
    ['*', undefined, false],
    ['*', 'not-a-version', false],
  ]) {
    const plugins = [
      plugin('consumer@main', '1.0.0', [{ name: 'vault', version: range }]),
      plugin('vault@main', version),
    ]
    const before = JSON.stringify(plugins)
    const result = r.verifyAndDemote(plugins)
    assert.equal(
      result.demoted.has('consumer@main'),
      !accepted,
      `${range} / ${version}`,
    )
    assert.equal(result.demoted.has('vault@main'), false)
    if (!accepted) assert.equal(result.errors[0].reason, 'version')
    assert.equal(
      JSON.stringify(plugins),
      before,
      'validation must not mutate settings or loaded plugins',
    )
  }
})

test('a dependency mismatch propagates to dependents with an actionable error', () => {
  const result = r.verifyAndDemote([
    plugin('grandparent@main', '1.0.0', ['consumer']),
    plugin('consumer@main', '1.0.0', [{ name: 'vault', version: '~2.1' }]),
    plugin('vault@main', '3.0.0'),
  ])
  assert.deepEqual([...result.demoted].sort(), [
    'consumer@main',
    'grandparent@main',
  ])
  assert.equal(
    r.getPluginErrorMessage(result.errors[0]),
    'Requires "vault@main" ~2.1, installed 3.0.0',
  )
  assert.equal(result.errors[1].reason, 'not-enabled')
})

test('local plugin copies satisfy qualified ranges and disabled local copies remain disabled', () => {
  const consumer = plugin('consumer@main', '1.0.0', [
    { name: 'vault', marketplace: 'other', version: '^9' },
  ])
  const local = plugin('vault@inline')
  assert.equal(r.verifyAndDemote([consumer, local]).demoted.size, 0)
  assert.deepEqual(r.findReverseDependents('vault@inline', [consumer, local]), [
    'consumer',
  ])
  local.enabled = false
  const result = r.verifyAndDemote([
    consumer,
    local,
    plugin('vault@other', '9.0.0'),
  ])
  assert.equal(result.errors[0].reason, 'not-enabled')
  assert.equal(result.errors[0].dependency, 'vault@inline')
  assert.equal(
    r.verifyAndDemote([consumer, plugin('vault@wrong', '9.0.0')]).errors[0]
      .reason,
    'not-found',
  )
})

test('bare local dependencies can choose a matching version from several marketplaces', () => {
  const result = r.verifyAndDemote([
    plugin('consumer@inline', undefined, [{ name: 'vault', version: '^2' }]),
    plugin('vault@one', '1.0.0'),
    plugin('vault@two', '2.0.0'),
  ])
  assert.equal(result.demoted.size, 0)
})

const pluginRoot = join(project, 'sample plugin')
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
write(
  join(pluginRoot, '.claude-plugin', 'plugin.json'),
  JSON.stringify({ name: 'sample', version: '1.0.0' }),
)
const skillDir = join(pluginRoot, 'skills', 'folder-name')
write(
  join(skillDir, 'SKILL.md'),
  `---
name: sample:review
description: Review a source file
context: fork
agent: Explore
model: inherit
effort: high
paths:
  - "src/**"
allowed-tools:
  - 'Read(\u0024{CLAUDE_PLUGIN_ROOT}/**)'
hooks:
  FutureEvent:
    - hooks:
        - type: command
          command: ignored
  PreToolUse:
    - matcher: Read
      hooks:
        - type: command
          command: echo skill
          once: true
---
Read \u0024{CLAUDE_SKILL_DIR}/notes.txt.
`,
)

test('plugin skills preserve execution fields and hooks through the shared parser', async () => {
  const [skill] = await r.loadSkillsFromDirectory(
    skillDir,
    'sample',
    'sample@main',
    { name: 'sample' },
    pluginRoot,
    new Set(),
  )
  assert.equal(skill.name, 'sample:review')
  assert.equal(skill.userFacingName(), 'sample:review')
  assert.equal(skill.context, 'fork')
  assert.equal(skill.agent, 'Explore')
  assert.equal(skill.model, undefined)
  assert.equal(skill.effort, 'high')
  assert.equal(skill.skillRoot, skillDir)
  assert.equal(skill.pluginInfo.root, pluginRoot)
  assert.deepEqual(skill.paths, ['src'])
  assert.equal(skill.hooks.PreToolUse[0].hooks[0].once, true)
  assert.equal(skill.hooks.FutureEvent, undefined)
  assert.ok(skill.allowedTools[0].includes(pluginRoot.replaceAll('\\', '/')))
  const prompt = await skill.getPromptForCommand('', fixtureContext([]))
  assert.ok(prompt[0].text.includes(skillDir.replaceAll('\\', '/')))
})

test('invalid skill display names fall back without losing the skill', async () => {
  const dir = join(pluginRoot, 'skills', 'safe-name')
  write(join(dir, 'SKILL.md'), '---\nname: "bad<name"\n---\nStill usable.\n')
  const [skill] = await r.loadSkillsFromDirectory(
    dir,
    'sample',
    'sample@main',
    { name: 'sample' },
    pluginRoot,
    new Set(),
  )
  assert.equal(skill.name, 'sample:safe-name')
  assert.equal(skill.userFacingName(), skill.name)
})

test('nested plugin command namespaces use the native path separator', () => {
  const base = join(pluginRoot, 'commands')
  assert.equal(
    r.getCommandNameFromFile(join(base, 'nested', 'review.md'), base, 'sample'),
    'sample:nested:review',
  )
})

test('plugin path conditions activate only on matching files and clear on reload', async () => {
  r.clearDynamicSkills()
  const [skill] = await r.loadSkillsFromDirectory(
    skillDir,
    'sample',
    'sample@main',
    { name: 'sample' },
    pluginRoot,
    new Set(),
  )
  assert.deepEqual(r.registerConditionalSkills([skill]), [])
  r.activateConditionalSkillsForPaths(
    [join(project, 'docs', 'notes.txt')],
    project,
  )
  assert.equal(
    r.getDynamicSkills().some(s => s.name === skill.name),
    false,
  )
  r.activateConditionalSkillsForPaths(
    [join(project, 'src', 'main.ts')],
    project,
  )
  assert.equal(
    r.getDynamicSkills().some(s => s.name === skill.name),
    true,
  )
  r.clearConditionalPluginSkills()
  assert.equal(
    r.getDynamicSkills().some(s => s.name === skill.name),
    false,
  )
  assert.deepEqual(r.registerConditionalSkills([skill]), [])
  r.clearDynamicSkills()
})

test('marketplace dependency requirements are retained alongside plugin.json', async () => {
  const errors = []
  const loaded = await r.finishLoadingPluginFromPath(
    {
      name: 'sample',
      source: './',
      dependencies: [{ name: 'vault', version: '^2' }],
    },
    'sample@main',
    true,
    errors,
    pluginRoot,
  )
  assert.deepEqual(loaded.manifest.dependencies, [
    { name: 'vault', version: '^2' },
  ])
  assert.equal(
    r.verifyAndDemote([loaded, plugin('vault@main', '3.0.0')]).errors[0].reason,
    'version',
  )
})

test('skill hook execution keeps plugin and skill directories distinct, including argv', async () => {
  const script =
    'console.log(JSON.stringify({plugin:process.env.CLAUDE_PLUGIN_ROOT,skill:process.env.CLAUDE_SKILL_DIR,args:process.argv.slice(1)}))'
  const result = await r.execCommandHook(
    {
      type: 'command',
      command: process.execPath,
      args: [
        '-e',
        script,
        '--',
        '${CLAUDE_PLUGIN_ROOT}',
        '${CLAUDE_SKILL_DIR}',
      ],
    },
    'PreToolUse',
    'fixture',
    '{}',
    new AbortController().signal,
    'fixture',
    0,
    pluginRoot,
    'sample@main',
    skillDir,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    plugin: pluginRoot,
    skill: skillDir,
    args: [pluginRoot, skillDir],
  })
})

test('identical hooks from different skills run separately and remove only their own one-shot registration', async () => {
  const state = fixtureContext([]).getAppState()
  const set = update => update(state)
  const session = r.getSessionId()
  const hook = {
    type: 'command',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    once: true,
  }
  const hooks = { PreToolUse: [{ matcher: 'Read', hooks: [hook] }] }
  r.registerSkillHooks(set, session, hooks, 'first', skillDir, {
    root: pluginRoot,
    id: 'sample@main',
  })
  r.registerSkillHooks(
    set,
    session,
    hooks,
    'second',
    join(pluginRoot, 'skills', 'other'),
    { root: pluginRoot, id: 'sample@main' },
  )
  const input = {
    session_id: session,
    cwd: project,
    transcript_path: join(root, 'transcript'),
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: {},
    tool_use_id: 'call',
  }
  const matched = await r.getMatchingHooks(state, session, 'PreToolUse', input)
  assert.equal(matched.length, 2)
  const second = matched[1].hook
  r.getSessionHookCallback(
    state,
    session,
    'PreToolUse',
    'Read',
    second,
  ).onHookSuccess(second, {})
  assert.equal(
    (await r.getMatchingHooks(state, session, 'PreToolUse', input)).length,
    1,
  )
  const context = fixtureContext([], {
    getAppState: () => state,
    setAppState: set,
  })
  context.options.mainLoopModel = 'claude-sonnet-4-6'
  for await (const _ of r.executeHooks({
    hookInput: input,
    toolUseID: 'call',
    toolUseContext: context,
    timeoutMs: 5000,
  })) {
  }
  assert.equal(
    (await r.getMatchingHooks(state, session, 'PreToolUse', input)).length,
    0,
  )
})

for (const child of [false, true]) {
  test(`one-shot hooks run once across parallel tools in the ${child ? 'child' : 'main'} session`, async () => {
    const state = fixtureContext([]).getAppState()
    const set = update => update(state)
    const session = child ? 'parallel-child' : r.getSessionId()
    const evidencePath = join(root, `parallel-${child}.jsonl`)
    writeFileSync(evidencePath, '')
    const context = fixtureContext([], { getAppState: () => state, setAppState: set })
    context.options.mainLoopModel = 'claude-sonnet-4-6'
    if (child) context.agentId = session
    const hook = {
      type: 'command',
      command: process.execPath,
      args: ['-e', `setTimeout(() => { require('node:fs').appendFileSync(process.argv[1], JSON.stringify(process.env.CLAUDE_SKILL_DIR) + '\\n'); console.log('{}') }, 100)`, evidencePath],
      once: true,
    }
    const arm = (name, once = true) => r.registerSkillHooks(
      set, session,
      { PreToolUse: [{ matcher: 'Read', hooks: [{ ...hook, once }] }] },
      name, join(pluginRoot, 'skills', name), { root: pluginRoot, id: 'sample@main' },
    )
    arm('first')
    arm('second')
    arm('repeat', false)
    const run = async (index, ctx = context) => {
      for await (const _ of r.executeHooks({
        hookInput: {
          session_id: r.getSessionId(), cwd: project, transcript_path: join(root, 'transcript'),
          permission_mode: 'default', hook_event_name: 'PreToolUse',
          tool_name: 'Read', tool_input: { file_path: `file-${index}` }, tool_use_id: `call-${index}`,
        },
        toolUseID: `call-${index}`, toolUseContext: ctx, timeoutMs: 5000,
      })) {}
    }
    const count = name => readFileSync(evidencePath, 'utf8').trim().split('\n')
      .filter(line => line && JSON.parse(line) === join(pluginRoot, 'skills', name)).length
    await Promise.all(Array.from({ length: 4 }, (_, i) => run(i)))
    assert.equal(count('first'), 1)
    assert.equal(count('second'), 1, 'identical commands in another skill own a separate one-shot')
    assert.equal(count('repeat'), 4, 'ordinary hooks still run for every tool')
    await run(4)
    assert.equal(count('first'), 1)
    arm('first')
    await Promise.all([run(5), run(6)])
    assert.equal(count('first'), 2, 'invoking a skill again creates a fresh one-shot')
    assert.equal(count('second'), 1)
    if (child) {
      await run(7, { ...context, agentId: undefined })
      assert.equal(count('repeat'), 7, 'child hooks must not run on the parent')
    }
    r.clearSessionHooks(set, session)
  })
}

for (const failure of ['exit', 'block', 'cancel', 'timeout']) {
  test(`a one-shot hook can retry after ${failure} and is consumed only after success`, async () => {
    const state = fixtureContext([]).getAppState()
    const set = update => update(state)
    const session = r.getSessionId()
    const evidencePath = join(root, `retry-${failure}.txt`)
    const modePath = join(root, `mode-${failure}.txt`)
    writeFileSync(evidencePath, '')
    writeFileSync(modePath, failure)
    r.registerSkillHooks(set, session, { PreToolUse: [{ matcher: 'Read', hooks: [{
      type: 'command', command: process.execPath, once: true,
      args: ['-e', `const fs = require('node:fs'); fs.appendFileSync(process.argv[1], 'attempt\\n'); const mode = fs.readFileSync(process.argv[2], 'utf8'); if (mode === 'exit') process.exit(1); if (mode === 'block') process.exit(2); if (mode === 'cancel' || mode === 'timeout') setInterval(() => {}, 100); else console.log('{}')`, evidencePath, modePath],
    }] }] }, 'retry', skillDir)
    const context = fixtureContext([], { getAppState: () => state, setAppState: set })
    context.options.mainLoopModel = 'claude-sonnet-4-6'
    const input = {
      session_id: session, cwd: project, transcript_path: join(root, 'transcript'),
      permission_mode: 'default', hook_event_name: 'PreToolUse',
      tool_name: 'Read', tool_input: {}, tool_use_id: 'retry',
    }
    const run = async (options = {}) => {
      const results = []
      for await (const result of r.executeHooks({
        hookInput: input, toolUseID: 'retry', toolUseContext: context, timeoutMs: 5000, ...options,
      })) {
        results.push(result)
        // Real callers may stop consuming immediately on a blocking result.
        if (result.blockingError) break
      }
      return results
    }
    const controller = new AbortController()
    const pending = run({ signal: controller.signal, timeoutMs: failure === 'timeout' ? 700 : 5000 })
    if (failure === 'cancel') {
      const deadline = Date.now() + 5000
      while (!readFileSync(evidencePath, 'utf8') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      controller.abort()
    }
    const failed = await pending
    assert.ok(failed.some(result => result.blockingError ||
      ['hook_non_blocking_error', 'hook_cancelled'].includes(result.message?.attachment?.type)))
    assert.equal(r.getSessionHooks(state, session).get('PreToolUse').length, 1)
    writeFileSync(modePath, 'success')
    await Promise.all([run(), run(), run(), run()])
    assert.equal(readFileSync(evidencePath, 'utf8').trim().split('\n').length, 2)
    assert.equal(r.getSessionHooks(state, session).size, 0)
    await run()
    assert.equal(readFileSync(evidencePath, 'utf8').trim().split('\n').length, 2)
  })
}

test('one-shot hooks share their reservation with the outside-REPL runner', async () => {
  const state = fixtureContext([]).getAppState()
  const set = update => update(state)
  const session = r.getSessionId()
  const evidencePath = join(root, 'notification-once.txt')
  writeFileSync(evidencePath, '')
  r.registerSkillHooks(set, session, { Notification: [{ hooks: [{
    type: 'command', command: process.execPath, once: true,
    args: ['-e', `setTimeout(() => { require('node:fs').appendFileSync(process.argv[1], 'notification\\n'); console.log('{}') }, 100)`, evidencePath],
  }] }] }, 'notification', skillDir)
  const context = fixtureContext([], { getAppState: () => state, setAppState: set })
  context.options.mainLoopModel = 'claude-sonnet-4-6'
  const input = {
    session_id: session, cwd: project, transcript_path: join(root, 'transcript'),
    permission_mode: 'default', hook_event_name: 'Notification',
    notification_type: 'idle_prompt', message: 'Ready',
  }
  const outside = () => r.executeHooksOutsideREPL({ hookInput: input, getAppState: () => state })
  const inside = async () => { for await (const _ of r.executeHooks({ hookInput: input, toolUseID: 'notice', toolUseContext: context })) {} }
  await Promise.all([outside(), outside(), inside(), outside()])
  assert.equal(readFileSync(evidencePath, 'utf8'), 'notification\n')
  assert.equal(r.getSessionHooks(state, session).size, 0)
  assert.deepEqual(await outside(), [])
})

test('forked skill Stop hooks are scoped to the agent and become SubagentStop hooks', () => {
  const state = fixtureContext([]).getAppState()
  const set = update => update(state)
  r.registerSkillHooks(
    set,
    'child',
    { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    'sample:review',
    skillDir,
    { root: pluginRoot, id: 'sample@main' },
    true,
  )
  assert.equal(r.getSessionHooks(state, r.getSessionId()).size, 0)
  const matchers = r.getSessionHooks(state, 'child').get('SubagentStop')
  assert.equal(matchers[0].pluginRoot, pluginRoot)
  assert.equal(matchers[0].skillRoot, skillDir)
  r.clearSessionHooks(set, 'child')
  assert.equal(r.getSessionHooks(state, 'child').size, 0)
})

function forkContext(agents = r.getBuiltInAgents()) {
  const context = fixtureContext([])
  context.options.agentDefinitions = { activeAgents: agents, allAgents: agents }
  return context
}

test('parsed plugin skills select explicit built-in agents without changing the normal catalog', async () => {
  const [skill] = await r.loadSkillsFromDirectory(
    skillDir, 'sample', 'sample@main', { name: 'sample' }, pluginRoot, new Set(),
  )
  const catalog = r.getBuiltInAgents().map(agent => agent.agentType)
  for (const agent of ['Explore', 'Plan']) {
    const prepared = await r.prepareForkedCommandContext({ ...skill, agent }, '', forkContext())
    assert.equal(prepared.baseAgent.agentType, agent)
    assert.equal(prepared.baseAgent.source, 'built-in')
    assert.ok(prepared.baseAgent.disallowedTools.includes('Write'))
  }
  assert.deepEqual(r.getBuiltInAgents().map(agent => agent.agentType), catalog)
})

test('forked skills preserve named custom agents and the default agent', async () => {
  const custom = { agentType: 'sample:reviewer', source: 'plugin', model: 'custom-model' }
  const agents = [...r.getBuiltInAgents(), custom]
  const command = { name: 'sample:audit', getPromptForCommand: async () => [{ type: 'text', text: 'Audit.' }] }
  assert.equal((await r.prepareForkedCommandContext({ ...command, agent: custom.agentType }, '', forkContext(agents))).baseAgent, custom)
  assert.equal((await r.prepareForkedCommandContext(command, '', forkContext(agents))).baseAgent.agentType, 'general-purpose')
  const override = { ...custom, agentType: 'Explore' }
  assert.equal((await r.prepareForkedCommandContext({ ...command, agent: 'Explore' }, '', forkContext([override]))).baseAgent, override)
})

test('unknown or restricted skill agents fail before prompt commands can execute', async () => {
  let expansions = 0
  const command = { name: 'sample:audit', agent: 'MissingAgent', getPromptForCommand: async () => { expansions++; return [] } }
  await assert.rejects(r.prepareForkedCommandContext(command, '', forkContext()), /MissingAgent.*not available/)
  const restricted = forkContext()
  restricted.options.agentDefinitions.allowedAgentTypes = ['general-purpose']
  await assert.rejects(r.prepareForkedCommandContext({ ...command, agent: 'Explore' }, '', restricted), /Explore.*not available/)
  const denied = forkContext()
  const state = denied.getAppState()
  state.toolPermissionContext.alwaysDenyRules = { localSettings: ['Agent(Explore)'] }
  denied.getAppState = () => state
  await assert.rejects(r.prepareForkedCommandContext({ ...command, agent: 'Explore' }, '', denied), /Explore.*not available/)
  assert.equal(expansions, 0)
})

test('explicit built-in selection respects the SDK switch disabling built-in agents', async () => {
  const wasInteractive = r.getIsInteractive()
  const previous = process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
  r.setIsInteractive(false)
  process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1'
  try {
    const command = { name: 'sample:audit', agent: 'Explore', getPromptForCommand: async () => [] }
    await assert.rejects(r.prepareForkedCommandContext(command, '', forkContext()), /Explore.*not available/)
    assert.deepEqual(r.getBuiltInAgents(), [])
  } finally {
    r.setIsInteractive(wasInteractive)
    if (previous === undefined) delete process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS
    else process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = previous
  }
})
