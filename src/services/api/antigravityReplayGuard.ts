import { isAntigravityRetryHandled } from '../../lanes/gemini/antigravity_retry.js'

/** Do not spend a fresh request after native recovery or a partial AGY stream. */
export function shouldSuppressAntigravityReplay(
  error: unknown,
  provider: string,
  receivedProviderEvent: boolean,
): boolean {
  return isAntigravityRetryHandled(error)
    || (provider === 'antigravity' && receivedProviderEvent)
}
