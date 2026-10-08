import {
  getProviderRetryBudget,
  type ProviderRetryBudget,
} from '../../services/api/providerRetryBudget.js'

const handled = new WeakSet<object>()
const finished = new WeakMap<ProviderRetryBudget, unknown>()
const RETRIES = 3
const MAX_SERVER_DELAY_MS = 30_000

/** Preserve provider diagnostics, but never let another layer replay this operation. */
export function markAntigravityRetryHandled(error: unknown): unknown {
  if (error && typeof error === 'object') {
    handled.add(error)
    // A concrete own property also prevents generic status/network classifiers
    // from treating an exhausted native recovery as a fresh retry opportunity.
    const descriptor = Object.getOwnPropertyDescriptor(error, 'isRetryable')
    if (Object.isExtensible(error) && (!descriptor || descriptor.configurable)) {
      Object.defineProperty(error, 'isRetryable', { value: false, configurable: true })
    }
  }
  return error
}

export function isAntigravityRetryHandled(error: unknown): boolean {
  return !!error && typeof error === 'object' && handled.has(error)
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** One initial attempt plus three silent retries, all owned by the native request. */
export async function retryAntigravityRequest<T>(
  operation: () => Promise<T>,
  model: string,
  canRetry: (error: unknown) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const budget = getProviderRetryBudget(`antigravity-generation:${model}`, RETRIES)
  if (finished.has(budget)) throw finished.get(budget)
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await operation()
    } catch (error) {
      if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error
      const hint = (error as { retryAfterMs?: number } | null)?.retryAfterMs
      // Never shorten a server cooldown to fit our latency target. Long caps
      // need a later user operation, not repeated requests before their reset.
      if (!canRetry(error) || budget.remaining === 0
        || (hint != null && (!Number.isFinite(hint) || hint > MAX_SERVER_DELAY_MS))) {
        finished.set(budget, markAntigravityRetryHandled(error))
        throw error
      }
      const retry = RETRIES - budget.remaining
      budget.remaining--
      const delay = hint != null
        ? Math.max(0, hint)
        : 500 * 2 ** retry * (0.8 + Math.random() * 0.4)
      await wait(delay, signal)
    }
  }
}
