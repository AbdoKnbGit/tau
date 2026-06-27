import chalk from 'chalk'
import { exec } from 'child_process'
import { execa } from 'execa'
import { mkdir, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { CLAUDE_AI_PROFILE_SCOPE } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { type APIProvider, getAPIProvider } from 'src/utils/model/providers.js'
import {
  getIsNonInteractiveSession,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
  getMockSubscriptionType,
  shouldUseMockSubscription,
} from '../services/mockRateLimits.js'
import {
  isOAuthTokenExpired,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
} from '../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../services/oauth/getOauthProfile.js'
import type { OAuthTokens, SubscriptionType } from '../services/oauth/types.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from './authFileDescriptor.js'
import {
  maybeRemoveApiKeyFromMacOSKeychainThrows,
  normalizeApiKeyForConfig,
} from './authPortable.js'
import {
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './awsAuthStatusManager.js'
import { clearBetasCaches } from './betas.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import { logAntError, logForDebugging } from './debug.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
  isRunningOnHomespace,
} from './envUtils.js'
import { errorMessage } from './errors.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { memoizeWithTTLAsync } from './memoize.js'
import { loadOpenCodeApiKeyFromAuthFile } from './opencodeAuth.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from './secureStorage/keychainPrefetch.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './secureStorage/macOsKeychainHelpers.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { jsonParse } from './slowOperations.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/** Default TTL for API key helper cache in milliseconds (5 minutes) */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

/**
 * CCR and Claude Desktop spawn the CLI with OAuth and should never fall back
 * to the user's ~/.claude/settings.json API-key config (apiKeyHelper,
 * env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN). Those settings exist for
 * the user's terminal CLI, not managed sessions. Without this guard, a user
 * who runs `claude` in their terminal with an API key sees every CCD session
 * also use that key — and fail if it's stale/wrong-org.
 */
function isManagedOAuthContext(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
  )
}

/** Whether we are supporting direct 1P auth. */
// this code is closely related to getAuthTokenSource
export function isAnthropicAuthEnabled(): boolean {
  // --bare: API-key-only, never OAuth.
  if (isBareMode()) return false

  // `claude ssh` remote: ANTHROPIC_UNIX_SOCKET tunnels API calls through a
  // local auth-injecting proxy. The launcher sets CLAUDE_CODE_OAUTH_TOKEN as a
  // placeholder iff the local side is a subscriber (so the remote includes the
  // oauth-2025 beta header to match what the proxy will inject). The remote's
  // ~/.claude settings (apiKeyHelper, settings.env.ANTHROPIC_API_KEY) MUST NOT
  // flip this — they'd cause a header mismatch with the proxy and a bogus
  // "invalid x-api-key" from the API. See src/ssh/sshAuthProxy.ts.
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  }

  const is3P =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)

  // Check if user has configured an external API key source
  // This allows externally-provided API keys to work (without requiring proxy configuration)
  const settings = getSettings_DEPRECATED() || {}
  const apiKeyHelper = settings.apiKeyHelper
  const hasExternalAuthToken =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    apiKeyHelper ||
    process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR

  // Check if API key is from an external source (not managed by /login)
  const { source: apiKeySource } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  const hasExternalApiKey =
    apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper'

  // Disable Anthropic auth if:
  // 1. Using 3rd party services (Bedrock/Vertex/Foundry)
  // 2. User has an external API key (regardless of proxy configuration)
  // 3. User has an external auth token (regardless of proxy configuration)
  // this may cause issues if users have complex proxy / gateway "client-side creds" auth scenarios,
  // e.g. if they want to set X-Api-Key to a gateway key but use Anthropic OAuth for the Authorization
  // if we get reports of that, we should probably add an env var to force OAuth enablement
  const shouldDisableAuth =
    is3P ||
    (hasExternalAuthToken && !isManagedOAuthContext()) ||
    (hasExternalApiKey && !isManagedOAuthContext())

  return !shouldDisableAuth
}

/** Where the auth token is being sourced from, if any. */
// this code is closely related to isAnthropicAuthEnabled
export function getAuthTokenSource() {
  // --bare: API-key-only. apiKeyHelper (from --settings) is the only
  // bearer-token-shaped source allowed. OAuth env vars, FD tokens, and
  // keychain are ignored.
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper()) {
      return { source: 'apiKeyHelper' as const, hasToken: true }
    }
    return { source: 'none' as const, hasToken: false }
  }

  if (process.env.ANTHROPIC_AUTH_TOKEN && !isManagedOAuthContext()) {
    return { source: 'ANTHROPIC_AUTH_TOKEN' as const, hasToken: true }
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { source: 'CLAUDE_CODE_OAUTH_TOKEN' as const, hasToken: true }
  }

  // Check for OAuth token from file descriptor (or its CCR disk fallback)
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    // getOAuthTokenFromFileDescriptor has a disk fallback for CCR subprocesses
    // that can't inherit the pipe FD. Distinguish by env var presence so the
    // org-mismatch message doesn't tell the user to unset a variable that
    // doesn't exist. Call sites fall through correctly — the new source is
    // !== 'none' (cli/handlers/auth.ts → oauth_token) and not in the
    // isEnvVarToken set (auth.ts:1844 → generic re-login message).
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) {
      return {
        source: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' as const,
        hasToken: true,
      }
    }
    return {
      source: 'CCR_OAUTH_TOKEN_FILE' as const,
      hasToken: true,
    }
  }

  // Check if apiKeyHelper is configured without executing it
  // This prevents security issues where arbitrary code could execute before trust is established
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (apiKeyHelper && !isManagedOAuthContext()) {
    return { source: 'apiKeyHelper' as const, hasToken: true }
  }

  const oauthTokens = getClaudeAIOAuthTokens()
  if (shouldUseClaudeAIAuth(oauthTokens?.scopes) && oauthTokens?.accessToken) {
    return { source: 'claude.ai' as const, hasToken: true }
  }

  return { source: 'none' as const, hasToken: false }
}

export type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'none'

export function getAnthropicApiKey(): null | string {
  const { key } = getAnthropicApiKeyWithSource()
  return key
}

export function hasAnthropicApiKeyAuth(): boolean {
  const { key, source } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  return key !== null && source !== 'none'
}

export function getAnthropicApiKeyWithSource(
  opts: { skipRetrievingKeyFromApiKeyHelper?: boolean } = {},
): {
  key: null | string
  source: ApiKeySource
} {
  // --bare: hermetic auth. Only ANTHROPIC_API_KEY env or apiKeyHelper from
  // the --settings flag. Never touches keychain, config file, or approval
  // lists. 3P (Bedrock/Vertex/Foundry) uses provider creds, not this path.
  if (isBareMode()) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
    }
    if (getConfiguredApiKeyHelper()) {
      return {
        key: opts.skipRetrievingKeyFromApiKeyHelper
          ? null
          : getApiKeyFromApiKeyHelperCached(),
        source: 'apiKeyHelper',
      }
    }
    return { key: null, source: 'none' }
  }

  // On homespace, don't use ANTHROPIC_API_KEY (use Console key instead)
  // https://anthropic.slack.com/archives/C08428WSLKV/p1747331773214779
  const apiKeyEnv = isRunningOnHomespace()
    ? undefined
    : process.env.ANTHROPIC_API_KEY

  // Always check for direct environment variable when the user ran claude --print.
  // This is useful for CI, etc.
  if (preferThirdPartyAuthentication() && apiKeyEnv) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  if (isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test') {
    // Check for API key from file descriptor first
    const apiKeyFromFd = getApiKeyFromFileDescriptor()
    if (apiKeyFromFd) {
      return {
        key: apiKeyFromFd,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    if (
      !apiKeyEnv &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    ) {
      throw new Error(
        'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required',
      )
    }

    if (apiKeyEnv) {
      return {
        key: apiKeyEnv,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    // OAuth token is present but this function returns API keys only
    return {
      key: null,
      source: 'none',
    }
  }
  // Check for ANTHROPIC_API_KEY before checking the apiKeyHelper or /login-managed key
  if (
    apiKeyEnv &&
    getGlobalConfig().customApiKeyResponses?.approved?.includes(
      normalizeApiKeyForConfig(apiKeyEnv),
    )
  ) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // Check for API key from file descriptor
  const apiKeyFromFd = getApiKeyFromFileDescriptor()
  if (apiKeyFromFd) {
    return {
      key: apiKeyFromFd,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // Check for apiKeyHelper — use sync cache, never block
  const apiKeyHelperCommand = getConfiguredApiKeyHelper()
  if (apiKeyHelperCommand) {
    if (opts.skipRetrievingKeyFromApiKeyHelper) {
      return {
        key: null,
        source: 'apiKeyHelper',
      }
    }
    // Cache may be cold (helper hasn't finished yet). Return null with
    // source='apiKeyHelper' rather than falling through to keychain —
    // apiKeyHelper must win. Callers needing a real key must await
    // getApiKeyFromApiKeyHelper() first (client.ts, useApiKeyVerification do).
    return {
      key: getApiKeyFromApiKeyHelperCached(),
      source: 'apiKeyHelper',
    }
  }

  const apiKeyFromConfigOrMacOSKeychain = getApiKeyFromConfigOrMacOSKeychain()
  if (apiKeyFromConfigOrMacOSKeychain) {
    return apiKeyFromConfigOrMacOSKeychain
  }

  return {
    key: null,
    source: 'none',
  }
}

/**
 * Get the configured apiKeyHelper from settings.
 * In bare mode, only the --settings flag source is consulted — apiKeyHelper
 * from ~/.claude/settings.json or project settings is ignored.
 */
export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper
  }
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.apiKeyHelper
}

/**
 * Check if the configured apiKeyHelper comes from project settings (projectSettings or localSettings)
 */
function isApiKeyHelperFromProjectOrLocalSettings(): boolean {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.apiKeyHelper === apiKeyHelper ||
    localSettings?.apiKeyHelper === apiKeyHelper
  )
}

/**
 * Get the configured awsAuthRefresh from settings
 */
function getConfiguredAwsAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsAuthRefresh
}

/**
 * Check if the configured awsAuthRefresh comes from project settings
 */
export function isAwsAuthRefreshFromProjectSettings(): boolean {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  if (!awsAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsAuthRefresh === awsAuthRefresh ||
    localSettings?.awsAuthRefresh === awsAuthRefresh
  )
}

/**
 * Get the configured awsCredentialExport from settings
 */
function getConfiguredAwsCredentialExport(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsCredentialExport
}

/**
 * Check if the configured awsCredentialExport comes from project settings
 */
export function isAwsCredentialExportFromProjectSettings(): boolean {
  const awsCredentialExport = getConfiguredAwsCredentialExport()
  if (!awsCredentialExport) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsCredentialExport === awsCredentialExport ||
    localSettings?.awsCredentialExport === awsCredentialExport
  )
}

