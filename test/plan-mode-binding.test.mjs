// Plan restrictions must follow the current file binding when copied history
// contains a recent reminder for another session, filename, directory or agent.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const previousCwd = process.cwd(),
  temporaryRoot = realpathSync.native(tmpdir())
const scratch = realpathSync.native(
  mkdtempSync(join(temporaryRoot, 'tau-plan-mode-binding-')),
)
const project = join(scratch, 'project with spaces'),
  config = join(scratch, 'config')
mkdirSync(project)
mkdirSync(config)
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ plansDirectory: 'plans', cleanupPeriodDays: 30 }),
)
Object.assign(process.env, {
  NODE_ENV: 'test',
  USER_TYPE: 'external',
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/utils/planFileStorage.ts',
    'src/utils/attachments.ts',
    'src/utils/messages.ts',
    'src/utils/permissions/filesystem.ts',
  ],
  exports: [
    'getPlanModeAttachments',
    'samePlanModePath',
    'replacePlanPathMatcher: matcher => { const previous = samePlanPath; samePlanPath = matcher; return () => { samePlanPath = previous; }; }',
    'getPlanFilePath',
    'getPlansDirectory',
    'getPlanSlug',
    'getPlanSlugCache',
    'setPlanSlug',
    'switchSession',
    'getSessionId',
    'copyPlanForFork',
    'getCurrentPlanFileReference',
    'renameStoredPlanFile',
    'checkEditableInternalPath',
    'createUserMessage',
    'createAssistantMessage',
    'createAttachmentMessage',
    'normalizeMessagesForAPI',
    'PLAN_MODE_ATTACHMENT_CONFIG',
    'setHasExitedPlanMode',
  ],
})
after(() => {
  process.chdir(previousCwd)
  const child = relative(temporaryRoot, scratch)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})

function plan() {
  const sessionId = randomUUID(),
    planId = `plan-${randomUUID()}`
  r.switchSession(sessionId)
  r.setPlanSlug(sessionId, planId)
  r.setHasExitedPlanMode(false)
  const path = r.getPlanFilePath()
  const content = '# Keep this saved plan\r\n'
  writeFileSync(path, content)
  return { sessionId, planId, path, content }
}
const user = text => r.createUserMessage({ content: text })
const assistant = text =>
  r.createAssistantMessage({ content: [{ type: 'text', text }] })
const mode = (path, reminderType = 'full') =>
  r.createAttachmentMessage({
    type: 'plan_mode',
    reminderType,
    planFilePath: path,
    planExists: true,
    isSubAgent: false,
  })
const context = (permissionMode = 'plan', agentId) => ({
  agentId,
  getAppState: () => ({ toolPermissionContext: { mode: permissionMode } }),
})
const turn = () => user('Continue inspecting the saved plan.')
const manyTurns = () =>
  Array.from(
    { length: r.PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS },
    turn,
  )
function fullCurrent(attachments, path, isSubAgent = false) {
  const reminder = attachments.find(item => item.type === 'plan_mode')
  assert.ok(
    reminder,
    'the current binding must be announced without waiting for another five human turns',
  )
  assert.equal(reminder.planFilePath, path)
  assert.equal(reminder.reminderType, 'full')
  assert.equal(reminder.isSubAgent, isSubAgent)
  return reminder
}

test('a fork immediately announces its own editable plan despite a recent inherited source reminder', async () => {
  const source = plan()
  const sourceHistory = [
    mode(source.path),
    user('Plan the original work.'),
    assistant('The original plan is ready.'),
  ]
  const sourceLog = {
    projectPath: project,
    planFileReference: r.getCurrentPlanFileReference(),
    messages: sourceHistory.map(message => ({
      ...message,
      sessionId: source.sessionId,
      slug: source.planId,
    })),
  }
  const forkSession = randomUUID()
  assert.equal(await r.copyPlanForFork(sourceLog, forkSession), true)
  r.switchSession(forkSession)
  const forkPath = r.getPlanFilePath()
  assert.notEqual(forkPath, source.path)
  assert.equal(readFileSync(forkPath, 'utf8'), source.content)
  assert.equal(
    r.checkEditableInternalPath(forkPath, {}).behavior,
    'allow',
    'the actual permission gate already permits this fork file',
  )
  assert.equal(
    r.checkEditableInternalPath(source.path, {}).behavior,
    'passthrough',
  )
  const beforeHistory = structuredClone(sourceHistory)
  const beforeRequest = r
    .normalizeMessagesForAPI(sourceHistory)
    .map(message => message.message)
  const request = user('Edit only the independent fork plan.')
  const additions = await r.getPlanModeAttachments(
    [...sourceHistory, request],
    context(),
  )
  fullCurrent(additions, forkPath)
  const next = r
    .normalizeMessagesForAPI([
      ...sourceHistory,
      request,
      ...additions.map(r.createAttachmentMessage),
    ])
    .map(message => message.message)
  assert.deepEqual(
    sourceHistory,
    beforeHistory,
    'announcing the binding must not rewrite saved source history',
  )
  assert.deepEqual(
    next.slice(0, beforeRequest.length),
    beforeRequest,
    'new instructions must append after the existing request prefix',
  )
  assert.ok(
    JSON.stringify(next.slice(beforeRequest.length)).includes(
      forkPath.replaceAll('\\', '\\\\'),
    ),
  )
})

