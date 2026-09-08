import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  NATIVE_VOICE_FILES, NATIVE_VOICE_TARGETS, verifyNativeVoice, writeNativeVoiceManifest,
} from '../release/verify-native-voice.mjs'

function fixture(t) {
  const binDir = mkdtempSync(join(tmpdir(), 'tau-native-voice-packaging-'))
  t.after(() => rmSync(binDir, { recursive: true, force: true }))
  for (const [index, target] of NATIVE_VOICE_TARGETS.entries()) {
    const data = Buffer.alloc(4096)
    const arm = target.endsWith('-arm64')
    if (target.startsWith('linux-')) {
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(data)
      data.writeUInt16LE(arm ? 0xb7 : 0x3e, 18)
    } else if (target.startsWith('darwin-')) {
      data.writeUInt32LE(0xfeedfacf)
      data.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4)
    } else {
      data.write('MZ')
      data.writeUInt32LE(0x80, 0x3c)
      data.writeUInt32LE(0x00004550, 0x80)
      data.writeUInt16LE(arm ? 0xaa64 : 0x8664, 0x84)
    }
    writeFileSync(join(binDir, NATIVE_VOICE_FILES[index]), data)
  }
  return { binDir }
}

test('a complete universal artifact collection verifies against its manifest', t => {
  const options = fixture(t)
  const manifest = writeNativeVoiceManifest(options)
  assert.deepEqual(verifyNativeVoice(options), manifest)
  assert.equal(Object.keys(manifest.artifacts).length, 6)
  assert.equal(manifest.napiVersion, 8)
})

test('a missing platform prevents both manifest creation and release', t => {
  const options = fixture(t)
  writeNativeVoiceManifest(options)
  unlinkSync(join(options.binDir, NATIVE_VOICE_FILES[5]))
  assert.throws(() => writeNativeVoiceManifest(options), /incomplete/)
  assert.throws(() => verifyNativeVoice(options), /incomplete/)
})

test('modified bytes fail integrity verification', t => {
  const options = fixture(t)
  writeNativeVoiceManifest(options)
  const path = join(options.binDir, NATIVE_VOICE_FILES[0])
  const data = readFileSync(path)
  data[data.length - 1] = 1
  writeFileSync(path, data)
  assert.throws(() => verifyNativeVoice(options), /integrity check failed/)
})

test('a copied x64 binary cannot masquerade as an arm64 build', t => {
  const options = fixture(t)
  writeFileSync(join(options.binDir, NATIVE_VOICE_FILES[1]), readFileSync(join(options.binDir, NATIVE_VOICE_FILES[0])))
  assert.throws(() => writeNativeVoiceManifest(options), /wrong format or architecture/)
})

test('missing, malformed, or incompatible manifests stop release', t => {
  const options = fixture(t)
  const path = join(options.binDir, 'manifest.json')
  assert.throws(() => verifyNativeVoice(options), /manifest is missing/)
  writeFileSync(path, '{')
  assert.throws(() => verifyNativeVoice(options), /manifest is missing or invalid/)
  const manifest = writeNativeVoiceManifest(options)
  manifest.napiVersion = 10
  writeFileSync(path, JSON.stringify(manifest))
  assert.throws(() => verifyNativeVoice(options), /unsupported format or ABI/)
})

test('unexpected binaries and extra manifest entries stop release', t => {
  const options = fixture(t)
  const manifest = writeNativeVoiceManifest(options)
  manifest.artifacts['../outside.node'] = { sha256: '0'.repeat(64), size: 4096 }
  writeFileSync(join(options.binDir, 'manifest.json'), JSON.stringify(manifest))
  assert.throws(() => verifyNativeVoice(options), /exactly the six/)
  writeFileSync(join(options.binDir, 'unreviewed.node'), Buffer.alloc(4096))
  assert.throws(() => writeNativeVoiceManifest(options), /Unexpected native voice binaries/)
})
