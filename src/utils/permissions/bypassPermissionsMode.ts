import {
  getSessionBypassPermissionsMode,
  setSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getLeaderToolUseConfirmQueue } from '../swarm/leaderPermissionBridge.js'
import type { PermissionMode } from './PermissionMode.js'
import { applyPermissionUpdate } from './PermissionUpdate.js'
import {
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from './permissionSetup.js'

export function createBypassPermissionsContext(
  toolPermissionContext: ToolPermissionContext,
): ToolPermissionContext {
  const preparedContext = transitionPermissionMode(
    toolPermissionContext.mode,
    'bypassPermissions',
    toolPermissionContext,
  )

  return {
    ...applyPermissionUpdate(preparedContext, {
      type: 'setMode',
      mode: 'bypassPermissions',
      destination: 'session',
    }),
    isBypassPermissionsModeAvailable: true,
  }
}

export function recheckQueuedToolPermissions(): void {
  setImmediate(() => {
    getLeaderToolUseConfirmQueue()?.(currentQueue => {
      currentQueue.forEach(item => {
        void item.recheckPermission()
      })
      return currentQueue
    })
  })
}

/**
 * Switches the session to bypass mode, as choosing it from a list of modes
 * does. Use enableBypassPermissionsFromPrompt for a tool permission prompt.
 */
export function enableBypassPermissionsModeForSession(
  context: Pick<ToolUseContext, 'setAppState'>,
): boolean {
  if (isBypassPermissionsModeDisabled()) {
    setSessionBypassPermissionsMode(false)
    return false
  }

  setSessionBypassPermissionsMode(true)
  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: createBypassPermissionsContext(
      prev.toolPermissionContext,
    ),
  }))
  recheckQueuedToolPermissions()

  return true
}

/**
 * Whether the user has bypass on: bypass mode, or bypass turned on for the
 * session, which permission checks honour in any mode (in plan mode the plan
 * keeps going and file edits wait for its approval).
 */
export function isBypassPermissionsOnForSession(mode: PermissionMode): boolean {
  return mode === 'bypassPermissions' || getSessionBypassPermissionsMode()
}

/**
 * A plan that ends in a mode someone chose other than bypass (manual
 * approval, accepted edits) ends bypass for the session as well. Otherwise
 * the session switch would keep skipping every prompt while the footer shows
 * the chosen mode. Ending in bypass mode keeps bypass on. Applies wherever an
 * approved change lands: a prompt, the plan approval, a remote reply, a hook.
 */
export function syncSessionBypassWithPlanExit(
  previous: ToolPermissionContext,
  next: ToolPermissionContext,
): void {
  if (
    previous.mode === 'plan' &&
    next.mode !== 'plan' &&
    next.mode !== 'bypassPermissions'
  ) {
    setSessionBypassPermissionsMode(false)
  }
}

/**
 * Turns bypass off while a plan is open. The plan stays, prompts come back,
 * and the plan no longer returns to bypass when it is approved.
 */
export function disableBypassPermissionsInPlanMode(
  context: Pick<ToolUseContext, 'setAppState'>,
): void {
  setSessionBypassPermissionsMode(false)
  context.setAppState(prev =>
    prev.toolPermissionContext.prePlanMode === 'bypassPermissions'
      ? {
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            prePlanMode: 'default',
          },
        }
      : prev,
  )
}

/**
 * Plan mode with bypass turned on: the plan stays open, and bypass is what its
 * approval returns to. Bypass is offered when the plan is approved, and a
 * hook-approved exit restores it.
 */
function keepPlanModeWithBypass(
  toolPermissionContext: ToolPermissionContext,
): ToolPermissionContext {
  return {
    ...toolPermissionContext,
    prePlanMode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
  }
}

/**
 * "Yes, and bypass permissions for this session" on a tool permission prompt.
 * Answering a prompt is not a request to change modes, so in plan mode the
 * plan stays open instead of ending mid-turn: bypass is turned on for the
 * session (nothing asks, file edits wait for the approval) and becomes the
 * mode the approval returns to. Outside plan mode the session switches to
 * bypass mode, as before.
 *
 * Decides from the session's own mode (the store's), never from the asking
 * agent's view of it.
 */
export function enableBypassPermissionsFromPrompt(
  context: Pick<ToolUseContext, 'setAppState'>,
): boolean {
  if (isBypassPermissionsModeDisabled()) {
    setSessionBypassPermissionsMode(false)
    return false
  }

  setSessionBypassPermissionsMode(true)
  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext:
      prev.toolPermissionContext.mode === 'plan'
        ? keepPlanModeWithBypass(prev.toolPermissionContext)
        : createBypassPermissionsContext(prev.toolPermissionContext),
  }))
  recheckQueuedToolPermissions()

  return true
}
