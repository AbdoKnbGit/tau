#!/usr/bin/env node
/**
 * Publishes a Tau release in the only order that works.
 *
 * Tau declares the six per-platform voice addons as optional dependencies, and
 * the production shrinkwrap gate refuses a direct optional dependency it cannot
 * resolve. The addons must therefore reach the registry before Tau does. Doing
 * that by hand is six publishes, a manifest edit, a lockfile refresh and a
 * shrinkwrap regeneration in a specific order; getting it wrong ships a Tau
 * that installs without voice.
 *
 * Dry run by default. Pass --publish to perform it. Safe to re-run: anything
 * already on the registry at this version is skipped, and the repository edits
 * are idempotent.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VOICE_TARGETS, addonVersion, packageDirFor, packageNameFor, syncVoicePackages } from './sync-voice-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const live = process.argv.includes('--publish')
const step = message => process.stdout.write(`\n== ${message}\n`)
const note = message => process.stdout.write(`   ${message}\n`)

// npm is a .cmd shim on Windows, which Node will not exec directly, and going
// through a shell concatenates arguments instead of escaping them. npm exports
// the path to its own JS entry point, so run that with the current Node and
// avoid both problems. Falls back to a shell only when that is unavailable.
const npmEntry = process.env.npm_execpath && process.env.npm_execpath.endsWith('.js')
  ? process.env.npm_execpath
  : null

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const viaNpmEntry = command === 'npm' && npmEntry
  const options = {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit',
  }
  if (command === 'npm' && !npmEntry && process.platform === 'win32') options.shell = true
  const result = viaNpmEntry
    ? spawnSync(process.execPath, [npmEntry, ...args], options)
    : spawnSync(command, args, options)
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed${capture ? `: ${(result.stderr || '').trim()}` : ''}`)
  }
  return { status: result.status, stdout: (result.stdout || '').trim() }
}

const readPackage = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function publishedAlready(name, version) {
  const { status, stdout } = run('npm', ['view', `${name}@${version}`, 'version'], { capture: true, allowFailure: true })
  return status === 0 && stdout.includes(version)
}

/** Declares the six pins and stops bundling their binaries in Tau's own tarball. */
export function applySplit(version, paths = {}) {
  const manifestPath = paths.manifestPath ?? join(root, 'package.json')
  const source = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(source)
  const stale = VOICE_TARGETS
    .map(entry => packageNameFor(entry.target))
    .some(name => manifest.optionalDependencies?.[name] !== version)
  if (stale) {
    // Rewrite the block wholesale so re-runs cannot leave duplicate pins.
    const pins = VOICE_TARGETS.map(entry => `    "${packageNameFor(entry.target)}": "${version}",\n`).join('')
    const anchor = '  "optionalDependencies": {\n'
    const stripped = source.replace(/^ {4}"@abdoknbgit\/tau-voice-[^"]+": "[^"]*",\n/gm, '')
    writeFileSync(manifestPath, stripped.replace(anchor, anchor + pins))
  }
  // native/ must stay published: the shell-parser and tau-tools go.mod files are
  // required in the tarball. Only the addon binaries are excluded.
  const ignorePath = paths.ignorePath ?? join(root, 'native', 'tau-voice', '.npmignore')
  const ignore = readFileSync(ignorePath, 'utf8')
  if (!/^\/bin\/$/m.test(ignore)) writeFileSync(ignorePath, `${ignore.replace(/\n*$/, '')}\n/bin/\n`)
}

function main() {
  const version = readPackage().version
  const addon = addonVersion()
  step(`Tau ${version} with voice addons ${addon} -- ${live ? 'PUBLISHING' : 'dry run (pass --publish to perform)'}`)

  step('1. Preflight')
  const who = run('npm', ['whoami'], { capture: true, allowFailure: true })
  if (who.status !== 0) throw new Error('Not logged in to npm. Run `npm login` first.')
  note(`npm user: ${who.stdout}`)

  const outstanding = VOICE_TARGETS.filter(entry => !publishedAlready(packageNameFor(entry.target), addon))
  if (outstanding.length === 0) {
    // The engine did not change, so there is nothing to build, stage or push.
    // Tau keeps pinning the addons already on the registry.
    note(`voice addons ${addon} are already published -- no binaries needed`)
  } else {
    note(`${outstanding.length} of ${VOICE_TARGETS.length} voice addons need publishing at ${addon}`)
    run('node', ['release/verify-native-voice.mjs'])
    syncVoicePackages({ withBinaries: true })
    note(`staged ${VOICE_TARGETS.length} platform packages at ${addon}`)
  }

  step('2. Publish the platform addons (before Tau)')
  if (outstanding.length === 0) {
    note('nothing to publish')
  }
  for (const entry of outstanding) {
    const name = packageNameFor(entry.target)
    const directory = packageDirFor(entry.target)
    if (!existsSync(join(directory, `tau_voice.${entry.target}.node`))) {
      throw new Error(`${name} has no binary; collect the native voice artifact into native/tau-voice/bin first.`)
    }
    if (!live) {
      note(`would publish ${name}@${addon}`)
      continue
    }
    run('npm', ['publish', directory])
    note(`published ${name}@${addon}`)
  }

  step('3. Point Tau at them and stop bundling the addons')
  if (!live) {
    note(`would pin the six optional dependencies at ${addon}, add /bin/ to native/tau-voice/.npmignore,`)
    note('refresh package-lock.json and the production shrinkwrap, then verify the gates')
    note('')
    note('Dry run complete. Re-run with --publish to perform it.')
    return
  }
  applySplit(addon)
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
  run('node', ['release/production-shrinkwrap.mjs', '--write'])

  step('4. Verify the gates before Tau goes out')
  run('node', ['release/production-shrinkwrap.mjs', '--check'])
  run('npm', ['run', 'test:voice'])
  run('npm', ['run', 'test:voice-packages'])

  step('5. Publish Tau')
  run('npm', ['publish'])

  step(`Done -- Tau ${version} is live, pinned to voice addons ${addon}.`)
  note('Commit the release edits: package.json, package-lock.json,')
  note('release/npm-shrinkwrap.production.json, native/tau-voice/.npmignore')
}

try {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
} catch (error) {
  process.stderr.write(`\nRelease stopped: ${error?.message ?? error}\n`)
  process.exitCode = 1
}
