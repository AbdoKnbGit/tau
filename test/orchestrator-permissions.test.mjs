// An orchestrator session (tau --orchestrate) reads and delegates: a call that
// changes something is refused in every permission mode, over hook approvals,
// and for its subagents. Reads, the tools that run the session itself, and
// Tau's own files (plan, memory) stay allowed. A plain session is unchanged.
// Runs against the built bundle: node --test test/orchestrator-permissions.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, test } from 'node:test'
import { z } from 'zod/v4'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const original = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau-orchestrator-permissions-'))
const project = join(root, 'project')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/utils/permissions/permissions.ts',
    'src/services/peers/runtime.ts',
    'src/utils/plans.ts',
    'src/memdir/paths.ts',
  ],
  exports: [
    'hasPermissionsToUseToolInner',
    'checkRuleBasedPermissions',
    'setOrchestrator',
    'getPlanFilePath',
    'getAutoMemPath',
    'setOriginalCwd',
    'ORCHESTRATOR_WORK_REFUSAL',
    'ORCHESTRATOR_AGENT_WORK_REFUSAL',
  ],
})
r.setOriginalCwd(project)
after(() => {
  process.chdir(original)
  rmSync(root, { recursive: true, force: true })
})

/** A tool like Write (it names a path) or Bash (it runs a command), read-only per input. */
function tool(name, readOnly = () => false, { file = false } = {}) {
  return {
    name,
    inputSchema: z.object({ path: z.string().optional(), command: z.string().optional() }).passthrough(),
    isReadOnly: readOnly,
    ...(file ? { getPath: input => input.path } : {}),
    requiresUserInteraction: () => false,
    checkPermissions: async input => ({ behavior: 'allow', updatedInput: input }),
  }
}
function context(mode = 'default', extra = {}) {
  const state = r.getDefaultAppState()
  state.toolPermissionContext = {
    ...state.toolPermissionContext,
    mode,
    alwaysAllowRules: {},
    alwaysAskRules: {},
    alwaysDenyRules: {},
  }
  return {
    abortController: new AbortController(),
    options: { tools: [], isNonInteractiveSession: true },
    getAppState: () => state,
    setAppState() {},
    messages: [],
    ...extra,
  }
}
const write = tool('FixtureWrite', () => false, { file: true })
const projectFile = { path: join(project, 'index.html') }
const decide = (t, input, ctx = context()) => r.hasPermissionsToUseToolInner(t, input, ctx)

// The role is process-wide and never switched off, so the plain session goes first.
test('a plain session decides as before', async () => {
  assert.equal((await decide(write, projectFile)).behavior, 'allow')
  assert.equal(await r.checkRuleBasedPermissions(write, projectFile, context()), null)
})

test('an orchestrator is refused a file edit in every mode', async () => {
  r.setOrchestrator()
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
    const decision = await decide(write, projectFile, context(mode))
    assert.equal(decision.behavior, 'deny', mode)
    assert.equal(decision.message, r.ORCHESTRATOR_WORK_REFUSAL, mode)
  }
})

test('a hook approval does not get around it', async () => {
  const decision = await r.checkRuleBasedPermissions(write, projectFile, context('bypassPermissions'))
  assert.equal(decision?.behavior, 'deny')
})

test('a command runs only when it is read-only', async () => {
  const shell = tool('FixtureShell', input => input.command === 'git status')
  assert.equal((await decide(shell, { command: 'git status' })).behavior, 'allow')
  assert.equal((await decide(shell, { command: 'rm -rf build' })).behavior, 'deny')
})

test('reads, the session tools and Tau files stay allowed', async () => {
  const read = tool('FixtureRead', () => true, { file: true })
  assert.equal((await decide(read, projectFile)).behavior, 'allow', 'read')
  const sessionTools = ['SendMessage', 'OpenPeer', 'Agent', 'TaskStop', 'StructuredOutput', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'Skill', 'ExitPlanMode']
  for (const name of sessionTools) {
    assert.equal((await decide(tool(name), {})).behavior, 'allow', name)
  }
  assert.equal((await decide(write, { path: r.getPlanFilePath() })).behavior, 'allow', 'plan file')
  assert.equal((await decide(write, { path: join(r.getAutoMemPath(), 'note.md') })).behavior, 'allow', 'memory file')
})

test('its subagents are refused too, with their own message', async () => {
  const decision = await decide(write, projectFile, context('default', { agentId: 'a1b2c3d4' }))
  assert.equal(decision.behavior, 'deny')
  assert.equal(decision.message, r.ORCHESTRATOR_AGENT_WORK_REFUSAL)
})
