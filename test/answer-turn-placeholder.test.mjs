import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// A model turn with nothing sendable in it (blank text, or reasoning only)
// between two user messages must reach the API as a "(no content)" assistant
// turn, live and after a resume. Dropping it glued the user messages together:
// the one already sent as the last message of a request changed in the next
// request, and a resumed session rebuilt a different history.

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tau-answer-turns-'))

const distPath = resolve('dist/tau.mjs')
let bundle = readFileSync(distPath, 'utf8').replace(/\nvoid main\d*\(\);\r?\n/, '\n')
const initFor = file => {
  const escaped = file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const match = bundle.match(new RegExp(`var (init_\\w+) = __esm\\(\\{\\s*"${escaped}"`))
  if (!match) throw new Error(`no module init for ${file}`)
  return match[1]
}
bundle += `
export function __answerTurns() {
  ${initFor('src/utils/messages.ts')}(); ${initFor('src/utils/conversationRecovery.ts')}();
  return { normalizeMessagesForAPI, filterWhitespaceOnlyAssistantMessages,
    filterOrphanedThinkingOnlyMessages, createUserMessage, createAssistantMessage,
    createAssistantAPIErrorMessage, createTurnDurationMessage, deserializeMessages,
    isNotEmptyMessage };
}
`
const path = join(dirname(distPath), `.answer-turns-${process.pid}.mjs`)
writeFileSync(path, bundle)
let tau
try {
  tau = (await import(pathToFileURL(path).href)).__answerTurns()
} finally {
  unlinkSync(path)
}

const NOTIFICATION = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "job" completed (exit code 0)</summary>\n</task-notification>'
const user = text => tau.createUserMessage({ content: text })
const say = (blocks, id = `msg_${Math.random().toString(36).slice(2)}`) => {
  const message = tau.createAssistantMessage({ content: blocks })
  message.message.id = id
  message.message.stop_reason = 'end_turn'
  return message
}
const text = (value, id) => say([{ type: 'text', text: value }], id)
const thinking = id => say([{ type: 'thinking', thinking: 'No answer needed.', signature: 'sig' }], id)
const wire = messages => tau.normalizeMessagesForAPI(messages, []).map(m => ({ role: m.message.role, content: m.message.content }))
const noContent = { role: 'assistant', content: [{ type: 'text', text: '(no content)', citations: [] }] }

function assertExtends(before, after, label) {
  assert.ok(after.length >= before.length, `${label}: history shrank`)
  before.forEach((message, index) => {
    assert.deepEqual(after[index], message, `${label}: message ${index} changed`)
  })
}
function assertAlternates(messages, label) {
  messages.forEach((message, index) => {
    if (index > 0) assert.notEqual(message.role, messages[index - 1].role, `${label}: two ${message.role} messages in a row at ${index}`)
  })
}

const start = () => [user('Start the job in the background.'), text('Started.')]

for (const [label, answer] of [
  ['a blank answer', () => text('\n\n')],
  ['an empty text answer', () => text('')],
  ['a reasoning-only answer', () => thinking()],
]) {
  test(`${label} to a notification leaves the notification as it was sent`, () => {
    const sent = wire([...start(), user(NOTIFICATION)])
    const next = wire([...start(), user(NOTIFICATION), answer(), user('Second question.')])
    assertExtends(sent, next, label)
    assert.deepEqual(next[sent.length], noContent)
    assert.equal(next.length, sent.length + 2)
    assertAlternates(next, label)
  })

  test(`${label}: a resumed session sends the same history as the live one`, () => {
    const live = [...start(), user(NOTIFICATION), answer(), user('Second question.'), text('Answer B.')]
    const resumed = tau.deserializeMessages(live)
    assert.deepEqual(wire(resumed), wire(live))
    // The resumed placeholder stays hidden from the screen and SDK output.
    const placeholder = resumed.find(m => m.type === 'assistant' && m.message.content[0]?.text === '(no content)')
    assert.ok(placeholder, 'the answer turn was kept on resume')
    assert.equal(tau.isNotEmptyMessage(placeholder), false)
  })
}

