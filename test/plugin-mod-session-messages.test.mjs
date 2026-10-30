import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transformSync } from 'esbuild'
import cloneDeep from 'lodash-es/cloneDeep.js'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// This pure module has only type imports. Test its production source without
// rebuilding the shared CLI bundle while other integration tests are running.
const code = transformSync(readFileSync(new URL('../src/utils/plugins/mods/sessionMessages.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'esm', target: 'node20',
}).code
const { projectModSessionMessages: project, countModSessionTurns: turns } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra })
const assistant = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, ...extra })
const text = value => ({ type: 'text', text: value })
const call = (id, name = 'Read', input = {}) => ({ type: 'tool_use', id, name, input })
const result = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra })
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

test('rows pair each tool with its own result and return independent copies', () => {
  const messages = freeze([
    user('inspect'),
    assistant([text('checking'), call('a', 'Read', { path: 'data.json' }), call('b', 'Bash'), call('pending')]),
    user([result('b', [text('denied'), text('by policy')], { is_error: true })], { toolUseResult: 'denied\nby policy' }),
    user([result('a', [text('contents'), { type: 'image', source: { data: 'pixels' } }])], { toolUseResult: { nested: { answer: 42 } } }),
  ])
  const rows = project(messages)
  assert.deepEqual(rows[1].toolUses, [
    { tool_use_id: 'a', tool: 'Read', input: { path: 'data.json' }, text: 'contents', result: { nested: { answer: 42 } } },
    { tool_use_id: 'b', tool: 'Bash', input: {}, text: 'denied\nby policy', isError: true, result: 'denied\nby policy' },
    { tool_use_id: 'pending', tool: 'Read', input: {} },
  ])
  assert.deepEqual(rows[2].toolResults, [{ tool_use_id: 'b', text: 'denied\nby policy', isError: true, result: 'denied\nby policy' }])
  rows[1].toolUses[0].input.path = 'changed'
  rows[1].toolUses[0].result.nested.answer = 0
  assert.equal(messages[1].message.content[1].input.path, 'data.json')
  assert.equal(messages[3].toolUseResult.nested.answer, 42)
})

test('a stored error record is not replaced by display text and missing records remain absent', () => {
  const rows = project([
    user('run checks'), assistant([call('stored'), call('missing')]),
    user([result('stored', 'short visible error', { is_error: true })], { toolUseResult: 'complete stored error' }),
    user([result('missing', 'agent transcript error', { is_error: true })]),
  ])
  assert.equal(rows[1].toolUses[0].result, 'complete stored error')
  assert.equal(rows[1].toolUses[0].text, 'short visible error')
  assert.equal(rows[1].toolUses[1].isError, true)
  assert.equal(Object.hasOwn(rows[1].toolUses[1], 'result'), false)
  assert.equal(Object.hasOwn(rows[3].toolResults[0], 'result'), false)
})

test('agent metadata comes only from a real answered Agent or Task call', () => {
  const rows = project([
    user('audit'), assistant([call('agent', 'Agent'), call('background', 'Task'), call('other', 'Read')]),
    user([result('agent', 'done')], { toolUseResult: { agentId: 'child', totalDurationMs: 25, status: 'completed' } }),
    user([result('background', 'started')], { toolUseResult: { agentId: 'background-child', status: 'async_launched' } }),
    user([result('other', 'contents')], { toolUseResult: { agentId: 'unrelated', totalDurationMs: 50, status: 'completed' } }),
  ])
  assert.equal(rows[1].toolUses[0].agentId, 'child')
  assert.equal(rows[1].toolUses[0].durationMs, 25)
  assert.equal(rows[1].toolUses[1].agentId, 'background-child')
  assert.equal(rows[1].toolUses[1].durationMs, undefined)
  assert.equal(rows[1].toolUses[2].agentId, undefined)
})

