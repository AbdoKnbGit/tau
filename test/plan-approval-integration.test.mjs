// Run after npm run build. Exercises real approval UI, clear, storage, and naming.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { after, test } from 'node:test'
import React from 'react'
import { loadBuiltRuntime, mount } from './helpers/ink-built-runtime.mjs'

const repoDir = process.cwd()
// Resolved like scratch: GitHub's Windows TEMP is an 8.3 name (RUNNER~1).
const temporaryRoot = realpathSync.native(tmpdir())
const scratch = realpathSync.native(
  mkdtempSync(join(temporaryRoot, 'tau-plan-approval-')),
)
const projectDir = join(scratch, 'project')
mkdirSync(join(projectDir, '.git'), { recursive: true })
mkdirSync(join(scratch, 'config'), { recursive: true })
writeFileSync(
  join(scratch, 'config', 'settings.json'),
  JSON.stringify({ cleanupPeriodDays: 30, plansDirectory: 'planning docs' }),
)
Object.assign(process.env, {
  NODE_ENV: 'test',
  USER_TYPE: 'external',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CONFIG_DIR: join(scratch, 'config'),
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
})
process.chdir(projectDir)

const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/utils/planApprovalNaming.ts',
    'src/utils/sessionStorage.ts',
    'src/commands/clear/conversation.ts',
    'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts',
    'src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx',
  ],
  exports: [
    'capturePlanFileOwner',
    'getPlanFilePath',
    'setPlanSlug',
    'getSessionId',
    'getTranscriptPath',
    'getCurrentSessionTitle',
    'saveCustomTitle',
    'clearConversation',
    'clearCommandQueue',
    'getCommandQueue',
    'startPlanApprovalNamingAfterClear',
    'cancelPlanApprovalNaming',
    'cancelStalePlanApprovalNaming',
    'getPlanFileRenameAttachments',
    'pendingRenameNotices: () => pendingPlanFileRenameNotices',
    'ExitPlanModePermissionRequest',
    'ExitPlanModeV2Tool',
    'setNameGenerator: generate => { generateSessionName = generate; }',
  ],
})

after(async () => {
  r.cancelPlanApprovalNaming()
  r.clearCommandQueue()
  process.chdir(repoDir)
  assert.ok(resolve(scratch).startsWith(temporaryRoot + sep))
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true })
      break
    } catch (error) {
      if (
        attempt >= 30 ||
        !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
})

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('approval naming did not settle')
}

