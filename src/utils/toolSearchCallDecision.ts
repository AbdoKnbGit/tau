export type LazyToolCallDecision =
  | { action: 'execute' }
  /**
   * The producing request did not carry this tool's schema. The call is still
   * allowed to run, but only after its arguments are checked against the
   * schema Tau holds locally (see checkBlindDeferredCallInput). This replaces
   * an unconditional block, which cost a turn and surfaced an internal
   * recovery error for calls that were in fact correct.
   */
  | { action: 'execute_unverified'; requiresExplicitSelection: boolean }
  | { action: 'reject_unavailable'; message: string }

export function rejectProviderFilteredToolCall(
  toolName: string,
  providerLabel: string,
): LazyToolCallDecision {
  return {
    action: 'reject_unavailable',
    message:
      `ToolUnavailable: ${toolName} was not declared in this ${providerLabel} request, so the call was blocked before validation, hooks, permissions, or tool code ran. ` +
      `The operation did not run. Choose one of the currently declared tools; ToolSearch cannot load ${toolName} in this mode.`,
  }
}

/**
 * Recovery guidance appended to a blind call that failed local verification.
 * The expected schema is already inlined in the error, so this only says how
 * the schema becomes declared again — never "call ToolSearch and retry" on a
 * lane where the failed tool_use alone is enough.
 */
export function blindCallRecoveryHint(
  toolName: string,
  requiresExplicitSelection: boolean,
): string {
  return requiresExplicitSelection
    ? `\n\n${toolName}'s schema was not declared on the request that produced this call. ` +
        `Retry using the schema above; if the retry fails the same way, load it with ToolSearch {"query":"select:${toolName}"} first.`
    : `\n\n${toolName}'s schema was not declared on the request that produced this call. ` +
        `It is declared on the next request, so retry ${toolName} directly using the schema above; do not call ToolSearch first.`
}

/** Pure state transition used by the runtime guard and regression tests. */
export function decideLazyToolCall(options: {
  toolName: string
  isDeferred: boolean
  schemaWasLoaded: boolean
  discoveryIsActive: boolean
  requiresExplicitSelection?: boolean
}): LazyToolCallDecision {
  if (
    !options.isDeferred ||
    options.schemaWasLoaded ||
    !options.discoveryIsActive
  ) {
    return { action: 'execute' }
  }

  return {
    action: 'execute_unverified',
    requiresExplicitSelection: options.requiresExplicitSelection === true,
  }
}
