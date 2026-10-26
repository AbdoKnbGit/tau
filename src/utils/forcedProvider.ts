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
  /**
   * How the provider was pinned. Without a source it is an explicit caller
   * choice (/team-mode, the Agent tool's `provider`). Agent-scoped overrides
   * may be replaced by a more specific nested agent. A spawn scope only keeps
   * a running sub-agent on the provider it started on: it is nobody's choice,
   * so getForcedProvider() and the policies that ask it ignore it.
   */
  source?: 'agent' | 'spawn'
  /**
   * The model the agent in this scope runs, once runAgent has resolved it.
   * Helpers that pick a model themselves (small-model side queries, token
   * counts) pair with it when this provider is not the session's, since the
   * session's model is not one this provider serves.
   */
  model?: string
}

const _forcedProvider = new AsyncLocalStorage<
  ForcedProviderContext | undefined
>()

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
 * Run `fn` on the session's provider, outside every provider scope.
 *
 * Main-thread turns start here. A scope can reach the main thread through
 * work a sub-agent schedules: a React re-render it triggers runs the effect
 * that starts the next queued turn, and a resumed agent's lifecycle queues its
 * completion notification from inside its route's scope. That turn would
 * otherwise send the session's model to the sub-agent's provider.
 */
export function runOutsideProviderScope<T>(fn: () => T): T {
  return _forcedProvider.run(undefined, fn)
}

/**
 * Drive `stream` inside `ctx` one step at a time.
 *
 * The generator's own code (an agent's turns and tools) runs on the scoped
 * provider; whoever consumes it runs outside, between steps. A consumer that
 * updates the main screen or queues a main-thread notice must not carry the
 * agent's provider there: a re-render it triggers would read it, and the
 * session bar would show the agent's provider with the session's model.
 */
export async function* driveInProviderScope<T>(
  ctx: ForcedProviderContext,
  stream: AsyncGenerator<T, void>,
): AsyncGenerator<T, void> {
  try {
    while (true) {
      const next = await _forcedProvider.run(ctx, () => stream.next())
      if (next.done) return
      yield next.value
    }
  } finally {
    await _forcedProvider.run(ctx, () => stream.return(undefined))
  }
}

/**
 * Read the currently forced provider, if any. Returns undefined when the
 * call is happening outside a runWithForcedProvider() scope, and inside a
 * spawn scope, which pins nothing anyone chose.
 */
export function getForcedProvider(): APIProvider | undefined {
  const current = _forcedProvider.getStore()
  return current?.source === 'spawn' ? undefined : current?.provider
}

/** The provider this async context runs on, a spawn scope included. */
export function getScopedProvider(): APIProvider | undefined {
  return _forcedProvider.getStore()?.provider
}

/** Read the full provider override, including how it was established. */
export function getForcedProviderContext(): ForcedProviderContext | undefined {
  return _forcedProvider.getStore()
}

/** Whether `context` is an explicit caller choice (/team-mode, the Agent tool's `provider`). */
export function isExplicitProviderOverride(
  context: ForcedProviderContext | undefined = _forcedProvider.getStore(),
): boolean {
  return context !== undefined && context.source === undefined
}

/**
 * Whether an agent definition's own provider may take effect at this point.
 *
 * An explicit caller override (e.g. a /team-mode spawn that names the
 * provider) wins over the agent file. An inherited agent-scoped or spawn
 * scope may be replaced by a more specific nested agent.
 */
export function canApplyAgentProvider(
  provider: APIProvider | undefined,
): provider is APIProvider {
  if (provider === undefined) return false
  return !isExplicitProviderOverride()
}

/**
 * Run `fn` with an agent definition's provider applied when it may apply.
 *
 * Use this for anything resolved on the agent's behalf before the agent loop
 * starts — model resolution in particular. Resolving a pinned agent's model
 * outside its provider scope reads the session provider's alias policy, which
 * hands the agent a model its own provider does not serve.
 */
export function runWithAgentProvider<T>(
  provider: APIProvider | undefined,
  fn: () => T,
): T {
  if (!canApplyAgentProvider(provider)) return fn()
  return _forcedProvider.run({ provider, source: 'agent' }, fn)
}
