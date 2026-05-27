/**
 * Forced-Provider Context
 *
 * AsyncLocalStorage that pins a specific APIProvider for the duration of an
 * async call tree. Used by /team-mode so each spawned agent can route through
 * a different provider+lane than the session-global one set via /provider.
 *
 * How it threads through the stack:
 *
 *   runWithForcedProvider({ provider: 'kiro' }, () => runAgent(...))
 *       └─ Agent loop calls getAnthropicClient(...)
 *           └─ Reads getAPIProvider() — returns 'kiro' (forced)
 *               └─ createProvider('kiro') builds a LaneBackedProvider
 *                   └─ All model calls land on the Kiro lane
 *
 * Without forcing, getAPIProvider() falls back to its normal session-cached
 * value, so non-team-mode code is unchanged.
 *
 * IMPORTANT: AsyncLocalStorage is preserved across awaits and promise chains
 * within the same async context, but does NOT propagate across `setImmediate`
 * scheduled outside the run callback, `worker_threads`, or fresh event-loop
 * tasks. The agent loop runs entirely inside the callback so this is fine.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { APIProvider } from './model/providers.js'

export interface ForcedProviderContext {
  provider: APIProvider
}

const _forcedProvider = new AsyncLocalStorage<ForcedProviderContext>()

/**
 * Run `fn` with `provider` pinned as the active APIProvider for every
 * getAPIProvider() call inside this async context tree.
 */
export function runWithForcedProvider<T>(
  ctx: ForcedProviderContext,
  fn: () => T,
): T {
  return _forcedProvider.run(ctx, fn)
}

/**
 * Read the currently forced provider, if any. Returns undefined when the
 * call is happening outside a runWithForcedProvider() scope.
 */
export function getForcedProvider(): APIProvider | undefined {
  return _forcedProvider.getStore()?.provider
}
