import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const config = mkdtempSync(join(tmpdir(), 'tau-codex-reasoning-'))
process.env.CLAUDE_CONFIG_DIR = config
process.env.NODE_ENV = 'test'
test.after(() => rmSync(config, { recursive: true, force: true }))

const r = await loadMcpRuntime({
  paths: ['src/utils/forcedProvider.ts', 'src/utils/conversationRecovery.ts',
    'src/services/compact/microCompact.ts', 'src/services/compact/timeBasedMCConfig.ts', 'src/query.ts'],
  exports: ['normalizeMessagesForAPI', 'stripSignatureBlocks', 'deserializeMessages',
    'createUserMessage', 'createAssistantMessage', 'runWithForcedProvider', 'convertHistoryToCodex',
    'microcompactMessages', 'query',
    'setTimeBasedConfig: value => { getTimeBasedMCConfig = () => value }'],
})
let sequence = 0
const MODEL = 'fixture-reasoning-model'
const time = second => `2026-10-11T12:00:${String(second).padStart(2, '0')}.000Z`
const state = (model = MODEL, id = `reasoning-${++sequence}`) => ({
  model,
  items: [{ id, encrypted_content: `encrypted-${id}`, summary: [{ type: 'summary_text', text: 'A summary.' }] }],
})
function assistant(blocks, { model = MODEL, id = `response-${++sequence}`, at = time(1) } = {}) {
  const message = r.createAssistantMessage({ content: blocks })
  message.message.id = id
  message.message.model = model
  message.timestamp = at
  return message
}
const text = (metadata = state()) => ({ type: 'text', text: 'Working.', _codex_reasoning: metadata })
const tool = (metadata = state()) => ({ type: 'tool_use', id: `call-${++sequence}`, name: 'Read', input: { file_path: 'file.txt' }, _codex_reasoning: metadata })
const thinking = (metadata = state()) => ({ type: 'thinking', thinking: 'A summary.', signature: '', _codex_reasoning: metadata })
const user = value => r.createUserMessage({ content: value })
const normalize = (messages, provider = 'openai', model = MODEL) => r.runWithForcedProvider(
  { provider }, () => r.normalizeMessagesForAPI(messages, [], { provider, model }),
)
const wire = messages => messages.map(m => ({ role: m.message.role, content: m.message.content }))
const metadata = messages => messages.filter(m => m.type === 'assistant').flatMap(m => m.message.content)
  .filter(b => b._codex_reasoning).map(b => b._codex_reasoning)
const resume = messages => r.deserializeMessages(messages.map(m => JSON.parse(JSON.stringify(m))))
const withoutReasoning = messages => JSON.parse(JSON.stringify(messages,
  (key, value) => key === '_codex_reasoning' ? undefined : value))

test('a reasoning-only answer retains opaque state on the existing placeholder live and after resume', () => {
  const kept = state()
  const messages = [user('Think it through.'), assistant([thinking(kept)]), user('Continue.')]
  const original = JSON.stringify(messages)
  const live = normalize(messages)
  const restored = normalize([...resume(messages.slice(0, -1)), messages.at(-1)])
  assert.deepEqual(metadata(live), [kept])
  assert.deepEqual(wire(restored), wire(live))
  assert.deepEqual(wire(withoutReasoning(live)), wire(normalize(withoutReasoning(messages))),
    'reasoning replay must not change the established placeholder or surrounding prompts')
  const replay = r.convertHistoryToCodex(wire(restored), new Map(), MODEL)
  assert.deepEqual(replay.filter(item => item.type === 'reasoning'), kept.items.map(item => ({
    type: 'reasoning', encrypted_content: item.encrypted_content, summary: [],
  })))
  assert.equal(JSON.stringify(messages), original)
})

test('a split reasoning-only answer keeps each item once in order when resume collapses its blocks', () => {
  const first = state()
  const second = state()
  const messages = [user('Think it through.'),
    assistant([thinking(first)], { id: 'reasoning-only' }),
    assistant([thinking(first), thinking(second)], { id: 'reasoning-only' }), user('Continue.')]
  const expected = [{ model: MODEL, items: [...first.items, ...second.items] }]
  assert.deepEqual(metadata(normalize(messages)), expected)
  assert.deepEqual(metadata(normalize(resume(messages))), expected)
})

