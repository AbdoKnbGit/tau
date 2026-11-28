/**
 * Cross-session messaging between Tau sessions on one machine. Files and
 * message formats live in store.ts; the REPL side in hooks/usePeerSession.ts.
 *
 * A session started with --orchestrate sends tasks (SendMessage to
 * "peer:<name>") and gets each final answer back as a task notification. Any
 * other session takes tasks once it runs /peers on, or by default with
 * settings peers.inbound "on". A session is never both, so a task can't bounce
 * between two sessions, and an answer never asks for another answer.
 *
 * Nothing runs until a session opts in: no files, no timers.
 *
 * Module-level names carry a peer prefix: the bundle is one scope, and a
 * generic name here would make esbuild rename same-named locals elsewhere.
 */

import { registerCleanup } from '../../utils/cleanupRegistry.js'
import {
  cutText,
  describePeer,
  isPidAlive,
  listLiveCards,
  newMessageId,
  postMessage,
  removeCard,
  resolvePeer,
  takeMessages,
  thisHost,
  writeCard,
  type PeerCard,
  type PeerMessage,
  type PeerOutcome,
  type PeerReply,
  type PeerSender,
  type PeerStatus,
  type PeerTask,
} from './store.js'

const PEER_POLL_MS = 2_000
const PEER_HEARTBEAT_MS = 20_000
/** A task that sat unread longer than this is stale: skip it, don't surprise. */
const PEER_TASK_MAX_AGE_MS = 15 * 60_000
/** A task for a window still being opened may wait this long, no longer. */
const PEER_TASK_LONGEST_WAIT_MS = 6 * 60 * 60_000
const PEER_DEFAULT_REPLY_LIMIT = 8_000

export type PeerSelf = {
  sessionId: string
  cwd: string
  name: string
  status: PeerStatus
  provider?: string
  model?: string
  permissionMode?: string
}

export type PeerHandlers = {
  /** A task this session accepted; queue it as a turn. */
  onTask: (task: PeerTask) => void
  /** An answer to a task this session sent. */
  onReply: (reply: PeerReply) => void
}

type OpenPeerTask = { to: string; name: string; cwd: string; pid: number; host: string }

let orchestratorRole = false
let acceptingPeerTasks = false
/** Set by --peer-of: a session OpenPeer opened takes tasks only from its opener. */
let acceptPeerTasksOnlyFrom: string | null = null
let peerHandlers: PeerHandlers | null = null
let peerSelf: (PeerSelf & { activeAt: number }) | null = null
let peerPollTimer: ReturnType<typeof setInterval> | null = null
let peerHeartbeatTimer: ReturnType<typeof setInterval> | null = null
let unregisterPeerCleanup: (() => void) | null = null
let peerPollInFlight: Promise<void> | null = null
/**
 * Card writes and removals run one at a time, in order: a slow write landing
 * after a removal would bring back a card for a session that stopped taking
 * tasks.
 */
let peerCardOps: Promise<void> = Promise.resolve()
/** Every id this process has had: answers to tasks sent before /clear still land. */
const peerInboxIds = new Set<string>()
/** Orchestrator: tasks sent and not answered yet. */
const openPeerTasks = new Map<string, OpenPeerTask>()
/** Taker: tasks queued as turns, by the queued prompt's uuid. */
const takenPeerTasks = new Map<string, PeerTask>()
let peerTasksSinceUserPrompt = 0

/** What the footer badge shows: this session's part in tasks between sessions. */
export type PeerRole =
  | { kind: 'orchestrator'; openTasks: number }
  | { kind: 'worker'; workingFor: string | null }
  | null

const peerRoleListeners = new Set<() => void>()
let peerRoleSnapshot: PeerRole = null
/** Taker: who sent the task the current turn runs, while it runs. */
let peerWorkingFor: string | null = null

/** A stable object until something it shows changes (useSyncExternalStore needs that). */
export function getPeerRole(): PeerRole {
  const next: PeerRole = orchestratorRole
    ? { kind: 'orchestrator', openTasks: openPeerTasks.size }
    : acceptingPeerTasks
      ? { kind: 'worker', workingFor: peerWorkingFor }
      : null
  if (JSON.stringify(next) !== JSON.stringify(peerRoleSnapshot)) peerRoleSnapshot = next
  return peerRoleSnapshot
}

export function subscribePeerRole(listener: () => void): () => void {
  peerRoleListeners.add(listener)
  return () => {
    peerRoleListeners.delete(listener)
  }
}

function notifyPeerRole(): void {
  for (const listener of peerRoleListeners) listener()
}

export function setPeerWorkingFor(name: string | null): void {
  if (peerWorkingFor === name) return
  peerWorkingFor = name
  notifyPeerRole()
}

/** Called once from main.tsx, before the tool list is built. */
export function setOrchestrator(): void {
  orchestratorRole = true
  notifyPeerRole()
}

