import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

// Wide enough that a GC pause between heartbeats cannot look like idleness.
process.env.TAU_VOICE_DELEGATION_TIMEOUT_MS = '400'
const bundle = await build({ entryPoints: ['src/voice/liveSession.ts'], bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node20' })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { LiveVoiceSession } = module.exports

const sleep = ms => new Promise(r => setTimeout(r, ms))
const delegation = id => ({ type: 'delegation.created', item: { type: 'delegation', target: 'client', id, content: [{ type: 'input_text', text: 'run the tests' }] } })

async function connected(submit) {
  const sent = []
  const transport = {
    connect: async () => {}, close: async () => {}, setMuted() {}, clearOutput() {}, pushAudio() {},
    send: async message => { sent.push(message) },
  }
  let emit
  const session = new LiveVoiceSession({
    createTransport: callbacks => { emit = callbacks.onEvent; return transport },
    capture: () => ({ stop() {} }),
  })
  session.setBridge({ submit })
  await session.start()
  return { session, sent, emit }
}
const finalFor = (sent, id) => sent.filter(m => m.delegation_item_id === id && m.content?.[0]?.text?.includes('Agent Final Message'))

test('a delegation the REPL never completes is given up on, not left pending', async () => {
  // submit resolves (the query was accepted) but no turn ever claims it.
  const { session, sent, emit } = await connected(async () => {})
  emit(delegation('rtc-1'))
  await sleep(20)
  assert.equal(session.getSnapshot().phase, 'working')
  await sleep(550)
  // The voice model is told, and the session is usable again.
  assert.equal(finalFor(sent, 'rtc-1').length, 1)
  assert.match(finalFor(sent, 'rtc-1')[0].content[0].text, /never reported a result/)
  assert.equal(session.getSnapshot().phase, 'ready')
  await session.stop()
})

test('progress keeps a long turn alive past the idle bound', async () => {
  const { session, sent, emit } = await connected(async () => {})
  emit(delegation('rtc-2'))
  // Heartbeat across more than one idle window.
  for (let i = 0; i < 5; i++) { await sleep(80); session.progress(`step ${i}`, 'rtc-2') }
  assert.equal(finalFor(sent, 'rtc-2').length, 0, 'a working turn was cut short')
  assert.equal(session.getSnapshot().phase, 'working')
  // Once it goes quiet the bound still applies.
  await sleep(550)
  assert.equal(finalFor(sent, 'rtc-2').length, 1)
  await session.stop()
})

test('a completed delegation is never given up on afterwards', async () => {
  const { session, sent, emit } = await connected(async () => {})
  emit(delegation('rtc-3'))
  await sleep(20)
  session.finish('Tests passed.', 'rtc-3')
  assert.equal(finalFor(sent, 'rtc-3').length, 1)
  await sleep(550)
  // No second final message from a stale timer.
  assert.equal(finalFor(sent, 'rtc-3').length, 1)
  assert.equal(session.getSnapshot().phase, 'ready')
  await session.stop()
})

test('stopping the call cancels outstanding delegation timers', async () => {
  const { session, sent, emit } = await connected(async () => {})
  emit(delegation('rtc-4'))
  await sleep(20)
  await session.stop()
  const after = sent.length
  await sleep(550)
  assert.equal(sent.length, after, 'a timer fired after the call ended')
})
