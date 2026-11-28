import {
  isAccepting,
  isOrchestrator,
  listPeerLines,
  setAccepting,
  taskBudgetUsed,
} from '../../services/peers/runtime.js'
import { readPeerSettings } from '../../services/peers/settings.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async args => {
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') {
    const problem = setAccepting(arg === 'on')
    if (problem) return { type: 'text', value: problem }
    return {
      type: 'text',
      value:
        arg === 'on'
          ? 'This session now takes tasks from orchestrator sessions on this machine. /peers off stops it.'
          : 'This session no longer takes tasks from other sessions.',
    }
  }
  if (arg) return { type: 'text', value: 'Usage: /peers [on|off]' }

  const role = isOrchestrator()
    ? `This session is an orchestrator. Tasks sent since your last message: ${taskBudgetUsed()} of ${readPeerSettings().taskLimit}.`
    : isAccepting()
      ? 'This session takes tasks from orchestrator sessions. /peers off stops it.'
      : "This session doesn't take tasks. /peers on lets an orchestrator (tau --orchestrate) send it tasks."
  const peers = await listPeerLines()
  const list = peers.length
    ? `Other sessions that take tasks:\n${peers.map(line => `  ${line}`).join('\n')}`
    : 'No other session on this machine takes tasks.'
  return { type: 'text', value: `${role}\n${list}` }
}