test('resume retains a terminal reasoning-only response until the next user message arrives', () => {
  const first = state()
  const second = state()
  const messages = [user('Think it through.'),
    assistant([thinking(first)], { id: 'terminal-reasoning' }),
    assistant([thinking(second)], { id: 'terminal-reasoning' })]
  const original = JSON.stringify(messages)
  const restored = resume(messages)
  assert.deepEqual(metadata(restored), [first, second])
  const continued = normalize([...restored, user('Continue.')])
  assert.deepEqual(metadata(continued), [{ model: MODEL, items: [...first.items, ...second.items] }])
  const replay = r.convertHistoryToCodex(wire(continued), new Map(), MODEL)
  assert.deepEqual(replay.filter(item => item.type === 'reasoning'), [first, second].flatMap(state =>
    state.items.map(item => ({ type: 'reasoning', encrypted_content: item.encrypted_content, summary: [] }))))
  assert.ok(!JSON.stringify(replay).includes('A summary.'), 'visible summaries are never replayed as text')
  assert.deepEqual(wire(withoutReasoning(normalize(messages))), wire(normalize(withoutReasoning(messages))),
    'normalizing a final assistant keeps the established request shape')
  assert.equal(JSON.stringify(messages), original)
})

test('a whitespace-only answer retains its reasoning without changing the placeholder text', () => {
  const kept = state()
  const messages = [user('Start.'), assistant([{ ...text(kept), text: ' \n\t' }]), user('Continue.')]
  const live = normalize(messages)
  assert.deepEqual(metadata(live), [kept])
  // Preserve the established sentinel for the interrupted final user prompt;
  // the preceding completed history must otherwise remain byte-identical.
  assert.deepEqual(wire(normalize(resume(messages))).slice(0, live.length), wire(live))
  assert.deepEqual(wire(withoutReasoning(live)), wire(normalize(withoutReasoning(messages))))
})

test('reasoning survives split streamed blocks, transcript serialization, and resume', () => {
  const shared = state()
  const call = tool(shared)
  const messages = [user('Inspect.'),
    assistant([thinking(shared)], { id: 'same-response' }),
    assistant([text(shared), call], { id: 'same-response' }),
    user([{ type: 'tool_result', tool_use_id: call.id, content: 'File contents.' }]),
    assistant([{ type: 'text', text: 'Done.' }]), user('Continue.')]
  const original = JSON.stringify(messages)
  const live = normalize(messages)
  assert.equal(live.filter(m => m.type === 'assistant').length, 2, 'split siblings merge')
  assert.deepEqual(metadata(live), [shared, shared, shared])
  assert.deepEqual(wire(normalize([...resume(messages.slice(0, -1)), messages.at(-1)])), wire(live))
  assert.equal(JSON.stringify(messages), original, 'normalization must not mutate the transcript')
})

test('a switch away and back drops earlier state but retains the new response', () => {
  const old = state()
  const other = state('another-model')
  const fresh = state()
  const messages = [user('Start.'), assistant([text(old)]), user('Switch.'),
    assistant([text(other)], { model: 'another-model' }), user('Switch back.'),
    assistant([text(fresh)]), user('Continue.')]
  assert.deepEqual(metadata(normalize(messages)), [fresh])
  assert.deepEqual(metadata(normalize(resume(messages))), [fresh])
  assert.equal(metadata(messages).length, 3, 'only the outbound copy loses old metadata')
})

test('context-window tags use the wire model identity for reasoning live and after resume', () => {
  const kept = state()
  const messages = [user('Start.'), assistant([text(kept)]), user('Continue.')]
  for (const suffix of ['[1m]', '[2m]']) {
    for (const history of [messages, resume(messages)]) {
      const continued = normalize(history, 'openai', MODEL + suffix)
      assert.deepEqual(metadata(continued), [kept])
      assert.deepEqual(r.convertHistoryToCodex(wire(continued), new Map(), MODEL)
        .filter(item => item.type === 'reasoning'), kept.items.map(item => ({
          type: 'reasoning', encrypted_content: item.encrypted_content, summary: [],
        })))
      assert.deepEqual(metadata(normalize(history, 'openai', 'another-model' + suffix)), [])
    }
  }
})

test('synthetic and virtual messages do not invalidate live model state', () => {
  const kept = state()
  const synthetic = r.createAssistantMessage({ content: 'Acknowledged.' })
  const virtual = assistant([text(state('another-model'))], { model: 'another-model' })
  virtual.isVirtual = true
  const messages = [user('Start.'), assistant([text(kept)]), synthetic, virtual, user('Continue.')]
  assert.deepEqual(metadata(normalize(messages)), [kept])
})

