import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const bundle = await build({ entryPoints: ['src/voice/liveSession.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20' })
const { LiveVoiceSession } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(t, overrides = {}) {
  const state = { captures: [], peers: [], submissions: [], listeners: 0 }
  const session = new LiveVoiceSession({
    createTransport(callbacks, signal) {
      const peer = { callbacks, signal, closed: 0, muted: [], audio: [], sent: [], cleared: 0,
        async connect() { if (overrides.connect) await overrides.connect(peer) },
        async close() { peer.closed++ }, setMuted(value) { peer.muted.push(value) },
        clearOutput() { peer.cleared++ }, pushAudio(samples) { peer.audio.push([...samples]) },
        async send(message) { peer.sent.push(message) },
      }
      state.peers.push(peer)
      return peer
    },
    capture(callback) {
      if (overrides.captureError) throw new Error('Access denied')
      const capture = { callback, stopped: 0, stop() { capture.stopped++ }, ...(overrides.drain ? { drain: overrides.drain } : {}) }
      state.captures.push(capture)
      return capture
    },
  })
  session.setBridge({ submit: (request, id) => { state.submissions.push({ request, id }); return overrides.submit?.(request, id) } })
  t.after(() => session.stop())
  return { session, state, event: event => state.peers.at(-1).callbacks.onEvent(event) }
}
const delegate = (id = 'd1', text = 'Read the source') => ({ type: 'delegation.created', item: { type: 'delegation', target: 'client', id, content: [{ type: 'input_text', text }] } })

test('/hey arms the call without recording; hold captures; release and /bye stop devices', async t => {
  const { session, state } = fixture(t)
  const original = session.getSnapshot()
  assert.equal(original, session.getSnapshot(), 'useSyncExternalStore requires stable snapshots')
  await session.start()
  await session.start()
  assert.equal(state.peers.length, 1)
  assert.equal(state.captures.length, 0)
  assert.equal(session.getSnapshot().phase, 'ready')
  await session.beginRecording()
  await session.beginRecording()
  assert.equal(state.captures.length, 1)
  assert.equal(session.getSnapshot().phase, 'recording')
  state.captures[0].callback(null, Float32Array.of(0.3, 0.4))
  assert.equal(state.peers[0].audio.length, 1)
  assert.ok(session.getSnapshot().inputLevel > 0)
  session.endRecording()
  assert.equal(state.captures[0].stopped, 1)
  assert.equal(session.getSnapshot().phase, 'ready')
  await session.stop()
  await session.stop()
  assert.equal(session.getSnapshot().phase, 'off')
  assert.equal(state.peers[0].closed, 1)
  state.captures[0].callback(null, Float32Array.of(1))
  assert.equal(state.peers[0].audio.length, 1, 'no stale capture after /bye')
})

test('/bye during connection cannot resurrect a session or open a microphone', async t => {
  const gate = deferred()
  const { session, state } = fixture(t, { connect: () => gate.promise })
  const connecting = session.start()
  const rejected = assert.rejects(connecting, /Voice stopped/)
  await tick()
  await session.stop()
  gate.resolve()
  await rejected
  assert.equal(session.getSnapshot().phase, 'off')
  assert.equal(state.captures.length, 0)
  assert.equal(state.peers[0].closed, 1)
})

test('old connection failure cannot overwrite a newer /hey', async t => {
  const gate = deferred()
  let attempts = 0
  const { session } = fixture(t, { connect: () => ++attempts === 1 ? gate.promise : Promise.resolve() })
  const first = session.start()
  const rejected = assert.rejects(first, /late failure/)
  await tick()
  await session.stop()
  await session.start()
  gate.reject(new Error('late failure'))
  await rejected
  assert.equal(session.getSnapshot().phase, 'ready')
})

test('permission-denied mic never reports REC and can be retried', async t => {
  const options = { captureError: true }
  const { session, state } = fixture(t, options)
  const phases = []
  session.subscribe(() => phases.push(session.getSnapshot().phase))
  await session.start()
  await assert.rejects(session.beginRecording(), /Access denied/)
  assert.ok(!phases.includes('recording'))
  assert.equal(state.peers[0].muted.at(-1), true)
  options.captureError = false
  await session.beginRecording()
  assert.equal(session.getSnapshot().phase, 'recording')
})

test('a transcript displays once but only delegation events submit agent work', async t => {
  const { session, state, event } = fixture(t)
  await session.start()
  event({ type: 'turn.done', turn: { role: 'user', transcript: 'Read the source' } })
  assert.equal(session.getSnapshot().transcriptId, 1)
  assert.equal(state.submissions.length, 0)
  event(delegate())
  event(delegate())
  assert.deepEqual(state.submissions, [{ request: 'Read the source', id: 'd1' }])
  assert.equal(session.getSnapshot().phase, 'working')
})

test('correlated results are chunked safely, and unrelated/final duplicate results are ignored', async t => {
  const { session, state, event } = fixture(t)
  await session.start()
  event(delegate('one'))
  event(delegate('two', 'Follow up'))
  session.finish('Unrelated', 'missing')
  const result = 'Done 🙂 漢字 '.repeat(130)
  session.finish(result, 'two')
  session.finish('duplicate', 'two')
  await tick()
  const sent = state.peers[0].sent
  assert.ok(sent.length > 1)
  assert.ok(sent.every(message => message.delegation_item_id === 'two'))
  assert.ok(sent.every(message => Buffer.byteLength(message.content[0].text) <= 500))
  assert.equal(sent.flatMap(message => message.content.map(item => item.text)).join(''), `"Agent Final Message":\n\n${result.trim()}`)
  assert.equal(session.getSnapshot().phase, 'working', 'the first request still runs')
  session.finish('First done', 'one')
  assert.equal(session.getSnapshot().phase, 'ready')
})

test('streaming progress batches deltas instead of resending the whole response', async t => {
  const { session, state, event } = fixture(t)
  await session.start()
  event(delegate())
  session.progress('Checking')
  session.progress('Checking the source')
  await new Promise(resolve => setTimeout(resolve, 240))
  session.progress('Checking the source now')
  await new Promise(resolve => setTimeout(resolve, 240))
  assert.deepEqual(state.peers[0].sent.map(message => message.content[0].text), ['Checking the source', ' now'])
  assert.ok(state.peers[0].sent.every(message => message.channel === 'commentary'))
})

test('failed agent submission is returned to the voice model, not silently dropped', async t => {
  const { session, state, event } = fixture(t, { submit: async () => { throw new Error('Queue rejected') } })
  await session.start()
  event(delegate())
  await tick()
  assert.match(state.peers[0].sent[0].content[0].text, /Queue rejected/)
  assert.equal(session.getSnapshot().phase, 'ready')
})

test('server or device failure releases the mic and permits reconnecting', async t => {
  const { session, state, event } = fixture(t)
  await session.start()
  await session.beginRecording()
  event({ type: 'error', message: 'Network lost' })
  await tick()
  assert.equal(state.captures[0].stopped, 1)
  assert.equal(state.peers[0].closed, 1)
  assert.equal(session.getSnapshot().phase, 'error')
  await session.start()
  assert.equal(session.getSnapshot().phase, 'ready')
})

test('release preserves queued PCM tail until native FIFO drain, while REC is already off', async t => {
  const gate = deferred()
  const { session, state } = fixture(t, { drain: () => gate.promise })
  await session.start()
  await session.beginRecording()
  session.endRecording()
  assert.equal(session.getSnapshot().phase, 'ready')
  assert.equal(state.captures[0].stopped, 1)
  state.captures[0].callback(null, Float32Array.of(0.5))
  assert.equal(state.peers[0].audio.length, 1)
  assert.equal(state.peers[0].muted.at(-1), false)
  gate.resolve()
  await tick()
  assert.equal(state.peers[0].muted.at(-1), true)
  state.captures[0].callback(null, Float32Array.of(0.6))
  assert.equal(state.peers[0].audio.length, 1)
})

test('a fresh hold rejects stale capture audio/errors and an older drain cannot mute it', async t => {
  const gate = deferred()
  const { session, state } = fixture(t, { drain: () => gate.promise })
  await session.start()
  await session.beginRecording()
  session.endRecording()
  await session.beginRecording()
  state.captures[0].callback(null, Float32Array.of(0.8))
  state.captures[0].callback(new Error('Old device failed'), new Float32Array())
  gate.resolve()
  await tick()
  assert.equal(state.peers[0].audio.length, 0)
  assert.equal(session.getSnapshot().phase, 'recording')
  assert.equal(state.peers[0].muted.at(-1), false)
  state.captures[1].callback(null, Float32Array.of(0.2))
  assert.equal(state.peers[0].audio.length, 1)
})
