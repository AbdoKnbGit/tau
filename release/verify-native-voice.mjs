#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_VOICE_TARGETS = [
  'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64',
]
export const NATIVE_VOICE_FILES = NATIVE_VOICE_TARGETS.map(target => `tau_voice.${target}.node`)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultBinDir = join(repositoryRoot, 'native', 'tau-voice', 'bin')

function validateBinary(data, target, name) {
  if (data.length < 4096) throw new Error(`Native voice artifact is empty or truncated: ${name}`)
  const arm = target.endsWith('-arm64')
  let matches = false
  if (target.startsWith('linux-')) {
    matches = data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && data[4] === 2 && data[5] === 1
      && data.readUInt16LE(18) === (arm ? 0xb7 : 0x3e)
  } else if (target.startsWith('darwin-')) {
    matches = data.readUInt32LE(0) === 0xfeedfacf
      && data.readUInt32LE(4) === (arm ? 0x0100000c : 0x01000007)
  } else {
    const peOffset = data.readUInt32LE(0x3c)
    matches = data.subarray(0, 2).toString('ascii') === 'MZ'
      && peOffset <= data.length - 6
      && data.readUInt32LE(peOffset) === 0x00004550
      && data.readUInt16LE(peOffset + 4) === (arm ? 0xaa64 : 0x8664)
  }
  if (!matches) throw new Error(`Native voice artifact has the wrong format or architecture: ${name}`)
}

function inspectArtifacts(binDir) {
  let present
  try { present = readdirSync(binDir) } catch {
    throw new Error('Native voice binaries are missing. Build and collect all six native voice targets before publishing.')
  }
  const extra = present.filter(name => name.endsWith('.node') && !NATIVE_VOICE_FILES.includes(name))
  if (extra.length) throw new Error(`Unexpected native voice binaries: ${extra.join(', ')}`)
  const artifacts = {}
  for (const [index, name] of NATIVE_VOICE_FILES.entries()) {
    if (!present.includes(name)) throw new Error(`Native voice release is incomplete: missing ${name}`)
    const data = readFileSync(join(binDir, name))
    validateBinary(data, NATIVE_VOICE_TARGETS[index], name)
    artifacts[name] = { sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
  }
  return artifacts
}

export function writeNativeVoiceManifest({ binDir = defaultBinDir } = {}) {
  const manifest = { version: 1, voiceAbiVersion: 1, napiVersion: 8, artifacts: inspectArtifacts(binDir) }
  writeFileSync(join(binDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function verifyNativeVoice({ binDir = defaultBinDir } = {}) {
  const actual = inspectArtifacts(binDir)
  let manifest
  try { manifest = JSON.parse(readFileSync(join(binDir, 'manifest.json'), 'utf8')) } catch {
    throw new Error('Native voice manifest is missing or invalid. Collect the verified native voice workflow artifact before publishing.')
  }
  if (manifest?.version !== 1 || manifest.voiceAbiVersion !== 1 || manifest.napiVersion !== 8
      || !manifest.artifacts || Array.isArray(manifest.artifacts)) {
    throw new Error('Native voice manifest has an unsupported format or ABI.')
  }
  const entries = Object.keys(manifest.artifacts)
  if (entries.length !== NATIVE_VOICE_FILES.length || entries.some(name => !NATIVE_VOICE_FILES.includes(name))) {
    throw new Error('Native voice manifest must contain exactly the six supported artifacts.')
  }
  for (const name of NATIVE_VOICE_FILES) {
    if (manifest.artifacts[name]?.sha256 !== actual[name].sha256
        || manifest.artifacts[name]?.size !== actual[name].size) {
      throw new Error(`Native voice integrity check failed: ${name}`)
    }
  }
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => arg !== '--write-manifest')) throw new Error('Usage: node release/verify-native-voice.mjs [--write-manifest]')
    if (args.includes('--write-manifest')) writeNativeVoiceManifest()
    verifyNativeVoice()
    process.stdout.write('Native voice release verified: six targets, N-API 8, SHA-256 integrity.\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 1
  }
}
