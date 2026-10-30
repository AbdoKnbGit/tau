import type { McpbManifestAny } from '@anthropic-ai/mcpb'
import axios from 'axios'
import { createHash, randomBytes } from 'crypto'
import { chmod, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join, sep } from 'path'
import type { McpServerConfig } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { parseAndValidateManifestFromBytes } from '../dxt/helpers.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { errorMessage, getErrnoCode, isENOENT, toError } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { getSecureStorage } from '../secureStorage/index.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../settings/settings.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getSystemDirectories } from '../systemDirectories.js'
import { classifyFetchError, logPluginFetch } from './fetchTelemetry.js'
import { resolveMcpbLaunch } from './mcpbRuntime.js'
import { pluginDataDirPath } from './pluginDirectories.js'

type McpbManifest = McpbManifestAny
type McpbUserConfigurationOption = NonNullable<
  McpbManifestAny['user_config']
>[string]

/**
 * User configuration values for MCPB
 */
export type UserConfigValues = Record<
  string,
  string | number | boolean | string[]
>

/**
 * User configuration schema from DXT manifest
 */
export type UserConfigSchema = Record<string, McpbUserConfigurationOption>

/**
 * Result of loading an MCPB file (success case)
 */
export type McpbLoadResult = {
  manifest: McpbManifest
  mcpConfig: McpServerConfig
  extractedPath: string
  contentHash: string
}

/**
 * Result when MCPB needs user configuration
 */
export type McpbNeedsConfigResult = {
  status: 'needs-config'
  manifest: McpbManifest
  extractedPath: string
  contentHash: string
  configSchema: UserConfigSchema
  existingConfig: UserConfigValues
  validationErrors: string[]
}

/**
 * Metadata stored for each cached MCPB
 */
export type McpbCacheMetadata = {
  source: string
  contentHash: string
  extractedPath: string
  cachedAt: string
  lastChecked: string
  sourceMtimeMs?: number
  sourceSize?: number
}

/**
 * Progress callback for download and extraction operations
 */
export type ProgressCallback = (status: string) => void

/**
 * Check if a source string is an MCPB file reference
 */
export function isMcpbSource(source: string): boolean {
  return source.endsWith('.mcpb') || source.endsWith('.dxt')
}

/**
 * Check if a source is a URL
 */
function isUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}

/**
 * Generate content hash for an MCPB file
 */
function generateContentHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').substring(0, 16)
}

/**
 * Get cache directory for MCPB files
 */
function getMcpbCacheDir(pluginPath: string): string {
  return join(pluginPath, '.mcpb-cache')
}

/**
 * Get metadata file path for cached MCPB
 */
function getMetadataPath(cacheDir: string, source: string): string {
  const sourceHash = createHash('md5')
    .update(source)
    .digest('hex')
    .substring(0, 8)
  return join(cacheDir, `${sourceHash}.metadata.json`)
}

/**
 * Compose the secureStorage key for a per-server secret bucket.
 * `pluginSecrets` is a flat map — per-server secrets share it with top-level
 * plugin options (pluginOptionsStorage.ts) using a `${pluginId}/${server}`
 * composite key. `/` can't appear in plugin IDs (`name@marketplace`) or
 * server names (MCP identifier constraints), so it's unambiguous. Keeps the
 * SecureStorageData schema unchanged and the single-keychain-entry size
 * budget (~2KB stdin-safe, see INC-3028) shared across all plugin secrets.
 */
function serverSecretsKey(pluginId: string, serverName: string): string {
  return `${pluginId}/${serverName}`
}

/**
 * Load user configuration for an MCP server, merging non-sensitive values
 * (from settings.json) with sensitive values (from secureStorage keychain).
 * secureStorage wins on collision — schema determines destination so
 * collision shouldn't happen, but if a user hand-edits settings.json we
 * trust the more secure source.
 *
 * Returns null only if NEITHER source has anything — callers skip
 * ${user_config.X} substitution in that case.
 *
 * @param pluginId - Plugin identifier in "plugin@marketplace" format
 * @param serverName - MCP server name from DXT manifest
 */
