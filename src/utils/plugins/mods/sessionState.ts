import type { Message } from '../../../types/message.js'
import { countModSessionTurns, projectModSessionMessages } from './sessionMessages.js'
import { dropAllQueuedModPrompts } from './promptQueue.js'
import type { Tools } from '../../../Tool.js'
import cloneDeep from 'lodash-es/cloneDeep.js'

/** These callbacks belong to the session, not the hook that happens to call it. */
export type ModSessionBinding = {
  getMessages(): readonly Message[]
  getModel(): string
  getTools?(): Tools
  setMessages?(messages: Message[]): void
  getAgentMessages?(agentId: string): readonly Message[] | undefined | Promise<readonly Message[] | undefined>
  isBusy?(): boolean
}

export type ModMainTurn = {
  readonly turnId: string
  readonly abortController: AbortController
}

export const MOD_SESSION_STOPPED = 'the session was stopped and nobody has sent input since'

let session: { binding: ModSessionBinding; owner: symbol } | undefined
let mainTurn: (ModMainTurn & { owner: symbol; detach(): void; modAbort: boolean }) | undefined
let stopped = false
const agentConversations = new Map<string, { owner: symbol; getMessages(): readonly Message[] }>()
const apiAbortedSignals = new WeakSet<AbortSignal>()
export const isModTurnAbort = (signal: AbortSignal | undefined): boolean => !!signal && apiAbortedSignals.has(signal)

/** An old React cleanup or completed headless session cannot detach a newer one. */
export function bindModSession(binding: ModSessionBinding): () => void {
  const owner = Symbol('mod session')
  mainTurn?.detach()
  mainTurn = undefined
  stopped = false
  agentConversations.clear()
  session = { binding, owner }
  return () => {
    if (session?.owner !== owner) return
    session = undefined
    mainTurn?.detach()
    mainTurn = undefined
    stopped = false
    agentConversations.clear()
    dropAllQueuedModPrompts('the session ended before the prompt ran')
  }
}

export function getModSessionBinding(): ModSessionBinding | undefined {
  return session?.binding
}

function requireSession() {
  if (!session) throw new Error('This mod API requires a running session')
  return session
}

export function readModSessionModel(): string {
  return requireSession().binding.getModel()
}

export function readModSessionTurns(): number {
  return countModSessionTurns(requireSession().binding.getMessages())
}

export async function readModSessionMessages(input?: unknown, signal?: AbortSignal) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)))
    throw new Error('session.messages requires an options object')
  const args = (input ?? {}) as { agentId?: unknown; as?: unknown }
  if (args.as !== undefined && args.as !== 'api')
    throw new Error('session.messages as must be api')
  if (args.agentId !== undefined && (typeof args.agentId !== 'string' || !args.agentId.trim()))
    throw new Error('session.messages agentId must be a nonempty string')
  signal?.throwIfAborted()
  const current = requireSession()
  const options = args.as === 'api' ? { as: 'api' as const } : undefined
  const project = async (messages: readonly Message[]) => {
    if (!options) return projectModSessionMessages(messages)
    const snapshot = cloneDeep([...messages])
    const tools = current.binding.getTools?.() ?? []
    const model = current.binding.getModel()
    const { normalizeMessagesForAPI, getMessagesAfterCompactBoundary } = await import('../../messages.js')
    signal?.throwIfAborted()
    if (session?.owner !== current.owner) throw new Error('The session changed while reading its conversation')
    // Normalization reads live model/tool capabilities. Copy first so symbol
    // annotations survive without exposing or mutating the engine's history.
    return projectModSessionMessages(normalizeMessagesForAPI(
      getMessagesAfterCompactBoundary(snapshot), tools, { model },
    ), options)
  }
  if (args.agentId === undefined) return project(current.binding.getMessages())

  const agentId = args.agentId as string
  let messages: readonly Message[] | undefined
  try {
    messages = await (current.binding.getAgentMessages ?? readModAgentMessages)(agentId)
  } catch {
    // An unreadable or external agent must never silently become the main loop.
    signal?.throwIfAborted()
    return { deny: `The session cannot read the conversation for agent ${agentId}` }
  }
  signal?.throwIfAborted()
  if (session?.owner !== current.owner || messages === undefined)
    return { deny: `The session cannot read the conversation for agent ${agentId}` }
  return project(messages)
}

export async function readModAgentMessages(agentId: string): Promise<readonly Message[] | undefined> {
  const live = agentConversations.get(agentId)
  if (live) return live.getMessages()
  // IDs address engine transcript files, never caller-supplied paths.
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) return undefined
  const [{ getAgentTranscript }, { asAgentId }, { getAgentConversation }] = await Promise.all([
    import('../../sessionStorage.js'), import('../../../types/ids.js'), import('../../../tools/AgentTool/resumeParity.js'),
  ])
  return getAgentConversation(agentId) ?? (await getAgentTranscript(asAgentId(agentId)))?.messages
}

/** Running children can be read before their transcript writer flushes. */
export function bindModAgentConversation(agentId: string, getMessages: () => readonly Message[]): () => void {
  const owner = Symbol('mod agent conversation')
  agentConversations.set(agentId, { owner, getMessages })
  return () => { if (agentConversations.get(agentId)?.owner === owner) agentConversations.delete(agentId) }
}

export function getModMainTurn(): ModMainTurn | undefined {
  return mainTurn
}

export function isModSessionBusy(): boolean {
  return mainTurn !== undefined || session?.binding.isBusy?.() === true
}

export function isModSessionStopped(): boolean {
  return stopped
}

export function resumeModSessionOnUserInput(): void {
  stopped = false
}

export function markModSessionStopped(): void {
  stopped = true
  dropAllQueuedModPrompts()
}

/** Track every main turn even when nobody subscribes to turn.start. */
export function beginModMainTurn(turnId: string, abortController: AbortController): () => void {
  if (mainTurn) throw new Error(`Main turn ${mainTurn.turnId} is already running`)
  const owner = Symbol('mod main turn')
  const onAbort = () => {
    if (mainTurn?.owner !== owner || mainTurn.modAbort || abortController.signal.reason === 'background') return
    markModSessionStopped()
  }
  const detach = () => abortController.signal.removeEventListener('abort', onAbort)
  mainTurn = { turnId, abortController, owner, detach, modAbort: false }
  abortController.signal.addEventListener('abort', onAbort, { once: true })
  if (abortController.signal.aborted) onAbort()
  return () => {
    detach()
    if (mainTurn?.owner === owner) mainTurn = undefined
  }
}

export function abortModMainTurn(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof (input as { turnId?: unknown }).turnId !== 'string' ||
      !(input as { turnId: string }).turnId.trim())
    throw new Error('turn.abort requires a nonempty turnId')
  const requested = (input as { turnId: string }).turnId
  if (!mainTurn || mainTurn.turnId !== requested || mainTurn.abortController.signal.aborted)
    throw new Error(`Cannot abort turn ${requested}: the running main turn is ${mainTurn && !mainTurn.abortController.signal.aborted ? mainTurn.turnId : 'none'}`)
  // This API explicitly permits a follow-up plugin prompt. Only the person's
  // stop action sets the stop latch, and interrupt suppresses the UI marker.
  mainTurn.modAbort = true
  apiAbortedSignals.add(mainTurn.abortController.signal)
  mainTurn.abortController.abort('interrupt')
}
