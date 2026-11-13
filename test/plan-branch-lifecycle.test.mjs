// Exercise the real /branch command, persisted JSONL, and a fresh runtime's
// resume reader. No replacement for the command or plan storage functions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const previousCwd = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tau-plan-branch-review-'))
const project = join(scratch, 'project'),
  config = join(scratch, 'config')
mkdirSync(project)
mkdirSync(config)
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ plansDirectory: 'plans', cleanupPeriodDays: 30 }),
)
Object.assign(process.env, {
  NODE_ENV: 'test',
  TEST_ENABLE_SESSION_PERSISTENCE: '1',
  USER_TYPE: 'external',
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})
process.chdir(project)
const paths = [
  'src/bootstrap/state.ts',
  'src/utils/plans.ts',
  'src/utils/sessionStorage.ts',
  'src/commands/branch/branch.ts',
  'src/commands/clone/clone.ts',
  'src/utils/conversationRecovery.ts',
]
const exports = [
  'branchCommand: branch_exports',
  'cloneCommand: clone_exports',
  'getPlanSlugCache',
  'switchSession',
  'setPlanSlug',
  'getPlanSlug',
  'getPlanFilePath',
  'getPlansDirectory',
  'getPlan',
  'copyPlanForFork',
  'copyPlanForResume',
  'recordTranscript',
  'flushSessionStorage',
  'getTranscriptPath',
  'resetSessionFilePointer',
  'createUserMessage',
  'renameStoredPlanFile',
  'savePlanFileReference',
  'clearSessionMetadata',
  'loadConversationForResume',
  'loadTranscriptFromFile',
]
const r = await loadBuiltRuntime({ paths, exports })

after(() => {
  process.chdir(previousCwd)
  const child = relative(tmpdir(), scratch)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})

test('/branch persists its own plan identity and a fresh runtime resumes it independently', async () => {
  const sourceSession = randomUUID(),
    sourceId = `plan-${randomUUID()}`
  r.switchSession(sourceSession)
  await r.resetSessionFilePointer()
  r.setPlanSlug(sourceSession, sourceId)
  const content = '# An approved plan with CRLF\r\n\r\nPreserve the source.\r\n'
  writeFileSync(r.getPlanFilePath(), content)
  await r.recordTranscript([
    r.createUserMessage({ content: 'Branch the approved plan.' }),
  ])
  await r.flushSessionStorage()
  const sourceTranscript = r.getTranscriptPath()
  const published = await r.renameStoredPlanFile({
    directory: r.getPlansDirectory(),
    planId: sourceId,
    title: 'branch-source-title',
    shouldProceed: () => true,
    persistReference: (ref) =>
      r.savePlanFileReference(sourceSession, ref, sourceTranscript),
  })
  await r.flushSessionStorage()
  let forkSession, forkPath, forkId
  const outcomes = []
  await r.branchCommand.call(
    (value) => outcomes.push(value),
    {
      resume: async (session, log, entrypoint) => {
        assert.equal(entrypoint, 'fork')
        forkSession = session
        forkPath = log.fullPath
        r.switchSession(session)
        await r.resetSessionFilePointer()
        r.clearSessionMetadata()
        assert.equal(await r.copyPlanForFork(log, session), true)
        forkId = r.getPlanSlug()
      },
    },
    'Independent approved plan',
  )
  assert.match(outcomes[0], /Branched conversation/)
  await r.flushSessionStorage()
  assert.ok(forkId && forkId !== sourceId)
  const rows = readFileSync(forkPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(rows.some((row) => row.type === 'user'))
  assert.ok(
    rows
      .filter((row) => row.type === 'user')
      .every((row) => row.slug === forkId),
  )
  assert.equal(
    rows.findLast((row) => row.type === 'plan-file-reference').planFileReference
      .planId,
    forkId,
  )

  const fresh = await loadBuiltRuntime({ paths, exports })
  const resumed = await fresh.loadConversationForResume(
    undefined,
    forkPath,
    'resume',
  )
  assert.equal(resumed.planFileReference.planId, forkId)
  fresh.switchSession(forkSession)
  const savedLog = await fresh.loadTranscriptFromFile(forkPath)
  assert.equal(await fresh.copyPlanForResume(savedLog, forkSession), true)
  assert.equal(fresh.getPlanSlug(), forkId)
  assert.equal(fresh.getPlan(), content)
  assert.notEqual(fresh.getPlanFilePath(), published.newPath)
  writeFileSync(fresh.getPlanFilePath(), '# Independent branch changes\n')
  assert.equal(readFileSync(published.newPath, 'utf8'), content)
})

const rowsOf = (path) =>
  readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)
