/**
 * Routes inbound traffic from a paired phone into the running session.
 *
 * Prompts use the same enqueue path the Remote Control bridge uses, including
 * `bridgeOrigin` — so slash commands typed on the phone run through
 * isBridgeSafeCommand() and terminal-only ones (pickers, local-jsx) report a
 * helpful error instead of popping a dialog nobody is looking at.
 */

import { enqueue } from '../../utils/messageQueueManager.js'
import { tryConsumeRemoteReply } from './interactive.js'

/** Set by useRemoteMirror; aborts the in-flight turn. */
let interruptFn: (() => void) | null = null

export function setInterruptHandler(fn: (() => void) | null): void {
  interruptFn = fn
}

export function routeInboundPrompt(text: string): void {
  const value = text.trim()
  if (!value) return
  enqueue({
    value,
    mode: 'prompt' as const,
    skipSlashCommands: true,
    bridgeOrigin: true,
  })
}

export function routeInterrupt(): void {
  interruptFn?.()
}

/** Returns false when the request was already settled elsewhere. */
export function routeReply(id: string, payload: unknown): boolean {
  return tryConsumeRemoteReply(id, payload)
}
