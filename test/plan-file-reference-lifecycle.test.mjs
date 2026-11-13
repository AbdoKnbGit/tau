// Run after `node build.mjs`: node --test test/plan-file-reference-lifecycle.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'tau-plan-lifecycle-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  USER_TYPE: 'external',
  CLAUDE_CONFIG_DIR: root,
  CLAUDE_CODE_TMPDIR: root,
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENVIRONMENT_KIND: 'byoc',
})
const r = await loadMcpRuntime({
  paths: [
    'src/utils/plans.ts',
    'src/utils/planFileStorage.ts',
    'src/utils/conversationRecovery.ts',
  ],
  exports: [
    'copyPlanForResume',
    'copyPlanForFork',
    'getPlan',
    'getPlanFilePath',
    'getPlansDirectory',
    'getPlanSlug',
    'setPlanSlug',
    'getPlanSlugCache',
    'getPlanMetadataPath',
    'switchSession',
    'withPlanFileLock',
    'restorePlanFileReference',
    'loadConversationForResume',
    'getSessionId',
    'restoreSessionMetadata',
    'getRetiredPlanPathReplacement',
  ],
})
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
const directory = r.getPlansDirectory()
const identity = () => `plan-${randomUUID()}`
const ref = (planId, filename, revision = 1) => ({
  version: 1,
  planId,
  filename,
  revision,
})
const message = (slug, content = 'Implement the plan.') => ({
  type: 'user',
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
  slug,
  message: { role: 'user', content },
})
const snapshot = (planFileReference, content) => ({
  type: 'system',
  subtype: 'file_snapshot',
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
  planFileReference,
  snapshotFiles: [
    { key: 'plan', path: join(directory, planFileReference.filename), content },
  ],
})
const log = (planId, reference, content) => ({
  planFileReference: reference,
  messages: [message(planId), snapshot(reference, content)],
})

test('a resumed fork ignores inherited source-plan snapshot identity', async () => {
  const forkPlanId = identity(),
    sourcePlanId = identity(),
    sessionId = randomUUID()
  writeFileSync(join(directory, `${forkPlanId}.md`), 'Independent fork plan.\n')
  const inherited = ref(sourcePlanId, `source-title-${randomUUID()}.md`, 4)
  const forkLog = {
    messages: [
      message(forkPlanId),
      snapshot(inherited, 'Source snapshot content.\n'),
    ],
  }
  r.switchSession(sessionId)
  assert.equal(await r.copyPlanForResume(forkLog, sessionId), true)
  assert.equal(r.getPlanSlug(), forkPlanId)
  assert.equal(r.getPlan(), 'Independent fork plan.\n')
  assert.equal(
    existsSync(r.getPlanMetadataPath(directory, sourcePlanId)),
    false,
  )
})

test('portable recovery prefers a newer matching-family snapshot over old metadata', async () => {
  const planId = identity(),
    sessionId = randomUUID()
  const old = ref(planId, `old-title-${randomUUID()}.md`, 1)
  const latest = ref(planId, `new-title-${randomUUID()}.md`, 2)
  const saved = {
    planFileReference: old,
    messages: [message(planId), snapshot(latest, 'Latest approved content.\n')],
  }
  r.switchSession(sessionId)
  assert.equal(await r.copyPlanForResume(saved, sessionId), true)
  assert.equal(basename(r.getPlanFilePath()), latest.filename)
  assert.equal(r.getPlan(), 'Latest approved content.\n')
})

test('portable recovery does not adopt or overwrite another plan occupying the saved title', async () => {
  const planId = identity(),
    sessionId = randomUUID()
  const saved = ref(planId, `shared-title-${randomUUID()}.md`)
  const occupied = join(directory, saved.filename)
  writeFileSync(occupied, 'Another session owns this file.\n')
  r.switchSession(sessionId)
  assert.equal(
    await r.copyPlanForResume(
      log(planId, saved, 'Recovered own plan.\n'),
      sessionId,
    ),
    true,
  )
  assert.notEqual(r.getPlanFilePath(), occupied)
  assert.equal(r.getPlan(), 'Recovered own plan.\n')
  assert.equal(
    readFileSync(occupied, 'utf8'),
    'Another session owns this file.\n',
  )
  assert.equal(r.getRetiredPlanPathReplacement(occupied), r.getPlanFilePath())
})

async function holdPlanLock(planId) {
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const wait = new Promise((resolve) => {
    release = resolve
  })
  const held = r.withPlanFileLock(directory, planId, async () => {
    entered()
    await wait
  })
  await started
  return { release, held }
}

test('late resume restoration cannot replace a newly switched session cache', async () => {
  const restoredId = identity(),
    currentId = identity()
  const outgoingSession = randomUUID(),
    currentSession = randomUUID()
  const saved = ref(restoredId, `restored-${randomUUID()}.md`)
  r.switchSession(outgoingSession)
  const held = await holdPlanLock(restoredId)
  let pending
  try {
    pending = r.copyPlanForResume(
      log(restoredId, saved, 'Restored old session.\n'),
      outgoingSession,
    )
    assert.equal(r.getPlanSlugCache().get(outgoingSession), restoredId)
    r.switchSession(currentSession)
    r.setPlanSlug(currentSession, currentId)
  } finally {
    held.release()
    await held.held
  }
  assert.equal(await pending, true)
  assert.equal(r.getPlanSlug(), currentId)
  assert.equal(r.getPlanSlugCache().has(outgoingSession), false)
})

test('fork reserves its independent plan identity before waiting for source restoration', async () => {
  const sourceId = identity(),
    forkSession = randomUUID()
  const saved = ref(sourceId, `fork-source-${randomUUID()}.md`)
  const sourceLog = log(sourceId, saved, 'Fork source content.\n')
  await r.restorePlanFileReference(directory, saved, 'Fork source content.\n')
  const held = await holdPlanLock(sourceId)
  let pending, forkId
  try {
    pending = r.copyPlanForFork(sourceLog, forkSession)
    forkId = r.getPlanSlugCache().get(forkSession)
    assert.equal(typeof forkId, 'string')
    assert.notEqual(forkId, sourceId)
  } finally {
    held.release()
    await held.held
  }
  assert.equal(await pending, true)
  assert.equal(
    readFileSync(join(directory, `${forkId}.md`), 'utf8'),
    'Fork source content.\n',
  )
})

test('the shared CLI resume loader returns the resolved reference and restores identity after switching', async () => {
  const planId = identity(),
    sessionId = randomUUID()
  const saved = ref(planId, `cli-plan-${randomUUID()}.md`)
  const source = { ...log(planId, saved, 'CLI plan contents.\n'), sessionId }
  const result = await r.loadConversationForResume(source, undefined, 'resume')
  assert.equal(result.planFileReference.planId, planId)
  r.switchSession(sessionId)
  r.restoreSessionMetadata(result)
  assert.equal(r.getPlanSlug(), planId)
  assert.equal(r.getPlan(), 'CLI plan contents.\n')
})

test('the shared CLI fork loader keeps the new session plan independent', async () => {
  const sourceId = identity(),
    forkSession = randomUUID()
  const saved = ref(sourceId, `cli-fork-source-${randomUUID()}.md`)
  r.switchSession(forkSession)
  const result = await r.loadConversationForResume(
    {
      ...log(sourceId, saved, 'Source fork bytes.\n'),
      sessionId: randomUUID(),
    },
    undefined,
    'fork',
  )
  assert.equal(result.planFileReference, undefined)
  assert.notEqual(r.getPlanSlug(), sourceId)
  assert.equal(r.getPlan(), 'Source fork bytes.\n')
})