test('a renamed main file refreshes its plan restriction immediately, then retains normal throttling', async () => {
  const source = plan()
  const oldHistory = [mode(source.path), user('Refine the current plan.')]
  const moved = await r.renameStoredPlanFile({
    directory: r.getPlansDirectory(),
    planId: source.planId,
    title: `binding-renamed-${randomUUID()}`,
    shouldProceed: () => true,
    persistReference: async () => {},
  })
  const additions = await r.getPlanModeAttachments(oldHistory, context())
  fullCurrent(additions, moved.newPath)
  const announced = [
    ...oldHistory,
    ...additions.map(r.createAttachmentMessage),
    turn(),
  ]
  assert.deepEqual(await r.getPlanModeAttachments(announced, context()), [])
  const next = await r.getPlanModeAttachments(
    [...announced, ...manyTurns()],
    context(),
  )
  assert.equal(
    next.find(item => item.type === 'plan_mode')?.reminderType,
    'sparse',
  )
})

test('stable bindings keep the normal sparse cycle while inherited binding counts are excluded', async () => {
  const source = plan()
  assert.deepEqual(
    await r.getPlanModeAttachments([mode(source.path), turn()], context()),
    [],
  )
  const sparse = await r.getPlanModeAttachments(
    [mode(source.path), ...manyTurns()],
    context(),
  )
  assert.equal(
    sparse.find(item => item.type === 'plan_mode')?.reminderType,
    'sparse',
  )
  const oldPath = join(r.getPlansDirectory(), `old-family-${randomUUID()}.md`)
  const oldCount =
    r.PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS - 1
  const history = [
    ...Array.from({ length: oldCount }, () => mode(oldPath)),
    mode(source.path),
    ...manyTurns(),
  ]
  const next = await r.getPlanModeAttachments(history, context())
  assert.equal(
    next.find(item => item.type === 'plan_mode')?.reminderType,
    'sparse',
    'an inherited source family must not advance the new family to a full reminder early',
  )
})

test('a directory alias for the same file does not spuriously refresh its plan restriction', async () => {
  const source = plan(),
    aliasDirectory = join(scratch, `plan-alias-${randomUUID()}`)
  symlinkSync(
    r.getPlansDirectory(),
    aliasDirectory,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const aliasPath = join(aliasDirectory, basename(source.path))
  assert.deepEqual(
    await r.getPlanModeAttachments([mode(aliasPath), turn()], context()),
    [],
  )
})

test('a saved reminder with no path refreshes the current binding instead of suppressing it', async () => {
  const source = plan()
  fullCurrent(
    await r.getPlanModeAttachments([mode(undefined), turn()], context()),
    source.path,
  )
})

test('inherited network paths are compared without filesystem probes', async () => {
  const source = plan()
  const remotePath = '\\\\unavailable-host\\share\\saved-plan.md'
  let filesystemComparisons = 0
  const restore = r.replacePlanPathMatcher(() => {
    filesystemComparisons++
    throw new Error('unexpected filesystem probe')
  })
  try {
    assert.equal(r.samePlanModePath(remotePath, source.path), false)
    assert.equal(r.samePlanModePath(source.path, remotePath), false)
    assert.equal(r.samePlanModePath(remotePath, remotePath), true)
    assert.equal(filesystemComparisons, 0)
  } finally {
    restore()
  }
  fullCurrent(
    await r.getPlanModeAttachments([mode(remotePath), turn()], context()),
    source.path,
  )
})

test('a subagent announces its own plan instead of inheriting the main agent restriction', async () => {
  const source = plan()
  const agentPath = r.getPlanFilePath('worker-1')
  writeFileSync(agentPath, '# Agent plan\n')
  const agentAddition = await r.getPlanModeAttachments(
    [mode(source.path), turn()],
    context('plan', 'worker-1'),
  )
  fullCurrent(agentAddition, agentPath, true)
  const agentHistory = [...agentAddition.map(r.createAttachmentMessage), turn()]
  assert.deepEqual(
    await r.getPlanModeAttachments(agentHistory, context('plan', 'worker-1')),
    [],
  )
})

test('reentry after a recorded plan exit sends fresh guidance despite a recent same-path reminder', async () => {
  const source = plan()
  const exited = r.createAttachmentMessage({
    type: 'plan_mode_exit',
    planFilePath: source.path,
    planExists: true,
  })
  r.setHasExitedPlanMode(true)
  const additions = await r.getPlanModeAttachments(
    [mode(source.path), exited, turn()],
    context(),
  )
  fullCurrent(additions, source.path)
  assert.equal(
    additions.find(item => item.type === 'plan_mode_reentry')?.planFilePath,
    source.path,
  )
  assert.deepEqual(
    await r.getPlanModeAttachments(
      [...additions.map(r.createAttachmentMessage), turn()],
      context(),
    ),
    [],
  )
})

test('outside plan mode no binding reminder or new identity is created', async () => {
  r.switchSession(randomUUID())
  assert.equal(r.getPlanSlugCache().has(r.getSessionId()), false)
  assert.deepEqual(
    await r.getPlanModeAttachments([turn()], context('default')),
    [],
  )
  assert.equal(r.getPlanSlugCache().has(r.getSessionId()), false)
})