/**
 * Calculate TTL in milliseconds for the API key helper cache
 * Uses CLAUDE_CODE_API_KEY_HELPER_TTL_MS env var if set and valid,
 * otherwise defaults to 5 minutes
 */
export function calculateApiKeyHelperTTL(): number {
  const envTtl = process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS

  if (envTtl) {
    const parsed = parseInt(envTtl, 10)
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
    logForDebugging(
      `Found CLAUDE_CODE_API_KEY_HELPER_TTL_MS env var, but it was not a valid number. Got ${envTtl}`,
      { level: 'error' },
    )
  }

  return DEFAULT_API_KEY_HELPER_TTL
}

// Async API key helper with sync cache for non-blocking reads.
// Epoch bumps on clearApiKeyHelperCache() — orphaned executions check their
// captured epoch before touching module state so a settings-change or 401-retry
// mid-flight can't clobber the newer cache/inflight.
let _apiKeyHelperCache: { value: string; timestamp: number } | null = null
let _apiKeyHelperInflight: {
  promise: Promise<string | null>
  // Only set on cold launches (user is waiting); null for SWR background refreshes.
  startedAt: number | null
} | null = null
let _apiKeyHelperEpoch = 0

export function getApiKeyHelperElapsedMs(): number {
  const startedAt = _apiKeyHelperInflight?.startedAt
  return startedAt ? Date.now() - startedAt : 0
}

export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  if (!getConfiguredApiKeyHelper()) return null
  const ttl = calculateApiKeyHelperTTL()
  if (_apiKeyHelperCache) {
    if (Date.now() - _apiKeyHelperCache.timestamp < ttl) {
      return _apiKeyHelperCache.value
    }
    // Stale — return stale value now, refresh in the background.
    // `??=` banned here by eslint no-nullish-assign-object-call (bun bug).
    if (!_apiKeyHelperInflight) {
      _apiKeyHelperInflight = {
        promise: _runAndCache(
          isNonInteractiveSession,
          false,
          _apiKeyHelperEpoch,
        ),
        startedAt: null,
      }
    }
    return _apiKeyHelperCache.value
  }
  // Cold cache — deduplicate concurrent calls
  if (_apiKeyHelperInflight) return _apiKeyHelperInflight.promise
  _apiKeyHelperInflight = {
    promise: _runAndCache(isNonInteractiveSession, true, _apiKeyHelperEpoch),
    startedAt: Date.now(),
  }
  return _apiKeyHelperInflight.promise
}

async function _runAndCache(
  isNonInteractiveSession: boolean,
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper(isNonInteractiveSession)
    if (epoch !== _apiKeyHelperEpoch) return value
    if (value !== null) {
      _apiKeyHelperCache = { value, timestamp: Date.now() }
    }
    return value
  } catch (e) {
    if (epoch !== _apiKeyHelperEpoch) return ' '
    const detail = e instanceof Error ? e.message : String(e)
    // biome-ignore lint/suspicious/noConsole: user-configured script failed; must be visible without --debug
    console.error(chalk.red(`apiKeyHelper failed: ${detail}`))
    logForDebugging(`Error getting API key from apiKeyHelper: ${detail}`, {
      level: 'error',
    })
    // SWR path: a transient failure shouldn't replace a working key with
    // the ' ' sentinel — keep serving the stale value and bump timestamp
    // so we don't hammer-retry every call.
    if (!isCold && _apiKeyHelperCache && _apiKeyHelperCache.value !== ' ') {
      _apiKeyHelperCache = { ..._apiKeyHelperCache, timestamp: Date.now() }
      return _apiKeyHelperCache.value
    }
    // Cold cache or prior error — cache ' ' so callers don't fall back to OAuth
    _apiKeyHelperCache = { value: ' ', timestamp: Date.now() }
    return ' '
  } finally {
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight = null
    }
  }
}

