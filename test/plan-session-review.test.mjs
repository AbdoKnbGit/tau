// Independent regression review: real session transitions and queued notices.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
import { isAbsolute, join, relative } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const originalCwd = process.cwd()
// Tau works in the resolved directory (on macOS /var is /private/var), so
// paths expected here must start from it too.
const temporaryRoot = realpathSync.native(tmpdir())
const scratch = realpathSync.native(
  mkdtempSync(join(temporaryRoot, 'tau-plan-session-review-')),
)
const project = join(scratch, 'project'),
  config = join(scratch, 'config')
mkdirSync(project)
mkdirSync(config)
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ cleanupPeriodDays: 30, plansDirectory: 'plans' }),
)
Object.assign(process.env, {
  NODE_ENV: 'test',
  USER_TYPE: 'external',
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
})
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/utils/planApprovalNaming.ts',
    'src/commands/clear/conversation.ts',
    'src/utils/messageQueueManager.ts',
    'src/utils/queueProcessor.ts',
  ],
  exports: [
    'capturePlanFileOwner',
    'getPlanFilePath',
    'nameSessionFromApprovedPlan',
    'cancelPlanApprovalNaming',
    'cancelStalePlanApprovalNaming',
    'clearConversation',
    'switchSession',
    'clearSessionMetadata',
    'getCommandQueue',
    'clearCommandQueue',
    'enqueue',
    'processQueueIfReady',
    'setPlanSlug',
    'persistFileSnapshotIfRemote',
    'resetSessionFilePointer',
    'recordTranscript',
    'flushSessionStorage',
    'getTranscriptPath',
    'createUserMessage',
    'restorePlanFileReference',
    'loadConversationForResume',
    'getPlansDirectory',
    'copyPlanForFork',
    'getPlanSlug',
    'getPlanFileRenameAttachments',
    'pendingRenameNotices: () => pendingPlanFileRenameNotices',
    'replaceBranchReader: reader => { const previous = getBranch; getBranch = reader; return () => { getBranch = previous; }; }',
    'setNameGenerator: generator => { generateSessionName = generator; }',
  ],
})

async function clear() {
  await r.clearConversation({ setMessages() {}, readFileState: new Map() })
  r.cancelStalePlanApprovalNaming()
}
afterEach(async () => {
  await clear()
  r.clearCommandQueue()
})
after(() => {
  process.chdir(originalCwd)
  const child = relative(temporaryRoot, scratch)
  assert.ok(child && !isAbsolute(child) && !child.startsWith('..'))
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})

async function createRealRenameNotice() {
  r.clearSessionMetadata()
  const path = r.getPlanFilePath()
  writeFileSync(path, '# A session-owned saved plan\n')
  const owner = r.capturePlanFileOwner()
  r.setNameGenerator(async () => `review-${randomUUID()}`)
  await r.nameSessionFromApprovedPlan(
    { plan: readFileSync(path, 'utf8'), owner },
    { setAppState() {} },
  )
  assert.equal(
    r.pendingRenameNotices().length,
    1,
    'the real successful rename must first hold its path update',
  )
  assert.equal(
    r.getCommandQueue().length,
    0,
    'the path update never becomes a queued command',
  )
  return { owner }
}

test('clear cannot deliver a completed old-session rename notice to the new session', async () => {
  await createRealRenameNotice()
  r.enqueue({
    mode: 'prompt',
    value: 'An unrelated queued user request',
    priority: 'next',
  })
  await clear()
  assert.deepEqual(
    r.getPlanFileRenameAttachments({}, 'repl_main_thread'),
    [],
    'completed rename notices need ownership too; cancelling only the pending model request is insufficient',
  )
  assert.ok(
    r
      .getCommandQueue()
      .some((command) => command.value === 'An unrelated queued user request'),
    'cleaning up plan notifications must preserve other queued work',
  )
})

