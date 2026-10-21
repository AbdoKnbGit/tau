import type { AgentId } from '../types/ids.js'
import type { AppState } from './AppStateStore.js'

/**
 * Only live background agents carry their names into another session.
 * Finished/evicted agents remain addressable by name within their session
 * (SendMessage can resume their transcripts), but must not leak into /clear,
 * /resume, or /branch. Task history can outlive that session too, so checking
 * task existence alone is insufficient.
 */
export function getAgentNamesForNewSession(
  registry: ReadonlyMap<string, AgentId>,
  tasks: AppState['tasks'],
): Map<string, AgentId> {
  return new Map(
    [...registry].filter(([, agentId]) => {
      const task = tasks[agentId]
      return (
        task?.type === 'local_agent' &&
        task.agentType !== 'main-session' &&
        task.isBackgrounded &&
        (task.status === 'running' || task.status === 'pending') &&
        !task.abortController?.signal.aborted
      )
    }),
  )
}
