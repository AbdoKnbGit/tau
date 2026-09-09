#!/usr/bin/env node
/**
 * Generates the six per-platform voice packages from the release binaries.
 *
 * Tau ships one tarball for every OS, so bundling all six addons made every
 * user download five they can never load. Each binary now lives in its own
 * package carrying `os`/`cpu`, declared by Tau as an optional dependency, so
 * npm installs only the matching one.
 *
 * The binaries themselves are build output and stay untracked: this script
 * copies them in from `native/tau-voice/bin` at release time and checks each
 * one against the signed manifest first. The package manifests it writes are
 * tracked, so `npm ci` can link the workspaces before any binary exists.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'native', 'tau-voice', 'bin')

export const VOICE_TARGETS = [
  { target: 'win32-x64', os: 'win32', cpu: 'x64', label: 'Windows x64' },
  { target: 'win32-arm64', os: 'win32', cpu: 'arm64', label: 'Windows arm64' },
  { target: 'darwin-x64', os: 'darwin', cpu: 'x64', label: 'macOS Intel' },
  { target: 'darwin-arm64', os: 'darwin', cpu: 'arm64', label: 'macOS Apple silicon' },
  { target: 'linux-x64', os: 'linux', cpu: 'x64', label: 'Linux x64 (glibc)' },
  { target: 'linux-arm64', os: 'linux', cpu: 'arm64', label: 'Linux arm64 (glibc)' },
]

export const packageNameFor = target => `@abdoknbgit/tau-voice-${target}`
export const packageDirFor = target => join(root, 'platform-packages', `tau-voice-${target}`)

/** The manifest each package.json declares, kept identical across releases. */
export function manifestFor({ target, os, cpu, label }, version) {
  const file = `tau_voice.${target}.node`
  return {
    name: packageNameFor(target),
    version,
    description: `Native audio and WebRTC engine for Tau voice (${label}).`,
    license: 'MIT',
    os: [os],
    cpu: [cpu],
    // Attribution travels with the binary: the engine is extracted from OMP.
    files: [file, 'manifest.json', 'LICENSE-OMP', 'THIRD_PARTY_NOTICES.md'],
    publishConfig: { access: 'public' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/AbdoKnbGit/tau.git',
      directory: `platform-packages/tau-voice-${target}`,
    },
    engines: { node: '>=20.19.0 <21.0.0 || >=22.12.0' },
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Writes the six package manifests. Binaries are copied only with `--binaries`. */
export function syncVoicePackages({ version, withBinaries = false } = {}) {
  const resolved = version ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const manifest = withBinaries
    ? JSON.parse(readFileSync(join(binDir, 'manifest.json'), 'utf8'))
    : null
  const written = []
  for (const entry of VOICE_TARGETS) {
    const directory = packageDirFor(entry.target)
    mkdirSync(directory, { recursive: true })
    writeJson(join(directory, 'package.json'), manifestFor(entry, resolved))
    // Build output must never be committed; the manifest is.
    writeFileSync(join(directory, '.gitignore'), `tau_voice.${entry.target}.node
manifest.json
`)
    for (const notice of ['LICENSE-OMP', 'THIRD_PARTY_NOTICES.md']) {
      copyFileSync(join(root, 'native', 'tau-voice', notice), join(directory, notice))
    }
    if (withBinaries) {
      const file = `tau_voice.${entry.target}.node`
      const source = join(binDir, file)
      if (!existsSync(source)) throw new Error(`Missing release binary ${file}. Collect the native voice workflow artifact first.`)
      const data = readFileSync(source)
      const expected = manifest.artifacts?.[file]
      const sha256 = createHash('sha256').update(data).digest('hex')
      if (expected?.sha256 !== sha256 || expected?.size !== data.length) {
        throw new Error(`Release binary ${file} does not match the signed manifest.`)
      }
      copyFileSync(source, join(directory, file))
      // The same manifest shape as the release directory, narrowed to this one
      // artifact, so verification does not care where the binary came from.
      writeJson(join(directory, 'manifest.json'), {
        version: manifest.version, voiceAbiVersion: manifest.voiceAbiVersion,
        napiVersion: manifest.napiVersion, artifacts: { [file]: expected },
      })
    }
    written.push(packageNameFor(entry.target))
  }
  return { version: resolved, packages: written }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const withBinaries = process.argv.includes('--binaries')
  const { version, packages } = syncVoicePackages({ withBinaries })
  process.stdout.write(`Synced ${packages.length} voice packages at ${version}${withBinaries ? ' with binaries' : ' (manifests only)'}.\n`)
}
