import type { AppState } from '../../state/AppState.js'
import { getSessionCronTasks } from '../../bootstrap/state.js'
import { isBackgroundTask } from '../../tasks/types.js'

/** Local to one query, never shared with another turn, session or subagent. */
export class StopHookContinuationGuard {
  private consecutive = 0

  resetAfterToolCall(): void {
    this.consecutive = 0
  }

  allowContinuation(): boolean {
    const configured = Number(process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP)
    const cap = Number.isSafeInteger(configured) && configured > 0 ? configured : 8
    if (this.consecutive >= cap) return false
    this.consecutive++
    return true
  }
}

function clipHookText(text: string): string {
  if (text.length <= 1000) return text
  let length = 1000
  let marker = ''
  do {
    marker = `… [+${text.length - length} chars]`
    length = 1000 - marker.length
  } while (`… [+${text.length - length} chars]` !== marker)
  return text.slice(0, length) + marker
}

/** Read live registries for the hook; do not put this snapshot in system context. */
export function stopHookWorkState(state: AppState | undefined) {
  if (!state) return {}
  const names: Record<string, string> = {
    local_bash: 'shell', local_agent: 'subagent', remote_agent: 'cloud session',
    in_process_teammate: 'teammate', local_workflow: 'workflow', monitor_mcp: 'monitor',
  }
  return {
    background_tasks: Object.values(state.tasks ?? {}).filter(isBackgroundTask).map(task => ({
      id: task.id,
      type: names[task.type] ?? task.type,
      status: task.status,
      description: clipHookText(task.description),
      ...(task.type === 'local_bash' ? { command: clipHookText(task.command) } : {}),
      ...(task.type === 'local_agent' ? { agent_type: task.agentType } : {}),
    })),
    session_crons: getSessionCronTasks().map(task => ({
      id: task.id,
      schedule: task.cron,
      recurring: task.recurring === true,
      prompt: clipHookText(task.prompt),
    })),
  }
}
