import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VOICE_TARGETS, manifestFor, packageNameFor, syncRootOptionalDependencies } from '../release/sync-voice-packages.mjs'
import { NATIVE_VOICE_TARGETS, resolveNativeVoiceArtifact, voicePackageNameFor } from '../scripts/native-voice.mjs'

test('a package is declared for exactly the supported targets', () => {
  assert.deepEqual(VOICE_TARGETS.map(t => t.target).sort(), [...NATIVE_VOICE_TARGETS].sort())
  for (const entry of VOICE_TARGETS) {
    const manifest = manifestFor(entry, '9.9.9')
    // os/cpu are what make npm skip the five a host cannot load.
    assert.deepEqual(manifest.os, [entry.os])
    assert.deepEqual(manifest.cpu, [entry.cpu])
    assert.equal(manifest.version, '9.9.9')
    assert.equal(manifest.name, voicePackageNameFor(entry.target))
    // Attribution must travel with the binary; the engine is MIT from OMP.
    for (const required of [`tau_voice.${entry.target}.node`, 'manifest.json', 'LICENSE-OMP', 'THIRD_PARTY_NOTICES.md']) {
      assert.ok(manifest.files.includes(required), `${entry.target} omits ${required}`)
    }
  }
})

test('the checked-in package manifests match the generator and the root version', () => {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  for (const entry of VOICE_TARGETS) {
    const path = join('platform-packages', `tau-voice-${entry.target}`, 'package.json')
    assert.ok(existsSync(path), `${path} is missing; run node release/sync-voice-packages.mjs`)
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(onDisk, manifestFor(entry, version), `${path} is stale`)
  }
})

test('a published install prefers its platform package over the release directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'tau-voice-pkg-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = 'linux-x64'
  const file = `tau_voice.${target}.node`
  // Both layouts present: the packaged one must win.
  const bin = join(root, 'native', 'tau-voice', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, file), 'release-staging')
  const pkg = join(root, 'node_modules', packageNameFor(target).replace('/', '-'))
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, file), 'from-package')

  const packaged = resolveNativeVoiceArtifact(root, target, {
    require: { resolve: id => { assert.equal(id, `${packageNameFor(target)}/${file}`); return join(pkg, file) } },
  })
  assert.equal(packaged.packaged, true)
  assert.equal(readFileSync(packaged.path, 'utf8'), 'from-package')
  // The manifest is read from wherever the binary was found.
  assert.equal(packaged.directory, pkg)
})

test('a source checkout still resolves the release directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'tau-voice-src-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const target = 'linux-x64'
  const bin = join(root, 'native', 'tau-voice', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, `tau_voice.${target}.node`), 'release-staging')
  const missing = { resolve: () => { throw new Error('MODULE_NOT_FOUND') } }
  const fallback = resolveNativeVoiceArtifact(root, target, { require: missing })
  assert.equal(fallback.packaged, false)
  assert.equal(fallback.directory, bin)
  assert.equal(readFileSync(fallback.path, 'utf8'), 'release-staging')
})

test('every declared platform pin tracks the root version', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const declared = Object.entries(pkg.optionalDependencies ?? {})
    .filter(([name]) => name.startsWith('@abdoknbgit/tau-voice-'))
  // Tolerated before the six are published; strict the moment they are pinned.
  if (declared.length) {
    assert.equal(declared.length, VOICE_TARGETS.length, 'some platforms are pinned and others are not')
    for (const [name, range] of declared) {
      assert.equal(range, pkg.version, `${name} is pinned at ${range} but Tau is ${pkg.version}`)
    }
  }
})

test('a version bump re-pins every platform dependency', t => {
  const file = join(mkdtempSync(join(tmpdir(), 'tau-pin-')), 'package.json')
  t.after(() => rmSync(join(file, '..'), { recursive: true, force: true }))
  const pins = Object.fromEntries(VOICE_TARGETS.map(e => [packageNameFor(e.target), '0.0.1']))
  writeFileSync(file, JSON.stringify({ name: '@abdoknbgit/tau', version: '9.9.9', optionalDependencies: { ...pins, 'node-pty': '^1.1.0' } }, null, 2))

  assert.equal(syncRootOptionalDependencies('9.9.9', file), true)
  const updated = JSON.parse(readFileSync(file, 'utf8'))
  for (const entry of VOICE_TARGETS) {
    assert.equal(updated.optionalDependencies[packageNameFor(entry.target)], '9.9.9', `${entry.target} was left behind`)
  }
  // Unrelated optional dependencies must not be touched.
  assert.equal(updated.optionalDependencies['node-pty'], '^1.1.0')
  // Running it again is a no-op, so it is safe in a release script.
  assert.equal(syncRootOptionalDependencies('9.9.9', file), false)
})
