import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/voice/liveTransport.ts'], bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node20', plugins: [{
  name: 'isolate-proxy-settings', setup(builder) {
    builder.onResolve({ filter: /utils\/proxy\.js$/ }, () => ({ path: 'proxy', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const getProxyUrl = () => undefined; export const shouldBypassProxy = () => false;' }))
  },
}] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { CodexLiveTransport, parseLiveCallId } = module.exports
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, overrides = {}) {
  const state = { posts: [], refreshes: [], peers: [], sockets: [], events: [], levels: [] }
  const controller = new AbortController()
  class Peer {
    constructor(event, level, failure) { Object.assign(this, { event, level, failure, muted: [], audio: [], closed: 0 }); state.peers.push(this) }
    async createOffer() { return 'v=0\r\nmock-offer' }
    async acceptAnswer(answer) { this.answer = answer }
    async waitForOpen() {}
    async close() { this.closed++ }
    setMuted(value) { this.muted.push(value) }
    clearOutput() { this.cleared = true }
    pushAudio(samples) { this.audio.push([...samples]) }
  }
  class Socket extends EventEmitter {
    readyState = 0
    sent = []
    terminated = 0
    send(data, callback) { this.sent.push(JSON.parse(data)); callback() }
    terminate() { this.terminated++; this.readyState = 3; this.emit('close', 1006) }
  }
  const transport = new CodexLiveTransport({
    native: { LiveWebRtcPeer: Peer }, signal: controller.signal,
    sessionId: 'tau-test-session', instructions: 'Voice instructions', voice: 'sol',
    access: async force => { state.refreshes.push(force); return { accessToken: force ? 'refreshed-session-token' : 'session-token', accountId: 'test-account' } },
    post: async (body, headers, signal) => {
      state.posts.push({ body: JSON.parse(body), headers, signal })
      if (overrides.post) return overrides.post(body, headers, signal, state.posts.length)
      return { status: 201, body: 'v=0\r\nmock-answer', location: '/v1/realtime/calls/rtc_test-123' }
    },
    socket: (url, headers) => {
      const socket = new Socket()
      socket.url = url
      socket.headers = headers
      state.sockets.push(socket)
      if (!overrides.stallSocket) queueMicrotask(() => { socket.readyState = 1; socket.emit('open') })
      return socket
    },
    callbacks: { onEvent: event => state.events.push(event), onOutputLevel: level => state.levels.push(level) },
  })
  t.after(() => transport.close())
  return { transport, state, controller }
}

test('signaling uses the OMP live model/voice/protocol and the ChatGPT session credential', async t => {
  const { transport, state } = fixture(t)
  await transport.connect()
  const { body, headers } = state.posts[0]
  assert.equal(body.session.model, 'gpt-live-1-codex')
  assert.deepEqual(body.session.audio, { output: { voice: 'sol' } })
  assert.deepEqual(body.session.delegation, { type: 'client' })
  assert.equal(headers.Authorization, 'Bearer session-token')
  assert.equal(headers['chatgpt-account-id'], 'test-account')
  assert.equal(headers['OpenAI-Alpha'], 'quicksilver=v2')
  assert.equal(state.sockets[0].url, 'wss://api.openai.com/v1/live/rtc_test-123')
  assert.deepEqual(state.sockets[0].headers, headers)
  assert.ok(state.peers[0].muted.every(value => value === true), 'connection never arms microphone input')
})

test('401/403 refresh exactly once; the sideband receives the fresh token', async t => {
  const { transport, state } = fixture(t, { post: (_body, _headers, _signal, attempt) => attempt === 1
    ? { status: 401, body: 'expired', location: null }
    : { status: 201, body: 'v=0\r\nanswer', location: '/rtc_fresh' } })
  await transport.connect()
  assert.deepEqual(state.refreshes, [false, true])
  assert.equal(state.sockets[0].headers.Authorization, 'Bearer refreshed-session-token')
})

test('missing account access produces a login/access error and closes native state', async t => {
  const { transport, state } = fixture(t, { post: () => ({ status: 403, body: 'denied', location: null }) })
  await assert.rejects(transport.connect(), /account must have access/)
  assert.equal(state.posts.length, 2)
  assert.equal(state.peers[0].closed, 1)
  assert.equal(state.sockets.length, 0)
})

test('invalid call identifiers/SDP never reach the native answer or sideband', async t => {
  assert.equal(parseLiveCallId('https://example.test/v1/rtc_good-2?x=1'), 'rtc_good-2')
  assert.equal(parseLiveCallId('/rtc_bad%2Fpath'), undefined)
  const { transport, state } = fixture(t, { post: () => ({ status: 201, body: '<html>error</html>', location: '/rtc_ok' }) })
  await assert.rejects(transport.connect(), /invalid call or SDP/)
  assert.equal(state.peers[0].answer, undefined)
  assert.equal(state.sockets.length, 0)
})

test('/bye aborts a pending HTTP offer and releases the native peer', async t => {
  const { transport, state, controller } = fixture(t, { post: (_body, _headers, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  const connecting = transport.connect()
  const rejected = assert.rejects(connecting, /Voice stopped/)
  await tick()
  controller.abort()
  await rejected
  assert.equal(state.peers[0].closed, 1)
})

test('/bye during sideband handshake cancels retries and closes all resources', async t => {
  const { transport, state, controller } = fixture(t, { stallSocket: true })
  const connecting = transport.connect()
  const rejected = assert.rejects(connecting, /Voice stopped/)
  await tick()
  controller.abort()
  await rejected
  assert.equal(state.sockets.length, 1)
  assert.equal(state.sockets[0].terminated, 1)
  assert.equal(state.peers[0].closed, 1)
})

test('sideband events deduplicate WebRTC events and ordered sends preserve chunk order', async t => {
  const { transport, state } = fixture(t)
  await transport.connect()
  const payload = JSON.stringify({ type: 'turn.done', turn: { role: 'user', transcript: 'Hello' } })
  state.sockets[0].emit('message', Buffer.from(payload), false)
  state.peers[0].event(null, payload)
  assert.equal(state.events.length, 1)
  await Promise.all([transport.send({ type: 'session.context.append', content: [{ type: 'input_text', text: 'one' }] }), transport.send({ type: 'session.context.append', content: [{ type: 'input_text', text: 'two' }] })])
  assert.deepEqual(state.sockets[0].sent.map(message => message.content[0].text), ['one', 'two'])
  transport.pushAudio(Float32Array.of(1))
  assert.equal(state.peers[0].audio.length, 0)
  transport.setMuted(false)
  transport.pushAudio(Float32Array.of(1))
  assert.equal(state.peers[0].audio.length, 1)
  await transport.close()
  state.peers[0].failure(null, 'late error')
  assert.equal(state.events.length, 1)
  await assert.rejects(transport.send({ type: 'session.close' }), /disconnected/)
})
