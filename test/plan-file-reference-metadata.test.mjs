// Run after `node build.mjs`: node --test test/plan-file-reference-metadata.test.mjs
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
import { join } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'tau-plan-metadata-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  USER_TYPE: 'external',
  CLAUDE_CONFIG_DIR: root,
  CLAUDE_CODE_TMPDIR: root,
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})
const r = await loadMcpRuntime({
  paths: ['src/utils/sessionStorage.ts'],
  exports: [
    'loadTranscriptFile',
    'loadTranscriptFromFile',
    'loadFullLog',
    'loadAllLogsFromSessionFile',
    'getLastSessionLog',
    'savePlanFileReference',
    'switchSession',
    'resetSessionFilePointer',
    'restoreSessionMetadata',
    'clearSessionMetadata',
    'adoptResumedSessionFile',
    'reAppendSessionMetadata',
    'setSessionPersistenceDisabled',
    'getProject',
  ],
})
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))

const reference = (revision) => ({
  version: 1,
  planId: 'calm-singing-star',
  filename:
    revision === 1
      ? 'add-oauth-login.md'
      : 'add-oauth-login-20261111T153045Z.md',
  revision,
})
const metadata = (sessionId, planFileReference) => ({
  type: 'plan-file-reference',
  sessionId,
  planFileReference,
})
const user = (sessionId, parentUuid = null) => ({
  parentUuid,
  isSidechain: false,
  type: 'user',
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
  sessionId,
  cwd: root,
  version: 'test',
  userType: 'external',
  message: { role: 'user', content: 'Implement the approved plan.' },
})
const jsonl = (entries) =>
  entries.map((entry) => JSON.stringify(entry) + '\n').join('')
function fixture(entries) {
  const sessionId = randomUUID()
  const fullPath = join(root, `${sessionId}.jsonl`)
  writeFileSync(fullPath, jsonl([...entries(sessionId), user(sessionId)]))
  return { sessionId, fullPath }
}

test('all full-log readers preserve validated current filename independently of the legacy slug', async () => {
  const { sessionId, fullPath } = fixture((id) => [
    metadata(id, reference(2)),
    metadata(id, reference(1)), // A stale process re-appended older metadata.
    metadata(id, { ...reference(3), filename: '../outside.md' }),
  ])
  const parsed = await r.loadTranscriptFile(fullPath)
  assert.deepEqual(parsed.planFileReferences.get(sessionId), reference(2))

  const direct = await r.loadTranscriptFromFile(fullPath)
  assert.deepEqual(direct.planFileReference, reference(2))
  const full = await r.loadFullLog({
    messages: [],
    isLite: true,
    sessionId,
    fullPath,
  })
  assert.deepEqual(full.planFileReference, reference(2))
  const all = await r.loadAllLogsFromSessionFile(fullPath)
  assert.equal(all.length, 1)
  assert.deepEqual(all[0].planFileReference, reference(2))

  r.switchSession(sessionId, root)
  const last = await r.getLastSessionLog(sessionId)
  assert.deepEqual(last.planFileReference, reference(2))
})

test('legacy transcripts without plan metadata remain readable', async () => {
  const { fullPath } = fixture(() => [])
  const loaded = await r.loadTranscriptFromFile(fullPath)
  assert.equal(loaded.planFileReference, undefined)
  assert.equal(loaded.messages.length, 1)
})

test('saving to a captured session path does not change another session cache', async () => {
  const owner = fixture(() => [])
  const active = fixture(() => [])
  r.switchSession(active.sessionId, root)
  await r.resetSessionFilePointer()
  r.clearSessionMetadata()
  r.adoptResumedSessionFile()
  await r.savePlanFileReference(owner.sessionId, reference(1), owner.fullPath)
  r.reAppendSessionMetadata()
  assert.deepEqual(
    (await r.loadTranscriptFile(owner.fullPath)).planFileReferences.get(
      owner.sessionId,
    ),
    reference(1),
  )
  assert.equal(
    (await r.loadTranscriptFile(active.fullPath)).planFileReferences.get(
      active.sessionId,
    ),
    undefined,
  )
})

