/**
 * Files behind cross-session messaging between Tau sessions on one machine.
 *
 *   <config>/tau-peers/cards/<sessionId>.json        a session that takes tasks
 *   <config>/tau-peers/inbox/<sessionId>/<id>.json   messages waiting for one
 *
 * Plain files work the same on every OS and survive the receiver being busy,
 * between polls or restarting. Official Claude Code runs its own peer protocol
 * out of <config>/sessions; nothing here reads or writes that folder.
 */

import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { hostname } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export const PEER_ADDRESS_PREFIX = 'peer:'

/** A card not rewritten for this long belongs to a session that hung or died. */
const CARD_FRESH_MS = 60_000
/** Stale cards from another host can't be probed, so drop them after this. */
const CARD_SWEEP_MS = 10 * 60_000
/** Bigger messages are refused rather than read into a session. */
const MAX_MESSAGE_CHARS = 200_000

export type PeerStatus = 'idle' | 'busy' | 'waiting'

export type PeerCard = {
  sessionId: string
  pid: number
  /** Platform and machine: a pid can only be checked on the host that wrote it. */
  host: string
  cwd: string
  name: string
  status: PeerStatus
  provider?: string
  model?: string
  /** When the status last changed. */
  activeAt: number
  updatedAt: number
}

export type PeerSender = {
  sessionId: string
  name: string
  cwd: string
  permissionMode?: string
}

export type PeerOutcome =
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'declined'
  | 'expired'
  | 'closed'
  | 'cleared'

const OUTCOMES = new Set<PeerOutcome>([
  'done',
  'failed',
  'interrupted',
  'declined',
  'expired',
  'closed',
  'cleared',
])

export type PeerTask = {
  kind: 'task'
  id: string
  to: string
  from: PeerSender
  text: string
  sentAt: number
  /** The sender's cap on the answer it gets back. */
  replyLimit?: number
  /** How long it may wait unread; longer than the default for a window being opened. */
  maxAgeMs?: number
}

export type PeerReply = {
  kind: 'reply'
  id: string
  to: string
  from: PeerSender
  text: string
  sentAt: number
  inReplyTo: string
  outcome: PeerOutcome
}

export type PeerMessage = PeerTask | PeerReply

export function peersDir(): string {
  return join(getClaudeConfigHomeDir(), 'tau-peers')
}

function cardsDir(): string {
  return join(peersDir(), 'cards')
}

function cardPath(sessionId: string): string {
  return join(cardsDir(), `${sessionId}.json`)
}

export function peerInboxDir(sessionId: string): string {
  return join(peersDir(), 'inbox', sessionId)
}

export function thisHost(): string {
  return `${process.platform}:${hostname()}`
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function isCardLive(card: PeerCard, now = Date.now()): boolean {
  if (now - card.updatedAt > CARD_FRESH_MS) return false
  return card.host !== thisHost() || isPidAlive(card.pid)
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9-]{1,80}$/.test(id)
}

function parseCard(raw: string): PeerCard | null {
  let v: Partial<PeerCard>
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    !v ||
    typeof v.sessionId !== 'string' ||
    !isSafeId(v.sessionId) ||
    typeof v.pid !== 'number' ||
    typeof v.host !== 'string' ||
    typeof v.cwd !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.updatedAt !== 'number' ||
    typeof v.activeAt !== 'number' ||
    (v.status !== 'idle' && v.status !== 'busy' && v.status !== 'waiting')
  ) {
    return null
  }
  return v as PeerCard
}

function parseMessage(raw: string): PeerMessage | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const from = v.from as Partial<PeerSender> | undefined
  if (
    (v.kind !== 'task' && v.kind !== 'reply') ||
    typeof v.id !== 'string' ||
    !isSafeId(v.id) ||
    typeof v.to !== 'string' ||
    typeof v.text !== 'string' ||
    v.text.length > MAX_MESSAGE_CHARS ||
    typeof v.sentAt !== 'number' ||
    !from ||
    typeof from.sessionId !== 'string' ||
    !isSafeId(from.sessionId) ||
    typeof from.name !== 'string' ||
    typeof from.cwd !== 'string'
  ) {
    return null
  }
  if (
    v.kind === 'reply' &&
    (typeof v.inReplyTo !== 'string' || !OUTCOMES.has(v.outcome as PeerOutcome))
  ) {
    return null
  }
  return v as PeerMessage
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 })
  try {
    await rename(tmp, path)
  } catch {
    // Windows refuses to replace a file another process has open; a reader
    // that catches a half-written card skips it until the next heartbeat.
    await unlink(tmp).catch(() => {})
    await writeFile(path, JSON.stringify(data), { mode: 0o600 })
  }
}

export async function writeCard(card: PeerCard): Promise<void> {
  await mkdir(cardsDir(), { recursive: true, mode: 0o700 })
  await writeJson(cardPath(card.sessionId), card)
}

export async function removeCard(sessionId: string): Promise<void> {
  await unlink(cardPath(sessionId)).catch(() => {})
}

/** Every session that takes tasks right now, by name. Sweeps dead ones. */
export async function listLiveCards(now = Date.now()): Promise<PeerCard[]> {
  let names: string[]
  try {
    names = await readdir(cardsDir())
  } catch {
    return []
  }
  const host = thisHost()
  const live: PeerCard[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(cardsDir(), name)
    const card = parseCard(await readFile(path, 'utf8').catch(() => ''))
    if (!card) continue
    if (isCardLive(card, now)) {
      live.push(card)
    } else if (
      (card.host === host && !isPidAlive(card.pid)) ||
      now - card.updatedAt > CARD_SWEEP_MS
    ) {
      await unlink(path).catch(() => {})
    }
  }
  return live.sort(
    (a, b) => a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId),
  )
}

