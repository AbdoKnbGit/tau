// Run after `npm run build`: node --test test/copy-response.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tempRoot = mkdtempSync(join(tmpdir(), 'tau-copy-response-'))
const environment = {
  NODE_ENV: 'test',
  CLAUDE_CONFIG_DIR: join(tempRoot, 'config'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}
const originalEnv = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
Object.assign(process.env, environment)
after(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(dirname(resolve(tempRoot)), resolve(tmpdir()))
  rmSync(tempRoot, { recursive: true, force: true })
})

// Exercise the shipped command, recovery and API normalization together. Only
// the OS clipboard boundary is replaced; file output goes to an isolated temp
// directory. This never touches a developer's clipboard, config or response.md.
const distPath = fileURLToPath(new URL('../dist/tau.mjs', import.meta.url))
let bundle = readFileSync(distPath, 'utf8')
const entry = /\nvoid main\d*\(\);\r?\n/g
assert.equal(bundle.match(entry)?.length, 1, 'disable exactly one CLI entry point')
bundle = bundle.replace(entry, '\n')
const auditPath = join(dirname(distPath), `.copy-response-${randomUUID()}.mjs`)
bundle += `
export function copyTestRuntime(directory, clipboard) {
  init_copy(); init_conversationRecovery();
  COPY_DIR = directory;
  setClipboard = async text => { clipboard.push(text); return ''; };
  return { ...copy_exports, createUserMessage, createAssistantMessage,
    createAssistantAPIErrorMessage, createTurnDurationMessage,
    deserializeMessages, deserializeMessagesWithInterruptDetection,
    normalizeMessagesForAPI, SYNTHETIC_MESSAGES, NO_RESPONSE_REQUESTED,
    NO_CONTENT_MESSAGE, SYNTHETIC_MODEL, saveGlobalConfig };
}
`
const clipboard = []
let tau
try {
  writeFileSync(auditPath, bundle)
  tau = (await import(pathToFileURL(auditPath).href)).copyTestRuntime(tempRoot, clipboard)
} finally {
  unlinkSync(auditPath)
}

const block = text => ({ type: 'text', text })
const assistant = content => tau.createAssistantMessage({ content })
const user = content => tau.createUserMessage({ content })
const sentinel = () => assistant(tau.NO_RESPONSE_REQUESTED)
const thinking = { type: 'thinking', thinking: 'Private reasoning', signature: 'signature' }
const tool = { type: 'tool_use', id: 'toolu_copy', name: 'Read', input: { file_path: 'example.txt' } }
const collect = messages => tau.collectRecentAssistantTexts(messages)
const wire = messages => tau.normalizeMessagesForAPI(messages, [])
const start = () => [user('Question'), assistant('First answer'), user('Next question'), assistant('Latest answer')]

test('copy skips every registered sentinel without excluding ordinary synthetic-model text', () => {
  const response = assistant('Real visible response')
  assert.equal(response.message.model, tau.SYNTHETIC_MODEL)
  for (const text of tau.SYNTHETIC_MESSAGES) {
    assert.deepEqual(collect([response, assistant(text)]), ['Real visible response'])
  }
})

test('hidden blocks at any position cannot leak or discard real text in the same message', () => {
  for (const text of tau.SYNTHETIC_MESSAGES) {
    for (const content of [
      [block(text), block('Keep this')],
      [thinking, block(text), block('Keep this')],
      [block('Keep this'), block(text)],
    ]) {
      assert.deepEqual(collect([assistant(content)]), ['Keep this'])
    }
    assert.deepEqual(collect([assistant([thinking, block(text)])]), [])
  }
})

test('hidden empty placeholders, blank blocks, errors and non-text messages do not count', () => {
  const messages = [
    assistant('Keep this'), user('User text'),
    tau.createAssistantAPIErrorMessage({ content: 'API Error: upstream unavailable' }),
    assistant([tool]), assistant([thinking]), assistant([]),
    assistant([block('')]), assistant(' \r\n\t'),
    assistant(tau.NO_CONTENT_MESSAGE),
    assistant('<context>Internal context</context>'),
    tau.createTurnDurationMessage(1000),
  ]
  assert.deepEqual(collect(messages), ['Keep this'])
  assert.deepEqual(collect([assistant([
    block(tau.NO_CONTENT_MESSAGE), block('First paragraph'), block(' \n'),
    thinking, block('Second paragraph'), block('<context>Hidden</context>'),
  ])]), ['First paragraph\n\nSecond paragraph'])
})

test('real prose, code, Unicode and line endings are preserved exactly', () => {
  const text = `  The placeholder is "${tau.NO_RESPONSE_REQUESTED}".\r\n\r\n` +
    '```text\r\n(no content)\r\n```\r\n\r\nRéponse 日本語 🙂  '
  assert.deepEqual(collect([assistant(text)]), [text])
})

test('the lookback limit counts copyable responses, not intervening history', () => {
  const messages = Array.from({ length: 25 }, (_, index) => [
    assistant(`Answer ${index}`), ...Array.from({ length: 25 }, sentinel),
  ]).flat()
  assert.deepEqual(collect(messages), Array.from({ length: 20 }, (_, index) => `Answer ${24 - index}`))
})