test('switching session cannot deliver a pending rename path update from the previous session', async () => {
  await createRealRenameNotice()
  r.switchSession(randomUUID())
  r.clearSessionMetadata()
  r.cancelStalePlanApprovalNaming()
  assert.deepEqual(
    r.getPlanFileRenameAttachments({}, 'repl_main_thread'),
    [],
    'the fresh conversation must not be instructed to read or edit the previous session plan',
  )
})

test('a pending notice that outlives its session is not delivered to the next one', async () => {
  await createRealRenameNotice()
  // No cleanup hook runs here: delivery itself must check the owner.
  r.switchSession(randomUUID())
  assert.deepEqual(r.getPlanFileRenameAttachments({}, 'repl_main_thread'), [])
  assert.equal(r.pendingRenameNotices().length, 0)
})

test('a remote plan snapshot cannot cross a session switch at its persistence await', async () => {
  const oldKind = process.env.CLAUDE_CODE_ENVIRONMENT_KIND
  const oldPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.CLAUDE_CODE_ENVIRONMENT_KIND = 'byoc'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  try {
    const firstSession = randomUUID(),
      secondSession = randomUUID()
    const firstPlan = `plan-${randomUUID()}`,
      secondPlan = `plan-${randomUUID()}`
    r.switchSession(firstSession)
    await r.resetSessionFilePointer()
    r.setPlanSlug(firstSession, firstPlan)
    writeFileSync(r.getPlanFilePath(), '# PRIVATE FIRST SESSION PLAN\n')
    await r.recordTranscript([
      r.createUserMessage({ content: 'First session request' }),
    ])
    await r.flushSessionStorage()

    const pending = r.persistFileSnapshotIfRemote()
    r.switchSession(secondSession)
    // resetSessionFilePointer mutates synchronously, before returning its promise.
    await r.resetSessionFilePointer()
    r.setPlanSlug(secondSession, secondPlan)
    writeFileSync(r.getPlanFilePath(), '# SECOND SESSION PLAN\n')
    await pending
    await r.recordTranscript([
      r.createUserMessage({ content: 'Second session request' }),
    ])
    await r.flushSessionStorage()
    const entries = readFileSync(r.getTranscriptPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const foreignSnapshots = entries.filter(
      (entry) =>
        entry.subtype === 'file_snapshot' &&
        entry.snapshotFiles?.some((file) =>
          file.content.includes('PRIVATE FIRST SESSION PLAN'),
        ),
    )
    assert.deepEqual(
      foreignSnapshots,
      [],
      'the second session must never persist the first session plan contents',
    )
  } finally {
    if (oldKind === undefined) delete process.env.CLAUDE_CODE_ENVIRONMENT_KIND
    else process.env.CLAUDE_CODE_ENVIRONMENT_KIND = oldKind
    if (oldPersistence === undefined)
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = oldPersistence
  }
})

test('loading a worktree session does not restore its named plan into the unrelated caller project', async () => {
  const targetWorktree = join(scratch, 'target-worktree')
  const targetPlans = join(targetWorktree, 'plans')
  mkdirSync(targetPlans, { recursive: true })
  const planId = `plan-${randomUUID()}`,
    sessionId = randomUUID()
  const reference = {
    version: 1,
    planId,
    filename: `worktree-review-${randomUUID()}.md`,
    revision: 1,
  }
  const content = '# Saved target worktree plan\n'
  await r.restorePlanFileReference(targetPlans, reference, content)
  const wrongPath = join(r.getPlansDirectory(), reference.filename)
  assert.equal(existsSync(wrongPath), false)
  const source = {
    sessionId,
    projectPath: targetWorktree,
    planFileReference: reference,
    worktreeSession: {
      originalCwd: project,
      worktreePath: targetWorktree,
      worktreeName: 'target-worktree',
      worktreeBranch: 'test-branch',
      sessionId,
    },
    messages: [
      {
        type: 'user',
        uuid: randomUUID(),
        sessionId,
        slug: planId,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Continue target worktree plan' },
      },
      {
        type: 'system',
        subtype: 'file_snapshot',
        uuid: randomUUID(),
        sessionId,
        slug: planId,
        timestamp: new Date().toISOString(),
        planFileReference: reference,
        snapshotFiles: [
          { key: 'plan', path: join(targetPlans, reference.filename), content },
        ],
      },
    ],
  }
  await r.loadConversationForResume(source, undefined, 'resume')
  assert.equal(
    existsSync(wrongPath),
    false,
    'plan restoration must resolve the saved worktree directory before creating files',
  )
  assert.equal(
    readFileSync(join(targetPlans, reference.filename), 'utf8'),
    content,
  )
})

test('a remote snapshot cannot cross a session switch during transcript Git lookup', async () => {
  const oldKind = process.env.CLAUDE_CODE_ENVIRONMENT_KIND
  const oldPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.CLAUDE_CODE_ENVIRONMENT_KIND = 'byoc'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  let release, restoreReader
  try {
    const first = randomUUID(),
      second = randomUUID()
    r.switchSession(first)
    await r.resetSessionFilePointer()
    r.setPlanSlug(first, `plan-${randomUUID()}`)
    writeFileSync(r.getPlanFilePath(), '# PRIVATE SNAPSHOT DURING GIT LOOKUP\n')
    await r.recordTranscript([
      r.createUserMessage({ content: 'First session' }),
    ])
    await r.flushSessionStorage()
    let entered
    const started = new Promise((done) => {
      entered = done
    })
    const gate = new Promise((done) => {
      release = done
    })
    restoreReader = r.replaceBranchReader(async () => {
      entered()
      await gate
      return 'fixture-branch'
    })
    const pending = r.persistFileSnapshotIfRemote()
    await started
    r.switchSession(second)
    await r.resetSessionFilePointer()
    r.setPlanSlug(second, `plan-${randomUUID()}`)
    release()
    await pending
    restoreReader()
    restoreReader = undefined
    await r.recordTranscript([
      r.createUserMessage({ content: 'Second session' }),
    ])
    await r.flushSessionStorage()
    assert.ok(
      !readFileSync(r.getTranscriptPath(), 'utf8').includes(
        'PRIVATE SNAPSHOT DURING GIT LOOKUP',
      ),
      'checking ownership only before recordTranscript is insufficient',
    )
  } finally {
    release?.()
    restoreReader?.()
    if (oldKind === undefined) delete process.env.CLAUDE_CODE_ENVIRONMENT_KIND
    else process.env.CLAUDE_CODE_ENVIRONMENT_KIND = oldKind
    if (oldPersistence === undefined)
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = oldPersistence
  }
})

test('forking a saved worktree plan copies from its saved directory into the active project', async () => {
  const sourceProject = join(scratch, 'fork-source-worktree'),
    sourcePlans = join(sourceProject, 'plans')
  mkdirSync(sourcePlans, { recursive: true })
  const planId = `plan-${randomUUID()}`,
    sourceSession = randomUUID(),
    forkSession = randomUUID()
  const reference = {
    version: 1,
    planId,
    filename: `fork-worktree-${randomUUID()}.md`,
    revision: 2,
  }
  const content = '# Independent cross-project fork\r\n'
  await r.restorePlanFileReference(sourcePlans, reference, content)
  const source = {
    projectPath: sourceProject,
    planFileReference: reference,
    worktreeSession: { worktreePath: sourceProject },
    messages: [
      {
        type: 'user',
        uuid: randomUUID(),
        sessionId: sourceSession,
        slug: planId,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Fork the source plan' },
      },
    ],
  }
  assert.equal(await r.copyPlanForFork(source, forkSession), true)
  r.switchSession(forkSession)
  const destination = r.getPlanFilePath()
  assert.equal(join(project, 'plans', `${r.getPlanSlug()}.md`), destination)
  assert.equal(readFileSync(destination, 'utf8'), content)
  writeFileSync(destination, '# Updated fork\n')
  assert.equal(
    readFileSync(join(sourcePlans, reference.filename), 'utf8'),
    content,
  )
})
