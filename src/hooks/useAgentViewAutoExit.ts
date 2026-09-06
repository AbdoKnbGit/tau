import { useEffect } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitAgentView } from '../state/agentViewHelpers.js'

/**
 * Auto-exits agent viewing mode when the viewed task disappears from the map
 * — evicted out from under us. Users stay viewing completed agents so they can
 * review the full transcript, so a task that still exists is never ejected.
 */
export function useAgentViewAutoExit(): void {
  const setAppState = useSetAppState()
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  // Select only whether the viewed task exists, not the full tasks map —
  // otherwise every streaming update from any agent re-renders this hook.
  const taskExists = useAppState(s =>
    s.viewingAgentTaskId ? s.tasks[s.viewingAgentTaskId] !== undefined : false,
  )

  useEffect(() => {
    if (!viewingAgentTaskId) return
    if (!taskExists) exitAgentView(setAppState)
  }, [viewingAgentTaskId, taskExists, setAppState])
}
