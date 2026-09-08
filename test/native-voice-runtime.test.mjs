import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativeVoiceTarget, nativeVoiceLoadPath, verifyNativeVoice } from '../scripts/native-voice.mjs'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tau-audio-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'native', 'tau-voice', 'bin')
  mkdirSync(bin, { recursive: true })
  const file = 'tau_voice.win32-x64.node'
  const data = Buffer.from('test artifact bytes')
  writeFileSync(join(bin, file), data)
  const manifest = { version: 1, voiceAbiVersion: 1, napiVersion: 8, artifacts: { [file]: { sha256: createHash('sha256').update(data).digest('hex'), size: data.length } } }
  writeFileSync(join(bin, 'manifest.json'), JSON.stringify(manifest))
  return { root, bin, file, data, manifest }
}
test('installed audio verifies and stages without Rust or any executable on PATH', t => {
  const { root, bin, file, data } = fixture(t)
  const oldPath = process.env.PATH
  try {
    process.env.PATH = ''
    const options = { target: 'win32-x64', platform: 'win32', cacheRoot: join(root, 'cache') }
    const staged = nativeVoiceLoadPath(root, options)
    assert.notEqual(staged, join(bin, file), 'loaded Windows DLL must not lock installed package')
    assert.deepEqual(readFileSync(staged), data)
    assert.equal(nativeVoiceLoadPath(root, options), staged)
  } finally { process.env.PATH = oldPath }
})
test('missing or corrupt installed audio fails with actionable errors', t => {
  const { root, bin, file } = fixture(t)
  writeFileSync(join(bin, file), 'corrupt')
  assert.throws(() => verifyNativeVoice(root, { target: 'win32-x64' }), /integrity.*Reinstall/)
  assert.throws(() => verifyNativeVoice(root, { target: 'darwin-arm64' }), /missing.*Reinstall/)
})
test('changed binaries stage to a different cache so an update does not overwrite a loaded DLL', t => {
  const { root, bin, file, manifest } = fixture(t)
  const options = { target: 'win32-x64', platform: 'win32', cacheRoot: join(root, 'cache') }
  const before = nativeVoiceLoadPath(root, options)
  const data = Buffer.from('updated native bytes')
  writeFileSync(join(bin, file), data)
  manifest.artifacts[file] = { sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
  writeFileSync(join(bin, 'manifest.json'), JSON.stringify(manifest))
  const after = nativeVoiceLoadPath(root, options)
  assert.notEqual(before, after)
  assert.deepEqual(readFileSync(after), data)
})
test('unsupported CPU/libc gets an explicit error instead of a compiler install', () => {
  // Explicit absence: undefined would invoke the default host libc detector.
  assert.throws(() => nativeVoiceTarget('linux', 'x64', ''), /musl/)
  assert.throws(() => nativeVoiceTarget('win32', 'ia32'), /does not yet support/)
  assert.equal(nativeVoiceTarget('linux', 'arm64', '2.28'), 'linux-arm64')
})