export function isOrchestrator(): boolean {
  return orchestratorRole
}

export function isAccepting(): boolean {
  return acceptingPeerTasks
}

/** Called from main.tsx for --peer-of, before the REPL starts. */
export function acceptPeersFrom(sessionId: string): void {
  acceptPeerTasksOnlyFrom = sessionId
}

function ownPeerSender(permissionMode?: string): PeerSender {
  const mode = permissionMode ?? peerSelf!.permissionMode
  return {
    sessionId: peerSelf!.sessionId,
    name: peerSelf!.name,
    cwd: peerSelf!.cwd,
    ...(mode ? { permissionMode: mode } : {}),
  }
}

function ownPeerCard(): PeerCard {
  const me = peerSelf!
  return {
    sessionId: me.sessionId,
    pid: process.pid,
    host: thisHost(),
    cwd: me.cwd,
    name: me.name,
    status: me.status,
    ...(me.provider ? { provider: me.provider } : {}),
    ...(me.model ? { model: me.model } : {}),
    activeAt: me.activeAt,
    updatedAt: Date.now(),
  }
}

function queuePeerCardOp(op: () => Promise<void>): Promise<void> {
  peerCardOps = peerCardOps.then(op).catch(() => {})
  return peerCardOps
}

function writeOwnPeerCard(): void {
  // The card is built when the write runs, so it carries the latest state.
  void queuePeerCardOp(async () => {
    if (acceptingPeerTasks && peerSelf) await writeCard(ownPeerCard())
  })
}

function dropPeerCard(sessionId: string): Promise<void> {
  return queuePeerCardOp(() => removeCard(sessionId))
}

function startPeerTimers(): void {
  if (!peerPollTimer) {
    peerPollTimer = setInterval(() => void pollPeerInbox(), PEER_POLL_MS)
    peerPollTimer.unref?.()
  }
  if (acceptingPeerTasks && !peerHeartbeatTimer) {
    peerHeartbeatTimer = setInterval(writeOwnPeerCard, PEER_HEARTBEAT_MS)
    peerHeartbeatTimer.unref?.()
  }
  unregisterPeerCleanup ??= registerCleanup(async () => {
    if (peerSelf) await dropPeerCard(peerSelf.sessionId)
  })
}

function stopPeerTimers(): void {
  if (peerPollTimer) clearInterval(peerPollTimer)
  if (peerHeartbeatTimer) clearInterval(peerHeartbeatTimer)
  peerPollTimer = null
  peerHeartbeatTimer = null
}

/**
 * Wires this process in once the REPL can queue turns. An orchestrator starts
 * reading its inbox at once; any other session only if `acceptTasks`.
 */
export function attachPeerSession(
  handlers: PeerHandlers,
  initial: PeerSelf,
  acceptTasks: boolean,
): void {
  peerHandlers = handlers
  peerSelf = { ...initial, activeAt: Date.now() }
  peerInboxIds.add(initial.sessionId)
  if (orchestratorRole) {
    startPeerTimers()
  } else if (acceptPeerTasksOnlyFrom) {
    acceptingPeerTasks = true
    startPeerTimers()
    writeOwnPeerCard()
  } else if (acceptTasks) {
    setAccepting(true)
  }
  notifyPeerRole()
}

export function detachPeerSession(): void {
  stopPeerTimers()
  unregisterPeerCleanup?.()
  unregisterPeerCleanup = null
  acceptingPeerTasks = false
  peerWorkingFor = null
  if (peerSelf) void dropPeerCard(peerSelf.sessionId)
  peerHandlers = null
  notifyPeerRole()
}

/** /peers on|off. Returns why it can't, or null. */
export function setAccepting(on: boolean): string | null {
  if (on && orchestratorRole) {
    return 'This session is an orchestrator: it sends tasks, so it does not take them.'
  }
  if (!peerSelf || !peerHandlers) return 'Peer messaging is not ready in this session yet.'
  acceptingPeerTasks = on
  // An explicit /peers on|off replaces a --peer-of restriction.
  acceptPeerTasksOnlyFrom = null
  notifyPeerRole()
  if (on) {
    startPeerTimers()
    writeOwnPeerCard()
    return null
  }
  void dropPeerCard(peerSelf.sessionId)
  if (peerHeartbeatTimer) clearInterval(peerHeartbeatTimer)
  peerHeartbeatTimer = null
  // One last pass declines anything sent just before the card went away.
  void pollPeerInbox().finally(() => {
    if (!acceptingPeerTasks && !orchestratorRole) stopPeerTimers()
  })
  return null
}