async function _executeApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return null
  }

  if (isApiKeyHelperFromProjectOrLocalSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !isNonInteractiveSession) {
      const error = new Error(
        `Security: apiKeyHelper executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('apiKeyHelper invoked before trust check', error)
      logEvent('tengu_apiKeyHelper_missing_trust11', {})
      return null
    }
  }

  const result = await execa(apiKeyHelper, {
    shell: true,
    timeout: 10 * 60 * 1000,
    reject: false,
  })
  if (result.failed) {
    // reject:false — execa resolves on exit≠0/timeout, stderr is on result
    const why = result.timedOut ? 'timed out' : `exited ${result.exitCode}`
    const stderr = result.stderr?.trim()
    throw new Error(stderr ? `${why}: ${stderr}` : why)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error('did not return a value')
  }
  return stdout
}

/**
 * Sync cache reader — returns the last fetched apiKeyHelper value without executing.
 * Returns stale values to match SWR semantics of the async reader.
 * Returns null only if the async fetch hasn't completed yet.
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  return _apiKeyHelperCache?.value ?? null
}

export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache = null
  _apiKeyHelperInflight = null
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(
  isNonInteractiveSession: boolean,
): void {
  // Skip if trust not yet accepted — the inner _executeApiKeyHelper check
  // would catch this too, but would fire a false-positive analytics event.
  if (
    isApiKeyHelperFromProjectOrLocalSettings() &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

/** Default STS credentials are one hour. We manually manage invalidation, so not too worried about this being accurate. */
const DEFAULT_AWS_STS_TTL = 60 * 60 * 1000

/**
 * Run awsAuthRefresh to perform interactive authentication (e.g., aws sso login)
 * Streams output in real-time for user visibility
 */
async function runAwsAuthRefresh(): Promise<boolean> {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()

  if (!awsAuthRefresh) {
    return false // Not configured, treat as success
  }

  // SECURITY: Check if awsAuthRefresh is from project settings
  if (isAwsAuthRefreshFromProjectSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsAuthRefresh invoked before trust check', error)
      logEvent('tengu_awsAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Fetching AWS caller identity for AWS auth refresh command')
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS auth refresh command',
    )
    return false
  } catch {
    // only actually do the refresh if caller-identity calls
    return refreshAwsAuth(awsAuthRefresh)
  }
}

// Timeout for AWS auth refresh command (3 minutes).
// Long enough for browser-based SSO flows, short enough to prevent indefinite hangs.
const AWS_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshAwsAuth(awsAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running AWS auth refresh command')
  // Start tracking authentication status
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(awsAuthRefresh, {
      timeout: AWS_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // Add output to status manager for UI display
        authStatusManager.addOutput(output)
        // Also log for debugging
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('AWS auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'AWS auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running awsAuthRefresh (in settings or ~/.claude.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * Run awsCredentialExport to get credentials and set environment variables
 * Expects JSON output containing AWS credentials
 */
async function getAwsCredsFromCredentialExport(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
} | null> {
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsCredentialExport) {
    return null
  }

  // SECURITY: Check if awsCredentialExport is from project settings
  if (isAwsCredentialExportFromProjectSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsCredentialExport executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsCredentialExport invoked before trust check', error)
      logEvent('tengu_awsCredentialExport_missing_trust', {})
      return null
    }
  }

  try {
    logForDebugging(
      'Fetching AWS caller identity for credential export command',
    )
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS credential export command',
    )
    return null
  } catch {
    // only actually do the export if caller-identity calls
    try {
      logForDebugging('Running AWS credential export command')
      const result = await execa(awsCredentialExport, {
        shell: true,
        reject: false,
      })
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error('awsCredentialExport did not return a valid value')
      }

      // Parse the JSON output from aws sts commands
      const awsOutput = jsonParse(result.stdout.trim())

      if (!isValidAwsStsOutput(awsOutput)) {
        throw new Error(
          'awsCredentialExport did not return valid AWS STS output structure',
        )
      }

      logForDebugging('AWS credentials retrieved from awsCredentialExport')
      return {
        accessKeyId: awsOutput.Credentials.AccessKeyId,
        secretAccessKey: awsOutput.Credentials.SecretAccessKey,
        sessionToken: awsOutput.Credentials.SessionToken,
      }
    } catch (e) {
      const message = chalk.red(
        'Error getting AWS credentials from awsCredentialExport (in settings or ~/.claude.json):',
      )
      if (e instanceof Error) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e.message)
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e)
      }
      return null
    }
  }
}

/**
 * Refresh AWS authentication and get credentials with cache clearing
 * This combines runAwsAuthRefresh, getAwsCredsFromCredentialExport, and clearAwsIniCache
 * to ensure fresh credentials are always used
 */
export const refreshAndGetAwsCredentials = memoizeWithTTLAsync(
  async (): Promise<{
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
  } | null> => {
    // First run auth refresh if needed
    const refreshed = await runAwsAuthRefresh()

    // Get credentials from export
    const credentials = await getAwsCredsFromCredentialExport()

    // Clear AWS INI cache to ensure fresh credentials are used
    if (refreshed || credentials) {
      await clearAwsIniCache()
    }

    return credentials
  },
  DEFAULT_AWS_STS_TTL,
)

export function clearAwsCredentialsCache(): void {
  refreshAndGetAwsCredentials.cache.clear()
}

/**
 * Get the configured gcpAuthRefresh from settings
 */
function getConfiguredGcpAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.gcpAuthRefresh
}

/**
 * Check if the configured gcpAuthRefresh comes from project settings
 */
export function isGcpAuthRefreshFromProjectSettings(): boolean {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()
  if (!gcpAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.gcpAuthRefresh === gcpAuthRefresh ||
    localSettings?.gcpAuthRefresh === gcpAuthRefresh
  )
}

/** Short timeout for the GCP credentials probe. Without this, when no local
 *  credential source exists (no ADC file, no env var), google-auth-library falls
 *  through to the GCE metadata server which hangs ~12s outside GCP. */
const GCP_CREDENTIALS_CHECK_TIMEOUT_MS = 5_000

/**
 * Check if GCP credentials are currently valid by attempting to get an access token.
 * This uses the same authentication chain that the Vertex SDK uses.
 */
export async function checkGcpCredentialsValid(): Promise<boolean> {
  try {
    // Dynamically import to avoid loading google-auth-library unnecessarily
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    const probe = (async () => {
      const client = await auth.getClient()
      await client.getAccessToken()
    })()
    const timeout = sleep(GCP_CREDENTIALS_CHECK_TIMEOUT_MS).then(() => {
      throw new GcpCredentialsTimeoutError('GCP credentials check timed out')
    })
    await Promise.race([probe, timeout])
    return true
  } catch {
    return false
  }
}

/** Default GCP credential TTL - 1 hour to match typical ADC token lifetime */
const DEFAULT_GCP_CREDENTIAL_TTL = 60 * 60 * 1000

/**
 * Run gcpAuthRefresh to perform interactive authentication (e.g., gcloud auth application-default login)
 * Streams output in real-time for user visibility
 */
async function runGcpAuthRefresh(): Promise<boolean> {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return false // Not configured, treat as success
  }

  // SECURITY: Check if gcpAuthRefresh is from project settings
  if (isGcpAuthRefreshFromProjectSettings()) {
    // Check if trust has been established for this project
    // Pass true to indicate this is a dangerous feature that requires trust
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: gcpAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('gcpAuthRefresh invoked before trust check', error)
      logEvent('tengu_gcpAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Checking GCP credentials validity for auth refresh')
    const isValid = await checkGcpCredentialsValid()
    if (isValid) {
      logForDebugging(
        'GCP credentials are valid, skipping auth refresh command',
      )
      return false
    }
  } catch {
    // Credentials check failed, proceed with refresh
  }

  return refreshGcpAuth(gcpAuthRefresh)
}

// Timeout for GCP auth refresh command (3 minutes).
// Long enough for browser-based auth flows, short enough to prevent indefinite hangs.
const GCP_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

export function refreshGcpAuth(gcpAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running GCP auth refresh command')
  // Start tracking authentication status. AwsAuthStatusManager is cloud-provider-agnostic
  // despite the name — print.ts emits its updates as generic SDK 'auth_status' messages.
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(gcpAuthRefresh, {
      timeout: GCP_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // Add output to status manager for UI display
        authStatusManager.addOutput(output)
        // Also log for debugging
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('GCP auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'GCP auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running gcpAuthRefresh (in settings or ~/.claude.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * Refresh GCP authentication if needed.
 * This function checks if credentials are valid and runs the refresh command if not.
 * Memoized with TTL to avoid excessive refresh attempts.
 */
export const refreshGcpCredentialsIfNeeded = memoizeWithTTLAsync(
  async (): Promise<boolean> => {
    // Run auth refresh if needed
    const refreshed = await runGcpAuthRefresh()
    return refreshed
  },
  DEFAULT_GCP_CREDENTIAL_TTL,
)

export function clearGcpCredentialsCache(): void {
  refreshGcpCredentialsIfNeeded.cache.clear()
}

/**
 * Prefetches GCP credentials only if workspace trust has already been established.
 * This allows us to start the potentially slow GCP commands early for trusted workspaces
 * while maintaining security for untrusted ones.
 *
 * Returns void to prevent misuse - use refreshGcpCredentialsIfNeeded() to actually refresh.
 */
export function prefetchGcpCredentialsIfSafe(): void {
  // Check if gcpAuthRefresh is configured
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return
  }

  // Check if gcpAuthRefresh is from project settings
  if (isGcpAuthRefreshFromProjectSettings()) {
    // Only prefetch if trust has already been established
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  void refreshGcpCredentialsIfNeeded()
}

/**
 * Prefetches AWS credentials only if workspace trust has already been established.
 * This allows us to start the potentially slow AWS commands early for trusted workspaces
 * while maintaining security for untrusted ones.
 *
 * Returns void to prevent misuse - use refreshAndGetAwsCredentials() to actually retrieve credentials.
 */
export function prefetchAwsCredentialsAndBedRockInfoIfSafe(): void {
  // Check if either AWS command is configured
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsAuthRefresh && !awsCredentialExport) {
    return
  }

  // Check if either command is from project settings
  if (
    isAwsAuthRefreshFromProjectSettings() ||
    isAwsCredentialExportFromProjectSettings()
  ) {
    // Only prefetch if trust has already been established
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  void refreshAndGetAwsCredentials()
  getModelStrings()
}

/** @private Use {@link getAnthropicApiKey} or {@link getAnthropicApiKeyWithSource} */
export const getApiKeyFromConfigOrMacOSKeychain = memoize(
  (): { key: string; source: ApiKeySource } | null => {
    if (isBareMode()) return null
    // TODO: migrate to SecureStorage
    if (process.platform === 'darwin') {
      // keychainPrefetch.ts fires this read at main.tsx top-level in parallel
      // with module imports. If it completed, use that instead of spawning a
      // sync `security` subprocess here (~33ms).
      const prefetch = getLegacyApiKeyPrefetchResult()
      if (prefetch) {
        if (prefetch.stdout) {
          return { key: prefetch.stdout, source: '/login managed key' }
        }
        // Prefetch completed with no key — fall through to config, not keychain.
      } else {
        const storageServiceName = getMacOsKeychainStorageServiceName()
        try {
          const result = execSyncWithDefaults_DEPRECATED(
            `security find-generic-password -a $USER -w -s "${storageServiceName}"`,
          )
          if (result) {
            return { key: result, source: '/login managed key' }
          }
        } catch (e) {
          logError(e)
        }
      }
    }

    const config = getGlobalConfig()
    if (!config.primaryApiKey) {
      return null
    }

    return { key: config.primaryApiKey, source: '/login managed key' }
  },
)

function isValidApiKey(apiKey: string): boolean {
  // Only allow alphanumeric characters, dashes, and underscores
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  // Store as primary API key
  await maybeRemoveApiKeyFromMacOSKeychain()
  let savedToKeychain = false
  if (process.platform === 'darwin') {
    try {
      // TODO: migrate to SecureStorage
      const storageServiceName = getMacOsKeychainStorageServiceName()
      const username = getUsername()

      // Convert to hexadecimal to avoid any escaping issues
      const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')

      // Use security's interactive mode (-i) with -X (hexadecimal) option
      // This ensures credentials never appear in process command-line arguments
      // Process monitors only see "security -i", not the password
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      await execa('security', ['-i'], {
        input: command,
        reject: false,
      })

      logEvent('tengu_api_key_saved_to_keychain', {})
      savedToKeychain = true
    } catch (e) {
      logError(e)
      logEvent('tengu_api_key_keychain_error', {
        error: errorMessage(
          e,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logEvent('tengu_api_key_saved_to_config', {})
    }
  } else {
    logEvent('tengu_api_key_saved_to_config', {})
  }

  const normalizedKey = normalizeApiKeyForConfig(apiKey)

  // Save config with all updates
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    return {
      ...current,
      // Only save to config if keychain save failed or not on darwin
      primaryApiKey: savedToKeychain ? current.primaryApiKey : apiKey,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: approved.includes(normalizedKey)
          ? approved
          : [...approved, normalizedKey],
        rejected: current.customApiKeyResponses?.rejected ?? [],
      },
    }
  })

  // Clear memo cache
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

export function isCustomApiKeyApproved(apiKey: string): boolean {
  const config = getGlobalConfig()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return (
    config.customApiKeyResponses?.approved?.includes(normalizedKey) ?? false
  )
}

export async function removeApiKey(): Promise<void> {
  await maybeRemoveApiKeyFromMacOSKeychain()

  // Also remove from config instead of returning early, for older clients
  // that set keys before we supported keychain.
  saveGlobalConfig(current => ({
    ...current,
    primaryApiKey: undefined,
  }))

  // Clear memo cache
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

async function maybeRemoveApiKeyFromMacOSKeychain(): Promise<void> {
  try {
    await maybeRemoveApiKeyFromMacOSKeychainThrows()
  } catch (e) {
    logError(e)
  }
}

// Function to store OAuth tokens in secure storage
export function saveOAuthTokensIfNeeded(tokens: OAuthTokens): {
  success: boolean
  warning?: string
} {
  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    logEvent('tengu_oauth_tokens_not_claude_ai', {})
    return { success: true }
  }

  // Skip saving inference-only tokens (they come from env vars)
  if (!tokens.refreshToken || !tokens.expiresAt) {
    logEvent('tengu_oauth_tokens_inference_only', {})
    return { success: true }
  }

  const secureStorage = getSecureStorage()
  const storageBackend =
    secureStorage.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

  try {
    const storageData = secureStorage.read() || {}
    const existingOauth = storageData.claudeAiOauth

    storageData.claudeAiOauth = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      // Profile fetch in refreshOAuthToken swallows errors and returns null on
      // transient failures (network, 5xx, rate limit). Don't clobber a valid
      // stored subscription with null — fall back to the existing value.
      subscriptionType:
        tokens.subscriptionType ?? existingOauth?.subscriptionType ?? null,
      rateLimitTier:
        tokens.rateLimitTier ?? existingOauth?.rateLimitTier ?? null,
    }

    const updateStatus = secureStorage.update(storageData)

    if (updateStatus.success) {
      logEvent('tengu_oauth_tokens_saved', { storageBackend })
    } else {
      logEvent('tengu_oauth_tokens_save_failed', { storageBackend })
    }

    getClaudeAIOAuthTokens.cache?.clear?.()
    clearBetasCaches()
    clearToolSchemaCache()
    return updateStatus
  } catch (error) {
    logError(error)
    logEvent('tengu_oauth_tokens_save_exception', {
      storageBackend,
      error: errorMessage(
        error,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return { success: false, warning: 'Failed to save OAuth tokens' }
  }
}

export const getClaudeAIOAuthTokens = memoize((): OAuthTokens | null => {
  // --bare: API-key-only. No OAuth env tokens, no keychain, no credentials file.
  if (isBareMode()) return null

  // Check for force-set OAuth token from environment variable
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Return an inference-only token (unknown refresh and expiry)
    return {
      accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  // Check for OAuth token from file descriptor
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    // Return an inference-only token (unknown refresh and expiry)
    return {
      accessToken: oauthTokenFromFd,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read()
    const oauthData = storageData?.claudeAiOauth

    if (!oauthData?.accessToken) {
      return null
    }

    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
})

/**
 * Clears all OAuth token caches. Call this on 401 errors to ensure
 * the next token read comes from secure storage, not stale in-memory caches.
 * This handles the case where the local expiration check disagrees with the
 * server (e.g., due to clock corrections after token was issued).
 */
export function clearOAuthTokenCache(): void {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
}

let lastCredentialsMtimeMs = 0

// Cross-process staleness: another CC instance may write fresh tokens to
// disk (refresh or /login), but this process's memoize caches forever.
// Without this, terminal 1's /login fixes terminal 1; terminal 2's /login
// then revokes terminal 1 server-side, and terminal 1's memoize never
// re-reads — infinite /login regress (CC-1096, GH#24317).
async function invalidateOAuthCacheIfDiskChanged(): Promise<void> {
  try {
    const { mtimeMs } = await stat(
      join(getClaudeConfigHomeDir(), '.credentials.json'),
    )
    if (mtimeMs !== lastCredentialsMtimeMs) {
      lastCredentialsMtimeMs = mtimeMs
      clearOAuthTokenCache()
    }
  } catch {
    // ENOENT — macOS keychain path (file deleted on migration). Clear only
    // the memoize so it delegates to the keychain cache's 30s TTL instead
    // of caching forever on top. `security find-generic-password` is
    // ~15ms; bounded to once per 30s by the keychain cache.
    getClaudeAIOAuthTokens.cache?.clear?.()
  }
}

// In-flight dedup: when N claude.ai proxy connectors hit 401 with the same
// token simultaneously (common at startup — #20930), only one should clear
// caches and re-read the keychain. Without this, each call's clearOAuthTokenCache()
// nukes readInFlight in macOsKeychainStorage and triggers a fresh spawn —
// sync spawns stacked to 800ms+ of blocked render frames.
const pending401Handlers = new Map<string, Promise<boolean>>()

/**
 * Handle a 401 "OAuth token has expired" error from the API.
 *
 * This function forces a token refresh when the server says the token is expired,
 * even if our local expiration check disagrees (which can happen due to clock
 * issues when the token was issued).
 *
 * Safety: We compare the failed token with what's in keychain. If another tab
 * already refreshed (different token in keychain), we use that instead of
 * refreshing again. Concurrent calls with the same failedAccessToken are
 * deduplicated to a single keychain read.
 *
 * @param failedAccessToken - The access token that was rejected with 401
 * @returns true if we now have a valid token, false otherwise
 */
export function handleOAuth401Error(
  failedAccessToken: string,
): Promise<boolean> {
  const pending = pending401Handlers.get(failedAccessToken)
  if (pending) return pending

  const promise = handleOAuth401ErrorImpl(failedAccessToken).finally(() => {
    pending401Handlers.delete(failedAccessToken)
  })
  pending401Handlers.set(failedAccessToken, promise)
  return promise
}

async function handleOAuth401ErrorImpl(
  failedAccessToken: string,
): Promise<boolean> {
  // Clear caches and re-read from keychain (async — sync read blocks ~100ms/call)
  clearOAuthTokenCache()
  const currentTokens = await getClaudeAIOAuthTokensAsync()

  if (!currentTokens?.refreshToken) {
    return false
  }

  // If keychain has a different token, another tab already refreshed - use it
  if (currentTokens.accessToken !== failedAccessToken) {
    logEvent('tengu_oauth_401_recovered_from_keychain', {})
    return true
  }

  // Same token that failed - force refresh, bypassing local expiration check
  return checkAndRefreshOAuthTokenIfNeeded(0, true)
}

/**
 * Reads OAuth tokens asynchronously, avoiding blocking keychain reads.
 * Delegates to the sync memoized version for env var / file descriptor tokens
 * (which don't hit the keychain), and only uses async for storage reads.
 */
export async function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  if (isBareMode()) return null

  // Env var and FD tokens are sync and don't hit the keychain
  if (
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    getOAuthTokenFromFileDescriptor()
  ) {
    return getClaudeAIOAuthTokens()
  }

  try {
    const secureStorage = getSecureStorage()
    const storageData = await secureStorage.readAsync()
    const oauthData = storageData?.claudeAiOauth
    if (!oauthData?.accessToken) {
      return null
    }
    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
}

// In-flight promise for deduplicating concurrent calls
let pendingRefreshCheck: Promise<boolean> | null = null

export function checkAndRefreshOAuthTokenIfNeeded(
  retryCount = 0,
  force = false,
): Promise<boolean> {
  // Deduplicate concurrent non-retry, non-force calls
  if (retryCount === 0 && !force) {
    if (pendingRefreshCheck) {
      return pendingRefreshCheck
    }

    const promise = checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
    pendingRefreshCheck = promise.finally(() => {
      pendingRefreshCheck = null
    })
    return pendingRefreshCheck
  }

  return checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
}

async function checkAndRefreshOAuthTokenIfNeededImpl(
  retryCount: number,
  force: boolean,
): Promise<boolean> {
  const MAX_RETRIES = 5

  await invalidateOAuthCacheIfDiskChanged()

  // First check if token is expired with cached value
  // Skip this check if force=true (server already told us token is bad)
  const tokens = getClaudeAIOAuthTokens()
  if (!force) {
    if (!tokens?.refreshToken || !isOAuthTokenExpired(tokens.expiresAt)) {
      return false
    }
  }

  if (!tokens?.refreshToken) {
    return false
  }

  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    return false
  }

  // Re-read tokens async to check if they're still expired
  // Another process might have refreshed them
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
  const freshTokens = await getClaudeAIOAuthTokensAsync()
  if (
    !freshTokens?.refreshToken ||
    !isOAuthTokenExpired(freshTokens.expiresAt)
  ) {
    return false
  }

  // Tokens are still expired, try to acquire lock and refresh
  const claudeDir = getClaudeConfigHomeDir()
  await mkdir(claudeDir, { recursive: true })

  let release
  try {
    logEvent('tengu_oauth_token_refresh_lock_acquiring', {})
    release = await lockfile.lock(claudeDir)
    logEvent('tengu_oauth_token_refresh_lock_acquired', {})
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOCKED') {
      // Another process has the lock, let's retry if we haven't exceeded max retries
      if (retryCount < MAX_RETRIES) {
        logEvent('tengu_oauth_token_refresh_lock_retry', {
          retryCount: retryCount + 1,
        })
        // Wait a bit before retrying
        await sleep(1000 + Math.random() * 1000)
        return checkAndRefreshOAuthTokenIfNeededImpl(retryCount + 1, force)
      }
      logEvent('tengu_oauth_token_refresh_lock_retry_limit_reached', {
        maxRetries: MAX_RETRIES,
      })
      return false
    }
    logError(err)
    logEvent('tengu_oauth_token_refresh_lock_error', {
      error: errorMessage(
        err,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }
  try {
    // Check one more time after acquiring lock
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    const lockedTokens = await getClaudeAIOAuthTokensAsync()
    if (
      !lockedTokens?.refreshToken ||
      !isOAuthTokenExpired(lockedTokens.expiresAt)
    ) {
      logEvent('tengu_oauth_token_refresh_race_resolved', {})
      return false
    }

    logEvent('tengu_oauth_token_refresh_starting', {})
    const refreshedTokens = await refreshOAuthToken(lockedTokens.refreshToken, {
      // For Claude.ai subscribers, omit scopes so the default
      // CLAUDE_AI_OAUTH_SCOPES applies — this allows scope expansion
      // (e.g. adding user:file_upload) on refresh without re-login.
      scopes: shouldUseClaudeAIAuth(lockedTokens.scopes)
        ? undefined
        : lockedTokens.scopes,
    })
    saveOAuthTokensIfNeeded(refreshedTokens)

    // Clear the cache after refreshing token
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    return true
  } catch (error) {
    logError(error)

    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    const currentTokens = await getClaudeAIOAuthTokensAsync()
    if (currentTokens && !isOAuthTokenExpired(currentTokens.expiresAt)) {
      logEvent('tengu_oauth_token_refresh_race_recovered', {})
      return true
    }

    return false
  } finally {
    logEvent('tengu_oauth_token_refresh_lock_releasing', {})
    await release()
    logEvent('tengu_oauth_token_refresh_lock_released', {})
  }
}

export function isClaudeAISubscriber(): boolean {
  if (!isAnthropicAuthEnabled()) {
    return false
  }

  return shouldUseClaudeAIAuth(getClaudeAIOAuthTokens()?.scopes)
}

/**
 * Check if the current OAuth token has the user:profile scope.
 *
 * Real /login tokens always include this scope. Env-var and file-descriptor
 * tokens (service keys) hardcode scopes to ['user:inference'] only. Use this
 * to gate calls to profile-scoped endpoints so service key sessions don't
 * generate 403 storms against /api/oauth/profile, bootstrap, etc.
 */
export function hasProfileScope(): boolean {
  return (
    getClaudeAIOAuthTokens()?.scopes?.includes(CLAUDE_AI_PROFILE_SCOPE) ?? false
  )
}

export function is1PApiCustomer(): boolean {
  // 1P API customers are users who are NOT:
  // 1. Claude.ai subscribers (Max, Pro, Enterprise, Team)
  // 2. Vertex AI users
  // 3. AWS Bedrock users
  // 4. Foundry users

  // Exclude Vertex, Bedrock, and Foundry customers
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return false
  }

  // Exclude Claude.ai subscribers
  if (isClaudeAISubscriber()) {
    return false
  }

  // Everyone else is an API customer (OAuth API customers, direct API key users, etc.)
  return true
}

/**
 * Gets OAuth account information when Anthropic auth is enabled.
 * Returns undefined when using external API keys or third-party services.
 */
export function getOauthAccountInfo(): AccountInfo | undefined {
  return isAnthropicAuthEnabled() ? getGlobalConfig().oauthAccount : undefined
}

/**
 * Checks if overage/extra usage provisioning is allowed for this organization.
 * This mirrors the logic in apps/claude-ai `useIsOverageProvisioningAllowed` hook as closely as possible.
 */
export function isOverageProvisioningAllowed(): boolean {
  const accountInfo = getOauthAccountInfo()
  const billingType = accountInfo?.billingType

  // Must be a Claude subscriber with a supported subscription type
  if (!isClaudeAISubscriber() || !billingType) {
    return false
  }

  // only allow Stripe and mobile billing types to purchase extra usage
  if (
    billingType !== 'stripe_subscription' &&
    billingType !== 'stripe_subscription_contracted' &&
    billingType !== 'apple_subscription' &&
    billingType !== 'google_play_subscription'
  ) {
    return false
  }

  return true
}

// Returns whether the user has Opus access at all, regardless of whether they
// are a subscriber or PayG.
export function hasOpusAccess(): boolean {
  const subscriptionType = getSubscriptionType()

  return (
    subscriptionType === 'max' ||
    subscriptionType === 'enterprise' ||
    subscriptionType === 'team' ||
    subscriptionType === 'pro' ||
    // subscriptionType === null covers both API users and the case where
    // subscribers do not have subscription type populated. For those
    // subscribers, when in doubt, we should not limit their access to Opus.
    subscriptionType === null
  )
}

export function getSubscriptionType(): SubscriptionType | null {
  // Check for mock subscription type first (ANT-only testing)
  if (shouldUseMockSubscription()) {
    return getMockSubscriptionType()
  }

  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.subscriptionType ?? null
}

export function isMaxSubscriber(): boolean {
  return getSubscriptionType() === 'max'
}

export function isTeamSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}

export function isTeamPremiumSubscriber(): boolean {
  return (
    getSubscriptionType() === 'team' &&
    getRateLimitTier() === 'default_claude_max_5x'
  )
}

export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}

export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function getRateLimitTier(): string | null {
  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.rateLimitTier ?? null
}

export function getSubscriptionName(): string {
  const subscriptionType = getSubscriptionType()

  switch (subscriptionType) {
    case 'enterprise':
      return 'Claude Enterprise'
    case 'team':
      return 'Claude Team'
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    default:
      return 'Claude API'
  }
}

/** Check if using third-party services (Bedrock or Vertex or Foundry) */
export function isUsing3PServices(): boolean {
  return !!(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  )
}

// ─── Third-Party (Non-Anthropic) Provider Auth ──────────────────────

/** Auth method resolved for a third-party provider */
export type ProviderAuthMethod = 'api_key' | 'oauth' | 'none'

/** Supported auth methods per provider */
export const PROVIDER_AUTH_SUPPORT: Record<string, ProviderAuthMethod[]> = {
  firstParty:  ['api_key', 'oauth'],
  openai:      ['api_key', 'oauth'],
  gemini:      ['api_key', 'oauth'],
  antigravity: ['oauth'],
  openrouter:  ['api_key'],
  agentrouter: ['api_key'],
  modelrouter: ['api_key'],
  vercel:      ['api_key'],
  requesty:    ['api_key'],
  opencode:    ['api_key'],
  opencodego:  ['api_key'],
  commandcode: ['api_key'],
  fireworks:   ['api_key'],
  cloudflare:  ['api_key'],
  groq:        ['api_key'],
  mistral:     ['api_key'],
  nim:         ['api_key'],
  deepseek:    ['api_key'],
  glm:         ['api_key'],
  moonshot:    ['api_key'],
  minimax:     ['api_key'],
  ollama:      ['api_key'],
  lmstudio:    ['api_key'],
  cline:       ['oauth'],
  copilot:     ['oauth'],
  cursor:      ['oauth'],
  iflow:       ['oauth'],
  kilocode:    ['oauth'],
  kiro:        ['oauth'],
}

/**
 * Determines which auth method is active for a provider.
 * Priority: OAuth token (if supported & stored) → API key → none
 *
 * OAuth takes priority because it uses the user's account subscription
 * (e.g. Gemini Pro, ChatGPT Plus), while API keys typically give
 * free-tier access with strict rate limits.
 */
export function getProviderAuthMethod(provider: APIProvider): ProviderAuthMethod {
  if (provider === 'firstParty') {
    if (getClaudeAIOAuthTokens()?.accessToken) return 'oauth'
    if (hasAnthropicApiKeyAuth()) return 'api_key'
    return 'none'
  }

  // Check OAuth first for providers that support it
  // OAuth = user's paid subscription; API key = often free tier
  const supported = PROVIDER_AUTH_SUPPORT[provider]
  if (supported?.includes('oauth')) {
    if (_hasStoredOAuthCredential(provider)) return 'oauth'
  }

  if (provider === 'ollama') {
    return process.env.OLLAMA_API_KEY ?? _loadStoredKey('ollama')
      ? 'api_key'
      : 'none'
  }

  if (provider === 'lmstudio') {
    return process.env.LMSTUDIO_API_KEY ?? _loadStoredKey('lmstudio')
      ? 'api_key'
      : 'none'
  }

  // Fall back to API key
  const key = _getApiKeyDirect(provider)
  if (key) return 'api_key'

  return 'none'
}

/**
 * Returns the API key for a third-party LLM provider.
 * Checks: env var → stored key file → null.
 */
export function getProviderApiKey(provider: APIProvider): string | null {
  return _getApiKeyDirect(provider)
}

/**
 * Returns the key used at request time. OpenCode Zen accepts `Bearer public`
 * for anonymous allow-listed models; paid rows still require a real account key.
 */
export function getProviderRuntimeApiKey(provider: APIProvider): string | null {
  if (provider === 'opencode' || provider === 'opencodego') return _getApiKeyDirect(provider) ?? 'public'
  return _getApiKeyDirect(provider)
}

/** Direct API key lookup — env var → stored key. No OAuth fallback. */
function _getApiKeyDirect(provider: APIProvider): string | null {
  switch (provider) {
    case 'openai':      return process.env.OPENAI_API_KEY ?? _loadStoredKey('openai')
    case 'openrouter':  return process.env.OPENROUTER_API_KEY ?? _loadStoredKey('openrouter')
    case 'agentrouter': return process.env.AGENT_ROUTER_TOKEN ?? process.env.AGENTROUTER_API_KEY ?? _loadStoredKey('agentrouter')
    case 'modelrouter': return process.env.MODEL_ROUTER_API_KEY ?? process.env.MODELROUTER_API_KEY ?? process.env.LXG2IT_API_KEY ?? _loadStoredKey('modelrouter')
    case 'vercel':      return process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? _loadStoredKey('vercel')
    case 'requesty':    return process.env.REQUESTY_API_KEY ?? _loadStoredKey('requesty')
    case 'opencode':    return process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_ZEN_API_KEY ?? _loadStoredKey('opencode') ?? loadOpenCodeApiKeyFromAuthFile()
    // Go shares the OpenCode credential with Zen — read the dedicated Go env
    // first, then fall back to the shared OpenCode key sources so one login
    // powers both tiers.
    case 'opencodego':  return process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_ZEN_API_KEY ?? _loadStoredKey('opencodego') ?? _loadStoredKey('opencode') ?? loadOpenCodeApiKeyFromAuthFile()
    case 'commandcode': return process.env.CMD_API_KEY ?? process.env.COMMANDCODE_API_KEY ?? process.env.COMMAND_CODE_API_KEY ?? _loadStoredKey('commandcode') ?? loadCommandCodeApiKeyFromAuthFile()
    case 'fireworks':   return process.env.FIREWORKS_API_KEY ?? _loadStoredKey('fireworks')
    case 'cloudflare':  return process.env.CLOUDFLARE_WORKERS_AI_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_API_KEY ?? _loadStoredKey('cloudflare')
    case 'groq':        return process.env.GROQ_API_KEY ?? _loadStoredKey('groq')
    case 'mistral':     return process.env.MISTRAL_API_KEY ?? _loadStoredKey('mistral')
    case 'nim':         return process.env.NIM_API_KEY ?? _loadStoredKey('nim')
    case 'gemini':      return process.env.GEMINI_API_KEY ?? _loadStoredKey('gemini')
    case 'antigravity': return null  // OAuth-only provider
    case 'deepseek':    return process.env.DEEPSEEK_API_KEY ?? _loadStoredKey('deepseek')
    case 'glm':         return process.env.GLM_API_KEY ?? process.env.BIGMODEL_API_KEY ?? process.env.ZHIPU_API_KEY ?? process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? _loadStoredKey('glm')
    case 'moonshot':    return process.env.MOONSHOT_API_KEY ?? process.env.MOONSHOTAI_API_KEY ?? _loadStoredKey('moonshot')
    case 'minimax':     return process.env.MINIMAX_API_KEY ?? _loadStoredKey('minimax')
    case 'ollama':      return process.env.OLLAMA_API_KEY ?? _loadStoredKey('ollama') ?? 'ollama'
    case 'lmstudio':    return process.env.LMSTUDIO_API_KEY ?? _loadStoredKey('lmstudio') ?? 'lm-studio'
    case 'cline':       return null  // OAuth-only
    case 'copilot':     return null  // OAuth-only
    case 'cursor':      return null  // OAuth-only
    case 'iflow':       return null  // OAuth-only
    case 'kilocode':    return null  // OAuth-only
    case 'kiro':        return null  // OAuth-only
    default:            return getAnthropicApiKey()
  }
}

/**
 * Returns an OAuth access token for a provider, if one is stored and valid.
 * Returns null if OAuth is not available or token is missing/expired.
 */
export function getProviderOAuthToken(provider: APIProvider): string | null {
  return _loadStoredOAuthToken(provider)
}

/** Load a stored OAuth token from provider-keys.json */
function _loadStoredOAuthToken(provider: string): string | null {
  try {
    const { readFileSync, existsSync } = require('fs')
    const { join } = require('path')
    const { homedir } = require('os')
    const keysFile = join(homedir(), '.config', 'claude-code', 'provider-keys.json')
    if (!existsSync(keysFile)) return null
    const data = JSON.parse(readFileSync(keysFile, 'utf-8'))

    // Gemini now uses the CLI-tier OAuth only — Antigravity has its own
    // provider row that reads gemini_oauth_antigravity directly.
    if (provider === 'gemini') {
      return _tryParseToken(data?.keys?.['gemini_oauth_cli'])
          ?? _tryParseToken(data?.keys?.['gemini_oauth'])  // legacy
    }
    if (provider === 'antigravity') {
      return _tryParseToken(data?.keys?.['gemini_oauth_antigravity'])
    }

    const oauthKey = `${provider}_oauth`
    return _tryParseToken(data?.keys?.[oauthKey])
  } catch {
    return null
  }
}

function _hasStoredOAuthCredential(provider: string): boolean {
  try {
    const { readFileSync, existsSync } = require('fs')
    const { join } = require('path')
    const { homedir } = require('os')
    const keysFile = join(homedir(), '.config', 'claude-code', 'provider-keys.json')
    if (!existsSync(keysFile)) return false
    const data = JSON.parse(readFileSync(keysFile, 'utf-8'))

    if (provider === 'gemini') {
      return _hasStoredOAuthBlob(data?.keys?.['gemini_oauth_cli'])
        || _hasStoredOAuthBlob(data?.keys?.['gemini_oauth'])
    }
    if (provider === 'antigravity') {
      return _hasStoredOAuthBlob(data?.keys?.['gemini_oauth_antigravity'])
    }

    return _hasStoredOAuthBlob(data?.keys?.[`${provider}_oauth`])
  } catch {
    return false
  }
}

/** Parse a stored token JSON string — returns accessToken if not expired, else null. */
function _tryParseToken(stored: string | undefined): string | null {
  if (!stored) return null
  try {
    const tokens = JSON.parse(stored)
    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      return null
    }
    return tokens.accessToken ?? null
  } catch {
    return null
  }
}

function _hasStoredOAuthBlob(stored: string | undefined): boolean {
  if (!stored) return false
  try {
    const tokens = JSON.parse(stored) as {
      accessToken?: unknown
      refreshToken?: unknown
    }
    return (
      (typeof tokens.accessToken === 'string' && tokens.accessToken.length > 0)
      || (typeof tokens.refreshToken === 'string' && tokens.refreshToken.length > 0)
    )
  } catch {
    return false
  }
}

/**
 * Returns the base URL for a third-party LLM provider's API.
 */
export function getProviderBaseUrl(provider: APIProvider): string {
  switch (provider) {
    case 'openai':      return process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
    case 'openrouter':  return 'https://openrouter.ai/api/v1'
    case 'agentrouter': return process.env.AGENTROUTER_BASE_URL ?? 'https://agentrouter.org/v1'
    case 'modelrouter': return process.env.MODELROUTER_BASE_URL ?? process.env.MODEL_ROUTER_BASE_URL ?? process.env.LXG2IT_BASE_URL ?? 'https://api.lxg2it.com/v1'
    case 'vercel':      return process.env.VERCEL_AI_GATEWAY_BASE_URL ?? process.env.AI_GATEWAY_BASE_URL ?? 'https://ai-gateway.vercel.sh/v1'
    case 'requesty':    return process.env.REQUESTY_BASE_URL ?? 'https://router.requesty.ai/v1'
    case 'opencode':    return process.env.OPENCODE_BASE_URL ?? process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1'
    case 'opencodego':  return process.env.OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1'
    case 'commandcode': return normalizeCommandCodeBaseUrl(process.env.COMMANDCODE_BASE_URL ?? process.env.COMMAND_CODE_BASE_URL ?? process.env.CMD_BASE_URL ?? 'https://api.commandcode.ai/provider/v1')
    case 'fireworks':   return process.env.FIREWORKS_BASE_URL ?? 'https://api.fireworks.ai/inference/v1'
    case 'cloudflare':  return getCloudflareWorkersAIBaseUrl()
    case 'groq':        return 'https://api.groq.com/openai/v1'
    case 'mistral':     return process.env.MISTRAL_BASE_URL ?? process.env.MISTRAL_API_BASE_URL ?? 'https://api.mistral.ai/v1'
    case 'nim':         return process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1'
    case 'gemini':      return 'https://generativelanguage.googleapis.com/v1beta'
    case 'antigravity': return 'https://cloudcode-pa.googleapis.com/v1internal'
    case 'deepseek':    return process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
    case 'glm':         return process.env.GLM_BASE_URL ?? process.env.GLM_API_URL ?? process.env.BIGMODEL_BASE_URL ?? process.env.ZHIPU_BASE_URL ?? process.env.ZAI_BASE_URL ?? process.env.Z_AI_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4'
    case 'moonshot':    return process.env.MOONSHOT_BASE_URL ?? process.env.MOONSHOT_API_BASE_URL ?? 'https://api.moonshot.ai/v1'
    case 'minimax':     return process.env.MINIMAX_BASE_URL ?? process.env.MINIMAX_API_BASE_URL ?? 'https://api.minimax.io/v1'
    case 'ollama':      return process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1'
    case 'lmstudio':    return normalizeLmStudioBaseUrl(process.env.LMSTUDIO_BASE_URL ?? process.env.LM_STUDIO_BASE_URL ?? _loadStoredKey('lmstudio_base_url') ?? 'http://localhost:1234/v1')
    case 'cline':       return process.env.CLINE_BASE_URL ?? 'https://api.cline.bot/v1'
    case 'copilot':     return 'https://api.githubcopilot.com'
    case 'cursor':      return 'https://api2.cursor.sh'
    case 'iflow':       return 'https://apis.iflow.cn/v1'
    case 'kilocode':    return 'https://api.kilo.ai'
    case 'kiro':        return 'https://codewhisperer.us-east-1.amazonaws.com'
    default:            return process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
  }
}

/**
 * Check if using any non-Anthropic third-party LLM provider.
 */
export function isUsingThirdPartyLLM(): boolean {
  return !!(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENROUTER) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_AGENTROUTER) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_MODELROUTER) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_MODEL_ROUTER) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_LXG2IT) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERCEL) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERCEL_AI_GATEWAY) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_REQUESTY) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENCODE) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENCODE_ZEN) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_COMMANDCODE) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_COMMAND_CODE) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_CLOUDFLARE) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_CLOUDFLARE_WORKERS_AI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GROQ) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_NIM) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_DEEPSEEK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GLM) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_MOONSHOT) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_MINIMAX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_LMSTUDIO)
  )
}

function normalizeLmStudioBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  const trimmed = withScheme.replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

export function getCloudflareWorkersAIAccountId(): string | null {
  return process.env.CLOUDFLARE_ACCOUNT_ID ?? _loadStoredKey('cloudflare_account_id')
}

export function getCloudflareWorkersAIBaseUrlOverride(): string | null {
  return process.env.CLOUDFLARE_WORKERS_AI_BASE_URL ?? process.env.CLOUDFLARE_BASE_URL ?? null
}

export function getCloudflareWorkersAIBaseUrl(accountId = getCloudflareWorkersAIAccountId()): string {
  const override = getCloudflareWorkersAIBaseUrlOverride()
  if (override) return override.replace(/\/+$/, '')
  if (accountId) {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`
  }
  return 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1'
}

function normalizeCommandCodeBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/**
 * Validates that the current provider has valid credentials configured.
 * Accepts either API key or OAuth token (for providers that support OAuth).
 * Returns { valid: true, method } or { valid: false, reason }.
 */
export function validateProviderAuth(provider: APIProvider): { valid: boolean; method?: ProviderAuthMethod; reason?: string } {
  const authMethod = getProviderAuthMethod(provider)

  if (provider === 'opencode' && getProviderRuntimeApiKey(provider)) {
    return { valid: true, method: 'api_key' }
  }

  if (
    provider === 'cloudflare'
    && authMethod === 'api_key'
    && !getCloudflareWorkersAIAccountId()
    && !getCloudflareWorkersAIBaseUrlOverride()
  ) {
    return {
      valid: false,
      reason: 'No Cloudflare account ID found. Set CLOUDFLARE_ACCOUNT_ID or run `/login cloudflare`.',
    }
  }

  if (authMethod === 'api_key') {
    const key = getProviderApiKey(provider)!
    const formatCheck = _validateKeyFormat(provider, key)
    if (!formatCheck.valid) return formatCheck
    return { valid: true, method: 'api_key' }
  }

  if (authMethod === 'oauth') {
    return { valid: true, method: 'oauth' }
  }

  // No auth found — build helpful error message
  if (provider === 'ollama' || provider === 'lmstudio') {
    return { valid: true, method: 'none' }
  }

  const envVar = _getApiKeyEnvName(provider)
  const supported = PROVIDER_AUTH_SUPPORT[provider] ?? ['api_key']
  const methods = supported.join(' or ')
  const oauthHint = supported.includes('oauth')
    ? ` Or authenticate with OAuth: run \`/login\` and choose ${provider}.`
    : ''

  return {
    valid: false,
    reason: `No credentials found for ${provider}. Set ${envVar} (${methods}).${oauthHint}`,
  }
}

