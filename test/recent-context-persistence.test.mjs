// Run after `node build.mjs`: node --test test/recent-context-persistence.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const tempRoot = await mkdtemp(join(tmpdir(), 'tau-recent-persistence-'))
const originalCwd = process.cwd()
const environment = {
  NODE_ENV: 'test', USER_TYPE: 'external',
  CLAUDE_CONFIG_DIR: join(tempRoot, 'config'),
  TEST_ENABLE_SESSION_PERSISTENCE: 'true',
  ENABLE_SESSION_PERSISTENCE: '',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_INTERNAL_FC_OVERRIDES: '{}',
}
const originalEnv = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
Object.assign(process.env, environment)
process.chdir(tempRoot)

let audit
after(async () => {
  if (audit) {
    await audit.flushSessionStorage()
    audit.resetProjectForTesting()
  }
  process.chdir(originalCwd)
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(dirname(resolve(tempRoot)), resolve(tmpdir()))
  await rm(tempRoot, { recursive: true, force: true })
})

// The build contains the actual writer and loader with their dependencies.
// Append test-only exports rather than adding a production entry point or
// replacing persistence internals. Remove the CLI invocation before import.
const distPath = join(repository, 'dist/tau.mjs')
const auditPath = join(dirname(distPath), `.recent-context-audit-${randomUUID()}.mjs`)
let source = readFileSync(distPath, 'utf8')
const invocation = /\nvoid main\d*\(\);\r?\n/g
assert.equal(source.match(invocation)?.length, 1, 'exactly one CLI entry point is removed')
source = source.replace(invocation, '\n')
source += `
export function __recentContextPersistenceAudit() {
  init_sessionStorage(); init_recentContext(); init_tokens(); init_compact();
  init_mappers(); init_coreSchemas();
  return {
    recordTranscript, flushSessionStorage, loadTranscriptFile,
    buildConversationChain, resetProjectForTesting, setSessionFileForTesting,
    clearSessionMessagesCache, switchSession, prepareRecentContext,
    annotateBoundaryWithPreservedSegment, buildPostCompactMessages,
    tokenCountWithEstimation, toSDKCompactMetadata, fromSDKCompactMetadata,
    SDKCompactBoundaryMessageSchema,
  };
}
`
try {
  writeFileSync(auditPath, source)
  audit = (await import(pathToFileURL(auditPath).href)).__recentContextPersistenceAudit()
} finally {
  try { unlinkSync(auditPath) } catch {}
}

function user(content) {
  return { type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(),
    message: { role: 'user', content } }
}

function assistant(content, id = randomUUID()) {
  return { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(),
    message: { role: 'assistant', id, model: 'test-model', content,
      usage: { input_tokens: 180000, output_tokens: 1000,
        cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } }
}

function textResponse(text) {
  return assistant([{ type: 'text', text }])
}

function toolResponse(call, text) {
  return { ...user([{ type: 'tool_result', tool_use_id: call.message.content[0].id,
    content: text }]), sourceToolAssistantUUID: call.uuid }
}

function compactResult(kept = []) {
  const summary = { ...user('Summary of the entire conversation'), isCompactSummary: true,
    isVisibleInTranscriptOnly: true }
  let marker = { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(),
    timestamp: new Date().toISOString(), content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 186000 } }
  if (kept.length) marker = audit.annotateBoundaryWithPreservedSegment(marker, summary.uuid, kept, true)
  return { boundaryMarker: marker, summaryMessages: [summary], messagesToKeep: kept,
    attachments: [], hookResults: [] }
}

async function startSession() {
  await audit.flushSessionStorage()
  audit.resetProjectForTesting()
  audit.clearSessionMessagesCache()
  const sessionId = randomUUID()
  const path = join(tempRoot, `${sessionId}.jsonl`)
  writeFileSync(path, '')
  audit.switchSession(sessionId, tempRoot)
  audit.setSessionFileForTesting(path)
  return path
}

async function reload(path, leafUuid) {
  await audit.flushSessionStorage()
  const loaded = await audit.loadTranscriptFile(path)
  const leaf = loaded.messages.get(leafUuid)
  assert.ok(leaf, 'resume leaf is present')
  return audit.buildConversationChain(loaded.messages, leaf)
}

