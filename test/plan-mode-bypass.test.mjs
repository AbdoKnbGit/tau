import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

// Plan mode and bypass working together, checked on the shipped bundle (run
// `npm run build` first) with isolated settings and a throwaway project.
const repoDir = process.cwd()
// Canonical paths (macOS links /var to /private/var; Windows may hand out short
// names), so files the test names are the same files the session's cwd holds.
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'tau-plan-bypass-')))
const projectDir = join(scratch, 'project')
mkdirSync(join(projectDir, '.git'), { recursive: true })
mkdirSync(join(projectDir, 'src'), { recursive: true })
writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const answer = 1\n')
// No kept transcripts: approving a plan would otherwise ask a model to name the session.
mkdirSync(join(scratch, 'config'), { recursive: true })
writeFileSync(join(scratch, 'config', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }))
process.env.CLAUDE_CONFIG_DIR = join(scratch, 'config')
process.env.CLAUDE_CODE_TMPDIR = join(scratch, 'tmp')
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
process.env.DISABLE_TELEMETRY = '1'
process.chdir(projectDir)

after(async () => {
  process.chdir(repoDir)
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 100 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
})

const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/permissions/permissions.ts',
    'src/utils/permissions/bypassPermissionsMode.ts',
    'src/utils/permissions/PermissionUpdate.ts',
    'src/utils/permissions/PermissionMode.ts',
    'src/hooks/toolPermission/PermissionContext.ts',
    'src/utils/attachments.ts',
    'src/utils/plans.ts',
    'src/utils/plugins/mods/permissions.ts',
    'src/tools/FileEditTool/FileEditTool.ts',
    'src/tools/FileWriteTool/FileWriteTool.ts',
    'src/tools/FileReadTool/FileReadTool.ts',
    'src/tools/BashTool/BashTool.tsx',
    'src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx',
    'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts',
    'src/components/permissions/bypassPermissionsOption.ts',
    'src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx',
    'src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx',
    'src/components/permissions/FilePermissionDialog/permissionOptions.tsx',
    'src/components/permissions/FallbackPermissionRequest.tsx',
    'src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx',
  ],
  exports: [
    'setSessionBypassPermissionsMode', 'getSessionBypassPermissionsMode',
    'setNeedsPlanModeExitAttachment', 'needsPlanModeExitAttachment',
    'hasPermissionsToUseTool', 'checkRuleBasedPermissions', 'isPlanModeWithBypass',
    'PLAN_MODE_FILE_EDIT_REFUSAL', 'getEmptyToolPermissionContext',
    'enableBypassPermissionsFromPrompt', 'enableBypassPermissionsModeForSession',
    'isBypassPermissionsOnForSession', 'disableBypassPermissionsInPlanMode',
    'syncSessionBypassWithPlanExit', 'ExitPlanModePermissionRequest',
    'applyApprovedPermissionUpdates', 'permissionModeTitle',
    'createPermissionContext', 'resolveToolPermissionContextUpdate',
    'getPlanModeExitAttachment', 'getPlanFilePath', 'resolveModToolPermissionDecision',
    'FileEditTool', 'FileWriteTool', 'FileReadTool', 'BashTool', 'AskUserQuestionTool',
    'ExitPlanModeV2Tool', 'getBypassPermissionsOption', 'bashToolUseOptions',
    'powershellToolUseOptions', 'getFilePermissionOptions', 'FallbackPermissionRequest',
  ],
})
const h = React.createElement
const assistant = { type: 'assistant', uuid: 'fixture-assistant', message: { id: 'fixture-message', content: [] } }
const appFile = join(projectDir, 'src', 'app.ts')
const edit = { file_path: appFile, old_string: 'answer = 1', new_string: 'answer = 2' }
const write = { file_path: join(projectDir, 'src', 'new.ts'), content: 'export {}\n' }
const install = { command: 'npm install left-pad', description: 'Install a package' }
const question = { questions: [{
  question: 'Which storage should the plan use?', header: 'Storage',
  options: [{ label: 'SQLite', description: 'One file.' }, { label: 'Postgres', description: 'A server.' }],
}] }