function _getApiKeyEnvName(provider: APIProvider): string {
  switch (provider) {
    case 'openai':      return 'OPENAI_API_KEY'
    case 'openrouter':  return 'OPENROUTER_API_KEY'
    case 'agentrouter': return 'AGENT_ROUTER_TOKEN or AGENTROUTER_API_KEY'
    case 'modelrouter': return 'MODEL_ROUTER_API_KEY or LXG2IT_API_KEY'
    case 'vercel':      return 'AI_GATEWAY_API_KEY or VERCEL_AI_GATEWAY_API_KEY'
    case 'requesty':    return 'REQUESTY_API_KEY'
    case 'opencodego':  return 'OPENCODE_API_KEY'
    case 'commandcode': return 'CMD_API_KEY'
    case 'fireworks':   return 'FIREWORKS_API_KEY'
    case 'cloudflare':  return 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID'
    case 'groq':        return 'GROQ_API_KEY'
    case 'mistral':     return 'MISTRAL_API_KEY'
    case 'nim':         return 'NIM_API_KEY'
    case 'gemini':      return 'GEMINI_API_KEY'
    case 'antigravity': return '(OAuth only — no API key)'
    case 'deepseek':    return 'DEEPSEEK_API_KEY'
    case 'glm':         return 'GLM_API_KEY'
    case 'moonshot':    return 'MOONSHOT_API_KEY'
    case 'minimax':     return 'MINIMAX_API_KEY'
    case 'ollama':      return 'OLLAMA_API_KEY'
    case 'lmstudio':    return 'LMSTUDIO_API_KEY'
    case 'cline':       return '(OAuth only — no API key)'
    case 'copilot':     return '(OAuth only — no API key)'
    case 'cursor':      return '(OAuth only — no API key)'
    case 'iflow':       return '(OAuth only — no API key)'
    case 'kilocode':    return '(OAuth only — no API key)'
    case 'kiro':        return '(OAuth only — no API key)'
    default:            return 'ANTHROPIC_API_KEY'
  }
}

