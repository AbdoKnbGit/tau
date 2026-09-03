import axios from 'axios'
import { constants as fsConstants } from 'fs'
import { access } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { getDynamicConfig_BLOCKS_ON_INIT } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { env } from './env.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { ClaudeError } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import {
  cleanStaleBinShims,
  extractEexistPath,
  getGlobalPackageRoot,
  packageRootsMatch,
  removeConflictingShim,
  verifyInstalledPackage,
} from './installIntegrity.js'
import { logError } from './log.js'
import { gte, lt } from './semver.js'
import { getInitialSettings } from './settings/settings.js'
import {
  filterClaudeAliases,
  getShellConfigPaths,
  readFileLines,
  writeFileLines,
} from './shellConfig.js'
import { jsonParse } from './slowOperations.js'
import {
  createUpdateLockHandoffEnvironment,
  UpdateLock,
} from './updateLock.js'

const GCS_BUCKET_URL =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'

const TAU_NPM_PACKAGE = '@abdoknbgit/tau'
const TAU_INSTALLER_PACKAGE = '@abdoknbgit/tau-installer@latest'
const TAU_INSTALL_TIMEOUT_MS = 20 * 60 * 1000

class AutoUpdaterError extends ClaudeError {}

export type InstallStatus =
  | 'success'
  | 'no_permissions'
  | 'install_failed'
  | 'in_progress'
  | 'prefix_mismatch'

export type AutoUpdaterResult = {
  version: string | null
  status: InstallStatus
  notifications?: string[]
}

export type MaxVersionConfig = {
  external?: string
  ant?: string
  external_message?: string
  ant_message?: string
}

/**
 * Checks if the current version meets the minimum required version from Statsig config
 * Terminates the process with an error message if the version is too old
 *
 * NOTE ON SHA-BASED VERSIONING:
 * We use SemVer-compliant versioning with build metadata format (X.X.X+SHA) for continuous deployment.
 * According to SemVer specs, build metadata (the +SHA part) is ignored when comparing versions.
 *
 * Versioning approach:
 * 1. For version requirements/compatibility (assertMinVersion), we use semver comparison that ignores build metadata
 * 2. For updates ('tau update'), we use exact string comparison to detect any change, including SHA
 *    - This ensures users always get the latest build, even when only the SHA changes
 *    - The UI clearly shows both versions including build metadata
 *
 * This approach keeps version comparison logic simple while maintaining traceability via the SHA.
 */
export async function assertMinVersion(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return
  }

  try {
    const versionConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
      minVersion: string
    }>('tengu_version_config', { minVersion: '0.0.0' })

    if (
      versionConfig.minVersion &&
      lt(MACRO.VERSION, versionConfig.minVersion)
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`
It looks like your version of Tau (${MACRO.VERSION}) needs an update.
A newer version (${versionConfig.minVersion} or higher) is required to continue.

To update, please run:
    tau update

This will ensure you have access to the latest features and improvements.
`)
      gracefulShutdownSync(1)
    }
  } catch (error) {
    logError(error as Error)
  }
}

/**
 * Returns the maximum allowed version for the current user type.
 * For ants, returns the `ant` field (dev version format).
 * For external users, returns the `external` field (clean semver).
 * This is used as a server-side kill switch to pause auto-updates during incidents.
 * Returns undefined if no cap is configured.
 */
export async function getMaxVersion(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant || undefined
  }
  return config.external || undefined
}

/**
 * Returns the server-driven message explaining the known issue, if configured.
 * Shown in the warning banner when the current version exceeds the max allowed version.
 */
export async function getMaxVersionMessage(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant_message || undefined
  }
  return config.external_message || undefined
}

async function getMaxVersionConfig(): Promise<MaxVersionConfig> {
  try {
    return await getDynamicConfig_BLOCKS_ON_INIT<MaxVersionConfig>(
      'tengu_max_version_config',
      {},
    )
  } catch (error) {
    logError(error as Error)
    return {}
  }
}

/**
 * Checks if a target version should be skipped due to user's minimumVersion setting.
 * This is used when switching to stable channel - the user can choose to stay on their
 * current version until stable catches up, preventing downgrades.
 */
export function shouldSkipVersion(targetVersion: string): boolean {
  const settings = getInitialSettings()
  const minimumVersion = settings?.minimumVersion
  if (!minimumVersion) {
    return false
  }
  // Skip if target version is less than minimum
  const shouldSkip = !gte(targetVersion, minimumVersion)
  if (shouldSkip) {
    logForDebugging(
      `Skipping update to ${targetVersion} - below minimumVersion ${minimumVersion}`,
    )
  }
  return shouldSkip
}

