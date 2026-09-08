import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

async function importBundle(options) {
  const output = await build({ bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20', ...options })
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
}

const { LiveVoiceSession } = await importBundle({ entryPoints: ['src/voice/liveSession.ts'] })
const tick = () => new Promise(resolve => setImmediate(resolve))

function deferredCloseSession() {
  let callbacks
  let close
  const closed = new Promise(resolve => { close = resolve })
  const session = new LiveVoiceSession({
    createTransport(nextCallbacks) {
      callbacks = nextCallbacks
      return {
        async connect() {},
        close: () => closed,
        setMuted() {}, clearOutput() {}, pushAudio() {}, async send() {},
      }
    },
    capture() { throw new Error('Audit does not open hardware') },
  })
  return { session, close, fail: () => callbacks.onEvent({ type: 'error', message: 'Earlier connection failure' }) }
}

test('explicit /bye during failed-session teardown keeps voice off', async () => {
  const { session, close, fail } = deferredCloseSession()
  await session.start()
  fail()
  await tick()
  const stopped = session.stop()
  close()
  await stopped
  await tick()
  assert.equal(session.getSnapshot().phase, 'off')
  assert.equal(session.getSnapshot().error, null)
})

test('a current connection failure is still surfaced after teardown', async () => {
  const { session, close, fail } = deferredCloseSession()
  await session.start()
  fail()
  close()
  await tick()
  assert.equal(session.getSnapshot().phase, 'error')
  assert.equal(session.getSnapshot().error, 'Earlier connection failure')
})

test('a new /hey takes precedence over an earlier failure finishing shutdown', async () => {
  const { session, close, fail } = deferredCloseSession()
  await session.start()
  fail()
  const restarted = session.start()
  close()
  await restarted
  await tick()
  assert.equal(session.getSnapshot().phase, 'ready')
  assert.equal(session.getSnapshot().error, null)
  await session.stop()
})

async function nativeLoader(abi) {
  return importBundle({
    stdin: {
      contents: `export { loadNativeVoice } from ${JSON.stringify(resolve('src/voice/nativeVoice.ts'))};`,
      resolveDir: process.cwd(), loader: 'ts',
    },
    plugins: [{
      name: 'native-loader-without-disk-or-hardware',
      setup(builder) {
        builder.onResolve({ filter: /^(?:node:module)$|(?:scripts\/native-voice\.mjs|utils\/installIntegrity\.js)$/ },
          ({ path }) => ({ path, namespace: 'fake-native' }))
        builder.onLoad({ filter: /.*/, namespace: 'fake-native' }, ({ path }) => ({
          contents: path === 'node:module'
            ? `export const createRequire = () => () => ({ voiceAbiVersion: ${abi === undefined ? 'undefined' : `() => ${abi}`}, AudioCapture: class {}, LiveWebRtcPeer: class {} });`
            : path.endsWith('installIntegrity.js')
              ? `export const getRunningPackageRoot = () => '/isolated-test';`
              : `export const nativeVoiceLoadPath = () => '/isolated-test/fake.node';`,
          loader: 'js',
        }))
      },
    }],
  })
}

test('runtime refuses a source-build addon with missing or incompatible ABI', async () => {
  for (const abi of [undefined, 0, 2]) {
    const loader = await nativeLoader(abi)
    assert.throws(() => loader.loadNativeVoice(), /Tau audio is incompatible/)
  }
})

test('runtime accepts the declared ABI and caches the verified native module', async () => {
  const loader = await nativeLoader(1)
  const addon = loader.loadNativeVoice()
  assert.equal(addon.voiceAbiVersion(), 1)
  assert.equal(loader.loadNativeVoice(), addon)
})
