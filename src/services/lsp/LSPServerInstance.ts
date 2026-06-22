import { existsSync } from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type {
  InitializeParams,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import { whichSync } from '../../utils/which.js'
import type { createLSPClient as createLSPClientType } from './LSPClient.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

/**
 * LSP error code for "content modified" - indicates the server's state changed
 * during request processing (e.g., rust-analyzer still indexing the project).
 * This is a transient error that can be retried.
 */
const LSP_ERROR_CONTENT_MODIFIED = -32801

/**
 * Maximum number of retries for transient LSP errors like "content modified".
 */
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3

/**
 * Base delay in milliseconds for exponential backoff on transient errors.
 * Actual delays: 500ms, 1000ms, 2000ms
 */
const RETRY_BASE_DELAY_MS = 500

/**
 * Project-load (indexing) warmup tuning. vtsls (and most servers) emit
 * workDoneProgress begin/end while building the project graph; we treat that as
 * the readiness signal and estimate a percentage from elapsed time for the UI.
 */
const WARMUP_NO_PROGRESS_GRACE_MS = 2_500
const WARMUP_SETTLE_MS = 600
const WARMUP_MAX_MS = 60_000
const WARMUP_EXPECTED_MS = 30_000

const requireFromLspServerInstance = createRequire(import.meta.url)

const NODE_PACKAGE_LSP_COMMANDS: Record<
  string,
  { packageName: string; relativeBinPath: string }
> = {
  'bash-language-server': {
    packageName: 'bash-language-server',
    relativeBinPath: path.join('out', 'cli.js'),
  },
  vtsls: {
    packageName: '@vtsls/language-server',
    relativeBinPath: path.join('bin', 'vtsls.js'),
  },
  'yaml-language-server': {
    packageName: 'yaml-language-server',
    relativeBinPath: path.join('bin', 'yaml-language-server'),
  },
  // HTML / CSS / JSON ship together in vscode-langservers-extracted.
  'vscode-html-language-server': {
    packageName: 'vscode-langservers-extracted',
    relativeBinPath: path.join('bin', 'vscode-html-language-server'),
  },
  'vscode-css-language-server': {
    packageName: 'vscode-langservers-extracted',
    relativeBinPath: path.join('bin', 'vscode-css-language-server'),
  },
  'vscode-json-language-server': {
    packageName: 'vscode-langservers-extracted',
    relativeBinPath: path.join('bin', 'vscode-json-language-server'),
  },
  // Python.
  'pyright-langserver': {
    packageName: 'pyright',
    relativeBinPath: 'langserver.index.js',
  },
}

function resolveLspCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const packageBackedCommand = NODE_PACKAGE_LSP_COMMANDS[command]

  if (packageBackedCommand) {
    try {
      const packageJsonPath = requireFromLspServerInstance.resolve(
        `${packageBackedCommand.packageName}/package.json`,
      )
      const cliPath = path.join(
        path.dirname(packageJsonPath),
        packageBackedCommand.relativeBinPath,
      )
      if (existsSync(cliPath)) {
        return { command: process.execPath, args: [cliPath, ...args] }
      }
    } catch {
      // Fall through to the configured command so the normal spawn error is logged.
    }
  }

  const pathCommand = whichSync(command)
  if (pathCommand && process.platform !== 'win32') {
    return { command: pathCommand, args }
  }

  return { command, args }
}

/**
 * LSP server instance interface returned by createLSPServerInstance.
 * Manages the lifecycle of a single LSP server with state tracking and health monitoring.
 */