// Lock file for auto-updater to prevent concurrent updates
// Refresh the lease while an update is alive. If the process crashes, another
// updater may recover the abandoned lock after this timeout.
const LOCK_TIMEOUT_MS = 15 * 60 * 1000
const LOCK_HEARTBEAT_MS = 60 * 1000

/**
 * Get the path to the lock file
 * This is a function to ensure it's evaluated at runtime after test setup
 */
export function getLockFilePath(): string {
  return resolve(getClaudeConfigHomeDir(), '.update.lock')
}

const updateLock = new UpdateLock({
  getLockPath: getLockFilePath,
  staleMs: LOCK_TIMEOUT_MS,
  heartbeatMs: LOCK_HEARTBEAT_MS,
  onHeartbeatError: error => {
    logForDebugging(`autoUpdater: could not refresh update lock: ${error}`)
  },
})

/**
 * Attempts to acquire a lock for auto-updater
 * @returns true if lock was acquired, false if another process holds the lock
 */
async function acquireLock(): Promise<boolean> {
  try {
    return await updateLock.acquire()
  } catch (error) {
    logError(error as Error)
    return false
  }
}

/**
 * Releases the update lock if it's held by this process
 */
async function releaseLock(): Promise<void> {
  try {
    await updateLock.release()
  } catch (error) {
    logError(error as Error)
  }
}

/** Keep this process's update-lock lease fresh during slow native builds. */
function startLockHeartbeat(): () => Promise<void> {
  return updateLock.startHeartbeat()
}

async function getInstallationPrefix(): Promise<string | null> {
  // Run from home directory to avoid reading project-level .npmrc/.bunfig.toml
  const isBun = env.isRunningWithBun()
  let prefixResult = null
  if (isBun) {
    prefixResult = await execFileNoThrowWithCwd('bun', ['pm', 'bin', '-g'], {
      cwd: homedir(),
    })
  } else {
    prefixResult = await execFileNoThrowWithCwd(
      'npm',
      ['-g', 'config', 'get', 'prefix'],
      { cwd: homedir() },
    )
  }
  if (prefixResult.code !== 0) {
    logError(new Error(`Failed to check ${isBun ? 'bun' : 'npm'} permissions`))
    return null
  }
  return prefixResult.stdout.trim()
}

export async function checkGlobalInstallPermissions(): Promise<{
  hasPermissions: boolean
  npmPrefix: string | null
}> {
  try {
    const prefix = await getInstallationPrefix()
    if (!prefix) {
      return { hasPermissions: false, npmPrefix: null }
    }

    try {
      await access(prefix, fsConstants.W_OK)
      return { hasPermissions: true, npmPrefix: prefix }
    } catch {
      logError(
        new AutoUpdaterError(
          'Insufficient permissions for global npm install.',
        ),
      )
      return { hasPermissions: false, npmPrefix: prefix }
    }
  } catch (error) {
    logError(error as Error)
    return { hasPermissions: false, npmPrefix: null }
  }
}

export async function getLatestVersion(
  channel: ReleaseChannel,
): Promise<string | null> {
  // Always 'latest'. No `stable` dist-tag is published, and asking npm for a tag
  // that does not exist exits non-zero, which getLatestVersion reports as null --
  // a value every caller reads as "already up to date". The channel parameter
  // stays so restoring a real stable track is a change here, not a signature
  // change across its call sites.
  const npmTag = 'latest'

  // Run from home directory to avoid reading project-level .npmrc
  // which could be maliciously crafted to redirect to an attacker's registry
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', `${MACRO.PACKAGE_URL}@${npmTag}`, 'version', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )
  if (result.code !== 0) {
    logForDebugging(`npm view failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    } else {
      logForDebugging('npm stderr: (empty)')
    }
    if (result.stdout) {
      logForDebugging(`npm stdout: ${result.stdout.trim()}`)
    }
    return null
  }
  return result.stdout.trim()
}

export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

/**
 * Get npm dist-tags (latest and stable versions) from the registry.
 * This is used by the doctor command to show users what versions are available.
 */
export async function getNpmDistTags(): Promise<NpmDistTags> {
  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', MACRO.PACKAGE_URL, 'dist-tags', '--json', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view dist-tags failed with code ${result.code}`)
    return { latest: null, stable: null }
  }

  try {
    const parsed = jsonParse(result.stdout.trim()) as Record<string, unknown>
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      stable: typeof parsed.stable === 'string' ? parsed.stable : null,
    }
  } catch (error) {
    logForDebugging(`Failed to parse dist-tags: ${error}`)
    return { latest: null, stable: null }
  }
}

