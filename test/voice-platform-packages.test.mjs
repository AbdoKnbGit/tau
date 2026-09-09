import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { VOICE_TARGETS, addonVersion, manifestFor, packageNameFor, syncRootOptionalDependencies } from '../release/sync-voice-packages.mjs'
import { NATIVE_VOICE_TARGETS, resolveNativeVoiceArtifact, voicePackageNameFor } from '../scripts/native-voice.mjs'
import { applySplit } from '../release/publish-voice-release.mjs'

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

test('the checked-in package manifests match the generator and the addon version', () => {
  const version = addonVersion()
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

test('every declared platform pin tracks the addon version, not Tau’s', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const addon = addonVersion()
  const declared = Object.entries(pkg.optionalDependencies ?? {})
    .filter(([name]) => name.startsWith('@abdoknbgit/tau-voice-'))
  // Tolerated before the six are published; strict the moment they are pinned.
  if (declared.length) {
    assert.equal(declared.length, VOICE_TARGETS.length, 'some platforms are pinned and others are not')
    for (const [name, range] of declared) {
      assert.equal(range, addon, `${name} is pinned at ${range} but the addon is ${addon}`)
    }
  }
})

test('the addon version is independent of Tau’s, so unrelated releases publish nothing', () => {
  const addon = addonVersion()
  assert.match(addon, /^\d+\.\d+\.\d+$/)
  // Not an assertion that they differ -- only that nothing derives one from the
  // other. Sharing Tau's version would force six republishes per Tau release.
  const source = readFileSync('release/sync-voice-packages.mjs', 'utf8')
  assert.doesNotMatch(source, /package\.json'\), 'utf8'\)\)\.version/, 'addon version must not be read from package.json')
  assert.equal(manifestFor(VOICE_TARGETS[0], addon).version, addon)
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

test('the release step pins every platform and stops bundling the addons', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tau-split-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const manifestPath = join(dir, 'package.json')
  const ignorePath = join(dir, '.npmignore')
  writeFileSync(manifestPath, JSON.stringify({
    name: '@abdoknbgit/tau', version: '1.2.3',
    optionalDependencies: { 'node-pty': '^1.1.0' },
  }, null, 2))
  writeFileSync(ignorePath, ['/target/', '/.tools/', ''].join('\n'))

  applySplit('1.2.3', { manifestPath, ignorePath })
  const pinned = JSON.parse(readFileSync(manifestPath, 'utf8')).optionalDependencies
  for (const entry of VOICE_TARGETS) {
    assert.equal(pinned[packageNameFor(entry.target)], '1.2.3', `${entry.target} not pinned`)
  }
  // Unrelated optional dependencies survive.
  assert.equal(pinned['node-pty'], '^1.1.0')
  // Only the addons leave the tarball; the rest of native/ must stay.
  const ignore = readFileSync(ignorePath, 'utf8')
  assert.match(ignore, /^\/bin\/$/m)
  assert.match(ignore, /^\/target\/$/m)

  // Re-running a release must not duplicate pins or ignore rules.
  applySplit('1.2.3', { manifestPath, ignorePath })
  const again = readFileSync(manifestPath, 'utf8')
  assert.equal(again.match(/tau-voice-win32-x64/g).length, 1, 'pin was duplicated on re-run')
  assert.equal(readFileSync(ignorePath, 'utf8').match(/^\/bin\/$/gm).length, 1, 'ignore rule duplicated')

  // A later version re-pins rather than stacking entries.
  applySplit('1.3.0', { manifestPath, ignorePath })
  const bumped = JSON.parse(readFileSync(manifestPath, 'utf8')).optionalDependencies
  assert.equal(bumped[packageNameFor('win32-x64')], '1.3.0')
  assert.equal(Object.keys(bumped).length, VOICE_TARGETS.length + 1)
})