for (const command of ['/cost', '/status', '/exit']) {
  for (const [label, deserialize] of [
    ['CLI recovery', messages => tau.deserializeMessagesWithInterruptDetection(messages).messages],
    ['/resume recovery', messages => tau.deserializeMessages(messages)],
  ]) {
    test(`${label} after ${command}: copy ignores the inserted sentinel on repeated resumes`, () => {
      const messages = [...start(), user(`<command-name>${command}</command-name>`),
        user('<local-command-stdout>Done</local-command-stdout>'),
        tau.createTurnDurationMessage(1000)]
      let resumed = deserialize(messages)
      assert.ok(resumed.some(message => message.message?.content?.[0]?.text === tau.NO_RESPONSE_REQUESTED))
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.deepEqual(collect(resumed), ['Latest answer', 'First answer'])
        resumed = deserialize(JSON.parse(JSON.stringify(resumed)))
      }
    })
  }
}

test('interrupted prompt and interrupted tool-result turn recover the last answer', () => {
  for (const tail of [
    [user('Unanswered prompt')],
    [user('Read a file'), assistant([tool]), user([{ type: 'tool_result', tool_use_id: tool.id, content: 'File contents' }])],
    [user('Read a file'), assistant([tool])],
  ]) {
    const result = tau.deserializeMessagesWithInterruptDetection([...start(), ...tail])
    assert.equal(result.turnInterruptionState.kind, 'interrupted_prompt')
    assert.deepEqual(collect(result.messages), ['Latest answer', 'First answer'])
  }
})

test('copying cannot mutate history, cache metadata or the next API request', () => {
  const messages = tau.deserializeMessages([...start(), user('Unanswered prompt')])
  messages[1].message.content[0].cache_control = { type: 'ephemeral' }
  const before = structuredClone(messages)
  const nextPrompt = user('Continue')
  const requestBefore = structuredClone(wire([...messages, nextPrompt]))
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
  }
  freeze(messages)
  assert.deepEqual(collect(messages), ['Latest answer', 'First answer'])
  assert.deepEqual(messages, before)
  assert.deepEqual(wire([...messages, nextPrompt]), requestBefore)
})

test('each call reflects changed history and switching sessions, with no stale selection', () => {
  const messages = [assistant('Session A'), sentinel()]
  assert.deepEqual(collect(messages), ['Session A'])
  messages.push(assistant('New response'))
  assert.deepEqual(collect(messages), ['New response', 'Session A'])
  assert.deepEqual(collect([assistant('Session B'), sentinel()]), ['Session B'])
  messages.length = 0
  assert.deepEqual(collect(messages), [])
})

async function copy(messages, args = '') {
  clipboard.length = 0
  const notices = []
  const element = await tau.call(message => notices.push(message), { messages }, args)
  return { notices, element }
}

test('/copy and /copy N send the selected real answer to clipboard and fallback file', async () => {
  const messages = tau.deserializeMessages([...start(), user('Unanswered prompt')])
  for (const [arg, expected] of [['', 'Latest answer'], ['1', 'Latest answer'], ['2', 'First answer']]) {
    const result = await copy(messages, arg)
    assert.equal(result.element, null)
    assert.deepEqual(clipboard, [expected])
    assert.equal(readFileSync(join(tempRoot, 'response.md'), 'utf8'), expected)
    assert.match(result.notices[0], /Copied to clipboard/)
  }
})

test('empty and out-of-range selections do not write the clipboard or fallback file', async () => {
  const previous = 'Previous file contents'
  writeFileSync(join(tempRoot, 'response.md'), previous)
  for (const [messages, args, notice] of [
    [[], '', 'No assistant message to copy'],
    [[sentinel(), assistant(tau.NO_CONTENT_MESSAGE)], '', 'No assistant message to copy'],
    [[assistant('Real answer'), sentinel()], '2', 'Only 1 assistant message available to copy'],
  ]) {
    const result = await copy(messages, args)
    assert.equal(result.element, null)
    assert.deepEqual(result.notices, [notice])
    assert.deepEqual(clipboard, [])
    assert.equal(readFileSync(join(tempRoot, 'response.md'), 'utf8'), previous)
  }
})

test('the code picker and always-copy preference receive the same filtered selection', async () => {
  const response = 'Example:\n\n```js\nconsole.log("hello")\n```'
  const messages = [assistant([block(tau.NO_RESPONSE_REQUESTED), block(response)]), sentinel()]
  tau.saveGlobalConfig(config => ({ ...config, copyFullResponse: false }))
  const picker = await copy(messages)
  assert.ok(picker.element)
  assert.equal(picker.element.props.fullText, response)
  assert.deepEqual(picker.element.props.codeBlocks, [{ code: 'console.log("hello")', lang: 'js' }])
  assert.equal(picker.element.props.messageAge, 0)
  assert.deepEqual(clipboard, [])
  tau.saveGlobalConfig(config => ({ ...config, copyFullResponse: true }))
  try {
    const result = await copy(messages)
    assert.equal(result.element, null)
    assert.deepEqual(clipboard, [response])
    assert.equal(readFileSync(join(tempRoot, 'response.md'), 'utf8'), response)
  } finally {
    tau.saveGlobalConfig(config => ({ ...config, copyFullResponse: false }))
  }
})