export type LSPServerInstance = {
  /** Unique server identifier */
  readonly name: string
  /** Server configuration */
  readonly config: ScopedLspServerConfig
  /** Current server state */
  readonly state: LspServerState
  /** When the server was last started */
  readonly startTime: Date | undefined
  /** Last error encountered */
  readonly lastError: Error | undefined
  /** Number of times restart() has been called */
  readonly restartCount: number
  /** Whether the server is still loading/indexing the project (initial warmup). */
  readonly indexing: boolean
  /** Estimated indexing progress 0-100 (time-based; 100 once ready). */
  readonly indexingPercent: number
  /** Resolves when the initial project load finishes (or after timeoutMs). */
  waitUntilReady(timeoutMs?: number): Promise<void>
  /** Server-advertised capabilities (from initialize); undefined until running. */
  readonly capabilities: ServerCapabilities | undefined
  /** Start the server and initialize it */
  start(): Promise<void>
  /** Stop the server gracefully */
  stop(): Promise<void>
  /** Manually restart the server (stop then start) */
  restart(): Promise<void>
  /** Check if server is healthy and ready for requests */
  isHealthy(): boolean
  /** Send an LSP request to the server */
  sendRequest<T>(method: string, params: unknown): Promise<T>
  /** Send an LSP notification to the server (fire-and-forget) */
  sendNotification(method: string, params: unknown): Promise<void>
  /** Register a handler for LSP notifications */
  onNotification(method: string, handler: (params: unknown) => void): void
  /** Register a handler for LSP requests from the server */
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
}

/**
 * Creates and manages a single LSP server instance.
 *
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 * Provides state tracking, health monitoring, and request forwarding for an LSP server.
 * Supports manual restart with configurable retry limits.
 *
 * State machine transitions:
 * - stopped → starting → running
 * - running → stopping → stopped
 * - any → error (on failure)
 * - error → starting (on retry)
 *
 * @param name - Unique identifier for this server instance
 * @param config - Server configuration including command, args, and limits
 * @returns LSP server instance with lifecycle management methods
 *
 * @example
 * const instance = createLSPServerInstance('my-server', config)
 * await instance.start()
 * const result = await instance.sendRequest('textDocument/definition', params)
 * await instance.stop()
 */
