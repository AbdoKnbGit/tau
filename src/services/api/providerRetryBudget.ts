import { AsyncLocalStorage } from 'node:async_hooks'

export interface ProviderRetryBudget {
  remaining: number
}

export type ProviderRetryState = Map<string, ProviderRetryBudget>

const providerRetryState = new AsyncLocalStorage<ProviderRetryState>()
const setupWindows = new WeakMap<ProviderRetryState, Map<string, ProviderSetupWindow>>()

interface ProviderSetupWindow {
  deadlineAt: number
  timeoutMs: number
}

/** One first-response window across outer retries, separate from retry counts. */
export function getProviderSetupWindow(key: string, timeoutMs: number): ProviderSetupWindow {
  const state = providerRetryState.getStore()
  let windows = state && setupWindows.get(state)
  const existing = windows?.get(key)
  if (existing) return existing
  const window = { deadlineAt: Date.now() + timeoutMs, timeoutMs }
  if (state) {
    if (!windows) {
      windows = new Map()
      setupWindows.set(state, windows)
    }
    windows.set(key, window)
  }
  return window
}

/** A local response deadline is not a quota refusal or a fresh retry window. */
export class ProviderSetupTimeoutError extends Error {
  readonly isRetryable = false

  constructor(provider: string, timeoutMs: number) {
    super(`${provider} response timed out after ${timeoutMs}ms before any output`)
    this.name = 'ProviderSetupTimeoutError'
  }
}

/** Keep native retry allowances attached to one outer operation, not the process. */
export function withProviderRetryState<T>(state: ProviderRetryState, operation: () => T): T {
  return providerRetryState.run(state, operation)
}

export interface ProviderRetryNotice {
  status: number | null
  attempt: number
  maxRetries: number
  delayMs: number
}

let retryListener: ((notice: ProviderRetryNotice) => void) | undefined

/** Print mode listens, so a script can see the wait. Interactive sessions do not. */
export function setProviderRetryListener(
  listener: (notice: ProviderRetryNotice) => void,
): void {
  retryListener = listener
}

/** A provider request is about to be sent again after this wait. */
export function reportProviderRetry(notice: ProviderRetryNotice): void {
  retryListener?.(notice)
}

/** Standalone native calls get their own allowance; outer retries reuse it. */
export function getProviderRetryBudget(key: string, limit: number): ProviderRetryBudget {
  const state = providerRetryState.getStore()
  const existing = state?.get(key)
  if (existing) return existing
  const budget = { remaining: limit }
  state?.set(key, budget)
  return budget
}