export function loadMcpServerUserConfig(
  pluginId: string,
  serverName: string,
): UserConfigValues | null {
  try {
    const settings = getSettings_DEPRECATED()
    const nonSensitive =
      settings.pluginConfigs?.[pluginId]?.mcpServers?.[serverName]

    const sensitive =
      getSecureStorage().read()?.pluginSecrets?.[
        serverSecretsKey(pluginId, serverName)
      ]

    if (!nonSensitive && !sensitive) {
      return null
    }

    logForDebugging(
      `Loaded user config for ${pluginId}/${serverName} (settings + secureStorage)`,
    )
    return { ...nonSensitive, ...sensitive }
  } catch (error) {
    const errorObj = toError(error)
    logError(errorObj)
    logForDebugging(
      `Failed to load user config for ${pluginId}/${serverName}: ${error}`,
      { level: 'error' },
    )
    return null
  }
}

/**
 * Save user configuration for an MCP server, splitting by `schema[key].sensitive`.
 * Mirrors savePluginOptions (pluginOptionsStorage.ts:90) for top-level options:
 *   - `sensitive: true` → secureStorage (keychain on macOS, .credentials.json 0600 elsewhere)
 *   - everything else   → settings.json pluginConfigs[pluginId].mcpServers[serverName]
 *
 * Without this split, per-channel `sensitive: true` was a false sense of
 * security — the dialog masked the input but the save went to plaintext
 * settings.json anyway. H1 #3617646 (Telegram/Discord bot tokens in
 * world-readable .env) surfaced this as the gap to close.
 *
 * Writes are skipped if nothing in that category is present.
 *
 * @param pluginId - Plugin identifier in "plugin@marketplace" format
 * @param serverName - MCP server name from DXT manifest
 * @param config - User configuration values
 * @param schema - The userConfig schema for this server (manifest.user_config
 *   or channels[].userConfig) — drives the sensitive/non-sensitive split
 */
