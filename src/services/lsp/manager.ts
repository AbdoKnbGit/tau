import { logForDebugging } from '../../utils/debug.js'
import { isBareMode } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getPowerModeFromSettings } from '../../utils/powerMode.js'
import { resetAllLSPDiagnosticState } from './LSPDiagnosticRegistry.js'
import {
  createLSPServerManager,
  type LSPServerManager,
} from './LSPServerManager.js'
import { registerLSPNotificationHandlers } from './passiveFeedback.js'
import { primeLspServers } from './prime.js'

/**
 * Initialization state of the LSP server manager
 */
type InitializationState = 'not-started' | 'pending' | 'success' | 'failed'

/**
 * Global singleton instance of the LSP server manager.
 * Initialized during Tau startup.
 */
let lspManagerInstance: LSPServerManager | undefined

/**
 * Current initialization state
 */
let initializationState: InitializationState = 'not-started'

/**
 * Error from last initialization attempt, if any
 */
let initializationError: Error | undefined

/**
 * Generation counter to prevent stale initialization promises from updating state
 */
let initializationGeneration = 0

/**
 * Promise that resolves when initialization completes (success or failure)
 */
let initializationPromise: Promise<void> | undefined
let shutdownPromise: Promise<void> = Promise.resolve()
let startupAllowed = false

/** LSP is explicit opt-in; ordinary file tools do not need a project index. */
export function isLspEnabled(): boolean {
  const settings = getInitialSettings()
  return (
    !isBareMode() &&
    settings.lspEnabled === true &&
    getPowerModeFromSettings(settings) !== 'cheap'
  )
}

/** Apply a user toggle without changing the tool catalog or system prompt. */
export function syncLspServerManagerWithSettings(): void {
  // Settings notifications must not launch project processes before main's
  // explicit post-trust initialization boundary.
  if (!startupAllowed) return
  if (isLspEnabled()) initializeLspServerManager()
  else void shutdownLspServerManager()
}

/**
 * Test-only sync reset. shutdownLspServerManager() is async and tears down
 * real connections; this only clears the module-scope singleton state so
 * reinitializeLspServerManager() early-returns on 'not-started' in downstream
 * tests on the same shard.
 */
export function _resetLspManagerForTesting(): void {
  startupAllowed = false
  lspManagerInstance = undefined
  initializationState = 'not-started'
  initializationError = undefined
  initializationPromise = undefined
  initializationGeneration++
}

/**
 * Get the singleton LSP server manager instance.
 * Returns undefined if not yet initialized, initialization failed, or still pending.
 *
 * Callers should check for undefined and handle gracefully, as initialization happens
 * asynchronously during Tau startup. Use getInitializationStatus() to
 * distinguish between pending, failed, and not-started states.
 */
export function getLspServerManager(): LSPServerManager | undefined {
  // Don't return a broken instance if initialization failed
  if (!isLspEnabled() || initializationState === 'failed') {
    return undefined
  }
  return lspManagerInstance
}

/**
 * Aggregate LSP indexing status for the UI progress bar. Safe to call any time —
 * returns "not indexing" when no manager is up.
 */
export function getLspIndexingStatus(): {
  indexing: boolean
  percent: number
  serverNames: string[]
} {
  const manager = getLspServerManager()
  if (!manager) return { indexing: false, percent: 100, serverNames: [] }
  return manager.getIndexingStatus()
}

/**
 * Get the current initialization status of the LSP server manager.
 *
 * @returns Status object with current state and error (if failed)
 */
export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  if (initializationState === 'failed') {
    return {
      status: 'failed',
      error: initializationError || new Error('Initialization failed'),
    }
  }
  if (initializationState === 'not-started') {
    return { status: 'not-started' }
  }
  if (initializationState === 'pending') {
    return { status: 'pending' }
  }
  return { status: 'success' }
}

/**
 * Check whether at least one language server is connected and healthy.
 *
 * Currently unused: this backed the LSP tool's isEnabled(), and that tool was
 * removed after 14 calls across 323 transcripts, 12 of them from sessions that
 * swept 40-51 distinct tools apiece. The language servers themselves stay --
 * they still drive diagnostics attachments and the indexing indicator.
 */
export function isLspConnected(): boolean {
  if (initializationState === 'failed') return false
  const manager = getLspServerManager()
  if (!manager) return false
  const servers = manager.getAllServers()
  if (servers.size === 0) return false
  for (const server of servers.values()) {
    if (server.state !== 'error') return true
  }
  return false
}

/**
 * Wait for LSP server manager initialization to complete.
 *
 * Returns immediately if initialization has already completed (success or failure).
 * If initialization is pending, waits for it to complete.
 * If initialization hasn't started, returns immediately.
 *
 * @returns Promise that resolves when initialization is complete
 */
export async function waitForInitialization(): Promise<void> {
  // If already initialized or failed, return immediately
  if (initializationState === 'success' || initializationState === 'failed') {
    return
  }

  // If pending and we have a promise, wait for it
  if (initializationState === 'pending' && initializationPromise) {
    await initializationPromise
  }

  // If not started, return immediately (nothing to wait for)
}