function _validateKeyFormat(provider: APIProvider, key: string): { valid: boolean; reason?: string } {
  // Light sanity checks — don't reject valid keys, just catch obvious misconfigs
  const checks: Record<string, { prefix?: string; minLen: number }> = {
    openai:      { prefix: 'sk-', minLen: 20 },
    openrouter:  { prefix: 'sk-or-', minLen: 20 },
    agentrouter: { minLen: 16 },
    modelrouter: { minLen: 10 },
    vercel:      { minLen: 10 },
    requesty:    { minLen: 10 },
    commandcode: { minLen: 10 },
    cloudflare:  { minLen: 10 },
    groq:        { prefix: 'gsk_', minLen: 20 },
    mistral:     { minLen: 20 },
    nim:         { prefix: 'nvapi-', minLen: 20 },
    gemini:      { minLen: 10 },
    deepseek:    { prefix: 'sk-', minLen: 20 },
    glm:         { minLen: 10 },
    moonshot:    { prefix: 'sk-', minLen: 20 },
    minimax:     { minLen: 10 },
  }
  const check = checks[provider]
  if (!check) return { valid: true }
  if (key.length < check.minLen) {
    return { valid: false, reason: `${provider} API key appears too short (${key.length} chars).` }
  }
  // Prefix check is advisory only — some providers issue keys without standard prefixes
  return { valid: true }
}

