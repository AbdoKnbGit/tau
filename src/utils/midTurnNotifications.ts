import type { QueuedCommand } from '../types/textInputTypes.js'
import type { APIProvider } from './model/providerRegistry.js'

/** Receive completed local agents after a tool round on the OpenAI main loop. */
export function isMidTurnNotification(
  command: QueuedCommand,
  options: { sleepRan: boolean; isMainThread: boolean; provider: APIProvider },
): boolean {
  if (command.modPrompt) return false
  if (options.sleepRan || command.priority !== 'later') return true
  return options.isMainThread
    && options.provider === 'openai'
    && command.mode === 'task-notification'
    && command.taskNotificationType === 'local_agent'
    && command.agentId === undefined
}