export function saveMcpServerUserConfig(
  pluginId: string,
  serverName: string,
  config: UserConfigValues,
  schema: UserConfigSchema,
): void {
  try {
    const nonSensitive: UserConfigValues = {}
    const sensitive: Record<string, string> = {}

    for (const [key, value] of Object.entries(config)) {
      if (schema[key]?.sensitive === true) {
        sensitive[key] = String(value)
      } else {
        nonSensitive[key] = value
      }
    }

    // Scrub ONLY keys we're writing in this call. Covers both directions
    // across schema-version flips:
    //  - sensitive→secureStorage ⇒ remove stale plaintext from settings.json
    //  - nonSensitive→settings.json ⇒ remove stale entry from secureStorage
    //    (otherwise loadMcpServerUserConfig's {...nonSensitive, ...sensitive}
    //    would let the stale secureStorage value win on next read)
    // Partial `config` (user only re-enters one field) leaves other fields
    // untouched in BOTH stores — defense-in-depth against future callers.
    const sensitiveKeysInThisSave = new Set(Object.keys(sensitive))
    const nonSensitiveKeysInThisSave = new Set(Object.keys(nonSensitive))

    // Sensitive → secureStorage FIRST. If this fails (keychain locked,
    // .credentials.json perms), throw before touching settings.json — the
    // old plaintext stays as a fallback instead of losing BOTH copies.
    //
    // Also scrub non-sensitive keys from secureStorage — schema flipped
    // sensitive→false and they're being written to settings.json now. Without
    // this, loadMcpServerUserConfig's merge would let the stale secureStorage
    // value win on next read.
    const storage = getSecureStorage()
    const k = serverSecretsKey(pluginId, serverName)
    const existingInSecureStorage =
      storage.read()?.pluginSecrets?.[k] ?? undefined
    const secureScrubbed = existingInSecureStorage
      ? Object.fromEntries(
          Object.entries(existingInSecureStorage).filter(
            ([key]) => !nonSensitiveKeysInThisSave.has(key),
          ),
        )
      : undefined
    const needSecureScrub =
      secureScrubbed &&
      existingInSecureStorage &&
      Object.keys(secureScrubbed).length !==
        Object.keys(existingInSecureStorage).length
    if (Object.keys(sensitive).length > 0 || needSecureScrub) {
      const existing = storage.read() ?? {}
      if (!existing.pluginSecrets) {
        existing.pluginSecrets = {}
      }
      // secureStorage keyvault is a flat object — direct replace, no merge
      // semantics to worry about (unlike settings.json's mergeWith).
      existing.pluginSecrets[k] = {
        ...secureScrubbed,
        ...sensitive,
      }
      const result = storage.update(existing)
      if (!result.success) {
        throw new Error(
          `Failed to save sensitive config to secure storage for ${k}`,
        )
      }
      if (result.warning) {
        logForDebugging(`Server secrets save warning: ${result.warning}`, {
          level: 'warn',
        })
      }
      if (needSecureScrub) {
        logForDebugging(
          `saveMcpServerUserConfig: scrubbed ${
            Object.keys(existingInSecureStorage!).length -
            Object.keys(secureScrubbed!).length
          } stale non-sensitive key(s) from secureStorage for ${k}`,
        )
      }
    }

    // Non-sensitive → settings.json. Write whenever there are new non-sensitive
    // values OR existing plaintext sensitive values to scrub — so reconfiguring
    // a sensitive-only schema still cleans up the old settings.json. Runs
    // AFTER the secureStorage write succeeded, so the scrub can't leave you
    // with zero copies of the secret.
    //
    // updateSettingsForSource does mergeWith(diskSettings, ourSettings, ...)
    // which PRESERVES destination keys absent from source — so simply omitting
    // sensitive keys doesn't scrub them, the disk copy merges back in. Instead:
    // set each sensitive key to explicit `undefined` — mergeWith (with the
    // customizer at settings.ts:349) treats explicit undefined as a delete.
    const settings = getSettings_DEPRECATED()
    const existingInSettings =
      settings.pluginConfigs?.[pluginId]?.mcpServers?.[serverName] ?? {}
    const keysToScrubFromSettings = Object.keys(existingInSettings).filter(k =>
      sensitiveKeysInThisSave.has(k),
    )
    if (
      Object.keys(nonSensitive).length > 0 ||
      keysToScrubFromSettings.length > 0
    ) {
      if (!settings.pluginConfigs) {
        settings.pluginConfigs = {}
      }
      if (!settings.pluginConfigs[pluginId]) {
        settings.pluginConfigs[pluginId] = {}
      }
      if (!settings.pluginConfigs[pluginId].mcpServers) {
        settings.pluginConfigs[pluginId].mcpServers = {}
      }
      // Build the scrub-via-undefined map. The UserConfigValues type doesn't
      // include undefined, but updateSettingsForSource's mergeWith customizer
      // needs explicit undefined to delete — cast is deliberate internal
      // plumbing (same rationale as deletePluginOptions in
      // pluginOptionsStorage.ts:184, see CLAUDE.md's 10% case).
      const scrubbed = Object.fromEntries(
        keysToScrubFromSettings.map(k => [k, undefined]),
      ) as Record<string, undefined>
      settings.pluginConfigs[pluginId].mcpServers![serverName] = {
        ...nonSensitive,
        ...scrubbed,
      } as UserConfigValues
      const result = updateSettingsForSource('userSettings', settings)
      if (result.error) {
        throw result.error
      }
      if (keysToScrubFromSettings.length > 0) {
        logForDebugging(
          `saveMcpServerUserConfig: scrubbed ${keysToScrubFromSettings.length} plaintext sensitive key(s) from settings.json for ${pluginId}/${serverName}`,
        )
      }
    }

    logForDebugging(
      `Saved user config for ${pluginId}/${serverName} (${Object.keys(nonSensitive).length} non-sensitive, ${Object.keys(sensitive).length} sensitive)`,
    )
  } catch (error) {
    const errorObj = toError(error)
    logError(errorObj)
    throw new Error(
      `Failed to save user configuration for ${pluginId}/${serverName}: ${errorObj.message}`,
    )
  }
}

/**
 * Validate user configuration values against DXT user_config schema
 */