/** Load a stored key from ~/.config/claude-code/provider-keys.json */
function _loadStoredKey(provider: string): string | null {
  try {
    // Dynamic import to avoid circular deps — api_key_manager is a leaf module
    const { readFileSync, existsSync } = require('fs')
    const { join } = require('path')
    const { homedir } = require('os')
    const keysFile = join(homedir(), '.config', 'claude-code', 'provider-keys.json')
    if (!existsSync(keysFile)) return null
    const data = JSON.parse(readFileSync(keysFile, 'utf-8'))
    return data?.keys?.[provider] ?? null
  } catch {
    return null
  }
}

/** Load a Command Code account key from ~/.commandcode/auth.json, if present. */
function loadCommandCodeApiKeyFromAuthFile(): string | null {
  try {
    const { readFileSync, existsSync } = require('fs')
    const { join } = require('path')
    const { homedir } = require('os')
    const authFile = join(homedir(), '.commandcode', 'auth.json')
    if (!existsSync(authFile)) return null
    const data = JSON.parse(readFileSync(authFile, 'utf-8'))
    const key = data?.apiKey
    return typeof key === 'string' && key.trim() ? key.trim() : null
  } catch {
    return null
  }
}

/**
 * Get the configured otelHeadersHelper from settings
 */
function getConfiguredOtelHeadersHelper(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.otelHeadersHelper
}