/** Time-ordered so a sorted folder listing reads oldest first (fixed width). */
export function newMessageId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, '0')}-${randomUUID().slice(0, 8)}`
}

export async function postMessage(message: PeerMessage): Promise<void> {
  if (!isSafeId(message.to)) throw new Error(`bad session id: ${message.to}`)
  const dir = peerInboxDir(message.to)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${message.id}.json`)
  // Published by rename, so a reader never sees half a message.
  await writeFile(`${path}.tmp`, JSON.stringify(message), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

/**
 * Takes every message waiting for `sessionId`, oldest first. Each is claimed
 * by a rename before it is read, so two processes never both act on one, and
 * a message is acted on at most once.
 */
export async function takeMessages(sessionId: string): Promise<PeerMessage[]> {
  if (!isSafeId(sessionId)) return []
  const dir = peerInboxDir(sessionId)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const taken: PeerMessage[] = []
  for (const name of names) {
    const path = join(dir, name)
    const claimed = `${path}.${process.pid}.taken`
    try {
      await rename(path, claimed)
    } catch {
      continue
    }
    const raw = await readFile(claimed, 'utf8').catch(() => '')
    await unlink(claimed).catch(() => {})
    const message = parseMessage(raw)
    if (message && message.to === sessionId) taken.push(message)
  }
  return taken
}

/** Picks the session a `peer:` address means: a name, else an id prefix. */
export function resolvePeer(
  cards: PeerCard[],
  target: string,
): { card: PeerCard } | { error: string } {
  const wanted = target.trim().toLowerCase()
  const byName = cards.filter(c => c.name.toLowerCase() === wanted)
  if (byName.length === 1) return { card: byName[0]! }
  const byId =
    wanted.length >= 4
      ? cards.filter(c => c.sessionId.toLowerCase().startsWith(wanted))
      : []
  if (byName.length === 0 && byId.length === 1) return { card: byId[0]! }
  const clash = byName.length > 1 ? byName : byId
  if (clash.length > 1) {
    const options = clash.map(c => `peer:${c.sessionId.slice(0, 8)} (${c.cwd})`)
    return {
      error: `"${target}" matches ${clash.length} sessions. Use one of: ${options.join(', ')}.`,
    }
  }
  if (cards.length === 0) {
    return {
      error:
        'No other Tau session on this machine takes tasks. The user can run /peers on in the session they want to use.',
    }
  }
  const names = cards.map(c => c.name).join(', ')
  return { error: `No session "${target}" takes tasks. Sessions that do: ${names}.` }
}

function peerAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

/** One line per session, for ListPeers and /peers. */
export function describePeer(card: PeerCard, now: number, openTasks: number): string {
  const status = card.status === 'waiting' ? 'waiting for its user' : card.status
  const parts = [card.name, status]
  if (card.model) parts.push(card.provider ? `${card.provider}/${card.model}` : card.model)
  parts.push(card.cwd, `id ${card.sessionId.slice(0, 8)}`, `active ${peerAge(now - card.activeAt)}`)
  if (openTasks > 0) {
    parts.push(openTasks === 1 ? '1 task of yours open' : `${openTasks} tasks of yours open`)
  }
  return parts.join(' · ')
}

/** A name or path made safe for a quoted attribute in the tags below. */
function peerAttr(value: string): string {
  return value.replace(/["\r\n]+/g, ' ').trim()
}

export function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[Cut at ${limit} characters. The full answer is in that session.]`
}

/** What the receiving session's model reads for a task. */
export function formatTaskPrompt(task: PeerTask): string {
  const name = peerAttr(task.from.name)
  return (
    `<peer-task from="${name}" cwd="${peerAttr(task.from.cwd)}">\n${task.text}\n</peer-task>\n` +
    `This task came from the Tau session "${name}". When you finish, your final message goes back to it automatically, so end with what you did and how you checked it. If you need something from it first, end your turn with your question.`
  )
}

const OUTCOME_SUMMARY: Record<PeerOutcome, [status: string, text: string]> = {
  done: ['completed', 'answered'],
  failed: ['failed', 'failed'],
  interrupted: ['killed', 'was interrupted in its window'],
  declined: ['killed', 'declined the task'],
  expired: ['killed', 'skipped a task that waited too long'],
  closed: ['killed', 'closed before answering'],
  cleared: ['killed', 'was cleared before answering'],
}

/**
 * What the orchestrator's model reads for an answer. It is a task
 * notification, so it shows as one line in the window and the model already
 * knows its shape; the task id is the address to write back to.
 */
export function formatReplyNotification(reply: PeerReply): string {
  const [status, verb] = OUTCOME_SUMMARY[reply.outcome]
  const name = peerAttr(reply.from.name)
  const result = reply.text.trim() ? `\n<result>${reply.text}</result>` : ''
  return (
    `<task-notification>\n<task-id>${PEER_ADDRESS_PREFIX}${name}</task-id>\n` +
    `<status>${status}</status>\n<summary>Session "${name}" ${verb}</summary>${result}\n</task-notification>`
  )
}