test('unsent messages around a contentless answer: resume matches live', () => {
  // A saved transcript also holds bookkeeping system messages and API errors,
  // which never reach the API; they must not change the decision.
  const live = [
    ...start(), user(NOTIFICATION), text('\n\n'),
    tau.createTurnDurationMessage(1200),
    tau.createAssistantAPIErrorMessage({ content: 'API Error: 500 upstream' }),
    user('Second question.'), text('Answer B.'),
  ]
  const sent = wire([...start(), user(NOTIFICATION)])
  const next = wire(live)
  assertExtends(sent, next, 'unsent neighbours')
  assert.deepEqual(next[sent.length], noContent)
  assertAlternates(next, 'unsent neighbours')
  assert.deepEqual(wire(tau.deserializeMessages(live)), next)
})

test('a contentless answer after a tool result keeps the tool result as sent', () => {
  const call = say([{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }])
  const result = tau.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'a.txt' }] })
  const sent = wire([user('List files.'), call, result])
  const next = wire([user('List files.'), call, result, text('\n'), user('Thanks.')])
  assertExtends(sent, next, 'after a tool result')
  assert.deepEqual(next[sent.length], noContent)
  assertAlternates(next, 'after a tool result')
})

test('an answer interrupted after only whitespace keeps the prompt as sent', () => {
  const partial = text('\n\n')
  partial.message.stop_reason = null
  const sent = wire([user('Explain the build.')])
  const next = wire([user('Explain the build.'), partial, user('[Request interrupted by user]'), user('Shorter please.')])
  assertExtends(sent, next, 'interrupted')
  assert.deepEqual(next[1], noContent)
  assertAlternates(next, 'interrupted')
})

test('a session that ended on a contentless answer resumes onto what was sent', () => {
  const lastSent = wire([...start(), user(NOTIFICATION)])
  const resumed = tau.deserializeMessages([...start(), user(NOTIFICATION), text('\n\n')])
  const next = wire([...resumed, user('After the restart.')])
  assertExtends(lastSent, next, 'ended on a contentless answer')
  assertAlternates(next, 'ended on a contentless answer')
})

test('several contentless turns in a row become one placeholder', () => {
  const next = wire([...start(), user(NOTIFICATION), text('\n'), thinking(), user('Second question.')])
  assert.deepEqual(next.slice(3), [noContent, { role: 'user', content: next[4].content }])
  assertAlternates(next, 'run')
})

test('whitespace streamed before a tool call in the same turn is untouched', () => {
  const id = 'msg_tool_turn'
  const call = say([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], id)
  const result = tau.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }] })
  const out = wire([user('List files.'), text('\n\n\n', id), call, result])
  assert.equal(out.length, 3)
  assert.deepEqual(out[1].content.map(b => b.type), ['text', 'tool_use'])
})

test('a contentless turn that does not separate two user messages is still dropped', () => {
  // Last message: nothing follows it yet.
  assert.deepEqual(wire([user('Hi.'), text('\n\n')]).map(m => m.role), ['user'])
  // Next to another assistant turn: dropping it glues nothing.
  const out = wire([user('Hi.'), text('Hello.'), thinking(), user('Bye.')])
  assert.deepEqual(out.map(m => m.role), ['user', 'assistant', 'user'])
  assert.equal(out[1].content[0].text, 'Hello.')
  // A thinking block with its answer is not an orphan.
  const id = 'msg_with_answer'
  const kept = wire([user('Hi.'), thinking(id), text('Hello.', id), user('Bye.')])
  assert.deepEqual(kept[1].content.map(b => b.type), ['thinking', 'text'])
})

test('the filters leave histories without contentless turns as they are', () => {
  const history = [...start(), user(NOTIFICATION), text('Noted.'), user('Second question.')]
  assert.deepEqual(tau.filterWhitespaceOnlyAssistantMessages(history), history)
  assert.deepEqual(tau.filterOrphanedThinkingOnlyMessages(history), history)
})

test('an empty assistant message keeps its existing placeholder', () => {
  const out = wire([user('Hi.'), say([]), user('Again.')])
  assert.deepEqual(out[1], noContent)
})
