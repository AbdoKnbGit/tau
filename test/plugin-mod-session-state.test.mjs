import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, afterEach, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'tau-mod-session-'))
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'), DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', NODE_ENV: 'test',
})
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/sessionState.ts', 'src/utils/plugins/mods/host.ts'],
  exports: [
    'bindModSession', 'readModSessionModel', 'readModSessionTurns', 'readModSessionMessages',
    'getModSessionBinding', 'getModMainTurn', 'beginModMainTurn', 'abortModMainTurn',
    'isModSessionBusy', 'isModSessionStopped', 'resumeModSessionOnUserInput', 'markModSessionStopped',
    'createModHost', 'createUserMessage', 'createAssistantMessage',
    'bindModAgentConversation', 'rememberAgentConversation',
  ],
})
const cleanups = []
const bind = binding => {
  const close = r.bindModSession(binding)
  cleanups.push(close)
  return close
}
const base = overrides => ({getMessages: () => [], getModel: () => 'session-model', ...overrides})
const user = (content, extra = {}) => r.createUserMessage({content, ...extra})
const assistant = content => r.createAssistantMessage({content: [{type: 'text', text: content}]})
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
after(() => { rmSync(root, {recursive: true, force: true, maxRetries: 10}) })

test('main session reads use live authoritative getters and return detached values', async () => {
  let model = 'initial-model', messages = [user('first question'), assistant('first answer')]
  bind(base({getMessages: () => messages, getModel: () => model}))
  assert.equal(r.readModSessionModel(), 'initial-model')
  assert.equal(r.readModSessionTurns(), 1)
  const first = await r.readModSessionMessages()
  first[0].text = 'a plugin cannot rewrite the transcript by editing its snapshot'
  assert.equal(messages[0].message.content, 'first question')
  messages = [...messages, user('tool output', {isMeta: true}), user('second question')]
  model = 'new-main-model'
  assert.equal(r.readModSessionModel(), 'new-main-model')
  assert.equal(r.readModSessionTurns(), 2)
  assert.equal((await r.readModSessionMessages()).at(-1).text, 'second question')
  const api = await r.readModSessionMessages({as: 'api'})
  api[0].content[0].text = 'also detached'
  assert.equal(messages[0].message.content, 'first question')
})

test('host methods read the same session even outside a tool callback', async () => {
  bind(base({getMessages: () => [user('ordinary prompt')]}))
  const host = r.createModHost({id: 'arbitrary@source', name: 'arbitrary', commands: new Map(),
    reserved: new Set(), commandsChanged: async () => {}, log() {}})
  const signal = new AbortController().signal
  assert.equal(await host('session.model', [], signal), 'session-model')
  assert.equal(await host('session.turns', [], signal), 1)
  assert.equal((await host('session.messages', [], signal))[0].text, 'ordinary prompt')
  const turn = new AbortController(), end = r.beginModMainTurn('own-main-turn', turn)
  assert.equal(await host('turn.abort', [{turnId: 'own-main-turn'}], signal), undefined)
  assert.equal(turn.signal.reason, 'interrupt')
  end()
})

test('agent transcripts never fall back to the main conversation', async () => {
  let agentMessages = [user('child question')]
  bind(base({getMessages: () => [user('main secret')], getAgentMessages: async id => {
    if (id === 'unreadable') throw new Error('read failed')
    return id === 'child' ? agentMessages : undefined
  }}))
  assert.equal((await r.readModSessionMessages({agentId: 'child'}))[0].text, 'child question')
  agentMessages = [...agentMessages, assistant('child answer')]
  assert.equal((await r.readModSessionMessages({agentId: 'child', as: 'api'})).at(-1).content[0].text, 'child answer')
  for (const id of ['missing', 'unreadable', '../../outside']) {
    const result = await r.readModSessionMessages({agentId: id})
    assert.deepEqual(Object.keys(result), ['deny'])
    assert.ok(result.deny.includes(id))
    assert.ok(!JSON.stringify(result).includes('main secret'))
  }
})

test('an agent read finishing after its session closes cannot disclose its old transcript', async () => {
  let resolveRead
  const close = bind(base({getAgentMessages: () => new Promise(resolve => { resolveRead = resolve })}))
  const pending = r.readModSessionMessages({agentId: 'old-child'})
  close()
  bind(base({getMessages: () => [user('new session')]}))
  resolveRead([user('old session')])
  assert.match((await pending).deny, /old-child/)
})

