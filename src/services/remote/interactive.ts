/**
 * Interactive request relay for /remote.
 *
 * Generalizes the permission relay: anything the agent needs a human for
 * becomes a *form* the phone renders and answers. Three shapes cover the
 * whole `toolUseConfirm` surface:
 *
 *   permission — allow / deny a tool call
 *   questions  — AskUserQuestion's multiple choice, incl. multi-select + Other
 *   plan       — ExitPlanMode's plan, read and approved on the phone
 *
 * The precedent for answering an interactive tool off-terminal is already in
 * the codebase: toolHooks.ts treats a supplied `updatedInput` as satisfying
 * `requiresUserInteraction()` — "the hook IS the user interaction". The phone
 * is the same kind of answer, arriving over a socket instead of a hook.
 *
 * Unlike the WhatsApp and channel relays this holds a live socket, so a prompt
 * settled at the keyboard is actively withdrawn from every phone rather than
 * left sitting there stale.
 */

import { broadcast } from './bus.js'

export type RemoteOption = {
  label: string
  description?: string
}

export type RemoteQuestion = {
  question: string
  header: string
  multiSelect: boolean
  options: RemoteOption[]
}

export type RemoteForm =
  | { kind: 'permission'; tool: string; description: string; detail: string }
  | { kind: 'questions'; tool: string; description: string; questions: RemoteQuestion[] }
  | { kind: 'plan'; tool: string; description: string; plan: string }

/** One outstanding request, as the phone sees it. */
export type RemoteAsk = {
  id: string
  form: RemoteForm
}

export type RemoteReply =
  | { action: 'allow' }
  | { action: 'deny'; feedback?: string }
  | { action: 'answers'; answers: Record<string, string> }

type Pending = {
  handler: (reply: RemoteReply) => void
  ask?: RemoteAsk
}

const pending = new Map<string, Pending>()

export function onRemoteReply(
  requestId: string,
  handler: (reply: RemoteReply) => void,
): () => void {
  pending.set(requestId, { handler })
  return () => {
    pending.delete(requestId)
  }
}

/**
 * Requests still awaiting an answer. A phone that pairs mid-turn replays these
 * so arriving during a prompt does not strand the turn.
 */
export function getPendingAsks(): RemoteAsk[] {
  const out: RemoteAsk[] = []
  for (const entry of pending.values()) {
    if (entry.ask) out.push(entry.ask)
  }
  return out
}

export function hasPendingAsks(): boolean {
  return pending.size > 0
}

export function sendRemoteAsk(requestId: string, form: RemoteForm): void {
  const ask: RemoteAsk = { id: requestId, form }
  const entry = pending.get(requestId)
  if (entry) entry.ask = ask
  broadcast({ t: 'ask', ...ask })
}

/** Withdraw a request settled somewhere other than the phone. */
export function cancelRemoteAsk(requestId: string): void {
  pending.delete(requestId)
  broadcast({ t: 'ask-end', id: requestId })
}

/** Called by the WebSocket router. Returns false if already settled. */
export function tryConsumeRemoteReply(requestId: string, raw: unknown): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false

  const reply = parseReply(raw)
  if (!reply) return false

  pending.delete(requestId)
  entry.handler(reply)
  return true
}

/**
 * Replies arrive from a browser on the LAN, so validate rather than trust:
 * a malformed frame must be ignored, never forwarded into a permission
 * decision as a partially-built object.
 */
function parseReply(raw: unknown): RemoteReply | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  if (obj.action === 'allow') return { action: 'allow' }

  if (obj.action === 'deny') {
    const feedback = typeof obj.feedback === 'string' ? obj.feedback.trim() : ''
    return feedback ? { action: 'deny', feedback } : { action: 'deny' }
  }

  if (obj.action === 'answers') {
    const source = obj.answers
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null
    const answers: Record<string, string> = {}
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof key !== 'string' || typeof value !== 'string') return null
      answers[key] = value
    }
    return Object.keys(answers).length > 0 ? { action: 'answers', answers } : null
  }

  return null
}