const reservedNames = () => {
  const names = join(project, 'plans', '.plan-metadata', 'names')
  return existsSync(names) ? readdirSync(names).sort() : []
}

test('/clone of a session whose plan was never written cannot share that plan identity later', async () => {
  const sourceSession = randomUUID(),
    sourceId = `plan-${randomUUID()}`
  r.switchSession(sourceSession)
  await r.resetSessionFilePointer()
  r.clearSessionMetadata()
  // Plan mode assigned an identity, but nothing was written to it yet.
  r.setPlanSlug(sourceSession, sourceId)
  await r.recordTranscript([
    r.createUserMessage({ content: 'Start planning, then clone.' }),
  ])
  await r.flushSessionStorage()
  let cloneSession, clonePath, cloneId
  const outcomes = []
  await r.cloneCommand.call(
    (value) => outcomes.push(value),
    {
      resume: async (session, log, entrypoint) => {
        assert.equal(entrypoint, 'fork')
        cloneSession = session
        clonePath = log.fullPath
        r.switchSession(session)
        await r.resetSessionFilePointer()
        r.clearSessionMetadata()
        assert.equal(await r.copyPlanForFork(log, session), false)
        cloneId = r.getPlanSlug()
      },
    },
    '',
  )
  await r.flushSessionStorage()
  assert.ok(cloneId && cloneId !== sourceId)
  const rows = rowsOf(clonePath)
  // /clone copies rows that still name the source plan...
  assert.ok(rows.some((row) => row.slug === sourceId))
  // ...so the clone must record its own identity even with nothing to copy.
  assert.equal(
    rows.findLast((row) => row.type === 'plan-file-reference')
      ?.planFileReference.planId,
    cloneId,
  )

  const fresh = await loadBuiltRuntime({ paths, exports })
  const resumed = await fresh.loadConversationForResume(
    undefined,
    clonePath,
    'resume',
  )
  assert.equal(resumed.planFileReference.planId, cloneId)
  fresh.switchSession(cloneSession)
  await fresh.copyPlanForResume(
    await fresh.loadTranscriptFromFile(clonePath),
    cloneSession,
  )
  assert.equal(fresh.getPlanSlug(), cloneId)
  assert.notEqual(
    fresh.getPlanFilePath(),
    join(fresh.getPlansDirectory(), `${sourceId}.md`),
  )
})

test('/branch without a plan identity creates none for either conversation', async () => {
  const sourceSession = randomUUID()
  r.switchSession(sourceSession)
  await r.resetSessionFilePointer()
  r.clearSessionMetadata()
  await r.recordTranscript([
    r.createUserMessage({ content: 'An ordinary conversation.' }),
  ])
  await r.flushSessionStorage()
  const before = reservedNames()
  let forkSession, forkPath
  await r.branchCommand.call(
    () => {},
    {
      resume: async (session, log) => {
        forkSession = session
        forkPath = log.fullPath
        r.switchSession(session)
        await r.resetSessionFilePointer()
        r.clearSessionMetadata()
        assert.equal(await r.copyPlanForFork(log, session), false)
      },
    },
    '',
  )
  await r.flushSessionStorage()
  assert.equal(r.getPlanSlugCache().has(sourceSession), false)
  assert.equal(r.getPlanSlugCache().has(forkSession), false)
  assert.ok(rowsOf(forkPath).every((row) => row.slug === undefined))
  assert.deepEqual(reservedNames(), before, 'no plan names were reserved')
  // Reading plan state must not create an identity either.
  assert.equal(r.getPlan(), null)
  assert.equal(r.getPlanSlugCache().has(forkSession), false)
})