test('running and retained child conversations remain readable before a transcript file exists', async () => {
  bind(base({getMessages: () => [user('main stays private')]}))
  const id = 'live-child-without-a-disk-transcript'
  let child = [user('child request')]
  const close = r.bindModAgentConversation(id, () => child)
  try {
    assert.equal((await r.readModSessionMessages({agentId:id}))[0].text, 'child request')
    child = [...child, assistant('fresh child answer')]
    const snapshot = await r.readModSessionMessages({agentId:id})
    assert.equal(snapshot.at(-1).text, 'fresh child answer')
    snapshot[0].text = 'mutated copy'
    assert.equal(child[0].message.content, 'child request')
    r.rememberAgentConversation(id, child)
  } finally { close() }
  assert.equal((await r.readModSessionMessages({agentId:id})).at(-1).text, 'fresh child answer')
  assert.doesNotMatch(JSON.stringify(await r.readModSessionMessages({agentId:id})), /main stays private/)
})

test('read cancellation remains cancellation rather than an unreadable-agent denial', async () => {
  const controller = new AbortController()
  bind(base({getAgentMessages: async () => {
    controller.abort(new Error('cancelled session read'))
    throw new Error('unreadable')
  }}))
  await assert.rejects(r.readModSessionMessages({agentId: 'child'}, controller.signal), /cancelled session read/)
})

test('invalid message options reject rather than select a different transcript', async () => {
  bind(base())
  for (const value of [null, [], 'child', {as: 'rows'}, {agentId: ''}, {agentId: 2}])
    await assert.rejects(r.readModSessionMessages(value), /session.messages/)
})

test('stale owner cleanup cannot detach a replacement session or running turn', () => {
  const closeOld = bind(base({getModel: () => 'old'}))
  const closeNew = bind(base({getModel: () => 'new'}))
  const controller = new AbortController(), end = r.beginModMainTurn('new-turn', controller)
  closeOld()
  assert.equal(r.readModSessionModel(), 'new')
  assert.equal(r.getModMainTurn().turnId, 'new-turn')
  assert.equal(r.isModSessionBusy(), true)
  end()
  closeNew()
  assert.equal(r.getModSessionBinding(), undefined)
  assert.throws(() => r.readModSessionModel(), /running session/)
})

test('turn abort requires the exact active main turn and does not set the user-stop latch', () => {
  bind(base())
  const controller = new AbortController(), end = r.beginModMainTurn('current-turn', controller)
  assert.throws(() => r.abortModMainTurn({turnId: 'other-turn'}), error =>
    /other-turn/.test(error.message) && /current-turn/.test(error.message))
  assert.equal(controller.signal.aborted, false)
  r.abortModMainTurn({turnId: 'current-turn'})
  assert.equal(controller.signal.reason, 'interrupt')
  assert.equal(r.isModSessionStopped(), false)
  assert.throws(() => r.abortModMainTurn({turnId: 'current-turn'}), /current-turn.*none/)
  end()
  assert.throws(() => r.abortModMainTurn({turnId: 'current-turn'}), /current-turn.*none/)
  for (const input of [null, {}, {turnId: ''}, {turnId: 3}])
    assert.throws(() => r.abortModMainTurn(input), /nonempty turnId/)
})

test('only active user cancellation sets the stop latch, which new user input clears', () => {
  bind(base())
  const controller = new AbortController(), end = r.beginModMainTurn('cancelled-turn', controller)
  controller.abort('user-cancel')
  assert.equal(r.isModSessionStopped(), true)
  end()
  r.resumeModSessionOnUserInput()
  assert.equal(r.isModSessionStopped(), false)
  const completed = new AbortController(), endCompleted = r.beginModMainTurn('completed-turn', completed)
  endCompleted()
  completed.abort('user-cancel')
  assert.equal(r.isModSessionStopped(), false)
  const background = new AbortController(), endBackground = r.beginModMainTurn('background-turn', background)
  background.abort('background')
  assert.equal(r.isModSessionStopped(), false)
  endBackground()
})

test('busy state includes prompt processing and overlapping main turns are refused', () => {
  let busy = true
  bind(base({isBusy: () => busy}))
  assert.equal(r.isModSessionBusy(), true)
  busy = false
  assert.equal(r.isModSessionBusy(), false)
  const end = r.beginModMainTurn('active-turn', new AbortController())
  assert.throws(() => r.beginModMainTurn('overlap', new AbortController()), /active-turn.*already running/)
  end()
  assert.equal(r.isModSessionBusy(), false)
})