/** Keeps the card in step with the session; writes only on a change. */
export function updatePeerSelf(patch: Partial<PeerSelf>): void {
  if (!peerSelf) return
  const before = peerSelf
  const next = { ...peerSelf, ...patch }
  if (next.status !== before.status) next.activeAt = Date.now()
  peerSelf = next
  if (next.sessionId !== before.sessionId) {
    peerInboxIds.add(next.sessionId)
    void dropPeerCard(before.sessionId)
  }
  const changed = (Object.keys(patch) as (keyof PeerSelf)[]).some(
    key => before[key] !== next[key],
  )
  if (changed) writeOwnPeerCard()
}

function peerTaskRefusal(task: PeerTask): { outcome: PeerOutcome; text: string } | null {
  const name = peerSelf!.name
  if (orchestratorRole || !acceptingPeerTasks) {
    return { outcome: 'declined', text: `Session "${name}" does not take tasks right now.` }
  }
  if (acceptPeerTasksOnlyFrom && task.from.sessionId !== acceptPeerTasksOnlyFrom) {
    return {
      outcome: 'declined',
      text: `Session "${name}" takes tasks only from the session that opened it. /peers on there opens it to any orchestrator.`,
    }
  }
  const wanted =
    typeof task.maxAgeMs === 'number' && task.maxAgeMs > 0 ? task.maxAgeMs : PEER_TASK_MAX_AGE_MS
  const maxAge = Math.min(wanted, PEER_TASK_LONGEST_WAIT_MS)
  if (Date.now() - task.sentAt > maxAge) {
    return {
      outcome: 'expired',
      text: 'The task waited too long before this session read it, so it was skipped. Send it again if it still matters.',
    }
  }
  // A session that runs with checks off would otherwise run, unasked,
  // what a more restricted sender could not.
  if (
    peerSelf!.permissionMode === 'bypassPermissions' &&
    task.from.permissionMode !== 'bypassPermissions'
  ) {
    return {
      outcome: 'declined',
      text: `Session "${name}" runs with permission checks off, so it only takes tasks from a session that also has them off.`,
    }
  }
  return null
}

async function handlePeerMessage(message: PeerMessage): Promise<void> {
  if (message.kind === 'reply') {
    openPeerTasks.delete(message.inReplyTo)
    notifyPeerRole()
    peerHandlers!.onReply(message)
    return
  }
  const refused = peerTaskRefusal(message)
  if (refused) {
    await sendReply(message, refused.outcome, refused.text).catch(() => {})
    return
  }
  peerHandlers!.onTask(message)
}

/** An orchestrator must not wait forever on a session that went away. */
function settleOrphanedPeerTasks(): void {
  const host = thisHost()
  for (const [id, open] of openPeerTasks) {
    if (open.pid === 0 || open.host !== host || isPidAlive(open.pid)) continue
    openPeerTasks.delete(id)
    notifyPeerRole()
    peerHandlers!.onReply({
      kind: 'reply',
      id: newMessageId(),
      to: peerSelf!.sessionId,
      from: { sessionId: open.to, name: open.name, cwd: open.cwd },
      text: 'That session closed before it answered.',
      sentAt: Date.now(),
      inReplyTo: id,
      outcome: 'closed',
    })
  }
}

/** A session OpenPeer started shows up with a card: from then on it can be watched. */
async function adoptOpenedPeerPids(): Promise<void> {
  const cards = await listLiveCards()
  for (const open of openPeerTasks.values()) {
    if (open.pid !== 0) continue
    const card = cards.find(c => c.sessionId === open.to)
    if (card) {
      open.pid = card.pid
      open.host = card.host
    }
  }
}

/** One pass over this process's inboxes; a second caller joins the running one. */
function pollPeerInbox(): Promise<void> {
  peerPollInFlight ??= (async () => {
    try {
      if (!peerHandlers || !peerSelf) return
      peerInboxIds.add(peerSelf.sessionId)
      for (const id of peerInboxIds) {
        for (const message of await takeMessages(id)) {
          if (peerHandlers) await handlePeerMessage(message)
        }
      }
      if ([...openPeerTasks.values()].some(open => open.pid === 0)) await adoptOpenedPeerPids()
      if (openPeerTasks.size > 0 && peerHandlers) settleOrphanedPeerTasks()
    } catch {
      // A failed pass leaves unread files in place for the next one.
    } finally {
      peerPollInFlight = null
    }
  })()
  return peerPollInFlight
}

/** Taker side: remember a queued task so its answer can be sent back. */
export function rememberTakenTask(uuid: string, task: PeerTask): void {
  takenPeerTasks.set(uuid, task)
}

export function takenTaskEntries(): [string, PeerTask][] {
  return [...takenPeerTasks]
}

export function takenTask(uuid: string): PeerTask | undefined {
  return takenPeerTasks.get(uuid)
}

export function isTakenTaskUuid(uuid: string): boolean {
  return takenPeerTasks.has(uuid)
}

export function forgetTakenTask(uuid: string): void {
  takenPeerTasks.delete(uuid)
}