test('metadata restore and reappend keep newer revisions and clear with the session', async () => {
  const { sessionId, fullPath } = fixture(() => [])
  r.switchSession(sessionId, root)
  await r.resetSessionFilePointer()
  r.clearSessionMetadata()
  r.restoreSessionMetadata({ planFileReference: reference(1) })
  r.adoptResumedSessionFile()
  writeFileSync(fullPath, jsonl([metadata(sessionId, reference(2))]), {
    flag: 'a',
  })
  r.reAppendSessionMetadata()
  let entries = readFileSync(fullPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
  const latest = entries
    .filter((entry) => entry.type === 'plan-file-reference')
    .at(-1)
  assert.deepEqual(latest.planFileReference, reference(2))

  r.clearSessionMetadata()
  // Use a new session so its tail contains no previous plan reference.
  const next = fixture(() => [])
  r.switchSession(next.sessionId, root)
  await r.resetSessionFilePointer()
  r.adoptResumedSessionFile()
  r.reAppendSessionMetadata()
  entries = readFileSync(next.fullPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.equal(
    entries.some((entry) => entry.type === 'plan-file-reference'),
    false,
  )
})

test('plan metadata survives a compact boundary and a split scanner marker', async () => {
  const sessionId = randomUUID(),
    boundaryId = randomUUID()
  const fullPath = join(root, `${sessionId}.jsonl`)
  // Place the 28-byte metadata marker across a 64 KiB read-stream seam.
  // This also forces the >5 MiB pre-compaction streaming loader.
  const metadataOffset = 6 * 1024 * 1024 + 65536 - 26
  const emptyPadding = JSON.stringify({ type: 'padding', content: '' }) + '\n'
  const padding =
    JSON.stringify({
      type: 'padding',
      content: 'x'.repeat(metadataOffset - Buffer.byteLength(emptyPadding)),
    }) + '\n'
  assert.equal(Buffer.byteLength(padding), metadataOffset)
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    parentUuid: null,
    isSidechain: false,
    uuid: boundaryId,
    sessionId,
    timestamp: new Date().toISOString(),
    content: 'Compacted',
    compactMetadata: { trigger: 'manual', preTokens: 1000 },
  }
  writeFileSync(
    fullPath,
    padding +
      jsonl([
        metadata(sessionId, reference(2)),
        boundary,
        user(sessionId, boundaryId),
      ]),
  )
  const loaded = await r.loadTranscriptFromFile(fullPath)
  assert.deepEqual(loaded.planFileReference, reference(2))
})

test('a fork reference for a session without a transcript waits for its first message', async () => {
  // --fork-session keeps the fresh startup session, whose transcript does
  // not exist until its first message. Appending would leave an orphan
  // metadata-only file for a fork that is never used.
  const sessionId = randomUUID()
  const fullPath = join(root, `${sessionId}.jsonl`)
  r.switchSession(sessionId, root)
  r.clearSessionMetadata()
  await r.savePlanFileReference(sessionId, reference(1), fullPath)
  assert.equal(existsSync(fullPath), false)
  assert.deepEqual(
    r.getProject().currentSessionPlanFileReference,
    reference(1),
    'the cached reference is written when the transcript is created',
  )
  r.clearSessionMetadata()
})

test('disabled session persistence keeps plan references out of transcripts', async () => {
  const owner = fixture(() => [])
  const before = readFileSync(owner.fullPath, 'utf8')
  r.setSessionPersistenceDisabled(true)
  try {
    await r.savePlanFileReference(owner.sessionId, reference(1), owner.fullPath)
  } finally {
    r.setSessionPersistenceDisabled(false)
  }
  assert.equal(readFileSync(owner.fullPath, 'utf8'), before)
})
