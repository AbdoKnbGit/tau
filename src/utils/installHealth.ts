import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

/**
 * Runtime read of the lifecycle-completion marker that `scripts/postinstall.mjs`
 * writes as its final mandatory step.
 *
 * WHY THIS EXISTS. `npm install -g @abdoknbgit/tau` run directly honours the
 * user's npm config, so `ignore-scripts=true` — common in corporate and
 * security-hardened setups — silently skips postinstall. That install has no
 * vendored ripgrep and no native helpers, and until now nothing noticed:
 * `getLifecycleMarkerStatus` lived in the installer package and was read only by
 * the installer and its tests, never by the running app. postinstall.mjs already
 * says "a failed run means the missing marker makes the updater repair it on
 * next launch" — this is the missing half of that sentence.
 *
 * The installer (`@abdoknbgit/tau-installer`) forces
 * `--ignore-scripts=false --include=optional` plus npm's newer
 * `--allow-scripts` allowlist, so an install that went through it always has a
 * marker. A missing one therefore means the install bypassed the installer or
 * was interrupted, and the fix is to run it.
 *
 * Read-only and total: every failure path returns a value, so a malformed or
 * unreadable marker can never throw into a caller. Nothing here spawns a
 * process, touches the network, or writes.
 */

/** Kept in sync with `scripts/verify-deps.mjs`, which writes the marker. */
const LIFECYCLE_MARKER_FILENAME = '.tau-lifecycle-complete.json'
const LIFECYCLE_MARKER_SCHEMA = 1

export type InstallHealthReason =
  /** Marker present and matching the installed manifest. */
  | 'complete'
  /** No manifest found — not running from an installed package layout. */
  | 'unpackaged'
  /** Manifest present, marker absent: postinstall never completed. */
  | 'marker-missing'
  /** Marker present but stale or malformed: a partial or interrupted update. */
  | 'marker-invalid'

export type InstallHealth = {
  ok: boolean
  reason: InstallHealthReason
  /** Version from the manifest, when one was found. */
  version: string | null
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Package root candidates, matching the layouts `nativeTauTools.ts` already
 * resolves against: the bundle sits in `dist/`, source execution in
 * `src/utils/`. The first candidate whose manifest names this package wins, so
 * an unrelated `package.json` higher up the tree cannot be mistaken for ours.
 */
function findPackageRoot(): { root: string; name: string; version: string } | null {
  for (const candidate of [
    resolve(moduleDir, '..'),
    resolve(moduleDir, '../..'),
    resolve(moduleDir, '../../..'),
  ]) {
    const manifest = readJson(join(candidate, 'package.json'))
    const name = manifest?.name
    const version = manifest?.version
    if (typeof name === 'string' && typeof version === 'string' && name.endsWith('/tau')) {
      return { root: candidate, name, version }
    }
  }
  return null
}

/**
 * Whether this installation completed its postinstall step.
 *
 * `unpackaged` is reported rather than treated as a failure: a source checkout
 * or an embedded/test layout has no manifest to check against, and warning
 * there would be noise. Callers that only care about real installs should gate
 * on installation type — `detectConfigurationIssues` does this by running after
 * its development-mode early return.
 */
export function getInstallHealth(): InstallHealth {
  const pkg = findPackageRoot()
  if (!pkg) return { ok: true, reason: 'unpackaged', version: null }

  const marker = readJson(join(pkg.root, LIFECYCLE_MARKER_FILENAME))
  if (!marker) {
    return { ok: false, reason: 'marker-missing', version: pkg.version }
  }

  const matches =
    marker.schema === LIFECYCLE_MARKER_SCHEMA &&
    marker.packageName === pkg.name &&
    marker.version === pkg.version
  return {
    ok: matches,
    reason: matches ? 'complete' : 'marker-invalid',
    version: pkg.version,
  }
}

/**
 * Doctor-shaped warning for an incomplete install, or null when healthy.
 * Separate from the check so the wording lives next to the reasoning rather
 * than inside the diagnostic builder.
 */
export function getInstallHealthWarning(): { issue: string; fix: string } | null {
  const health = getInstallHealth()
  if (health.ok) return null

  const issue =
    health.reason === 'marker-missing'
      ? "This installation never completed its setup step, so the vendored ripgrep and native helpers are missing. The most common cause is `npm install -g` run directly with `ignore-scripts=true` in an npm config, which silently skips it."
      : `This installation's setup marker does not match the installed version${health.version ? ` (${health.version})` : ''}, which means an update was interrupted partway.`

  return {
    issue,
    fix: 'Repair with: npx @abdoknbgit/tau-installer',
  }
}