function permissionContext(overrides = {}) {
  return { ...r.getEmptyToolPermissionContext(), mode: 'plan', ...overrides }
}

function toolContext(toolPermissionContext, extra = {}) {
  const state = r.getDefaultAppState()
  state.toolPermissionContext = toolPermissionContext
  return {
    abortController: new AbortController(), messages: [],
    options: {
      tools: [r.FileEditTool, r.FileWriteTool, r.FileReadTool, r.BashTool, r.AskUserQuestionTool, r.ExitPlanModeV2Tool],
      mcpClients: [], isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [] }, mainLoopModel: 'fixture-model',
    },
    getAppState: () => state,
    setAppState: update => Object.assign(state, update(state)),
    ...extra,
  }
}

const decide = (tool, input, ctx) => r.hasPermissionsToUseTool(tool, input, ctx, assistant, 'tool-use-1')

beforeEach(() => {
  r.setSessionBypassPermissionsMode(false)
  r.setNeedsPlanModeExitAttachment(false)
})

test('plan mode without bypass asks before anything that changes state, as before', async () => {
  const ctx = toolContext(permissionContext())
  assert.equal(r.isPlanModeWithBypass(ctx.getAppState().toolPermissionContext), false)
  assert.equal((await decide(r.FileEditTool, edit, ctx)).behavior, 'ask')
  assert.equal((await decide(r.FileWriteTool, write, ctx)).behavior, 'ask')
  assert.equal((await decide(r.BashTool, install, ctx)).behavior, 'ask')
  assert.equal((await decide(r.FileReadTool, { file_path: appFile }, ctx)).behavior, 'allow')
  const plan = { file_path: r.getPlanFilePath(), content: '# Plan\n' }
  assert.equal((await decide(r.FileWriteTool, plan, ctx)).behavior, 'allow')
})

test('plan mode with bypass on: nothing asks, and file edits wait for the plan approval', async () => {
  r.setSessionBypassPermissionsMode(true)
  const ctx = toolContext(permissionContext())
  assert.equal(r.isPlanModeWithBypass(ctx.getAppState().toolPermissionContext), true)
  for (const [tool, input] of [[r.FileEditTool, edit], [r.FileWriteTool, write]]) {
    const decision = await decide(tool, input, ctx)
    assert.equal(decision.behavior, 'deny', tool.name)
    assert.equal(decision.message, r.PLAN_MODE_FILE_EDIT_REFUSAL)
  }
  assert.equal((await decide(r.BashTool, install, ctx)).behavior, 'allow')
  assert.equal((await decide(r.FileReadTool, { file_path: appFile }, ctx)).behavior, 'allow')
  // The plan file is what plan mode is for.
  const plan = { file_path: r.getPlanFilePath(), content: '# Plan\n' }
  assert.equal((await decide(r.FileWriteTool, plan, ctx)).behavior, 'allow')
  // The agent's questions and the plan approval still reach the user.
  assert.equal((await decide(r.AskUserQuestionTool, question, ctx)).behavior, 'ask')
  assert.equal((await decide(r.ExitPlanModeV2Tool, {}, ctx)).behavior, 'ask')
})

test('rules decide the same way as plan mode without bypass would', async () => {
  for (const bypass of [false, true]) {
    r.setSessionBypassPermissionsMode(bypass)
    // A rule that allows every edit: no prompt either way, so nothing to refuse.
    const allowEdits = toolContext(permissionContext({ alwaysAllowRules: { session: ['Edit'] } }))
    assert.equal((await decide(r.FileEditTool, edit, allowEdits)).behavior, 'allow', `allow rule, bypass ${bypass}`)
    // An ask rule: a prompt without bypass; with bypass, "no" for an edit and "yes" for a command.
    const askAll = toolContext(permissionContext({ alwaysAskRules: { session: ['Edit', 'Bash'] } }))
    assert.equal((await decide(r.FileEditTool, edit, askAll)).behavior, bypass ? 'deny' : 'ask', `ask rule edit, bypass ${bypass}`)
    assert.equal((await decide(r.BashTool, install, askAll)).behavior, bypass ? 'allow' : 'ask', `ask rule bash, bypass ${bypass}`)
  }
})