function assertSameMessages(actual, expected) {
  assert.deepEqual(actual.map(message => message.uuid), expected.map(message => message.uuid))
  for (let index = 0; index < actual.length; index++) {
    if (expected[index].message) assert.deepEqual(actual[index].message, expected[index].message)
  }
}

test('real transcript roundtrip retains exact messages, then survives another compaction and full compact', async () => {
  const path = await startSession()
  const kept = [user('Keep this exact instruction: café / Δ'), textResponse('Exact result\nline 2')]
  const history = [user('Old work'), textResponse('Old response'), ...kept]
  await audit.recordTranscript(history)
  const result = compactResult(kept)
  let active = audit.buildPostCompactMessages(result)
  await audit.recordTranscript(active)
  let resumed = await reload(path, kept.at(-1).uuid)
  assertSameMessages(resumed, active)
  assert.ok(audit.tokenCountWithEstimation(resumed) < 1000, 'historical usage is not current context')
  const raw = readFileSync(path, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(raw.filter(entry => entry.uuid === kept[0].uuid).length, 1, 'retained UUIDs are deduplicated')
  assert.equal(raw.find(entry => entry.uuid === kept[0].uuid).parentUuid, history[1].uuid,
    'the original on-disk parent is retained; resume must apply the splice')

  const next = [user('A new instruction'), textResponse('A new exact response')]
  active = [...active, ...next]
  await audit.recordTranscript(active)
  const selected = audit.prepareRecentContext(active, 1000, () => 1)
  assert.deepEqual(selected.messagesToKeep.map(message => message.uuid), next.map(message => message.uuid),
    'the next segment starts after the previous preserved tail')
  const second = compactResult(selected.messagesToKeep)
  active = audit.buildPostCompactMessages(second)
  await audit.recordTranscript(active)
  resumed = await reload(path, next.at(-1).uuid)
  assertSameMessages(resumed, active)
  assert.ok(!resumed.some(message => kept.some(previous => previous.uuid === message.uuid)))

  const full = compactResult()
  active = audit.buildPostCompactMessages(full)
  await audit.recordTranscript(active)
  resumed = await reload(path, full.summaryMessages[0].uuid)
  assertSameMessages(resumed, active)
})

test('parallel streamed tool siblings and their results survive the actual writer DAG and resume', async () => {
  const path = await startSession()
  const responseId = randomUUID()
  const first = assistant([{ type: 'tool_use', id: randomUUID(), name: 'Read', input: { file_path: 'one.ts' } }], responseId)
  const second = assistant([{ type: 'tool_use', id: randomUUID(), name: 'Read', input: { file_path: 'two.ts' } }], responseId)
  const firstResult = toolResponse(first, 'export const one = 1')
  const secondResult = toolResponse(second, 'export const two = 2')
  const kept = [first, second, firstResult, secondResult]
  const history = [user('Read both files'), ...kept]
  await audit.recordTranscript(history)
  const selected = audit.prepareRecentContext(history, 1000, () => 1)
  assert.deepEqual(selected.messagesToKeep.map(message => message.uuid), kept.map(message => message.uuid))
  const compacted = audit.buildPostCompactMessages(compactResult(selected.messagesToKeep))
  await audit.recordTranscript(compacted)
  const resumed = await reload(path, secondResult.uuid)
  assertSameMessages(resumed, compacted)
})

test('ordered preserved UUIDs survive SDK conversion and schema parsing; legacy boundaries stay compatible', () => {
  const kept = [user('Instruction'), textResponse('Response')]
  const { boundaryMarker } = compactResult(kept)
  const metadata = audit.toSDKCompactMetadata(boundaryMarker.compactMetadata)
  assert.deepEqual(metadata.preserved_segment.message_uuids, kept.map(message => message.uuid))
  const parsed = audit.SDKCompactBoundaryMessageSchema().parse({
    type: 'system', subtype: 'compact_boundary', compact_metadata: metadata,
    uuid: boundaryMarker.uuid, session_id: randomUUID(),
  })
  assert.deepEqual(audit.fromSDKCompactMetadata(parsed.compact_metadata), boundaryMarker.compactMetadata)

  const legacy = structuredClone(metadata)
  delete legacy.preserved_segment.message_uuids
  const legacyParsed = audit.SDKCompactBoundaryMessageSchema().parse({
    ...parsed, compact_metadata: legacy,
  })
  assert.ok(!('messageUuids' in audit.fromSDKCompactMetadata(legacyParsed.compact_metadata).preservedSegment))
})