test('resume preserves Codex state before routing and default normalization honors the active provider', () => {
  const kept = state()
  const messages = [user('Start.'), assistant([thinking(kept)])]
  const restored = r.runWithForcedProvider({ provider: 'firstParty' }, () => resume(messages))
  assert.deepEqual(metadata(restored), [kept], 'loading a transcript must not depend on the active provider')
  const continued = [...restored, user('Continue.')]
  const normalizeDefault = (value, provider) => r.runWithForcedProvider({ provider },
    () => r.normalizeMessagesForAPI(value))
  assert.deepEqual(metadata(normalizeDefault(continued, 'openai')), [kept])
  for (const provider of ['firstParty', 'gemini', 'openrouter', 'mistral', 'bedrock']) {
    assert.deepEqual(wire(normalizeDefault(continued, provider)),
      wire(normalizeDefault(withoutReasoning(continued), provider)))
    assert.equal(metadata(normalizeDefault(continued, provider)).length, 0)
  }
})

for (const provider of ['firstParty', 'gemini', 'openrouter', 'mistral', 'bedrock']) {
  test(`${provider} receives no Codex metadata on thinking, text, or tool blocks`, () => {
    const messages = [user('Start.'), assistant([thinking(), text(), tool()]), user('Continue.')]
    const plain = JSON.parse(JSON.stringify(messages, (key, value) => key === '_codex_reasoning' ? undefined : value))
    assert.deepEqual(wire(normalize(messages, provider)), wire(normalize(plain, provider)))
    assert.equal(metadata(normalize(messages, provider)).length, 0)
    assert.equal(metadata(messages).length, 3)
  })
  test(`${provider} receives the same reasoning-only placeholder after resume`, () => {
    const messages = [user('Start.'), assistant([thinking()]), user('Continue.')]
    const plain = withoutReasoning(messages)
    assert.deepEqual(wire(normalize(messages, provider)), wire(normalize(plain, provider)))
    assert.deepEqual(wire(normalize(resume(messages), provider)), wire(normalize(resume(plain), provider)))
  })
}

function boundary({ at = time(20), segment, subtype = 'compact_boundary' } = {}) {
  return { type: 'system', subtype, uuid: `boundary-${++sequence}`, timestamp: at,
    content: 'Compacted.', isMeta: false, level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 100, ...(segment && { preservedSegment: segment }) } }
}

test('compaction drops pre-boundary and preserved-tail state live and after resume', () => {
  const before = assistant([text()], { at: time(1) })
  const kept = assistant([tool()], { at: time(5) })
  const freshState = state()
  const fresh = assistant([text(freshState)], { at: time(25) })
  const marker = boundary({ segment: { headUuid: kept.uuid, tailUuid: kept.uuid, anchorUuid: 'summary' } })
  const messages = [before, marker, user('Summary.'), kept, user('Continue.'), fresh, user('Next.')]
  assert.deepEqual(metadata(normalize(messages)), [freshState])
  assert.deepEqual(metadata(normalize(resume(messages))), [freshState])
})

test('preserved segment UUIDs remove old state even when timestamps are unavailable', () => {
  const old = assistant([text()], { at: 'unknown' })
  const marker = boundary({ segment: { headUuid: 'missing-head', tailUuid: 'missing-tail', anchorUuid: 'summary', messageUuids: [old.uuid] } })
  const freshState = state()
  const messages = [marker, user('Summary.'), old, user('Continue.'), assistant([text(freshState)], { at: time(25) }), user('Next.')]
  assert.deepEqual(metadata(normalize(messages)), [freshState])
})

test('microcompaction invalidates state bound to the old history', () => {
  const freshState = state()
  const messages = [user('Start.'), assistant([text()]), boundary({ subtype: 'microcompact_boundary' }),
    user('Continue.'), assistant([text(freshState)], { at: time(25) }), user('Next.')]
  assert.deepEqual(metadata(normalize(messages)), [freshState])
})

