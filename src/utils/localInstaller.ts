/**
 * Utilities for handling local installation
 */

import { access, chmod, readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { atomicReplaceTextFile } from './atomicFile.js'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { verifyInstalledPackage } from './installIntegrity.js'
import { logError } from './log.js'
import { buildManagedLocalWrapper } from './localWrapper.js'
import {
  type ManagedLocalInstallStatus,
  withManagedLocalUpdateLock,
} from './managedLocalUpdateLock.js'
import { jsonStringify } from './slowOperations.js'
import {
  createUpdateLockHandoffEnvironment,
  UpdateLock,
} from './updateLock.js'

// Project-scoped npm installs cannot use the CLI --allow-scripts flag. Keep
// the managed local project's policy aligned with Tau's published installer.
export const LOCAL_ALLOW_SCRIPTS = [
  '@abdoknbgit/tau',
  '@whiskeysockets/baileys',
  'core-js',
  'fsevents',
  'node-pty',
  'protobufjs',
  'sharp',
] as const

const LOCAL_ALLOW_SCRIPTS_POLICY = Object.fromEntries(
  LOCAL_ALLOW_SCRIPTS.map(name => [name, true]),
)

function npmSupportsAllowScripts(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return false
  const [major, minor] = match.slice(1, 3).map(Number)
  return major > 11 || (major === 11 && minor >= 16)
}

function createNpmInstallEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const overriddenConfigs = new Set([
    'npm_config_allow_scripts',
    'npm_config_ignore_scripts',
    'npm_config_dangerously_allow_all_scripts',
    'npm_config_strict_allow_scripts',
    'npm_config_dry_run',
    'npm_config_global',
    'npm_config_location',
    'npm_config_package_lock_only',
    'npm_config_omit',
    'npm_config_include',
    'npm_config_optional',
    'npm_config_production',
    'npm_config_bin_links',
  ])

  for (const key of Object.keys(env)) {
    if (overriddenConfigs.has(key.toLowerCase().replaceAll('-', '_'))) {
      delete env[key]
    }
  }
  return env
}

// Lazy getters: getClaudeConfigHomeDir() is memoized and reads process.env.
// Evaluating at module scope would capture the value before entrypoints like
// hfi.tsx get a chance to set CLAUDE_CONFIG_DIR in main(), and would also
// populate the memoize cache with that stale value for all 150+ other callers.
function getLocalInstallDir(): string {
  return join(getClaudeConfigHomeDir(), 'local')
}

const LOCAL_UPDATE_LOCK_STALE_MS = 15 * 60 * 1000
const LOCAL_UPDATE_LOCK_HEARTBEAT_MS = 60 * 1000

/** A separate lease because managed-local and npm-global trees do not overlap. */
export function getManagedLocalUpdateLockPath(): string {
  return resolve(getClaudeConfigHomeDir(), '.local-update.lock')
}

const managedLocalUpdateLock = new UpdateLock({
  getLockPath: getManagedLocalUpdateLockPath,
  staleMs: LOCAL_UPDATE_LOCK_STALE_MS,
  heartbeatMs: LOCAL_UPDATE_LOCK_HEARTBEAT_MS,
  onHeartbeatError: error => {
    logError(
      error instanceof Error
        ? error
        : new Error(`Could not refresh managed-local update lock: ${error}`),
    )
  },
})

export function getLocalClaudePath(): string {
  return join(getLocalInstallDir(), 'claude')
}
export function getLocalTauPath(): string {
  return join(getLocalInstallDir(), 'tau')
}

/**
 * Check if we're running from our managed local installation
 */
export function isRunningFromLocalInstallation(): boolean {
  const execPath = process.argv[1] || ''
  const normalized = execPath.replace(/\\/g, '/')
  return normalized.includes('/.claude/local/node_modules/')
}

/**
 * Write `content` to `path` only if the file does not already exist.
 * Uses O_EXCL ('wx') for atomic create-if-missing.
 */
async function writeIfMissing(
  path: string,
  content: string,
  mode?: number,
): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode })
    return true
  } catch (e) {
    if (getErrnoCode(e) === 'EEXIST') return false
    throw e
  }
}

/**
 * Ensure the local package environment is set up
 * Creates the directory, package.json, and wrapper script
 */