test('outside plan mode bypass works as it always has', async () => {
  r.setSessionBypassPermissionsMode(true)
  const ctx = toolContext(permissionContext({ mode: 'default' }))
  assert.equal(r.isPlanModeWithBypass(ctx.getAppState().toolPermissionContext), false)
  assert.equal((await decide(r.FileEditTool, edit, ctx)).behavior, 'allow')
  assert.equal((await decide(r.BashTool, install, ctx)).behavior, 'allow')
  r.setSessionBypassPermissionsMode(false)
  const bypassMode = toolContext(permissionContext({ mode: 'bypassPermissions' }))
  const decision = await decide(r.FileEditTool, edit, bypassMode)
  assert.equal(decision.behavior, 'allow')
  assert.deepEqual(decision.decisionReason, { type: 'mode', mode: 'bypassPermissions' })
})

test("a hook's approval of an edit: plan mode with bypass answers the prompt it would have shown", async () => {
  const sensitive = { file_path: join(projectDir, '.git', 'config'), old_string: 'a', new_string: 'b' }
  for (const bypass of [false, true]) {
    r.setSessionBypassPermissionsMode(bypass)
    const ctx = toolContext(permissionContext())
    // A safety check prompts even over a hook's allow; with bypass that prompt is answered "no".
    const safety = await r.checkRuleBasedPermissions(r.FileEditTool, sensitive, ctx)
    assert.equal(safety?.behavior, bypass ? 'deny' : 'ask', `safety check, bypass ${bypass}`)
    // A plain edit has no rule objection, so the hook's approval stands either way.
    assert.equal(await r.checkRuleBasedPermissions(r.FileEditTool, edit, ctx), null, `plain edit, bypass ${bypass}`)
  }
})

test('choosing bypass on a prompt keeps the plan open; choosing it as a mode switches', () => {
  let state = { toolPermissionContext: permissionContext({ prePlanMode: 'default' }) }
  const setAppState = update => { state = update(state) }
  assert.equal(r.enableBypassPermissionsFromPrompt({ setAppState }), true)
  assert.equal(state.toolPermissionContext.mode, 'plan')
  assert.equal(state.toolPermissionContext.prePlanMode, 'bypassPermissions')
  assert.equal(state.toolPermissionContext.isBypassPermissionsModeAvailable, true)
  assert.equal(r.getSessionBypassPermissionsMode(), true)
  assert.equal(r.isPlanModeWithBypass(state.toolPermissionContext), true)

  r.setSessionBypassPermissionsMode(false)
  state = { toolPermissionContext: permissionContext({ mode: 'default' }) }
  assert.equal(r.enableBypassPermissionsFromPrompt({ setAppState }), true)
  assert.equal(state.toolPermissionContext.mode, 'bypassPermissions')

  // /permissions lists modes: picking Bypass Permissions there is a mode switch.
  r.setSessionBypassPermissionsMode(false)
  state = { toolPermissionContext: permissionContext() }
  assert.equal(r.enableBypassPermissionsModeForSession({ setAppState }), true)
  assert.equal(state.toolPermissionContext.mode, 'bypassPermissions')
})

test('turning bypass off while planning keeps the plan, brings prompts back and stops it returning to bypass', async () => {
  r.setSessionBypassPermissionsMode(true)
  assert.equal(r.isBypassPermissionsOnForSession('plan'), true)
  let state = { toolPermissionContext: permissionContext({ prePlanMode: 'bypassPermissions' }) }
  r.disableBypassPermissionsInPlanMode({ setAppState: update => { state = update(state) } })
  assert.equal(r.getSessionBypassPermissionsMode(), false)
  assert.equal(r.isBypassPermissionsOnForSession('plan'), false)
  assert.equal(state.toolPermissionContext.mode, 'plan')
  assert.equal(state.toolPermissionContext.prePlanMode, 'default')
  assert.equal((await decide(r.FileEditTool, edit, toolContext(state.toolPermissionContext))).behavior, 'ask')
  // Bypass mode itself is on whatever the session flag says.
  assert.equal(r.isBypassPermissionsOnForSession('bypassPermissions'), true)
  assert.equal(r.isBypassPermissionsOnForSession('default'), false)
})