/**
 * Check if the configured otelHeadersHelper comes from project settings (projectSettings or localSettings)
 */
export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()
  if (!otelHeadersHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.otelHeadersHelper === otelHeadersHelper ||
    localSettings?.otelHeadersHelper === otelHeadersHelper
  )
}

// Cache for debouncing otelHeadersHelper calls
let cachedOtelHeaders: Record<string, string> | null = null
let cachedOtelHeadersTimestamp = 0
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29 minutes

export function getOtelHeadersFromHelper(): Record<string, string> {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()

  if (!otelHeadersHelper) {
    return {}
  }

  // Return cached headers if still valid (debounce)
  const debounceMs = parseInt(
    process.env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS ||
      DEFAULT_OTEL_HEADERS_DEBOUNCE_MS.toString(),
  )
  if (
    cachedOtelHeaders &&
    Date.now() - cachedOtelHeadersTimestamp < debounceMs
  ) {
    return cachedOtelHeaders
  }

  if (isOtelHeadersHelperFromProjectOrLocalSettings()) {
    // Check if trust has been established for this project
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      return {}
    }
  }

  try {
    const result = execSyncWithDefaults_DEPRECATED(otelHeadersHelper, {
      timeout: 30000, // 30 seconds - allows for auth service latency
    })
      ?.toString()
      .trim()
    if (!result) {
      throw new Error('otelHeadersHelper did not return a valid value')
    }

    const headers = jsonParse(result)
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(
        'otelHeadersHelper must return a JSON object with string key-value pairs',
      )
    }

    // Validate all values are strings
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `otelHeadersHelper returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    // Cache the result
    cachedOtelHeaders = headers as Record<string, string>
    cachedOtelHeadersTimestamp = Date.now()

    return cachedOtelHeaders
  } catch (error) {
    logError(
      new Error(
        `Error getting OpenTelemetry headers from otelHeadersHelper (in settings): ${errorMessage(error)}`,
      ),
    )
    throw error
  }
}

function isConsumerPlan(plan: SubscriptionType): plan is 'max' | 'pro' {
  return plan === 'max' || plan === 'pro'
}

export function isConsumerSubscriber(): boolean {
  const subscriptionType = getSubscriptionType()
  return (
    isClaudeAISubscriber() &&
    subscriptionType !== null &&
    isConsumerPlan(subscriptionType)
  )
}

export type UserAccountInfo = {
  subscription?: string
  tokenSource?: string
  apiKeySource?: ApiKeySource
  organization?: string
  email?: string
}

export function getAccountInformation() {
  const apiProvider = getAPIProvider()
  // Only provide account info for first-party Anthropic API
  if (apiProvider !== 'firstParty') {
    return undefined
  }
  const { source: authTokenSource } = getAuthTokenSource()
  const accountInfo: UserAccountInfo = {}
  if (
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
  ) {
    accountInfo.tokenSource = authTokenSource
  } else if (isClaudeAISubscriber()) {
    accountInfo.subscription = getSubscriptionName()
  } else {
    accountInfo.tokenSource = authTokenSource
  }
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) {
    accountInfo.apiKeySource = apiKeySource
  }

  // We don't know the organization if we're relying on an external API key or auth token
  if (
    authTokenSource === 'claude.ai' ||
    apiKeySource === '/login managed key'
  ) {
    // Get organization name from OAuth account info
    const orgName = getOauthAccountInfo()?.organizationName
    if (orgName) {
      accountInfo.organization = orgName
    }
  }
  const email = getOauthAccountInfo()?.emailAddress
  if (
    (authTokenSource === 'claude.ai' ||
      apiKeySource === '/login managed key') &&
    email
  ) {
    accountInfo.email = email
  }
  return accountInfo
}

/**
 * Result of org validation — either success or a descriptive error.
 */
export type OrgValidationResult =
  | { valid: true }
  | { valid: false; message: string }

/**
 * Validate that the active OAuth token belongs to the organization required
 * by `forceLoginOrgUUID` in managed settings. Returns a result object
 * rather than throwing so callers can choose how to surface the error.
 *
 * Fails closed: if `forceLoginOrgUUID` is set and we cannot determine the
 * token's org (network error, missing profile data), validation fails.
 */
export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  // `claude ssh` remote: real auth lives on the local machine and is injected
  // by the proxy. The placeholder token can't be validated against the profile
  // endpoint. The local side already ran this check before establishing the session.
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return { valid: true }
  }

  if (!isAnthropicAuthEnabled()) {
    return { valid: true }
  }

  const requiredOrgUuid =
    getSettingsForSource('policySettings')?.forceLoginOrgUUID
  if (!requiredOrgUuid) {
    return { valid: true }
  }

  // Ensure the access token is fresh before hitting the profile endpoint.
  // No-op for env-var tokens (refreshToken is null).
  await checkAndRefreshOAuthTokenIfNeeded()

  const tokens = getClaudeAIOAuthTokens()
  if (!tokens) {
    return { valid: true }
  }

  // Always fetch the authoritative org UUID from the profile endpoint.
  // Even keychain-sourced tokens verify server-side: the cached org UUID
  // in ~/.claude.json is user-writable and cannot be trusted.
  const { source } = getAuthTokenSource()
  const isEnvVarToken =
    source === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    source === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'

  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
  if (!profile) {
    // Fail closed — we can't verify the org
    return {
      valid: false,
      message:
        `Unable to verify organization for the current authentication token.\n` +
        `This machine requires organization ${requiredOrgUuid} but the profile could not be fetched.\n` +
        `This may be a network error, or the token may lack the user:profile scope required for\n` +
        `verification (tokens from 'claude setup-token' do not include this scope).\n` +
        `Try again, or obtain a full-scope token via 'claude auth login'.`,
    }
  }

  const tokenOrgUuid = profile.organization.uuid
  if (tokenOrgUuid === requiredOrgUuid) {
    return { valid: true }
  }

  if (isEnvVarToken) {
    const envVarName =
      source === 'CLAUDE_CODE_OAUTH_TOKEN'
        ? 'CLAUDE_CODE_OAUTH_TOKEN'
        : 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
    return {
      valid: false,
      message:
        `The ${envVarName} environment variable provides a token for a\n` +
        `different organization than required by this machine's managed settings.\n\n` +
        `Required organization: ${requiredOrgUuid}\n` +
        `Token organization:   ${tokenOrgUuid}\n\n` +
        `Remove the environment variable or obtain a token for the correct organization.`,
    }
  }

  return {
    valid: false,
    message:
      `Your authentication token belongs to organization ${tokenOrgUuid},\n` +
      `but this machine requires organization ${requiredOrgUuid}.\n\n` +
      `Please log in with the correct organization: claude auth login`,
  }
}

class GcpCredentialsTimeoutError extends Error {}