export async function ensureLocalPackageEnvironment(): Promise<boolean> {
  try {
    const localInstallDir = getLocalInstallDir()

    // Create installation directory (recursive, idempotent)
    await getFsImplementation().mkdir(localInstallDir)

    // Create or migrate the managed package policy before npm installs Tau.
    const manifestPath = join(localInstallDir, 'package.json')
    const initialManifest = {
      name: 'tau-local',
      version: '0.0.1',
      private: true,
      allowScripts: LOCAL_ALLOW_SCRIPTS_POLICY,
    }
    const createdManifest = await writeIfMissing(
      manifestPath,
      jsonStringify(initialManifest, null, 2),
    )
    if (!createdManifest) {
      const currentManifest = JSON.parse(
        await readFile(manifestPath, 'utf8'),
      ) as Record<string, unknown>
      const currentPolicy = currentManifest.allowScripts
      // This directory is Tau-managed, so keep the policy exact. Retaining
      // arbitrary old approvals would let a future dependency reuse them.
      const nextPolicy = LOCAL_ALLOW_SCRIPTS_POLICY
      if (
        jsonStringify(currentPolicy) !== jsonStringify(nextPolicy)
      ) {
        await atomicReplaceTextFile(
          manifestPath,
          jsonStringify(
            {
              ...currentManifest,
              allowScripts: nextPolicy,
            },
            null,
            2,
          ),
        )
      }
    }

    // Keep both wrappers so old local aliases still land on the Tau binary.
    const wrapperContents = buildManagedLocalWrapper(localInstallDir)
    for (const wrapperName of ['tau', 'claude']) {
      const wrapperPath = join(localInstallDir, wrapperName)
      await writeFile(
        wrapperPath,
        wrapperContents,
        { encoding: 'utf8', mode: 0o755 },
      )
      // Mode in writeFile is masked by umask; chmod to ensure executable bit.
      await chmod(wrapperPath, 0o755)
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}

/**
 * Install or update Tau CLI package in the local directory
 * @param channel - Release channel to use (latest or stable)
 * @param specificVersion - Optional specific version to install (overrides channel)
 */
export async function installOrUpdateTauPackage(
  channel: ReleaseChannel,
  specificVersion?: string | null,
): Promise<ManagedLocalInstallStatus> {
  try {
    return await withManagedLocalUpdateLock(async () => {
      // Acquire the cross-process lease before policy/wrapper mutation and
      // retain it through npm reification and integrity verification.
      const lockHandoff = managedLocalUpdateLock.getHandoff()
      if (!lockHandoff) {
        logError(new Error('Managed-local update lock ownership was lost'))
        return 'install_failed'
      }
      if (!(await ensureLocalPackageEnvironment())) {
        return 'install_failed'
      }

      // An explicit version still wins. The channel resolves to 'latest'
      // because no `stable` dist-tag is published -- see
      // autoUpdater.getLatestVersion. Truthiness is preserved from the previous
      // form, so an empty string still falls through to the tag.
      const versionSpec = specificVersion ? specificVersion : 'latest'
      const npmEnv = {
        ...createNpmInstallEnvironment(),
        ...createUpdateLockHandoffEnvironment(
          lockHandoff,
          'TAU_LOCAL_UPDATE_LOCK',
        ),
      }
      const npmVersionResult = await execFileNoThrowWithCwd(
        'npm',
        ['--version'],
        { cwd: getLocalInstallDir(), env: npmEnv, maxBuffer: 1000000 },
      )
      if (npmVersionResult.code !== 0) {
        logError(new Error(`Failed to detect npm: ${npmVersionResult.stderr}`))
        return 'install_failed'
      }
      const npmVersion = npmVersionResult.stdout.trim()
      const installArgs = [
        'install',
        `${MACRO.PACKAGE_URL}@${versionSpec}`,
        '--global=false',
        '--ignore-scripts=false',
        '--dry-run=false',
        '--package-lock-only=false',
        '--bin-links=true',
        '--include=optional',
        ...(npmSupportsAllowScripts(npmVersion)
          ? [
              '--dangerously-allow-all-scripts=false',
              '--strict-allow-scripts=true',
            ]
          : []),
        '--no-audit',
        '--no-fund',
      ]
      const result = await execFileNoThrowWithCwd('npm', installArgs, {
        cwd: getLocalInstallDir(),
        env: npmEnv,
        maxBuffer: 1000000,
      })

      if (result.code !== 0) {
        const error = new Error(
          `Failed to install Tau CLI package: ${result.stderr}`,
        )
        logError(error)
        return result.code === 190 ? 'in_progress' : 'install_failed'
      }

      // Verify the dependency tree landed completely (interrupted installs on
      // Windows can leave holes that crash the CLI at runtime).
      const installedRoot = join(
        getLocalInstallDir(),
        'node_modules',
        ...MACRO.PACKAGE_URL.split('/'),
      )
      if (!(await verifyInstalledPackage(installedRoot, { env: npmEnv }))) {
        logError(
          new Error('Local Tau install has an incomplete dependency tree'),
        )
        return 'install_failed'
      }

      // Set installMethod only after the selected version is fully verified.
      saveGlobalConfig(current => ({
        ...current,
        installMethod: 'local',
      }))

      return 'success'
    }, managedLocalUpdateLock)
  } catch (error) {
    logError(error)
    return 'install_failed'
  }
}

/**
 * Check if local installation exists.
 * Pure existence probe — callers use this to choose update path / UI hints.
 */
export async function localInstallationExists(): Promise<boolean> {
  try {
    try {
      await access(join(getLocalInstallDir(), 'node_modules', '.bin', 'tau'))
      return true
    } catch {
      await access(join(getLocalInstallDir(), 'node_modules', '.bin', 'claude'))
    }
    return true
  } catch {
    return false
  }
}

/**
 * Get shell type to determine appropriate path setup
 */
export function getShellType(): string {
  const shellPath = process.env.SHELL || ''
  if (shellPath.includes('zsh')) return 'zsh'
  if (shellPath.includes('bash')) return 'bash'
  if (shellPath.includes('fish')) return 'fish'
  return 'unknown'
}
