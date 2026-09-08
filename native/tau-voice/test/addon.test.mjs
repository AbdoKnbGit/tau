import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const addon = fileURLToPath(new URL(`../bin/tau_voice.${process.platform}-${process.arch}.node`, import.meta.url))
const voice = require(addon)

test('built addon exports the supported N-API voice interface', t => {
  t.diagnostic(`Node ${process.versions.node}, N-API ${process.versions.napi}`)
  assert.equal(voice.voiceAbiVersion(), 1)
  for (const name of ['AudioCapture', 'AudioPlayback', 'LiveWebRtcPeer']) {
    assert.equal(typeof voice[name], 'function', name)
  }
  assert.equal(typeof voice.AudioCapture.prototype.drain, 'function')
  for (const method of ['createOffer', 'acceptAnswer', 'waitForOpen', 'pushAudio', 'setMuted', 'clearOutput', 'close']) {
    assert.equal(typeof voice.LiveWebRtcPeer.prototype[method], 'function', method)
  }
})

test('addon loads without compiler, codec, or helper executables on PATH', () => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = ''
  const result = spawnSync(process.execPath, ['-e', `const v=require(${JSON.stringify(addon)});if(v.voiceAbiVersion()!==1)process.exit(2)`], {
    env, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
})

test('Windows artifact does not import an external MSVC runtime', { skip: process.platform !== 'win32' }, () => {
  const bytes = readFileSync(addon).toString('latin1')
  assert.doesNotMatch(bytes, /VCRUNTIME\d+(?:_\d+)?\.dll/i)
  assert.doesNotMatch(bytes, /MSVCP\d+(?:_\d+)?\.dll/i)
})

test('invalid sample rates fail before accessing hardware', () => {
  assert.throws(() => new voice.AudioCapture(1, () => {}), /Unsupported audio sample rate/)
  assert.throws(() => new voice.AudioPlayback(1), /Unsupported audio sample rate/)
})

test('idle peer can mute, interrupt, and close repeatedly without audio devices', async () => {
  const peer = new voice.LiveWebRtcPeer(() => {}, () => {}, () => {})
  peer.setMuted(true)
  peer.pushAudio(new Float32Array(320))
  peer.clearOutput()
  await peer.close()
  await peer.close()
  await assert.rejects(peer.waitForOpen(50), /closed/)
})
