import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

process.env.TAU_VOICE_CONNECT_TIMEOUT_MS = '120'
const bundle = await build({ entryPoints: ['src/voice/liveSession.ts'], bundle: true, packages: 'external', write: false, format: 'cjs', platform: 'node', target: 'node20' })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { LiveVoiceSession } = module.exports

const never = () => new Promise(() => {})

test('a stalled startup fails on a deadline instead of hanging forever', async () => {
  const session = new LiveVoiceSession({ createTransport: () => never(), capture: () => ({ stop() {} }) })
  await assert.rejects(session.start(), /gave up after/)
  // The prompt must be usable again, not stuck reporting "connecting".
  assert.equal(session.getSnapshot().phase, 'error')
  assert.match(session.getSnapshot().error, /gave up after/)
})

test('the timeout names the step that was outstanding', async () => {
  // Stall inside connect(), after the transport reported a later stage.
  const session = new LiveVoiceSession({
    createTransport: (_callbacks, _signal, stage) => {
      stage?.('asking ChatGPT to open the call')
      return { connect: never, close: async () => {}, setMuted() {}, clearOutput() {}, pushAudio() {}, send: async () => {} }
    },
    capture: () => ({ stop() {} }),
  })
  await assert.rejects(session.start(), /while asking ChatGPT to open the call/)
})

test('a startup that completes in time clears the deadline', async () => {
  const transport = { connect: async () => {}, close: async () => {}, setMuted() {}, clearOutput() {}, pushAudio() {}, send: async () => {} }
  const session = new LiveVoiceSession({ createTransport: () => transport, capture: () => ({ stop() {} }) })
  await session.start()
  assert.equal(session.getSnapshot().phase, 'ready')
  // Well past the 120 ms deadline: a stray timer must not tear down a live call.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(session.getSnapshot().phase, 'ready')
  assert.equal(session.getSnapshot().error, null)
  await session.stop()
})
