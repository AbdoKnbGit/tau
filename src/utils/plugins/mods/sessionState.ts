import type { Message } from '../../../types/message.js'
import { countModSessionTurns, projectModSessionMessages } from './sessionMessages.js'
import { dropAllQueuedModPrompts } from './promptQueue.js'
import type { Tools, ToolUseContext } from '../../../Tool.js'
import cloneDeep from 'lodash-es/cloneDeep.js'

/** These callbacks belong to the session, not the hook that happens to call it. */
export type ModSessionBinding = {
  getMessages(): readonly Message[]
  getModel(): string
  getTools?(): Tools
  getCompactContext?(): ToolUseContext
  setMessages?(messages: Message[]): void
  commitCompaction?(messages: Message[]): void
  getAgentMessages?(agentId: string): readonly Message[] | undefined | Promise<readonly Message[] | undefined>
  isBusy?(): boolean
  /** Draws one plugin line as its own transcript row, which the model never reads. */
  appendNotice?(text: string): void
  /** The prompt box as it stands; absent where the session draws none. */
  readPrompt?(): { text: string; cursor: number }
  /** Puts text in the prompt box as the draft; false under a dialog. */
  fillPrompt?(text: string, mode: 'replace' | 'append' | 'insert'): boolean
  /** Shows text as the prompt box's dim suggestion; false while it holds text. */
  suggestPrompt?(text: string): boolean
  /** The session's app state (its tasks, for `$.agent.list`). */
  getAppState?(): unknown
  /** Whether a pane may take the keyboard now: the prompt holds it over an
   * empty composer, idle, with no dialog up. */
  canGiveKeyboard?(): boolean
  /** What the person last selected with the mouse, as $.ui.selection answers. */
  readSelection?(): { text: string; requestId?: string } | undefined
  /** A few seconds' toast for a plugin; a newer one replaces its older one. */
  toast?(plugin: string, text: string, timeoutMs?: number): void
  /** A terminal notification on the user's channel: the method that sent it,
   * or `disabled`, `no_method_available`, `none`, `error`. */
  notify?(text: string, title: string): Promise<string>
}

const idleWork: Array<() => void> = []
/** Runs `work` now when no main turn is running, else once the turn ends. */
export function runWhenModTurnIdle(work: () => void): void {
  if (!mainTurn) {
    work()
    return
  }
  idleWork.push(work)
}
function runIdleWork(): void {
  for (const work of idleWork.splice(0)) {
    try { work() } catch { /* each queued row settles its own caller */ }
  }
}

export type ModMainTurn = {
  readonly turnId: string
  readonly abortController: AbortController
}

export const MOD_SESSION_STOPPED = 'the session was stopped and nobody has sent input since'

export function preserveModCompactionScrollback(previousInterval: Message[], next: Message[]): Message[] {
  const retained = new Set(next.map(message => message.uuid))
  // Kept native rows must appear only once in the fullscreen UUID-keyed list.
  return [...previousInterval.filter(message => !retained.has(message.uuid)), ...next]
}

let session: { binding: ModSessionBinding; owner: symbol } | undefined
let mainTurn: (ModMainTurn & { owner: symbol; detach(): void; modAbort: boolean }) | undefined
const heldLogs: string[] = []

function flushModLogs(): void {
  const notice = session?.binding.appendNotice
  if (notice) for (const text of heldLogs.splice(0)) notice(text)
}

/**
 * A `$.ui.log` line. Where a session draws a transcript it becomes a row of
 * its own at once, in logging order. Elsewhere (print mode, before the REPL
 * binds) it waits for the next hook, tool or command output that drains it.
 */
export function emitModLog(text: string): void {
  if (!session?.binding.appendNotice) {
    heldLogs.push(text)
    return
  }
  flushModLogs()
  session.binding.appendNotice(text)
}

export function takeModLogs(): string[] {
  return heldLogs.splice(0)
}

/** Toasts sent before a session draws (from session.start): the newest of
 * each plugin, shown once one does. */
const heldToasts: Array<{ plugin: string; text: string; timeoutMs?: number }> = []

/** A `$.ui.toast`, shown by the session that draws, or held for it. */
export function toastFromMod(plugin: string, text: string, timeoutMs?: number): void {
  const toast = session?.binding.toast
  if (toast) {
    toast(plugin, text, timeoutMs)
    return
  }
  const at = heldToasts.findIndex(item => item.plugin === plugin)
  if (at >= 0) heldToasts.splice(at, 1)
  heldToasts.push({ plugin, text, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
  if (heldToasts.length > 8) heldToasts.shift()
}
let stopped = false
let pendingCompact: AbortController | undefined
const agentConversations = new Map<string, { owner: symbol; getMessages(): readonly Message[] }>()
const apiAbortedSignals = new WeakSet<AbortSignal>()
export const isModTurnAbort = (signal: AbortSignal | undefined): boolean => !!signal && apiAbortedSignals.has(signal)

/** An old React cleanup or completed headless session cannot detach a newer one. */
export function bindModSession(binding: ModSessionBinding): () => void {
  pendingCompact?.abort(new Error('The session changed during compaction'))
  const owner = Symbol('mod session')
  mainTurn?.detach()
  mainTurn = undefined
  stopped = false
  agentConversations.clear()
  session = { binding, owner }
  // Rows queued for the previous session's turn settle now (refused).
  runIdleWork()
  // Lines logged while mods started (before a transcript existed) show once
  // the session's first rows are in place.
  if (binding.appendNotice && heldLogs.length)
    setTimeout(() => { if (session?.owner === owner) flushModLogs() }, 0)
  if (binding.toast && heldToasts.length)
    setTimeout(() => {
      if (session?.owner !== owner) return
      for (const { plugin, text, timeoutMs } of heldToasts.splice(0)) binding.toast!(plugin, text, timeoutMs)
    }, 0)
  return () => {
    if (session?.owner !== owner) return
    pendingCompact?.abort(new Error('The session ended during compaction'))
    session = undefined
    mainTurn?.detach()
    mainTurn = undefined
    runIdleWork()
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
  pendingCompact?.abort(new Error('Compaction cancelled'))
  stopped = true
  dropAllQueuedModPrompts()
}

/** Track every main turn even when nobody subscribes to turn.start. */
export function beginModMainTurn(turnId: string, abortController: AbortController): () => void {
  if (mainTurn) throw new Error(`Main turn ${mainTurn.turnId} is already running`)
  pendingCompact?.abort(new Error('A turn started during compaction'))
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
    if (mainTurn?.owner === owner) {
      mainTurn = undefined
      runIdleWork()
    }
  }
}

export function reserveModCompaction(controller: AbortController): () => void {
  if (mainTurn) throw new Error('Cannot compact while a turn is running')
  if (pendingCompact && !pendingCompact.signal.aborted) throw new Error('A compaction is already in progress')
  pendingCompact = controller
  return () => { if (pendingCompact === controller) pendingCompact = undefined }
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