test("an approval on a sub-agent's prompt changes the session's permissions, not the agent's copy", async () => {
  let session = permissionContext({
    prePlanMode: 'default',
    alwaysAllowRules: { userSettings: ['Read'], session: ['Glob'] },
  })
  // What a sub-agent with its own mode, scoped tools and no prompts sees.
  const agentView = {
    ...session, mode: 'acceptEdits', shouldAvoidPermissionPrompts: true,
    awaitAutomatedChecksBeforeDialog: true,
    alwaysAllowRules: { cliArg: [], session: ['Bash(git status:*)'] },
  }
  const agent = toolContext(agentView, { agentId: 'agent-1' })
  const setToolPermissionContext = (update, options) => {
    session = r.resolveToolPermissionContextUpdate(session, update, options)
  }
  const prompt = r.createPermissionContext(r.BashTool, install, agent, assistant, 'tool-use-2', setToolPermissionContext)
  await prompt.persistPermissions([{
    type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    behavior: 'allow', destination: 'session',
  }])
  assert.equal(session.mode, 'plan')
  assert.equal(session.prePlanMode, 'default')
  assert.equal(session.shouldAvoidPermissionPrompts, undefined)
  assert.equal(session.awaitAutomatedChecksBeforeDialog, undefined)
  assert.deepEqual(session.alwaysAllowRules.userSettings, ['Read'])
  assert.deepEqual(session.alwaysAllowRules.session, ['Glob', 'Bash(npm test:*)'])

  // A mode the user picks there applies to the session, and ends the plan cleanly.
  await prompt.persistPermissions([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
  assert.equal(session.mode, 'acceptEdits')
  assert.equal(session.prePlanMode, undefined)

  // Workers still pass a whole context with preserveMode, and keep the session's mode.
  session = permissionContext()
  setToolPermissionContext({ ...agentView }, { preserveMode: true })
  assert.equal(session.mode, 'plan')
})

test('a plan approved into a mode that asks ends bypass; approved into bypass mode it stays on', async () => {
  for (const [mode, stays] of [['default', false], ['acceptEdits', false], ['bypassPermissions', true]]) {
    r.setSessionBypassPermissionsMode(true)
    let session = permissionContext({ prePlanMode: 'bypassPermissions' })
    const approval = r.createPermissionContext(r.ExitPlanModeV2Tool, {}, toolContext(session), assistant, 'tool-use-5',
      (update, options) => { session = r.resolveToolPermissionContextUpdate(session, update, options) })
    await approval.persistPermissions([{ type: 'setMode', mode, destination: 'session' }])
    assert.equal(session.mode, mode)
    assert.equal(r.getSessionBypassPermissionsMode(), stays, `approved into ${mode}`)
  }
  // Only the end of a plan does this; other changes leave bypass alone.
  r.setSessionBypassPermissionsMode(true)
  r.syncSessionBypassWithPlanExit(permissionContext({ mode: 'default' }), permissionContext({ mode: 'acceptEdits' }))
  r.syncSessionBypassWithPlanExit(permissionContext(), permissionContext())
  assert.equal(r.getSessionBypassPermissionsMode(), true)
})

/** The real plan approval box, for a plan file with `planText` (none = an empty plan). */
async function mountApproval(planText, onAllow) {
  const planFile = r.getPlanFilePath()
  if (planText) {
    mkdirSync(dirname(planFile), { recursive: true })
    writeFileSync(planFile, planText)
  } else {
    rmSync(planFile, { force: true })
  }
  const ui = await mount(r, h(() => h(r.ExitPlanModePermissionRequest, {
    toolUseConfirm: {
      tool: r.ExitPlanModeV2Tool, input: {}, description: 'Exit plan mode?', toolUseID: 'tool-use-7',
      permissionResult: { behavior: 'ask', message: 'Exit plan mode?' },
      assistantMessage: { ...assistant, message: { ...assistant.message, usage: { input_tokens: 10, output_tokens: 5 } } },
      onAllow, onReject: () => {},
    },
    toolUseContext: toolContext(permissionContext()),
    onDone: () => {}, onReject: () => {},
  })), { columns: 100, rows: 40 })
  ui.store.setState(prev => ({ ...prev, toolPermissionContext: {
    ...prev.toolPermissionContext, mode: 'plan', isBypassPermissionsModeAvailable: true,
  } }))
  return ui
}

test('the plan approval box: "manually approve edits" really brings the prompts back', async () => {
  for (const [choice, mode, stays] of [['Yes, manually approve edits', 'default', false], ['Yes, and bypass permissions', 'bypassPermissions', true]]) {
    r.setSessionBypassPermissionsMode(true)
    const approvals = []
    const ui = await mountApproval('# Plan\n\n1. Add a comment to README.md.\n', (input, updates) => approvals.push(updates))
    try {
      const option = new RegExp(`(\\d)\\.\\s*${choice}`)
      await ui.waitFor(option)
      await ui.press(ui.frame().match(option)[1])
      assert.equal(approvals.length, 1, choice)
      // What the session does with the approved change.
      let session = permissionContext({ prePlanMode: 'bypassPermissions' })
      const approval = r.createPermissionContext(r.ExitPlanModeV2Tool, {}, toolContext(session), assistant, 'tool-use-8',
        update => { session = r.resolveToolPermissionContextUpdate(session, update) })
      await approval.persistPermissions(approvals[0])
      assert.equal(session.mode, mode, choice)
      assert.equal(r.getSessionBypassPermissionsMode(), stays, choice)
      assert.equal((await decide(r.FileEditTool, edit, toolContext(session))).behavior, stays ? 'allow' : 'ask', choice)
    } finally {
      ui.close()
    }
  }
})

test('an empty plan’s "Yes" goes back to bypass mode when bypass is on, else to the default mode', async () => {
  for (const bypass of [true, false]) {
    r.setSessionBypassPermissionsMode(bypass)
    const approvals = []
    const ui = await mountApproval(null, (input, updates) => approvals.push(updates))
    try {
      await ui.waitFor(/Tau wants to exit plan mode/)
      await ui.press('1')
      assert.deepEqual(approvals, [[{ type: 'setMode', mode: bypass ? 'bypassPermissions' : 'default', destination: 'session' }]])
    } finally {
      ui.close()
    }
  }
})

test('leaving plan mode through an approved change drops the stale return mode', () => {
  const planning = permissionContext({ prePlanMode: 'bypassPermissions' })
  const left = r.applyApprovedPermissionUpdates(planning, [{ type: 'setMode', mode: 'default', destination: 'session' }])
  assert.equal(left.mode, 'default')
  assert.equal(left.prePlanMode, undefined)
  const stays = r.applyApprovedPermissionUpdates(planning, [{
    type: 'addRules', rules: [{ toolName: 'Glob' }], behavior: 'allow', destination: 'session',
  }])
  assert.equal(stays.prePlanMode, 'bypassPermissions')
})

test('the note that plan mode ended goes to the main agent, not to a sub-agent', async () => {
  const after = permissionContext({ mode: 'default' })
  r.setNeedsPlanModeExitAttachment(true)
  const sub = toolContext(after, { agentId: 'agent-1' })
  assert.deepEqual(await r.getPlanModeExitAttachment(sub), [])
  assert.equal(r.needsPlanModeExitAttachment(), true, 'a sub-agent must not take the note')
  const main = await r.getPlanModeExitAttachment(toolContext(after))
  assert.equal(main.length, 1)
  assert.equal(main[0].type, 'plan_mode_exit')
  assert.equal(r.needsPlanModeExitAttachment(), false)
})

test('mod checks see plan mode with bypass as the core check does', async () => {
  for (const bypass of [false, true]) {
    r.setSessionBypassPermissionsMode(bypass)
    const ctx = toolContext(permissionContext())
    const command = await r.resolveModToolPermissionDecision(r.BashTool, install, ctx)
    assert.equal(command.behavior, bypass ? 'allow' : 'ask', `command, bypass ${bypass}`)
    const change = await r.resolveModToolPermissionDecision(r.FileEditTool, edit, ctx)
    assert.equal(change.behavior, bypass ? 'deny' : 'ask', `edit, bypass ${bypass}`)
  }
})

test('every prompt offers bypass under the mode’s own name, and says what it does in plan mode', () => {
  assert.equal(r.permissionModeTitle('bypassPermissions'), 'Bypass Permissions')
  const label = 'Yes, and bypass permissions for this session'
  const noop = () => {}
  for (const sessionMode of ['default', 'acceptEdits', 'plan']) {
    const built = [
      r.bashToolUseOptions({ onRejectFeedbackChange: noop, onAcceptFeedbackChange: noop, sessionMode }),
      r.powershellToolUseOptions({ onRejectFeedbackChange: noop, onAcceptFeedbackChange: noop, sessionMode }),
      r.getFilePermissionOptions({ filePath: appFile, toolPermissionContext: permissionContext({ mode: sessionMode }) }),
    ]
    for (const options of built) {
      const bypass = options.find(option => option.value === 'yes-bypass-permissions')
      assert.equal(bypass.label, label)
      assert.equal(bypass.description, r.getBypassPermissionsOption(sessionMode).description)
      assert.ok(!options.some(option => /dangerously/i.test(String(option.label))))
    }
    const { description } = r.getBypassPermissionsOption(sessionMode)
    assert.match(description, sessionMode === 'plan' ? /edits wait for plan approval/ : /stop asking/)
    // Shown inline after the label: no longer than the option it replaced, so
    // the row wraps no earlier than it used to.
    const replaced = 'Yes, dangerously skip permissions for this session' + 'Tau will stop asking before running tools.'
    assert.ok((label + description).length <= replaced.length, `${sessionMode}: ${label} ${description}`)
  }
})

test('the generic prompt in plan mode: its bypass choice keeps the plan open', async () => {
  const tool = {
    name: 'fixture_tool', isMcp: false,
    userFacingName: () => 'Fixture tool',
    renderToolUseMessage: () => 'input',
  }
  const allowed = []
  const ui = await mount(r, h(() => h(r.FallbackPermissionRequest, {
    toolUseConfirm: {
      tool, input: {}, description: 'Does a fixture thing', toolUseID: 'tool-use-3',
      permissionResult: { behavior: 'ask', message: 'Fixture tool needs approval' },
      assistantMessage: assistant,
      onAllow: (input, updates) => allowed.push(updates), onReject: () => {},
    },
    toolUseContext: {
      options: { debug: false }, messages: [],
      setAppState: update => ui.store.setState(update),
    },
    onDone: () => {}, onReject: () => {},
  })), { columns: 100, rows: 30 })
  try {
    ui.store.setState(prev => ({
      ...prev, toolPermissionContext: { ...prev.toolPermissionContext, mode: 'plan' },
    }))
    await ui.waitFor(/Yes, and bypass permissions for this session/)
    assert.doesNotMatch(ui.frame(), /dangerously/i)
    // Choose it by its number, as a user can.
    const [, number] = ui.frame().match(/(\d)\. Yes, and bypass permissions for this session/)
    await ui.press(number)
    const after = ui.store.getState().toolPermissionContext
    assert.equal(after.mode, 'plan')
    assert.equal(after.prePlanMode, 'bypassPermissions')
    assert.equal(r.getSessionBypassPermissionsMode(), true)
    assert.deepEqual(allowed, [[]], 'the tool runs once, with no rule written')
  } finally {
    ui.close()
  }
})
