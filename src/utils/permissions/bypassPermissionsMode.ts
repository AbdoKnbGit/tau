import { setSessionBypassPermissionsMode } from '../../bootstrap/state.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { getLeaderToolUseConfirmQueue } from '../swarm/leaderPermissionBridge.js'
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