test('compaction replaces earlier history while preserving summary, context and microcompact history', () => {
  const messages = [
    user('old prompt'), assistant([text('old answer')]),
    { type: 'system', subtype: 'compact_boundary' },
    user('retained summary', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('hook context', { isMeta: true }),
    { type: 'system', subtype: 'microcompact_boundary' },
    { type: 'progress', content: 'progress' }, { type: 'system', content: 'notice' },
    user('virtual user', { isVirtual: true }), assistant([text('virtual assistant')], { isVirtual: true }),
    assistant([text('API failure')], { isApiErrorMessage: true }), user('new prompt'),
  ]
  assert.deepEqual(project(messages).map(row => row.text), ['retained summary', 'hook context', 'new prompt'])
  assert.equal(turns(messages), 2, 'compaction must not erase earlier user turns in retained scrollback')
})

test('API view keeps media, thinking, unknown block fields and tool results without cache markers', () => {
  const messages = freeze([
    assistant([text('orphan prefill')]),
    user([text('question'), { type: 'document', source: { type: 'text', data: 'page' } }, { type: 'image', source: { data: 'pixels' } }]),
    assistant([{ type: 'thinking', thinking: 'reasoning', signature: 'signed', cache_control: { type: 'ephemeral' } }, call('a', 'Read', { path: 'x' })]),
    user([result('a', [{ type: 'text', text: 'answer', annotations: { custom: true } }])]),
  ])
  const api = project(messages, { as: 'api' })
  assert.deepEqual(api.map(row => row.role), ['user', 'assistant', 'user'])
  assert.deepEqual(api[1].content[0], { type: 'thinking', thinking: 'reasoning', signature: 'signed' })
  assert.equal(api[0].content[1].source.data, 'page')
  assert.deepEqual(api[2].content[0].content[0].annotations, { custom: true })
  api[0].content[2].source.data = 'changed'
  assert.equal(messages[1].message.content[2].source.data, 'pixels')
  assert.equal(messages[2].message.content[0].cache_control.type, 'ephemeral')
  assert.deepEqual(project([assistant([text('prefill')])], { as: 'api' }), [])
})

test('projection windows stay bounded and API windows begin with a user row', () => {
  const messages = Array.from({ length: 4100 }, (_, i) => i % 2 ? assistant([text(String(i))]) : user(String(i)))
  assert.equal(project(messages).length, 4096)
  assert.equal(project(messages)[0].text, '4')
  const api = project([...messages, user('last')], { as: 'api' })
  assert.equal(api.length, 4095)
  assert.equal(api[0].role, 'user')
  assert.equal(api[0].content[0].text, '6')
})

test('turn count ignores tool replies, plugin submissions and generated context', () => {
  assert.equal(turns([
    user('keyboard'), user([text('SDK')], { origin: { kind: 'human' } }),
    user([{ type: 'image', source: { data: 'pixels' } }]),
    user([result('one', 'answer')]), user('context', { isMeta: true }),
    user([result('two', 'answer'), text('generated tool context')]),
    user('summary', { isCompactSummary: true }), user('hidden', { isVisibleInTranscriptOnly: true }),
    user('virtual', { isVirtual: true }), user('plugin', { origin: { kind: 'plugin', asUser: true } }),
    assistant([text('answer')]),
  ]), 3)
})

test('native API normalization includes hook context and keeps a detached, stable request snapshot', async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' })
  const r = await loadMcpRuntime({ exports: ['normalizeMessagesForAPI', 'getMessagesAfterCompactBoundary', 'createUserMessage', 'createAssistantMessage'] })
  const messages = freeze([
    r.createUserMessage({ content: 'discarded before compact' }),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', timestamp: '2026-01-01T00:00:00Z' },
    r.createUserMessage({ content: 'retained summary', isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    r.createUserMessage({ content: 'inspect the receipt' }),
    r.createAssistantMessage({ content: [call('receipt', 'Read', { file_path: 'receipt.txt' })] }),
    r.createUserMessage({ content: [result('receipt', [text('receipt contents'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } }])], toolUseResult: { type: 'text', file: { content: 'receipt contents' } } }),
    { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['Only use the verified receipt.'], hookName: 'receipt-policy', hookEvent: 'PostToolUse', toolUseID: 'receipt' }, uuid: 'context', timestamp: '2026-01-01T00:00:01Z' },
    { type: 'system', subtype: 'local_command', content: 'local command output', uuid: 'command', timestamp: '2026-01-01T00:00:02Z' },
  ])
  const original = JSON.stringify(messages)
  const tools = freeze([{ name: 'Read', aliases: [] }])
  const readSnapshot = () => project(r.normalizeMessagesForAPI(r.getMessagesAfterCompactBoundary(cloneDeep(messages)), tools, { model: 'claude-sonnet-4-6' }), { as: 'api' })
  const first = readSnapshot(), second = readSnapshot()
  assert.deepEqual(second, first, 'reading messages does not change the next snapshot')
  assert.equal(JSON.stringify(messages), original, 'stored transcript and tool records stay byte-for-byte unchanged')
  assert.doesNotMatch(JSON.stringify(first), /discarded before compact/)
  assert.match(JSON.stringify(first), /Only use the verified receipt/)
  assert.match(JSON.stringify(first), /local command output/)
  const uses = first.flatMap(row => row.content).filter(block => block.type === 'tool_use')
  const results = first.flatMap(row => row.content).filter(block => block.type === 'tool_result')
  assert.equal(uses.length, 1)
  assert.equal(results.length, 1)
  assert.equal(uses[0].id, results[0].tool_use_id)
  assert.deepEqual(uses[0].input, { file_path: 'receipt.txt' })
  assert.ok(results[0].content.some(block => block.type === 'image' && block.source.data === 'eA=='))
  first[0].content[0].text = 'changed externally'
  assert.deepEqual(readSnapshot(), second)
})