async function mountApproval({ clearContext = false, agentId } = {}) {
  const plan = '# Add OAuth login\n\nPreserve the saved plan bytes.\n'
  const oldPath = r.getPlanFilePath()
  assert.equal(dirname(oldPath), join(projectDir, 'planning docs'))
  writeFileSync(oldPath, plan)
  const readFileState = new Map([[oldPath, { content: plan }]])
  const context = { readFileState, agentId }
  const ui = await mount(
    r,
    React.createElement(r.ExitPlanModePermissionRequest, {
      toolUseConfirm: {
        tool: r.ExitPlanModeV2Tool,
        input: {},
        description: 'Exit plan mode?',
        toolUseID: 'plan-approval',
        permissionResult: { behavior: 'ask', message: 'Exit plan mode?' },
        assistantMessage: {
          type: 'assistant',
          uuid: 'fixture-assistant',
          message: {
            id: 'fixture-message',
            content: [],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
        toolUseContext: context,
        onAllow() {},
        onReject() {},
      },
      toolUseContext: context,
      onDone() {},
      onReject() {},
    }),
    { columns: 110, rows: 45 },
  )
  ui.store.setState((prev) => ({
    ...prev,
    settings: { ...prev.settings, showClearContextOnPlanAccept: clearContext },
    toolPermissionContext: {
      ...prev.toolPermissionContext,
      mode: 'plan',
      isBypassPermissionsModeAvailable: false,
    },
  }))
  return { ui, plan, oldPath, readFileState }
}

async function clear(ui, readFileState) {
  await r.clearConversation({
    setMessages() {},
    readFileState,
    getAppState: ui.store.getState,
    setAppState: ui.store.setState,
  })
}

test('clear-context approval starts naming once, after the fresh execution session exists', async () => {
  const calls = []
  r.setNameGenerator(async () => {
    calls.push({ sessionId: r.getSessionId(), path: r.getTranscriptPath() })
    return 'clear-context-oauth-login'
  })
  const { ui, plan, oldPath, readFileState } = await mountApproval({
    clearContext: true,
  })
  const source = r.capturePlanFileOwner()
  await r.saveCustomTitle(
    source.sessionId,
    'previous-planning-title',
    r.getTranscriptPath(),
  )
  try {
    const option = /(\d)\.\s*Yes, clear context.*auto-accept edits/
    await ui.waitFor(option)
    await ui.press(ui.frame().match(option)[1])
    const pending = ui.store.getState().initialMessage
    assert.equal(pending.clearContext, true)
    assert.deepEqual(pending.planApprovalNaming.owner, source)
    assert.equal(
      calls.length,
      0,
      'the dialog must not query a name for the abandoned session',
    )

    // These are the same real transition and shared naming controller REPL uses.
    await clear(ui, readFileState)
    r.setPlanSlug(r.getSessionId(), source.planId)
    const target = r.capturePlanFileOwner()
    assert.notEqual(target.sessionId, source.sessionId)
    r.startPlanApprovalNamingAfterClear(pending.planApprovalNaming, {
      setAppState: ui.store.setState,
      readFileState,
    })
    await waitFor(
      () =>
        basename(r.getPlanFilePath()) === 'clear-context-oauth-login.md' &&
        !existsSync(oldPath),
    )
    assert.deepEqual(calls, [
      { sessionId: target.sessionId, path: r.getTranscriptPath() },
    ])
    assert.equal(
      r.getCurrentSessionTitle(target.sessionId),
      'clear-context-oauth-login',
    )
    assert.equal(readFileSync(r.getPlanFilePath(), 'utf8'), plan)
    await waitFor(() => r.pendingRenameNotices().length === 1)
    assert.equal(
      r.getCommandQueue().length,
      0,
      'a rename notice must neither interrupt nor start a model turn',
    )
    const [notice] = r.getPlanFileRenameAttachments({}, 'repl_main_thread')
    assert.equal(notice?.type, 'plan_file_renamed')
    assert.equal(notice.newPath, r.getPlanFilePath())
    assert.equal(basename(notice.oldPath), basename(oldPath))
  } finally {
    ui.close()
    r.clearCommandQueue()
    await clear(ui, readFileState)
  }
})

test('a manual rename while keep-context approval waits for its generated title preserves the plan filename', async () => {
  let resolveName
  const generated = new Promise((resolve) => {
    resolveName = resolve
  })
  let calls = 0
  r.setNameGenerator(() => {
    calls++
    return generated
  })
  const { ui, oldPath, readFileState } = await mountApproval()
  try {
    const option = /(\d)\.\s*Yes, manually approve edits/
    await ui.waitFor(option)
    await ui.press(ui.frame().match(option)[1])
    assert.equal(calls, 1)
    await r.saveCustomTitle(
      r.getSessionId(),
      'user-selected-title',
      r.getTranscriptPath(),
    )
    resolveName('obsolete-auto-title')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      r.getCurrentSessionTitle(r.getSessionId()),
      'user-selected-title',
    )
    assert.equal(r.getPlanFilePath(), oldPath)
    assert.equal(existsSync(oldPath), true)
    assert.equal(r.getCommandQueue().length, 0)
  } finally {
    ui.close()
    r.cancelPlanApprovalNaming()
    await clear(ui, readFileState)
  }
})

test('a subagent approval cannot rename the main session or its plan', async () => {
  let calls = 0
  r.setNameGenerator(async () => {
    calls++
    return 'wrong-main-title'
  })
  const { ui, oldPath, readFileState } = await mountApproval({
    agentId: 'worker-1',
  })
  try {
    const option = /(\d)\.\s*Yes, manually approve edits/
    await ui.waitFor(option)
    await ui.press(ui.frame().match(option)[1])
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 0)
    assert.equal(r.getPlanFilePath(), oldPath)
    assert.equal(existsSync(oldPath), true)
  } finally {
    ui.close()
    await clear(ui, readFileState)
  }
})
