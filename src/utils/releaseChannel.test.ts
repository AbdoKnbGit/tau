/**
 * Release-channel resolution tests.
 *
 * Run via: bun run src/utils/releaseChannel.test.ts
 *
 * Background. `/config` used to offer a "stable" auto-update channel, and three
 * places turned that setting into an npm dist-tag with
 * `channel === 'stable' ? 'stable' : 'latest'`. No `stable` tag has ever been
 * published, so `npm view @abdoknbgit/tau@stable version` exits non-zero with
 * E404. getLatestVersion reports that as null, and every caller reads null as
 * "already up to date":
 *
 *   AutoUpdater.tsx           `... && latestVersion && ...` -> guard false, no update
 *   useNpmUpdateNotification  `if (!latestVersion) return null` -> no notice
 *   cli/update.ts             prints a network/proxy diagnosis, which is wrong
 *
 * So a user who picked that option stopped receiving updates and was not told.
 * These tests assert on source text because the resolvers are inline constants
 * with no seam to call, and the property that matters is that no code path asks
 * the registry for a tag that does not exist.
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: unknown, hint: string): asserts cond {
  if (!cond) throw new Error(hint)
}

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: unknown) {
    failed++
    const message = e instanceof Error ? e.message : String(e)
    failures.push(`${name}: ${message}`)
    console.log(`  FAIL ${name}: ${message}`)
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const src = (rel: string) => readFileSync(join(here, '..', rel), 'utf8')

console.log('\nrelease channel')

test('no npm tag resolves to "stable"', () => {
  // The regression this whole file exists for. If someone reintroduces the
  // ternary without publishing the tag, updates break silently again.
  //
  // Scoped to the npm tag/version resolvers by variable name. The GCS helpers
  // in autoUpdater.ts (getLatestVersionFromGcs / getGcsDistTags) also take a
  // channel and legitimately mention 'stable', but they are a different
  // mechanism -- an object path in a release bucket, used by native and
  // package-manager installs, with its own null handling. They are not the npm
  // dist-tag lookup this guards.
  for (const rel of [
    'utils/autoUpdater.ts',
    'utils/localInstaller.ts',
    'utils/nativeInstaller/download.ts',
    'cli/update.ts',
  ]) {
    const offending = src(rel)
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .filter(line => /\b(npmTag|versionSpec)\b/.test(line))
      .filter(line => /['"]stable['"]/.test(line))
    assert(
      offending.length === 0,
      `${rel} still resolves an npm tag to 'stable':\n    ${offending.join('\n    ')}`,
    )
  }
})

test('the settings schema still accepts a stored "stable"', () => {
  // Narrowing the enum would make an existing user's settings file fail to
  // parse. The value has to remain readable; it just must not be requested.
  const source = src('utils/settings/types.ts')
  assert(
    source.includes("enum(['latest', 'stable'])"),
    'the autoUpdatesChannel enum was narrowed; stored values would stop parsing',
  )
})

test('ReleaseChannel still has both members', () => {
  const source = src('utils/config.ts')
  assert(
    /type ReleaseChannel = 'stable' \| 'latest'/.test(source),
    'the ReleaseChannel type was narrowed; stored values would stop type-checking',
  )
})

test('config no longer offers a way to switch TO stable', () => {
  const source = src('components/Settings/Config.tsx')
  assert(
    !source.includes("label: 'Enable with stable channel'"),
    'the enable-auto-updates menu still offers a stable channel',
  )
  assert(
    !source.includes("setShowSubmenu('ChannelDowngrade')"),
    'the channel row still opens the downgrade dialog, which stores stable',
  )
})

test('config keeps the way back OUT of stable', () => {
  // Someone whose settings already say 'stable' must still be able to toggle
  // to 'latest'. Removing that branch would strand them.
  const source = src('components/Settings/Config.tsx')
  assert(
    source.includes("autoUpdatesChannel: 'latest'"),
    'the switch-back-to-latest branch is gone; existing stable users are stranded',
  )
})

console.log(
  `\n${passed} passed, ${failed} failed` +
    (failures.length ? '\n\nfailures:\n  - ' + failures.join('\n  - ') : ''),
)
if (failed > 0) process.exit(1)