export async function sendReply(
  task: PeerTask,
  outcome: PeerOutcome,
  text: string,
): Promise<void> {
  if (!peerSelf) return
  await postMessage({
    kind: 'reply',
    id: newMessageId(),
    to: task.from.sessionId,
    from: ownPeerSender(),
    text: cutText(text, task.replyLimit ?? PEER_DEFAULT_REPLY_LIMIT),
    sentAt: Date.now(),
    inReplyTo: task.id,
    outcome,
  })
}

/** A prompt the user typed in the orchestrator resets its task budget. */
export function resetTaskBudget(): void {
  peerTasksSinceUserPrompt = 0
}

export function taskBudgetUsed(): number {
  return peerTasksSinceUserPrompt
}

export function openTaskCount(sessionId: string): number {
  let count = 0
  for (const open of openPeerTasks.values()) if (open.to === sessionId) count++
  return count
}

export async function listPeerLines(): Promise<string[]> {
  const now = Date.now()
  const cards = (await listLiveCards(now)).filter(c => c.sessionId !== peerSelf?.sessionId)
  return cards.map(c => describePeer(c, now, openTaskCount(c.sessionId)))
}

export type PeerTaskOptions = {
  sessionId: string
  permissionMode?: string
  taskLimit: number
  replyLimit: number
}

/** Why this session can't send a task now, or null. */
export function cannotSendPeerTask(options: PeerTaskOptions): string | null {
  if (!orchestratorRole) return 'Only a session started with tau --orchestrate can send tasks to other sessions.'
  if (!peerSelf || !peerHandlers) return 'Peer messaging is not ready in this session yet.'
  if (peerTasksSinceUserPrompt >= options.taskLimit) {
    return `You sent ${peerTasksSinceUserPrompt} tasks since the user last wrote, the limit (settings peers.taskLimit). Stop here and report to the user.`
  }
  return null
}

/**
 * Posts a task and tracks it until it is answered. A pid of 0 means the
 * session is still being opened; its card supplies the pid once it starts.
 */
export async function deliverPeerTask(
  to: { sessionId: string; name: string; cwd: string; pid: number; host: string },
  text: string,
  options: PeerTaskOptions & { maxAgeMs?: number },
): Promise<string | null> {
  const problem = cannotSendPeerTask(options)
  if (problem) return problem
  updatePeerSelf({ sessionId: options.sessionId })
  const task: PeerTask = {
    kind: 'task',
    id: newMessageId(),
    to: to.sessionId,
    from: ownPeerSender(options.permissionMode),
    text,
    sentAt: Date.now(),
    replyLimit: options.replyLimit,
    ...(options.maxAgeMs ? { maxAgeMs: options.maxAgeMs } : {}),
  }
  startPeerTimers()
  await postMessage(task)
  openPeerTasks.set(task.id, { to: to.sessionId, name: to.name, cwd: to.cwd, pid: to.pid, host: to.host })
  peerTasksSinceUserPrompt++
  notifyPeerRole()
  return null
}

/** Orchestrator side of SendMessage to "peer:<target>". */
export async function sendPeerTask(
  target: string,
  text: string,
  options: PeerTaskOptions,
): Promise<{ ok: boolean; message: string }> {
  const problem = cannotSendPeerTask(options)
  if (problem) return { ok: false, message: problem }
  updatePeerSelf({ sessionId: options.sessionId })
  const resolved = resolvePeer(
    (await listLiveCards()).filter(c => c.sessionId !== peerSelf!.sessionId),
    target,
  )
  if ('error' in resolved) return { ok: false, message: resolved.error }
  const peer = resolved.card
  const failed = await deliverPeerTask(peer, text, options)
  if (failed) return { ok: false, message: failed }
  return {
    ok: true,
    message: `Sent to "${peer.name}" (${peer.cwd}). Its answer arrives later as a task notification for peer:${peer.name}. Don't wait or poll for it.`,
  }
}

/** Test seam: back to a fresh process. */
export async function resetPeersForTesting(): Promise<void> {
  detachPeerSession()
  await peerCardOps
  await peerPollInFlight
  orchestratorRole = false
  acceptPeerTasksOnlyFrom = null
  peerSelf = null
  peerInboxIds.clear()
  openPeerTasks.clear()
  takenPeerTasks.clear()
  peerTasksSinceUserPrompt = 0
  peerWorkingFor = null
  peerRoleSnapshot = null
  peerRoleListeners.clear()
}

/** Test seam: run one inbox pass now, after any pending card writes. */
export async function pollPeersForTesting(): Promise<void> {
  await peerCardOps
  await pollPeerInbox()
  await peerCardOps
}

/** Test seam: wait for pending card writes and removals. */
export async function settlePeersForTesting(): Promise<void> {
  await peerCardOps
}
