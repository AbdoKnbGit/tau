import type { QueuedCommand } from '../types/textInputTypes.js'
import { hasModEvent } from './plugins/mods/manager.js'
import { dropQueuedModPrompt } from './plugins/mods/promptQueue.js'
import {
  dequeue,
  dequeueAllMatching,
  hasCommandsInQueue,
  peek,
  getCommandQueue,
} from './messageQueueManager.js'

type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}

type ProcessQueueResult = {
  processed: boolean
}

/**
 * Check if a queued command is a slash command (value starts with '/').
 */
function isSlashCommand(cmd: QueuedCommand): boolean {
  if (cmd.skipSlashCommands && !cmd.bridgeOrigin) {
    return false
  }
  if (typeof cmd.value === 'string') {
    return cmd.value.trim().startsWith('/')
  }
  // For ContentBlockParam[], check the first text block
  for (const block of cmd.value) {
    if (block.type === 'text') {
      return block.text.trim().startsWith('/')
    }
  }
  return false
}

/**
 * Processes commands from the queue.
 *
 * Slash commands (starting with '/'), bash-mode commands, and prompts with
 * submission hooks are processed one at a time through executeInput.
 * Bash commands need individual processing to preserve per-command error
 * isolation, exit codes, and progress UI. Other non-slash commands are
 * batched: all items **with the same mode** as the highest-priority item
 * are drained at once and passed as a single array to executeInput — each
 * becomes its own user message with its own UUID. Different modes
 * (e.g. prompt vs task-notification) are never mixed because they are
 * treated differently downstream.
 *
 * The caller is responsible for ensuring no query is currently running
 * and for calling this function again after each command completes
 * until the queue is empty.
 *
 * @returns result with processed status
 */
export function processQueueIfReady({
  executeInput,
}: ProcessQueueParams): ProcessQueueResult {
  // This processor runs on the REPL main thread between turns. Skip anything
  // addressed to a subagent — an unfiltered peek() returning a subagent
  // notification would set targetMode, dequeueAllMatching would find nothing
  // matching that mode with agentId===undefined, and we'd return processed:
  // false with the queue unchanged → the React effect never re-fires and any
  // queued user prompt stalls permanently.
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  const next = peek(isMainThread)
  if (!next) {
    return { processed: false }
  }

  // Submission hooks can drop a prompt and restore its input. Keep that result
  // independent from later prompts so a drop cannot suppress their model turn
  // or lose its own restored input in executeUserInput's batched result.
  if (
    isSlashCommand(next) ||
    next.modPrompt ||
    next.mode === 'bash' ||
    (next.mode === 'prompt' && hasModEvent('prompt.submit'))
  ) {
    const cmd = dequeue(isMainThread)!
    if (cmd.modPrompt) {
      // The turn-start acknowledgement removes accepted receipts. If input
      // processing exits first, settle the pending API call instead of leaking it.
      try {
        void executeInput([cmd]).then(
          () => { dropQueuedModPrompt(cmd.uuid) },
          error => { dropQueuedModPrompt(cmd.uuid, `the prompt could not run: ${String(error)}`) },
        )
      } catch (error) {
        dropQueuedModPrompt(cmd.uuid, `the prompt could not run: ${String(error)}`)
      }
    } else void executeInput([cmd])
    return { processed: true }
  }

  // Drain all non-slash-command items with the same mode at once.
  const targetMode = next.mode
  const queue = getCommandQueue()
  const barrier = queue.findIndex(cmd => isMainThread(cmd) && cmd.modPrompt)
  const beforeBarrier = barrier < 0 ? undefined : new Set(queue.slice(0, barrier))
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !cmd.modPrompt && (!beforeBarrier || beforeBarrier.has(cmd)) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) {
    return { processed: false }
  }

  void executeInput(commands)
  return { processed: true }
}

/**
 * Checks if the queue has pending commands.
 * Use this to determine if queue processing should be triggered.
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}