/**
 * Get the latest version from GCS bucket for a given release channel.
 * This is used by installations that don't have npm (e.g. package manager installs).
 */
export async function getLatestVersionFromGcs(
  channel: ReleaseChannel,
): Promise<string | null> {
  try {
    const response = await axios.get(`${GCS_BUCKET_URL}/${channel}`, {
      timeout: 5000,
      responseType: 'text',
    })
    return response.data.trim()
  } catch (error) {
    logForDebugging(`Failed to fetch ${channel} from GCS: ${error}`)
    return null
  }
}

/**
 * Get available versions from GCS bucket (for native installations).
 * Fetches both latest and stable channel pointers.
 */
export async function getGcsDistTags(): Promise<NpmDistTags> {
  const [latest, stable] = await Promise.all([
    getLatestVersionFromGcs('latest'),
    getLatestVersionFromGcs('stable'),
  ])

  return { latest, stable }
}

/**
 * Get version history from npm registry (ant-only feature)
 * Returns versions sorted newest-first, limited to the specified count
 *
 * Uses NATIVE_PACKAGE_URL when available because:
 * 1. Native installation is the primary installation method for ant users
 * 2. Not all JS package versions have corresponding native packages
 * 3. This prevents rollback from listing versions that don't have native binaries
 */
export async function getVersionHistory(limit: number): Promise<string[]> {
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }

  // Use native package URL when available to ensure we only show versions
  // that have native binaries (not all JS package versions have native builds)
  const packageUrl = MACRO.NATIVE_PACKAGE_URL ?? MACRO.PACKAGE_URL

  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', packageUrl, 'versions', '--json', '--prefer-online'],
    // Longer timeout for version list
    { abortSignal: AbortSignal.timeout(30000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view versions failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    }
    return []
  }

  try {
    const versions = jsonParse(result.stdout.trim()) as string[]
    // Take last N versions, then reverse to get newest first
    return versions.slice(-limit).reverse()
  } catch (error) {
    logForDebugging(`Failed to parse version history: ${error}`)
    return []
  }
}