export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig,
): LSPServerInstance {
  // Validate that unimplemented fields are not set
  if (config.restartOnCrash !== undefined) {
    throw new Error(
      `LSP server '${name}': restartOnCrash is not yet implemented. Remove this field from the configuration.`,
    )
  }
  if (config.shutdownTimeout !== undefined) {
    throw new Error(
      `LSP server '${name}': shutdownTimeout is not yet implemented. Remove this field from the configuration.`,
    )
  }

  // Private state encapsulated via closures. Lazy-require LSPClient so
  // vscode-jsonrpc (~129KB) only loads when an LSP server is actually
  // instantiated, not when the static import chain reaches this module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createLSPClient } = require('./LSPClient.js') as {
    createLSPClient: typeof createLSPClientType
  }
  let state: LspServerState = 'stopped'
  let startTime: Date | undefined
  let lastError: Error | undefined
  let restartCount = 0
  let crashRecoveryCount = 0
  // Propagate crash state so ensureServerStarted can restart on next use.
  // Without this, state stays 'running' after crash and the server is never
  // restarted (zombie state).
  const client = createLSPClient(name, error => {
    state = 'error'
    lastError = error
    crashRecoveryCount++
  })

  // --- Indexing / warmup readiness (driven by LSP $/progress) ---
  // The server emits workDoneProgress begin/end while loading the project graph.
  // We use begin/end as the readiness signal (vtsls sends no percentage) and a
  // time-based estimate for the progress bar. Set-based token tracking is
  // idempotent, so re-registering handlers on restart is harmless.
  const activeProgressTokens = new Set<unknown>()
  let warmedUp = false
  let sawAnyProgress = false
  let warmupStartedAt: number | undefined
  const readyWaiters: Array<() => void> = []
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined

  function clearWarmupTimers(): void {
    if (graceTimer) clearTimeout(graceTimer)
    if (settleTimer) clearTimeout(settleTimer)
    if (maxTimer) clearTimeout(maxTimer)
    graceTimer = settleTimer = maxTimer = undefined
  }

  function markWarmedUp(): void {
    if (warmedUp) return
    warmedUp = true
    clearWarmupTimers()
    for (const resolve of readyWaiters.splice(0)) resolve()
  }

  function resetWarmup(): void {
    clearWarmupTimers()
    activeProgressTokens.clear()
    warmedUp = false
    sawAnyProgress = false
    warmupStartedAt = undefined
  }

  // Start the grace + hard-cap timers once the server is initialized.
  function startWarmupTimers(): void {
    // No project-loading progress shortly after init => nothing to index
    // (small project) => ready.
    graceTimer = setTimeout(() => {
      if (!sawAnyProgress) markWarmedUp()
    }, WARMUP_NO_PROGRESS_GRACE_MS)
    // Never wait forever.
    maxTimer = setTimeout(markWarmedUp, WARMUP_MAX_MS)
  }

  function handleProgress(params: unknown): void {
    const p = params as { token?: unknown; value?: { kind?: string } }
    const kind = p?.value?.kind
    if (kind === 'begin') {
      sawAnyProgress = true
      if (warmupStartedAt === undefined) warmupStartedAt = Date.now()
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = undefined
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = undefined
      }
      activeProgressTokens.add(p?.token)
    } else if (kind === 'end') {
      activeProgressTokens.delete(p?.token)
      if (!warmedUp && activeProgressTokens.size === 0) {
        // A brief quiet period after work ends means the initial load settled.
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          if (activeProgressTokens.size === 0) markWarmedUp()
        }, WARMUP_SETTLE_MS)
      }
    }
  }

  function registerProgressHandlers(): void {
    // Must ack progress-token creation now that we advertise workDoneProgress.
    client.onRequest('window/workDoneProgress/create', () => null)
    client.onNotification('$/progress', handleProgress)
  }

  function waitUntilReady(timeoutMs = 45_000): Promise<void> {
    if (warmedUp || state !== 'running') return Promise.resolve()
    return new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      readyWaiters.push(finish)
      setTimeout(finish, timeoutMs)
    })
  }

  function computeIndexingPercent(): number {
    if (warmedUp) return 100
    if (warmupStartedAt === undefined) return 0
    const elapsed = Date.now() - warmupStartedAt
    // Asymptotic approach toward 99: the bar keeps creeping (never hard-caps or
    // stalls at a fixed number) and never claims done until the real 'end'
    // signal sets warmedUp -> 100.
    const pct = 99 * (1 - Math.exp(-elapsed / (WARMUP_EXPECTED_MS / 3)))
    return Math.max(1, Math.round(pct))
  }

  /**
   * Starts the LSP server and initializes it with workspace information.
   *
   * If the server is already running or starting, this method returns immediately.
   * On failure, sets state to 'error', logs for monitoring, and throws.
   *
   * @throws {Error} If server fails to start or initialize
   */
  // Dedupe concurrent start() calls: callers during an in-progress start await
  // the SAME promise instead of receiving a half-started ('starting') server.
  // Without this, batched LSP operations would try to use a server that was
  // still initializing and hit "server is starting" notification failures.
  let startPromise: Promise<void> | undefined
  function start(): Promise<void> {
    if (state === 'running') return Promise.resolve()
    if (startPromise) return startPromise
    startPromise = doStart()
    startPromise
      .finally(() => {
        startPromise = undefined
      })
      .catch(() => {})
    return startPromise
  }

  async function doStart(): Promise<void> {
    // Cap crash-recovery attempts so a persistently crashing server doesn't
    // spawn unbounded child processes on every incoming request.
    const maxRestarts = config.maxRestarts ?? 3
    if (state === 'error' && crashRecoveryCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max crash recovery attempts (${maxRestarts})`,
      )
      lastError = error
      logError(error)
      throw error
    }

    let initPromise: Promise<unknown> | undefined
    try {
      state = 'starting'
      logForDebugging(`Starting LSP server instance: ${name}`)

      // Start the client
      const resolvedCommand = resolveLspCommand(
        config.command,
        config.args || [],
      )
      await client.start(resolvedCommand.command, resolvedCommand.args, {
        env: config.env,
        cwd: config.workspaceFolder,
      })

      // Register progress handlers + reset warmup BEFORE initialize, so we catch
      // the project-load progress the server emits immediately after it.
      registerProgressHandlers()
      resetWarmup()

      // Initialize with workspace info
      const workspaceFolder = config.workspaceFolder || getCwd()
      const workspaceUri = pathToFileURL(workspaceFolder).href

      const initParams: InitializeParams = {
        processId: process.pid,

        // Pass server-specific initialization options from plugin config
        // Required by vue-language-server, optional for others
        // Provide empty object as default to avoid undefined errors in servers
        // that expect this field to exist
        initializationOptions: config.initializationOptions ?? {},

        // Modern approach (LSP 3.16+) - required for Pyright, gopls
        workspaceFolders: [
          {
            uri: workspaceUri,
            name: path.basename(workspaceFolder),
          },
        ],

        // Deprecated fields - some servers still need these for proper URI resolution
        rootPath: workspaceFolder, // Deprecated in LSP 3.8 but needed by some servers
        rootUri: workspaceUri, // Deprecated in LSP 3.16 but needed by typescript-language-server for goToDefinition

        // Client capabilities - declare what features we support
        capabilities: {
          workspace: {
            // Don't claim to support workspace/configuration since we don't implement it
            // This prevents servers from requesting config we can't provide
            configuration: false,
            // Don't claim to support workspace folders changes since we don't handle
            // workspace/didChangeWorkspaceFolders notifications
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2], // Unnecessary (1), Deprecated (2)
              },
              versionSupport: false,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: {
              dynamicRegistration: false,
            },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: {
              dynamicRegistration: false,
            },
          },
          general: {
            positionEncodings: ['utf-16'],
          },
          window: {
            // Lets the server report project-loading progress via $/progress,
            // which we use to know when indexing has finished.
            workDoneProgress: true,
          },
        },
      }

      initPromise = client.initialize(initParams)
      if (config.startupTimeout !== undefined) {
        await withTimeout(
          initPromise,
          config.startupTimeout,
          `LSP server '${name}' timed out after ${config.startupTimeout}ms during initialization`,
        )
      } else {
        await initPromise
      }

      state = 'running'
      startTime = new Date()
      crashRecoveryCount = 0
      // Now that the server is initialized and about to load the project, arm
      // the grace/hard-cap timers that bound the warmup window.
      startWarmupTimers()
      logForDebugging(`LSP server instance started: ${name}`)
    } catch (error) {
      // Clean up the spawned child process on timeout/error
      client.stop().catch(() => {})
      // Prevent unhandled rejection from abandoned initialize promise
      initPromise?.catch(() => {})
      state = 'error'
      lastError = error as Error
      logError(error)
      throw error
    }
  }

  /**
   * Stops the LSP server gracefully.
   *
   * If already stopped or stopping, returns immediately.
   * On failure, sets state to 'error', logs for monitoring, and throws.
   *
   * @throws {Error} If server fails to stop
   */
  async function stop(): Promise<void> {
    if (state === 'stopped' || state === 'stopping') {
      return
    }

    try {
      state = 'stopping'
      await client.stop()
      state = 'stopped'
      // Don't leave readiness waiters hanging once the server is down.
      for (const resolve of readyWaiters.splice(0)) resolve()
      resetWarmup()
      logForDebugging(`LSP server instance stopped: ${name}`)
    } catch (error) {
      state = 'error'
      lastError = error as Error
      logError(error)
      throw error
    }
  }

  /**
   * Manually restarts the server by stopping and starting it.
   *
   * Increments restartCount and enforces maxRestarts limit.
   * Note: This is NOT automatic - must be called explicitly.
   *
   * @throws {Error} If stop or start fails, or if restartCount exceeds config.maxRestarts (default: 3)
   */
  async function restart(): Promise<void> {
    try {
      await stop()
    } catch (error) {
      const stopError = new Error(
        `Failed to stop LSP server '${name}' during restart: ${errorMessage(error)}`,
      )
      logError(stopError)
      throw stopError
    }

    restartCount++

    const maxRestarts = config.maxRestarts ?? 3
    if (restartCount > maxRestarts) {
      const error = new Error(
        `Max restart attempts (${maxRestarts}) exceeded for server '${name}'`,
      )
      logError(error)
      throw error
    }

    try {
      await start()
    } catch (error) {
      const startError = new Error(
        `Failed to start LSP server '${name}' during restart (attempt ${restartCount}/${maxRestarts}): ${errorMessage(error)}`,
      )
      logError(startError)
      throw startError
    }
  }

  /**
   * Checks if the server is healthy and ready to handle requests.
   *
   * @returns true if state is 'running' AND the client has completed initialization
   */
  function isHealthy(): boolean {
    return state === 'running' && client.isInitialized
  }

  /**
   * Sends an LSP request to the server with retry logic for transient errors.
   *
   * Checks server health before sending and wraps errors with context.
   * Automatically retries on "content modified" errors (code -32801) which occur
   * when servers like rust-analyzer are still indexing. This is expected LSP behavior
   * and clients should retry silently per the LSP specification.
   *
   * @param method - LSP method name (e.g., 'textDocument/definition')
   * @param params - Method-specific parameters
   * @returns The server's response
   * @throws {Error} If server is not healthy or request fails after all retries
   */
  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ''}`,
      )
      logError(error)
      throw error
    }

    let lastAttemptError: Error | undefined

    for (
      let attempt = 0;
      attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS;
      attempt++
    ) {
      try {
        return await client.sendRequest(method, params)
      } catch (error) {
        lastAttemptError = error as Error

        // Check if this is a transient "content modified" error that we should retry
        // This commonly happens with rust-analyzer during initial project indexing.
        // We use duck typing instead of instanceof because there may be multiple
        // versions of vscode-jsonrpc in the dependency tree (8.2.0 vs 8.2.1).
        const errorCode = (error as { code?: number }).code
        const isContentModifiedError =
          typeof errorCode === 'number' &&
          errorCode === LSP_ERROR_CONTENT_MODIFIED

        if (
          isContentModifiedError &&
          attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS
        ) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          logForDebugging(
            `LSP request '${method}' to '${name}' got ContentModified error, ` +
              `retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES_FOR_TRANSIENT_ERRORS})…`,
          )
          await sleep(delay)
          continue
        }

        // Non-retryable error or max retries exceeded
        break
      }
    }

    // All retries failed or non-retryable error
    const requestError = new Error(
      `LSP request '${method}' failed for server '${name}': ${lastAttemptError?.message ?? 'unknown error'}`,
    )
    logError(requestError)
    throw requestError
  }

  /**
   * Send a notification to the LSP server (fire-and-forget).
   * Used for file synchronization (didOpen, didChange, didClose).
   */
  async function sendNotification(
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`,
      )
      logError(error)
      throw error
    }

    try {
      await client.sendNotification(method, params)
    } catch (error) {
      const notificationError = new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`,
      )
      logError(notificationError)
      throw notificationError
    }
  }

  /**
   * Registers a handler for LSP notifications from the server.
   *
   * @param method - LSP notification method (e.g., 'window/logMessage')
   * @param handler - Callback function to handle the notification
   */
  function onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): void {
    client.onNotification(method, handler)
  }

  /**
   * Registers a handler for LSP requests from the server.
   *
   * Some LSP servers send requests TO the client (reverse direction).
   * This allows registering handlers for such requests.
   *
   * @param method - LSP request method (e.g., 'workspace/configuration')
   * @param handler - Callback function to handle the request and return a response
   */
  function onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void {
    client.onRequest(method, handler)
  }

  // Return public API
  return {
    name,
    config,
    get state() {
      return state
    },
    get startTime() {
      return startTime
    },
    get lastError() {
      return lastError
    },
    get restartCount() {
      return restartCount
    },
    get indexing() {
      return !warmedUp && sawAnyProgress
    },
    get indexingPercent() {
      return computeIndexingPercent()
    },
    get capabilities() {
      return client.capabilities
    },
    waitUntilReady,
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    onNotification,
    onRequest,
  }
}

/**
 * Race a promise against a timeout. Cleans up the timer regardless of outcome
 * to avoid unhandled rejections from orphaned setTimeout callbacks.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout((rej, msg) => rej(new Error(msg)), ms, reject, message)
  })
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timer!),
  )
}
