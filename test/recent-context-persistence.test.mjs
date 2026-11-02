// Run after `node build.mjs`: node --test test/recent-context-persistence.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
const distPath = resolve(process.env.TAU_MCP_TEST_BUNDLE ?? join(repository, 'dist/tau.mjs'))
const auditPath = join(dirname(distPath), `.recent-context-audit-${randomUUID()}.mjs`)
let source = readFileSync(distPath, 'utf8')
const invocation = /\nvoid main\d*\(\);\r?\n/g
assert.equal(source.match(invocation)?.length, 1, 'exactly one CLI entry point is removed')
source = source.replace(invocation, '\n')
source += `
export function __recentContextPersistenceAudit() {
  init_sessionStorage(); init_recentContext(); init_tokens(); init_compact();
  init_mappers(); init_coreSchemas(); init_conversationRecovery(); init_print();
  return {
    recordTranscript, flushSessionStorage, loadTranscriptFile,
    buildConversationChain, resetProjectForTesting, setSessionFileForTesting,
    clearSessionMessagesCache, switchSession, prepareRecentContext,
    annotateBoundaryWithPreservedSegment, buildPostCompactMessages,
    tokenCountWithEstimation, toSDKCompactMetadata, fromSDKCompactMetadata,
    SDKCompactBoundaryMessageSchema, deserializeMessages, removeInterruptedMessage, getLastSessionLog,
    NO_RESPONSE_REQUESTED, walkToConversationEnd,
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

function replacementBoundary(rows) {
  const marker = { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(),
    timestamp: new Date().toISOString(), content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 186000 } }
  return audit.annotateBoundaryWithPreservedSegment(marker, marker.uuid, rows, true)
}

// How a mod's replacement reaches the writer. /compact saves it with the command's
// messages in one array. The interactive API path has two writers race over the
// same array, then the next message takes its parent from what they returned.
const replacementWrites = {
  'one write': async (active, next) => { await audit.recordTranscript([...active, next]) },
  'racing writers': async (active, next) => {
    const [, parent] = await Promise.all([audit.recordTranscript(active), audit.recordTranscript(active)])
    await audit.recordTranscript([next], undefined, parent, [...active, next])
  },
  'a later full array': async (active, next) => {
    await audit.recordTranscript(active)
    await audit.recordTranscript([...active, next])
  },
}
const replacementShapes = {
  'a new row ahead of retained rows': (built, kept) => [built, ...kept],
  'a new row between retained rows': (built, kept) => [kept[0], built, kept[1]],
  'a new row after retained rows': (built, kept) => [...kept, built],
  'retained rows alone': (_built, kept) => kept,
}
for (const [shape, arrange] of Object.entries(replacementShapes)) {
  for (const [write, save] of Object.entries(replacementWrites)) {
    test(`a replacement with ${shape} resumes whole after ${write}`, async () => {
      const path = await startSession()
      const kept = [user('Keep this exact instruction'), textResponse('Kept answer')]
      await audit.recordTranscript([user('Old work'), textResponse('Old response'), ...kept])
      const rows = arrange(user('Replacement summary'), kept)
      const active = [replacementBoundary(rows), ...rows]
      const next = user('The next prompt')
      await save(active, next)
      assertSameMessages(await reload(path, next.uuid), [...active, next])
    })
  }
}

test('a rewind inside a retained segment stays a branch: the abandoned rows do not return on resume', async () => {
  const path = await startSession()
  const kept = [user('Keep A'), textResponse('Keep B'), user('Abandoned by the rewind')]
  await audit.recordTranscript([user('Old work'), textResponse('Old response'), ...kept])
  const rows = [user('Replacement summary'), ...kept]
  const active = [replacementBoundary(rows), ...rows]
  await audit.recordTranscript(active)
  const survivors = active.slice(0, 3)
  const parent = await audit.recordTranscript(survivors)
  assert.equal(parent, kept[0].uuid)
  const next = user('A different direction')
  await audit.recordTranscript([next], undefined, parent, [...survivors, next])
  assertSameMessages(await reload(path, next.uuid), [...survivors, next])
})

test('native retained compaction keeps its on-disk shape: later messages chain from the summary', async () => {
  const path = await startSession()
  const kept = [user('Instruction'), textResponse('Response')]
  await audit.recordTranscript([user('Old work'), textResponse('Old response'), ...kept])
  const result = compactResult(kept)
  const active = audit.buildPostCompactMessages(result)
  const next = user('The next prompt')
  const returned = await audit.recordTranscript([...active, next])
  assert.equal(returned, next.uuid)
  await audit.flushSessionStorage()
  const raw = readFileSync(path, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
  assert.equal(raw.find(entry => entry.uuid === next.uuid).parentUuid, result.summaryMessages[0].uuid)
  assertSameMessages(await reload(path, next.uuid), [...active, next])
})

function contextAttachment(content) {
  return {type:'attachment',uuid:randomUUID(),timestamp:new Date().toISOString(),
    attachment:{type:'hook_additional_context',content:[content],hookName:'SessionStart',toolUseID:'SessionStart',hookEvent:'SessionStart'}}
}

test('resume includes trailing compaction attachments and the next turn chains after them once', async () => {
  const path = await startSession()
  const result = compactResult()
  const footer = [user('caveat'),user('/compact'),user('compacted')]
  const attachments = [contextAttachment('hook context'),contextAttachment('restored file context')]
  const active = [...audit.buildPostCompactMessages(result),...footer,...attachments]
  await audit.recordTranscript(active)
  const leaf = footer.at(-1)
  const resumed = await reload(path,leaf.uuid)
  assertSameMessages(resumed,active)
  assertSameMessages(await reload(path,leaf.uuid),active)
  const next = user('continue after restored context')
  await audit.recordTranscript([...resumed,next])
  await audit.flushSessionStorage()
  const raw=readFileSync(path,'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(raw.find(row=>row.uuid===next.uuid).parentUuid,attachments.at(-1).uuid)
  assertSameMessages(await reload(path,next.uuid),[...active,next])
})

test('trailing context survives when the selected leaf is an older preserved row', async () => {
  const path=await startSession(),kept=[user('preserved question'),textResponse('preserved reply')]
  await audit.recordTranscript([user('old work'),...kept])
  const result=compactResult(kept),context=contextAttachment('context after the preserved tail')
  const active=[...audit.buildPostCompactMessages(result),context]
  await audit.recordTranscript(active)
  assertSameMessages(await reload(path,kept.at(-1).uuid),active)
})

test('resume excludes attachments on a rewind or superseded attachment branch and leaves sidechains alone', async () => {
  const path = await startSession()
  const early=user('rewind target'),leaf=textResponse('latest response')
  const abandoned=contextAttachment('abandoned attachment'),kept=contextAttachment('current attachment')
  await audit.recordTranscript([early,leaf,abandoned])
  await audit.recordTranscript([kept],undefined,leaf.uuid)
  assertSameMessages(await reload(path,leaf.uuid),[early,leaf,kept])
  assertSameMessages(await reload(path,early.uuid),[early])
  const next=user('real continuation on another branch')
  await audit.recordTranscript([next],undefined,leaf.uuid)
  assertSameMessages(await reload(path,next.uuid),[early,leaf,next])
  assertSameMessages(await reload(path,leaf.uuid),[early,leaf])
  const side=textResponse('child response'),sideAttachment=contextAttachment('child context')
  await audit.flushSessionStorage()
  writeFileSync(path,readFileSync(path,'utf8')+[
    {...side,parentUuid:null,isSidechain:true},
    {...sideAttachment,parentUuid:side.uuid,isSidechain:true},
  ].map(JSON.stringify).join('\n')+'\n')
  assertSameMessages(await reload(path,side.uuid),[side])
})

test('the resume sentinel keeps trailing attachments on the chain through every later resume', async () => {
  const path = await startSession()
  const footer = [user('caveat'), user('/compact'), user('compacted')]
  const attachments = [contextAttachment('hook context'), contextAttachment('restored file context')]
  await audit.recordTranscript([...audit.buildPostCompactMessages(compactResult()), ...footer, ...attachments])
  const first = audit.deserializeMessages(await reload(path, footer.at(-1).uuid))
  assert.equal(first.at(-1).message.content[0].text, audit.NO_RESPONSE_REQUESTED)
  assert.deepEqual(first.slice(-3, -1).map(row => row.uuid), attachments.map(row => row.uuid))

  const second = user('second question'), secondReply = textResponse('second answer')
  await audit.recordTranscript([...first, second])
  await audit.recordTranscript([...first, second, secondReply])
  const resumed = audit.deserializeMessages(await reload(path, secondReply.uuid))
  assertSameMessages(resumed, [...first, second, secondReply])

  const third = user('third question'), thirdReply = textResponse('third answer')
  await audit.recordTranscript([...resumed, third])
  await audit.recordTranscript([...resumed, third, thirdReply])
  assertSameMessages(audit.deserializeMessages(await reload(path, thirdReply.uuid)), [...resumed, third, thirdReply])
})

test('without trailing attachments the resume sentinel stays right after the user row', () => {
  const prompt = user('last question')
  const note = { type: 'system', subtype: 'informational', uuid: randomUUID(), timestamp: new Date().toISOString(), content: 'note' }
  const rows = audit.deserializeMessages([textResponse('earlier answer'), prompt, note])
  assert.equal(rows[1].uuid, prompt.uuid)
  assert.equal(rows[2].message.content[0].text, audit.NO_RESPONSE_REQUESTED)
  assert.equal(rows[3].uuid, note.uuid)
})

test('submitting an interrupted prompt again removes it, its sentinel and the attachments between them', () => {
  const earlier = textResponse('earlier answer'), prompt = user('interrupted prompt')
  const withContext = audit.deserializeMessages([earlier, prompt, contextAttachment('prompt context'), contextAttachment('more context')])
  assert.equal(withContext.length, 5)
  audit.removeInterruptedMessage(withContext, prompt)
  assert.deepEqual(withContext.map(row => row.uuid), [earlier.uuid])

  const note = { type: 'system', subtype: 'informational', uuid: randomUUID(), timestamp: new Date().toISOString(), content: 'note' }
  const plain = audit.deserializeMessages([earlier, prompt, note])
  audit.removeInterruptedMessage(plain, prompt)
  assert.deepEqual(plain.map(row => row.uuid), [earlier.uuid, note.uuid])
})

test('resume reaches the kept rows even when nothing was written after the compaction', async () => {
  const sessionOf = path => basename(path, '.jsonl')
  // A replacement: its boundary is the newest row and owns the new row and the kept ones.
  let path = await startSession()
  const kept = [user('kept question'), textResponse('kept answer')]
  await audit.recordTranscript([user('old work'), ...kept])
  const replacement = user('replacement summary')
  let marker = { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), timestamp: new Date(Date.now() + 5).toISOString(),
    content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 100 } }
  marker = audit.annotateBoundaryWithPreservedSegment(marker, marker.uuid, [replacement, ...kept], true)
  await audit.recordTranscript([marker, replacement, ...kept])
  await audit.flushSessionStorage()
  audit.clearSessionMessagesCache()
  let log = await audit.getLastSessionLog(sessionOf(path))
  assert.deepEqual(log.messages.map(row => row.uuid), [marker.uuid, replacement.uuid, ...kept.map(row => row.uuid)])

  // Native retention: the summary is the newest row and the kept rows follow it.
  path = await startSession()
  const retained = [user('retained question'), textResponse('retained answer')]
  await audit.recordTranscript([user('older work'), ...retained])
  const result = compactResult(retained)
  await audit.recordTranscript(audit.buildPostCompactMessages(result))
  await audit.flushSessionStorage()
  audit.clearSessionMessagesCache()
  log = await audit.getLastSessionLog(sessionOf(path))
  assert.deepEqual(log.messages.map(row => row.uuid), [result.boundaryMarker.uuid, result.summaryMessages[0].uuid, ...retained.map(row => row.uuid)])
})

test('resume still ends at the newest branch when no segment was relinked', async () => {
  const path = await startSession()
  const first = user('first'), abandoned = textResponse('abandoned answer')
  await audit.recordTranscript([first, abandoned])
  await new Promise(done => setTimeout(done, 5))
  const retry = textResponse('newer answer')
  await audit.recordTranscript([retry], undefined, first.uuid)
  await audit.flushSessionStorage()
  audit.clearSessionMessagesCache()
  const log = await audit.getLastSessionLog(basename(path, '.jsonl'))
  assert.deepEqual(log.messages.map(row => row.uuid), [first.uuid, retry.uuid])
})

test('resume traverses retained attachments and system rows through later resumes, including tied timestamps', async () => {
  for (const tiedTimestamps of [false, true]) {
    const path = await startSession()
    const kept = [
      user('retained question'), contextAttachment('retained hook context'),
      { type: 'system', subtype: 'informational', uuid: randomUUID(), content: 'retained note' },
      textResponse('retained answer'),
    ].map(row => ({ ...row, timestamp: '2026-01-01T10:00:00.000Z' }))
    await audit.recordTranscript([user('old work'), ...kept])
    const result = compactResult(kept)
    const compactTime = tiedTimestamps ? kept[0].timestamp : '2026-01-01T10:01:00.000Z'
    result.boundaryMarker.timestamp = compactTime
    result.summaryMessages[0].timestamp = compactTime
    const active = audit.buildPostCompactMessages(result)
    await audit.recordTranscript(active)
    await audit.flushSessionStorage()
    audit.clearSessionMessagesCache()

    for (let resume = 0; resume < 2; resume++) {
      const log = await audit.getLastSessionLog(basename(path, '.jsonl'))
      assert.ok(log, 'the compacted session can be resumed')
      assertSameMessages(log.messages, active)
    }

    const next = [user('next question'), textResponse('next answer')]
    const resumed = await audit.getLastSessionLog(basename(path, '.jsonl'))
    await audit.recordTranscript([...audit.deserializeMessages(resumed.messages), ...next])
    await audit.flushSessionStorage()
    audit.clearSessionMessagesCache()
    const later = await audit.getLastSessionLog(basename(path, '.jsonl'))
    assertSameMessages(later.messages, [...active, ...next])
  }
})

test('resume traversal bridges auxiliary rows without choosing trailing metadata, sidechains or cycles', () => {
  const row = (uuid, type, parentUuid, second = 0) => ({
    uuid, type, parentUuid, timestamp: `2026-01-01T10:00:0${second}.000Z`,
  })
  const root = row('root', 'user', null)
  const rows = [root, row('old-answer', 'assistant', root.uuid, 1),
    row('context', 'attachment', root.uuid, 2), row('note', 'system', 'context', 3),
    row('current-answer', 'assistant', 'note', 4),
    row('trailing-note', 'system', root.uuid, 5),
    { ...row('side-answer', 'assistant', root.uuid, 6), isSidechain: true }]
  let messages = new Map(rows.map(message => [message.uuid, message]))
  assert.equal(audit.walkToConversationEnd(messages, root).uuid, 'current-answer')
  assert.equal(audit.walkToConversationEnd(messages, rows[5]).uuid, 'trailing-note',
    'an already-selected terminal metadata row remains the selected end')

  const tied = row('tied-answer', 'assistant', root.uuid, 4)
  messages.set(tied.uuid, tied)
  assert.equal(audit.walkToConversationEnd(messages, root).uuid, tied.uuid,
    'later physical conversation rows still win timestamp ties')

  const cycle = [row('cycle-a', 'attachment', 'cycle-b'), row('cycle-b', 'system', 'cycle-a'),
    row('cycle-answer', 'assistant', 'cycle-b')]
  messages = new Map(cycle.map(message => [message.uuid, message]))
  assert.equal(audit.walkToConversationEnd(messages, cycle[0]).uuid, 'cycle-answer')
})

test('an immediate resume includes the retained segment when it ends in an attachment', async () => {
  const path = await startSession()
  const answer = textResponse('retained answer')
  const kept = [user('retained question'), answer, contextAttachment('last retained context')]
  await audit.recordTranscript([user('previous question'), ...kept])
  const result = compactResult(kept)
  const active = audit.buildPostCompactMessages(result)
  await audit.recordTranscript(active)
  await audit.flushSessionStorage()
  audit.clearSessionMessagesCache()
  const log = await audit.getLastSessionLog(basename(path, '.jsonl'))
  assertSameMessages(log.messages, active)
  assertSameMessages(await reload(path, answer.uuid), active)
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