export async function installGlobalPackage(
  specificVersion?: string | null,
  options: {
    interactive?: boolean
    expectedPackageRoot?: string | null
  } = {},
): Promise<InstallStatus> {
  const isAnthropicPackage = MACRO.PACKAGE_URL.startsWith('@anthropic-ai/')
  const productName = isAnthropicPackage ? 'Tau' : 'Tau'

  if (!(await acquireLock())) {
    logError(
      new AutoUpdaterError('Another process is currently installing an update'),
    )
    // Log the lock contention
    logEvent('tengu_auto_updater_lock_contention', {
      pid: process.pid,
      currentVersion:
        MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return 'in_progress'
  }

  const stopLockHeartbeat = startLockHeartbeat()

  try {
    const lockHandoff = updateLock.getHandoff()
    if (!lockHandoff) {
      logError(new AutoUpdaterError('Update lock ownership was lost'))
      return 'install_failed'
    }
    const updateEnvironment = {
      ...process.env,
      ...createUpdateLockHandoffEnvironment(
        lockHandoff,
        'TAU_UPDATE_LOCK',
      ),
    }

    const isBun = env.isRunningWithBun()
    // Check if we're using npm from Windows path in WSL
    if (!isBun && env.isNpmFromWindowsPath()) {
      logError(new Error('Windows NPM detected in WSL environment'))
      logEvent('tengu_auto_updater_windows_npm_in_wsl', {
        currentVersion:
          MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`
Error: Windows NPM detected in WSL

You're running ${productName} in WSL but using the Windows NPM installation from /mnt/c/.
This configuration is not supported for updates.

To fix this issue:
  1. Install Node.js within your Linux distribution: e.g. sudo apt install nodejs npm
  2. Make sure Linux NPM is in your PATH before the Windows version
  3. Try updating again
`)
      return 'install_failed'
    }

    if (Object.hasOwn(options, 'expectedPackageRoot')) {
      const activeGlobalRoot = isBun ? null : await getGlobalPackageRoot()
      if (
        !options.expectedPackageRoot ||
        !activeGlobalRoot ||
        !(await packageRootsMatch(
          options.expectedPackageRoot,
          activeGlobalRoot,
        ))
      ) {
        logError(
          new AutoUpdaterError(
            'The active package-manager prefix does not own the Tau installation that is currently running',
          ),
        )
        return 'prefix_mismatch'
      }
    }

    if (isAnthropicPackage) {
      await removeClaudeAliasesFromShellConfigs()
    }

    const { hasPermissions, npmPrefix } = await checkGlobalInstallPermissions()
    if (!hasPermissions) {
      return 'no_permissions'
    }

    // Interrupted updates can orphan tau/claudex bin shims. Remove only
    // dangling launchers here so a network or registry failure cannot delete
    // the currently working Tau command. Proven EEXIST conflicts are handled
    // by the targeted retry below.
    await cleanStaleBinShims(npmPrefix, isBun)

    // Use specific version if provided, otherwise use latest
    const packageSpec = specificVersion
      ? `${MACRO.PACKAGE_URL}@${specificVersion}`
      : MACRO.PACKAGE_URL

    // Run from home directory to avoid reading project-level .npmrc/.bunfig.toml
    // which could be maliciously crafted to redirect to an attacker's registry
    const packageManager = isBun ? 'bun' : 'npm'
    const useTauInstaller =
      !isBun && MACRO.PACKAGE_URL === TAU_NPM_PACKAGE
    const installArgs = useTauInstaller
      ? [
          'exec',
          '--yes',
          '--prefer-online',
          '--ignore-scripts=false',
          '--dry-run=false',
          '--global=false',
          '--package-lock-only=false',
          '--bin-links=true',
          '--no-fund',
          '--no-audit',
          `--package=${TAU_INSTALLER_PACKAGE}`,
          '--',
          'tau-installer',
          ...(specificVersion ? ['--tau-version', specificVersion] : []),
        ]
      : ['install', '-g', packageSpec]
    const installOptions = {
      cwd: homedir(),
      env: updateEnvironment,
      ...(useTauInstaller
        ? {
            timeout: TAU_INSTALL_TIMEOUT_MS,
            killTreeOnTimeout: true,
          }
        : {}),
    }

    let installResult = await execFileNoThrowWithCwd(
      packageManager,
      installArgs,
      installOptions,
    )

    // EEXIST bin conflict: delete the conflicting shim npm named and retry
    // once. This recovers machines whose previous update died mid-flight.
    if (installResult.code !== 0) {
      const conflictPath = extractEexistPath(
        `${installResult.stdout}\n${installResult.stderr}`,
      )
      if (conflictPath) {
        const removed = await removeConflictingShim(
          conflictPath,
          npmPrefix,
          isBun,
        )
        if (removed) {
          logForDebugging(
            `installGlobalPackage: retrying after removing EEXIST conflict at ${conflictPath}`,
          )
          installResult = await execFileNoThrowWithCwd(
            packageManager,
            installArgs,
            installOptions,
          )
        }
      }
    }

    if (installResult.code !== 0) {
      const error = new AutoUpdaterError(
        `Failed to install new version of ${productName}: ${installResult.stdout} ${installResult.stderr}`,
      )
      logError(error)
      return 'install_failed'
    }

    // Verify the freshly installed tree is complete (and repair it if a
    // locked file made npm leave holes) before declaring success.
    if (!isBun) {
      const packageRoot = await getGlobalPackageRoot()
      if (!packageRoot) {
        logError(
          new AutoUpdaterError(
            `Installed ${productName} but could not locate its global package tree for verification`,
          ),
        )
        return 'install_failed'
      }
      const verified = await verifyInstalledPackage(packageRoot, {
        interactive: options.interactive,
        env: updateEnvironment,
      })
      if (!verified) {
        logError(
          new AutoUpdaterError(
            `Installed ${productName} but its dependency tree is incomplete and could not be repaired`,
          ),
        )
        return 'install_failed'
      }
    }

    // Set installMethod to 'global' to track npm global installations
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'global',
    }))

    return 'success'
  } finally {
    // Ensure we always release the lock
    await stopLockHeartbeat()
    await releaseLock()
  }
}

/**
 * Remove claude aliases from shell configuration files
 * This helps clean up old installation methods when switching to native or npm global
 */
async function removeClaudeAliasesFromShellConfigs(): Promise<void> {
  const configMap = getShellConfigPaths()

  // Process each shell config file
  for (const [, configFile] of Object.entries(configMap)) {
    try {
      const lines = await readFileLines(configFile)
      if (!lines) continue

      const { filtered, hadAlias } = filterClaudeAliases(lines)

      if (hadAlias) {
        await writeFileLines(configFile, filtered)
        logForDebugging(`Removed claude alias from ${configFile}`)
      }
    } catch (error) {
      // Don't fail the whole operation if one file can't be processed
      logForDebugging(`Failed to remove alias from ${configFile}: ${error}`, {
        level: 'error',
      })
    }
  }
}