test('time-based microcompaction persists OpenAI invalidation before the next request', async () => {
  const calls = [tool(), tool()]
  const messages = [user('Inspect.'), ...calls.flatMap(call => [
    assistant([call]), user([{ type: 'tool_result', tool_use_id: call.id, content: 'old file contents '.repeat(100) }]),
  ]), assistant([{ type: 'text', text: 'Done.' }])]
  const original = JSON.stringify(messages)
  const context = fixtureContext([])
  context.options.mainLoopModel = MODEL
  r.setTimeBasedConfig({ enabled: true, gapThresholdMinutes: 0, keepRecent: 1 })
  try {
    const compacted = await r.runWithForcedProvider({ provider: 'openai' },
      () => r.microcompactMessages(messages, context, 'repl_main_thread'))
    assert.equal(compacted.boundaryMessage?.subtype, 'microcompact_boundary')
    assert.deepEqual(compacted.boundaryMessage.microcompactMetadata.compactedToolIds, [calls[0].id])
    assert.ok(compacted.boundaryMessage.microcompactMetadata.tokensSaved > 0)
    assert.equal(compacted.messages.at(-1), compacted.boundaryMessage)
    assert.deepEqual(metadata(normalize(compacted.messages)), [])
    // Resume reads the original assistant records, plus the yielded boundary.
    assert.deepEqual(metadata(normalize(resume([...messages, compacted.boundaryMessage]))), [])
    const fresh = state()
    const next = assistant([text(fresh)], { at: new Date(Date.now() + 1000).toISOString() })
    assert.deepEqual(metadata(normalize([...compacted.messages, user('Continue.'), next, user('Next.')])), [fresh])
    assert.equal(JSON.stringify(messages), original, 'compaction does not mutate the transcript')

    await r.runWithForcedProvider({ provider: 'openai' }, async () => {
      const iterator = r.query({ messages, systemPrompt: [], userContext: {}, systemContext: {},
        canUseTool: async () => ({ behavior: 'allow' }), toolUseContext: context, querySource: 'repl_main_thread',
        deps: { uuid: () => 'fixture-query', microcompact: r.microcompactMessages,
          autocompact: async () => { throw new Error('boundary was not yielded before continuing') },
          callModel: async function* () { throw new Error('unexpected model request') } } })
      try {
        assert.equal((await iterator.next()).value.type, 'stream_request_start')
        const event = (await iterator.next()).value
        assert.equal(event.subtype, 'microcompact_boundary', 'query must yield the boundary for transcript persistence')
      } finally { await iterator.return() }
    })

    for (const provider of ['firstParty', 'gemini', 'openrouter']) {
      const legacy = await r.runWithForcedProvider({ provider },
        () => r.microcompactMessages(messages, context, 'repl_main_thread'))
      assert.equal(legacy.boundaryMessage, undefined)
      assert.deepEqual(legacy.messages, compacted.messages.slice(0, -1), 'other providers keep their original message shape')
    }
    r.setTimeBasedConfig({ enabled: false, gapThresholdMinutes: 0, keepRecent: 1 })
    const unchanged = await r.runWithForcedProvider({ provider: 'openai' },
      () => r.microcompactMessages(messages, context, 'repl_main_thread'))
    assert.equal(unchanged.messages, messages)
    assert.equal(unchanged.boundaryMessage, undefined)
  } finally {
    r.setTimeBasedConfig({ enabled: false, gapThresholdMinutes: 60, keepRecent: 5 })
  }
})

test('reasoning-only placeholders still obey model and compaction invalidation after resume', () => {
  const old = state()
  const other = state('another-model')
  const fresh = state()
  const messages = [user('Start.'), assistant([thinking(old)]), user('Switch.'),
    assistant([thinking(other)], { model: 'another-model' }), boundary(), user('Summary.'),
    assistant([thinking(fresh)], { at: time(25) }), user('Continue.')]
  assert.deepEqual(metadata(normalize(messages)), [fresh])
  assert.deepEqual(metadata(normalize(resume(messages))), [fresh])
  assert.equal(metadata(normalize(resume(messages), 'openai', 'different-model')).length, 0)
})

test('credential cleanup removes reasoning from surviving text and tools without mutation', () => {
  const messages = [user('Start.'), assistant([thinking(), text(), tool()])]
  const original = JSON.stringify(messages)
  const cleaned = r.stripSignatureBlocks(messages)
  assert.deepEqual(cleaned[1].message.content.map(b => b.type), ['text', 'tool_use'])
  assert.equal(metadata(cleaned).length, 0)
  assert.equal(JSON.stringify(messages), original)
  assert.equal(r.stripSignatureBlocks(cleaned), cleaned, 'cleanup is identity-preserving once clean')
})

test('append-only continuation leaves normalized old request bytes unchanged', () => {
  const messages = [user('Start.'), assistant([text()]), user('Next.')]
  const before = wire(normalize(messages))
  const after = wire(normalize([...messages, assistant([text()]), user('Continue.')]))
  assert.deepEqual(after.slice(0, before.length), before)
})