/**
 * Initialize the LSP server manager singleton.
 *
 * This function is called during Tau startup. It synchronously creates
 * the manager instance, then starts async initialization (loading LSP configs)
 * in the background without blocking the startup process.
 *
 * Safe to call multiple times - will only initialize once (idempotent).
 * However, if initialization previously failed, calling again will retry.
 */
export function initializeLspServerManager(): void {
  startupAllowed = true
  // No server, project warmup, or implicit launch from an edit unless opted in.
  if (!isLspEnabled()) {
    return
  }
  logForDebugging('[LSP MANAGER] initializeLspServerManager() called')

  // Skip if already initialized or currently initializing
  if (lspManagerInstance !== undefined && initializationState !== 'failed') {
    logForDebugging(
      '[LSP MANAGER] Already initialized or initializing, skipping',
    )
    return
  }

  lspManagerInstance ??= createLSPServerManager()
  initializeManager(lspManagerInstance)
}

function initializeManager(manager: LSPServerManager): void {
  initializationState = 'pending'
  initializationError = undefined

  // Increment generation to invalidate any pending initializations
  const currentGeneration = ++initializationGeneration
  logForDebugging(
    `[LSP MANAGER] Starting async initialization (generation ${currentGeneration})`,
  )

  // Start initialization asynchronously without blocking
  // Store the promise so callers can await it via waitForInitialization()
  initializationPromise = shutdownPromise
    .then(() => {
      if (!isLspEnabled()) return shutdownLspServerManager()
      return manager.initialize()
    })
    .then(() => {
      // Only update state if this is still the current initialization
      if (currentGeneration === initializationGeneration) {
        initializationState = 'success'
        logForDebugging('LSP server manager initialized successfully')

        // Register passive notification handlers for diagnostics
        if (lspManagerInstance === manager) {
          registerLSPNotificationHandlers(manager)
          // Warm the always-on servers now so the indexing bar appears at
          // session start instead of waiting for the first LSP query.
          void primeLspServers(manager).catch(error => {
            logForDebugging(`LSP priming failed: ${errorMessage(error)}`)
          })
        }
      }
    })
    .catch((error: unknown) => {
      // Only update state if this is still the current initialization
      if (currentGeneration === initializationGeneration) {
        initializationState = 'failed'
        initializationError = error as Error
        // Retain ownership for cleanup/retry even if configuration loading failed.

        logError(error as Error)
        logForDebugging(
          `Failed to initialize LSP server manager: ${errorMessage(error)}`,
        )
      }
    })
}

/**
 * Force re-initialization of the LSP server manager, even after a prior
 * successful init. Called from refreshActivePlugins() after plugin caches
 * are cleared, so newly-loaded plugin LSP servers are picked up.
 *
 * Fixes https://github.com/anthropics/claude-code/issues/15521:
 * loadAllPlugins() is memoized and can be called very early in startup
 * (via getCommands prefetch in setup.ts) before marketplaces are reconciled,
 * caching an empty plugin list. initializeLspServerManager() then reads that
 * stale memoized result and initializes with 0 servers. Unlike commands/agents/
 * hooks/MCP, LSP was never re-initialized on plugin refresh.
 *
 * Refresh configuration on the same manager. Unchanged servers keep their
 * processes and project indexes; changed/removed servers are stopped first.
 */
export function reinitializeLspServerManager(): void {
  if (!isLspEnabled()) {
    void shutdownLspServerManager()
    return
  }
  if (initializationState === 'not-started') {
    // initializeLspServerManager() was never called (e.g. headless subcommand
    // path). Don't start it now.
    return
  }

  logForDebugging('[LSP MANAGER] reinitializeLspServerManager() called')

  if (lspManagerInstance) initializeManager(lspManagerInstance)
}

/**
 * Shutdown the LSP server manager and clean up resources.
 *
 * This should be called during Tau shutdown. Stops all running LSP servers
 * and clears internal state. Safe to call when not initialized (no-op).
 *
 * NOTE: Errors during shutdown are logged for monitoring but NOT propagated to the caller.
 * State is always cleared even if shutdown fails, to prevent resource accumulation.
 * This is acceptable during application exit when recovery is not possible.
 *
 * @returns Promise that resolves when shutdown completes (errors are swallowed)
 */
export async function shutdownLspServerManager(): Promise<void> {
  const manager = lspManagerInstance
  // Invalidate callbacks before awaiting cleanup, so a late initialize cannot
  // publish success or prime a retired manager. A new init waits for this stop.
  lspManagerInstance = undefined
  initializationState = 'not-started'
  initializationError = undefined
  initializationPromise = undefined
  initializationGeneration++
  resetAllLSPDiagnosticState()
  if (!manager) return shutdownPromise

  shutdownPromise = Promise.all([shutdownPromise, manager.shutdown()])
    .then(() => {
      logForDebugging('LSP server manager shut down successfully')
    })
    .catch((error: unknown) => {
      logError(error as Error)
      logForDebugging(
        `Failed to shutdown LSP server manager: ${errorMessage(error)}`,
      )
    })
  return shutdownPromise
}