export function validateUserConfig(
  values: UserConfigValues,
  schema: UserConfigSchema,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Check each field in the schema
  for (const [key, fieldSchema] of Object.entries(schema)) {
    const value = values[key]

    // Check required fields
    if (fieldSchema.required && (value === undefined || value === '')) {
      errors.push(`${fieldSchema.title || key} is required but not provided`)
      continue
    }

    // Skip validation for optional fields that aren't provided
    if (value === undefined || value === '') {
      continue
    }

    // Type validation
    if (fieldSchema.type === 'string') {
      if (Array.isArray(value)) {
        // String arrays are allowed if multiple: true
        if (!fieldSchema.multiple) {
          errors.push(
            `${fieldSchema.title || key} must be a string, not an array`,
          )
        } else if (!value.every(v => typeof v === 'string')) {
          errors.push(`${fieldSchema.title || key} must be an array of strings`)
        }
      } else if (typeof value !== 'string') {
        errors.push(`${fieldSchema.title || key} must be a string`)
      }
    } else if (fieldSchema.type === 'number' && typeof value !== 'number') {
      errors.push(`${fieldSchema.title || key} must be a number`)
    } else if (fieldSchema.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${fieldSchema.title || key} must be a boolean`)
    } else if (
      (fieldSchema.type === 'file' || fieldSchema.type === 'directory') &&
      typeof value !== 'string'
    ) {
      errors.push(`${fieldSchema.title || key} must be a path string`)
    }

    // Number range validation
    if (fieldSchema.type === 'number' && typeof value === 'number') {
      if (fieldSchema.min !== undefined && value < fieldSchema.min) {
        errors.push(
          `${fieldSchema.title || key} must be at least ${fieldSchema.min}`,
        )
      }
      if (fieldSchema.max !== undefined && value > fieldSchema.max) {
        errors.push(
          `${fieldSchema.title || key} must be at most ${fieldSchema.max}`,
        )
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

type McpbVariables = Record<string, string | string[]>

const LONE_USER_CONFIG_VARIABLE = /^\$\{(user_config\.[^}]+)\}$/

/**
 * Fill ${...} variables. Values go in literally: String.replace with a string
 * replacement would turn a password like pa$$word into pa$word. A variable alone
 * in an array can expand to several arguments, and an optional setting with no
 * value drops out instead of reaching the server as the text "${user_config.x}".
 * Other unknown variables stay, for resolvePluginMcpEnvironment to fill.
 */
function substituteMcpbVariables(
  value: unknown,
  variables: McpbVariables,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
      const replacement = variables[name]
      if (replacement !== undefined) {
        return Array.isArray(replacement) ? replacement.join(' ') : replacement
      }
      return name.startsWith('user_config.') ? '' : match
    })
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      const lone =
        typeof item === 'string' ? LONE_USER_CONFIG_VARIABLE.exec(item) : null
      if (!lone) return [substituteMcpbVariables(item, variables)]
      return variables[lone[1]!] ?? []
    })
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteMcpbVariables(item, variables),
      ]),
    )
  }
  return value
}

function baseMcpbVariables(extractedPath: string): McpbVariables {
  return {
    __dirname: extractedPath,
    pathSeparator: sep,
    '/': sep,
    ...getSystemDirectories(),
  }
}

/** Manifest defaults, with their own ${HOME}-style variables filled in. */
function userConfigDefaults(
  schema: UserConfigSchema,
  extractedPath: string,
): UserConfigValues {
  const variables = baseMcpbVariables(extractedPath)
  const defaults: UserConfigValues = {}
  for (const [key, option] of Object.entries(schema)) {
    if (option.default !== undefined) {
      defaults[key] = substituteMcpbVariables(
        option.default,
        variables,
      ) as UserConfigValues[string]
    }
  }
  return defaults
}

/**
 * Generate MCP server configuration from DXT manifest
 */
async function generateMcpConfig(
  manifest: McpbManifest,
  extractedPath: string,
  userConfig: UserConfigValues = {},
): Promise<McpServerConfig> {
  const baseConfig = manifest.server?.mcp_config
  if (!baseConfig) {
    const error = new Error(
      `Failed to generate MCP server configuration from manifest "${manifest.name}"`,
    )
    logError(error)
    throw error
  }

  const override = baseConfig.platform_overrides?.[process.platform]
  const variables = baseMcpbVariables(extractedPath)
  for (const [key, value] of Object.entries(userConfig)) {
    variables[`user_config.${key}`] = Array.isArray(value)
      ? value.map(String)
      : String(value)
  }
  const env = override?.env || baseConfig.env
  const launch = await resolveMcpbLaunch(
    {
      command: substituteMcpbVariables(
        override?.command || baseConfig.command,
        variables,
      ) as string,
      args: substituteMcpbVariables(
        override?.args || baseConfig.args || [],
        variables,
      ) as string[],
      env: env
        ? Object.fromEntries(
            Object.entries(env as Record<string, string>)
              // An unset optional setting leaves the variable unset, not empty.
              .filter(([, value]) => {
                const lone = LONE_USER_CONFIG_VARIABLE.exec(value)
                return !lone || variables[lone[1]!] !== undefined
              })
              .map(([key, value]) => [
                key,
                substituteMcpbVariables(value, variables) as string,
              ]),
          )
        : undefined,
    },
    manifest.compatibility,
    extractedPath,
  )
  return launch as McpServerConfig
}

/**
 * Load cache metadata for an MCPB source
 */
async function loadCacheMetadata(
  cacheDir: string,
  source: string,
): Promise<McpbCacheMetadata | null> {
  const fs = getFsImplementation()
  const metadataPath = getMetadataPath(cacheDir, source)

  try {
    const content = await fs.readFile(metadataPath, { encoding: 'utf-8' })
    return jsonParse(content) as McpbCacheMetadata
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') return null
    const errorObj = toError(error)
    logError(errorObj)
    logForDebugging(`Failed to load MCPB cache metadata: ${error}`, {
      level: 'error',
    })
    return null
  }
}

/** Nobody, in this session or another, can see half a file. */
async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporaryPath, data)
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Save cache metadata for an MCPB source. Best effort: without it the next load
 * only has to hash the bundle again. Other clients sharing ~/.claude read this
 * file, so existing fields keep their meaning.
 */
async function saveCacheMetadata(
  cacheDir: string,
  source: string,
  metadata: McpbCacheMetadata,
): Promise<void> {
  const metadataPath = getMetadataPath(cacheDir, source)
  try {
    await getFsImplementation().mkdir(cacheDir)
    await writeFileAtomic(metadataPath, jsonStringify(metadata, null, 2))
  } catch (error) {
    logForDebugging(`Failed to save MCPB cache metadata: ${error}`, {
      level: 'warn',
    })
  }
}

/**
 * Download MCPB file from URL
 */
async function downloadMcpb(
  url: string,
  destPath: string,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  logForDebugging(`Downloading MCPB from ${url}`)
  if (onProgress) {
    onProgress(`Downloading ${url}...`)
  }

  const started = performance.now()
  let fetchTelemetryFired = false
  try {
    const response = await axios.get(url, {
      timeout: 120000, // 2 minute timeout
      responseType: 'arraybuffer',
      maxRedirects: 5, // Follow redirects (like curl -L)
      onDownloadProgress: progressEvent => {
        if (progressEvent.total && onProgress) {
          const percent = Math.round(
            (progressEvent.loaded / progressEvent.total) * 100,
          )
          onProgress(`Downloading... ${percent}%`)
        }
      },
    })

    const data = new Uint8Array(response.data)
    // Fire telemetry before writeFile — the event measures the network
    // fetch, not disk I/O. A writeFile EACCES would otherwise match
    // classifyFetchError's /permission denied/ → misreport as auth.
    logPluginFetch('mcpb', url, 'success', performance.now() - started)
    fetchTelemetryFired = true

    // Save to disk (binary data)
    await writeFile(destPath, Buffer.from(data))

    logForDebugging(`Downloaded ${data.length} bytes to ${destPath}`)
    if (onProgress) {
      onProgress('Download complete')
    }

    return data
  } catch (error) {
    if (!fetchTelemetryFired) {
      logPluginFetch(
        'mcpb',
        url,
        'failure',
        performance.now() - started,
        classifyFetchError(error),
      )
    }
    const errorMsg = errorMessage(error)
    const fullError = new Error(
      `Failed to download MCPB file from ${url}: ${errorMsg}`,
    )
    logError(fullError)
    throw fullError
  }
}

async function hasSameBytes(path: string, data: Uint8Array): Promise<boolean> {
  try {
    return Buffer.compare(await readFile(path), data) === 0
  } catch {
    return false
  }
}

/**
 * Extract MCPB file and write contents to extraction directory.
 *
 * The directory is named after the bundle's hash, so its right contents are
 * known. A file that already has them is left alone: it may be a running server,
 * which neither Windows nor Linux will let us overwrite. Anything else is
 * replaced atomically, so this is safe to repeat, to resume after a crash, and
 * to run from several sessions at once. Files are written byte for byte.
 *
 * @param modes - name→mode map from `parseZipModes`. MCPB bundles can ship
 *   native MCP server binaries, so preserving the exec bit matters here.
 */
async function extractMcpbContents(
  unzipped: Record<string, Uint8Array>,
  extractPath: string,
  modes: Record<string, number>,
  onProgress?: ProgressCallback,
): Promise<void> {
  if (onProgress) {
    onProgress('Extracting files...')
  }

  // Create extraction directory
  await getFsImplementation().mkdir(extractPath)

  // Write all files. Filter directory entries from the count so progress
  // messages use the same denominator as filesWritten (which skips them).
  let filesWritten = 0
  const entries = Object.entries(unzipped).filter(
    ([k]) => !k.endsWith('/') && !k.endsWith('\\'),
  )
  const totalFiles = entries.length

  for (const [entryName, fileData] of entries) {
    // Older Windows zip tools write backslashes, which are plain filename
    // characters on macOS and Linux.
    const fullPath = join(extractPath, entryName.replaceAll('\\', '/'))
    await getFsImplementation().mkdir(dirname(fullPath))

    if (!(await hasSameBytes(fullPath, fileData))) {
      try {
        await writeFileAtomic(fullPath, fileData)
      } catch (error) {
        // Fine if another session got there first.
        if (!(await hasSameBytes(fullPath, fileData))) throw error
      }
    }

    const mode = modes[entryName]
    if (mode && mode & 0o111) {
      // Swallow EPERM/ENOTSUP (NFS root_squash, some FUSE mounts) — losing +x
      // is the pre-PR behavior and better than aborting mid-extraction.
      await chmod(fullPath, mode & 0o777).catch(() => {})
    }

    filesWritten++
    if (onProgress && filesWritten % 10 === 0) {
      onProgress(`Extracted ${filesWritten}/${totalFiles} files`)
    }
  }

  logForDebugging(`Extracted ${filesWritten} files to ${extractPath}`)
  if (onProgress) {
    onProgress(`Extraction complete (${filesWritten} files)`)
  }
}

/**
 * Check if an MCPB source has changed and needs re-extraction. A matching
 * timestamp and size is the fast path. Otherwise only the bytes can tell:
 * timestamps move both ways through copies, restores and checkouts.
 */
async function checkMcpbChanged(
  source: string,
  pluginPath: string,
  cacheDir: string,
  metadata: McpbCacheMetadata,
): Promise<boolean> {
  // URLs are re-checked by plugin updates, which start from a new folder.
  if (isUrl(source)) return false

  const fs = getFsImplementation()
  const localPath = join(pluginPath, source)
  let stats
  try {
    stats = await fs.stat(localPath)
  } catch (error) {
    logForDebugging(`MCPB source file unavailable: ${localPath}: ${error}`)
    return true
  }

  // Floor to the ms precision other clients store.
  const sourceMtimeMs = Math.floor(stats.mtimeMs)
  if (
    metadata.sourceMtimeMs === sourceMtimeMs &&
    (metadata.sourceSize ?? stats.size) === stats.size
  ) {
    return false
  }
  const contentHash = generateContentHash(await fs.readFileBytes(localPath))
  if (contentHash !== metadata.contentHash) return true

  await saveCacheMetadata(cacheDir, source, {
    ...metadata,
    extractedPath: join(cacheDir, contentHash),
    sourceMtimeMs,
    sourceSize: stats.size,
    lastChecked: new Date().toISOString(),
  })
  return false
}

type CachedMcpb = {
  manifest: McpbManifest
  extractedPath: string
  contentHash: string
}

/**
 * A cache entry we can run, or null to extract again, which repairs anything
 * wrong here. The path is rebuilt from the cache folder rather than read from
 * the metadata: that absolute path goes stale when a plugin folder is copied or
 * moved, or reached from both Windows and WSL.
 */
async function readCachedMcpb(
  cacheDir: string,
  source: string,
  pluginPath: string,
): Promise<CachedMcpb | null> {
  const metadata = await loadCacheMetadata(cacheDir, source)
  if (!metadata || !/^[0-9a-f]+$/.test(metadata.contentHash ?? '')) return null
  const { contentHash } = metadata
  const extractedPath = join(cacheDir, contentHash)
  const fs = getFsImplementation()
  try {
    if (await checkMcpbChanged(source, pluginPath, cacheDir, metadata)) {
      return null
    }
    const manifest = await parseAndValidateManifestFromBytes(
      await fs.readFileBytes(join(extractedPath, 'manifest.json')),
    )
    const entryPoint = manifest.server?.entry_point
    if (entryPoint) {
      await fs.stat(join(extractedPath, entryPoint.replaceAll('\\', '/')))
    }
    return { manifest, extractedPath, contentHash }
  } catch (error) {
    logForDebugging(`Cached MCPB is unusable, extracting again: ${error}`)
    return null
  }
}

/**
 * Plugins can live somewhere read-only (CLAUDE_CODE_PLUGIN_SEED_DIR, a managed
 * install), so fall back to the plugin's data folder, which uninstall removes.
 */
async function writableCacheDir(
  primary: string,
  fallback: string,
): Promise<string> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(primary)
    const probe = join(primary, `.write-test-${process.pid}-${randomBytes(4).toString('hex')}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return primary
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error
    logForDebugging(`${primary} is read-only, using ${fallback}`)
    await fs.mkdir(fallback)
    return fallback
  }
}

async function finishMcpbLoad(
  { manifest, extractedPath, contentHash }: CachedMcpb,
  pluginId: string,
  providedUserConfig: UserConfigValues | undefined,
  forceConfigDialog: boolean | undefined,
): Promise<McpbLoadResult | McpbNeedsConfigResult> {
  const schema = manifest.user_config as UserConfigSchema | undefined
  if (!schema || Object.keys(schema).length === 0) {
    const mcpConfig = await generateMcpConfig(manifest, extractedPath)
    return { manifest, mcpConfig, extractedPath, contentHash }
  }

  // Server name from DXT manifest
  const serverName = manifest.name
  const savedConfig = loadMcpServerUserConfig(pluginId, serverName)
  // A required setting with a default is already satisfied.
  const userConfig = {
    ...userConfigDefaults(schema, extractedPath),
    ...(providedUserConfig || savedConfig),
  }
  const validation = validateUserConfig(userConfig, schema)

  // Return needs-config if: forced (reconfiguration) OR validation failed
  if (forceConfigDialog || !validation.valid) {
    return {
      status: 'needs-config',
      manifest,
      extractedPath,
      contentHash,
      configSchema: schema,
      existingConfig: savedConfig || {},
      validationErrors: validation.valid ? [] : validation.errors,
    }
  }

  // Save config if it was provided (first time or reconfiguration)
  if (providedUserConfig) {
    saveMcpServerUserConfig(pluginId, serverName, providedUserConfig, schema)
  }

  const mcpConfig = await generateMcpConfig(manifest, extractedPath, userConfig)
  return { manifest, mcpConfig, extractedPath, contentHash }
}

/**
 * Load and extract an MCPB file, with caching and user configuration support
 *
 * @param source - MCPB file path or URL
 * @param pluginPath - Plugin directory path
 * @param pluginId - Plugin identifier in "plugin@marketplace" format (for config storage)
 * @param onProgress - Progress callback
 * @param providedUserConfig - User configuration values (for initial setup or reconfiguration)
 * @returns Success with MCP config, or needs-config status with schema
 */
export async function loadMcpbFile(
  source: string,
  pluginPath: string,
  pluginId: string,
  onProgress?: ProgressCallback,
  providedUserConfig?: UserConfigValues,
  forceConfigDialog?: boolean,
): Promise<McpbLoadResult | McpbNeedsConfigResult> {
  const fs = getFsImplementation()
  const primaryCacheDir = getMcpbCacheDir(pluginPath)
  const fallbackCacheDir = join(pluginDataDirPath(pluginId), 'mcpb-cache')

  logForDebugging(`Loading MCPB from source: ${source}`)

  // Check cache first
  for (const dir of [primaryCacheDir, fallbackCacheDir]) {
    const cached = await readCachedMcpb(dir, source, pluginPath)
    if (cached) {
      logForDebugging(
        `Using cached MCPB from ${cached.extractedPath} (hash: ${cached.contentHash})`,
      )
      return finishMcpbLoad(
        cached,
        pluginId,
        providedUserConfig,
        forceConfigDialog,
      )
    }
  }

  // Not cached or changed - need to download/load and extract
  const cacheDir = await writableCacheDir(primaryCacheDir, fallbackCacheDir)
  let mcpbData: Uint8Array

  if (isUrl(source)) {
    // Download from URL
    const sourceHash = createHash('md5')
      .update(source)
      .digest('hex')
      .substring(0, 8)
    mcpbData = await downloadMcpb(
      source,
      join(cacheDir, `${sourceHash}.mcpb`),
      onProgress,
    )
  } else {
    // Load from local path
    const localPath = join(pluginPath, source)

    if (onProgress) {
      onProgress(`Loading ${source}...`)
    }

    try {
      mcpbData = await fs.readFileBytes(localPath)
    } catch (error) {
      if (isENOENT(error)) {
        const err = new Error(`MCPB file not found: ${localPath}`)
        logError(err)
        throw err
      }
      throw error
    }
  }

  // Generate content hash
  const contentHash = generateContentHash(mcpbData)
  logForDebugging(`MCPB content hash: ${contentHash}`)

  // Extract ZIP
  if (onProgress) {
    onProgress('Extracting MCPB archive...')
  }

  const unzipped = await unzipFile(Buffer.from(mcpbData))
  // fflate doesn't surface external_attr — parse the central directory so
  // native MCP server binaries keep their exec bit after extraction.
  const modes = parseZipModes(mcpbData)

  // Check for manifest.json
  const manifestData = unzipped['manifest.json']
  if (!manifestData) {
    const error = new Error('No manifest.json found in MCPB file')
    logError(error)
    throw error
  }

  // Parse and validate manifest
  const manifest = await parseAndValidateManifestFromBytes(manifestData)
  logForDebugging(
    `MCPB manifest: ${manifest.name} v${manifest.version} by ${manifest.author?.name}`,
  )

  // Check if manifest has server config
  if (!manifest.server) {
    const error = new Error(
      `MCPB manifest for "${manifest.name}" does not define a server configuration`,
    )
    logError(error)
    throw error
  }

  // Extract to cache directory
  const extractPath = join(cacheDir, contentHash)
  await extractMcpbContents(unzipped, extractPath, modes, onProgress)

  // Before the config step: a missing setting or runtime must not cost another
  // extraction once the user has fixed it.
  const now = new Date().toISOString()
  let sourceStats
  if (!isUrl(source)) {
    sourceStats = await fs.stat(join(pluginPath, source)).catch(() => undefined)
  }
  await saveCacheMetadata(cacheDir, source, {
    source,
    contentHash,
    extractedPath: extractPath,
    cachedAt: now,
    lastChecked: now,
    ...(sourceStats && {
      sourceMtimeMs: Math.floor(sourceStats.mtimeMs),
      sourceSize: sourceStats.size,
    }),
  })

  logForDebugging(
    `Successfully loaded MCPB: ${manifest.name} (extracted to ${extractPath})`,
  )

  return finishMcpbLoad(
    { manifest, extractedPath: extractPath, contentHash },
    pluginId,
    providedUserConfig,
    forceConfigDialog,
  )
}
