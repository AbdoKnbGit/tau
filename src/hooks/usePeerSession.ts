/**
 * REPL side of cross-session messaging (services/peers/runtime.ts): connects
 * the inbox to this session's queue, keeps its card current, and sends each
 * task's final answer back as soon as its turn is over: when the next task or
 * prompt starts, or once the session is idle again.
 *
 * A task runs as its own turn, like a prompt typed at an idle prompt, so the
 * system prompt and tools never change and the provider cache stays warm.
 * A task from an orchestrator that has permission checks off runs with them
 * off here too, for that turn only.
 */

import { randomUUID } from 'crypto'
import { basename } from 'path'
import { useEffect, useRef } from 'react'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { Notification } from '../context/notifications.js'
import {
  attachPeerSession,
  detachPeerSession,
  forgetTakenTask,
  isOrchestrator,
  isTakenTaskUuid,
  rememberTakenTask,
  resetTaskBudget,
  sendReply,
  setPeerWorkingFor,
  takenTask,
  takenTaskEntries,
  updatePeerSelf,
} from '../services/peers/runtime.js'
import { readPeerSettings } from '../services/peers/settings.js'
import {
  formatReplyNotification,
  formatTaskPrompt,
  type PeerOutcome,
  type PeerStatus,
  type PeerTask,
} from '../services/peers/store.js'
import type { AppState } from '../state/AppState.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../tasks/LocalMainSessionTask.js'
import type { ToolPermissionContext, ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import {
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
} from '../utils/messageQueueManager.js'
import {
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../utils/messages.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  enableBypassPermissionsModeForSession,
  endBypassPermissionsModeForSession,
  isBypassPermissionsOnForSession,
  permissionModeWithSessionBypass,
  type PermissionModeBeforeBypass,
} from '../utils/permissions/bypassPermissionsMode.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'

/** Idle this long before answering: the queue may start the next turn first. */
const SETTLE_MS = 800

type Props = {
  messages: readonly Message[]
  isLoading: boolean
  /** A permission prompt is waiting for the user. */
  waiting: boolean
  model: string
  toolPermissionContext: ToolPermissionContext
  setAppState: ToolUseContext['setAppState']
  addNotification: (notification: Notification) => void
  tasks: AppState['tasks']
}

function peerSessionName(): string {
  return (
    getCurrentSessionTitle(getSessionId())?.trim() ||
    basename(getOriginalCwd()) ||
    'tau'
  )
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function originKind(message: Message): string | undefined {
  return (message as { origin?: { kind?: string } }).origin?.kind
}

function isInterruption(text: string): boolean {
  return text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE
}

/** A prompt the user typed (or a command they ran), not a tool result or notice. */
function isTypedPrompt(message: Message): boolean {
  if (message.type !== 'user' || message.isMeta) return false
  const kind = originKind(message)
  if (kind !== undefined && kind !== 'human') return false
  const content = message.message.content
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) {
    return false
  }
  const text = textOf(content).trim()
  return text !== '' && !isInterruption(text)
}

/**
 * The task's answer: the last text the session wrote after it, up to the next
 * task or the next prompt the user typed. Notices from the session's own
 * background agents don't end it, since the task's work goes on after them.
 * `ended`: that next task or prompt has started, so the answer is final.
 */
function readAnswer(
  messages: readonly Message[],
  start: number,
): { outcome: PeerOutcome; text: string; ended: boolean } {
  let answer = ''
  let failed = false
  let interrupted = false
  let ended = false
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i]!
    if (message.type === 'assistant') {
      const text = textOf(message.message.content).trim()
      if (text) {
        answer = text
        failed = message.isApiErrorMessage === true
      }
      continue
    }
    if (message.type !== 'user') continue
    if (originKind(message) === 'peer' || isTakenTaskUuid(message.uuid) || isTypedPrompt(message)) {
      ended = true
      break
    }
    if (isInterruption(textOf(message.message.content).trim())) interrupted = true
  }
  if (interrupted) return { outcome: 'interrupted', text: answer, ended }
  if (failed) return { outcome: 'failed', text: answer, ended }
  return { outcome: 'done', text: answer || 'It finished without a written answer.', ended }
}

function hasRunningPeerTaskAgents(tasks: AppState['tasks']): boolean {
  return Object.values(tasks).some(
    task => isLocalAgentTask(task) && !isMainSessionTask(task) && task.status === 'running',
  )
}

/** Answers tasks whose turn is over because a later task or prompt started. */
function answerEndedTasks(messages: readonly Message[]): void {
  for (const [uuid, task] of takenTaskEntries()) {
    const index = messages.findIndex(message => message.uuid === uuid)
    if (index < 0) continue
    const { outcome, text, ended } = readAnswer(messages, index)
    if (!ended) continue
    forgetTakenTask(uuid)
    void sendReply(task, outcome, text).catch(() => {})
  }
}

/** Answers the rest once the session is idle: the last task, and any that were cleared. */
function answerFinishedTasks(messages: readonly Message[], tasks: AppState['tasks']): void {
  const queue = getCommandQueue()
  if (queue.some(command => command.agentId === undefined)) return
  if (hasRunningPeerTaskAgents(tasks)) return
  for (const [uuid, task] of takenTaskEntries()) {
    const index = messages.findIndex(message => message.uuid === uuid)
    forgetTakenTask(uuid)
    const { outcome, text } =
      index < 0
        ? {
            outcome: 'cleared' as const,
            text: 'The session dropped the task before answering: it was cleared, or a hook blocked the prompt.',
          }
        : readAnswer(messages, index)
    void sendReply(task, outcome, text).catch(() => {})
  }
}

/** The task whose turn is running: the latest task or typed prompt, when it is a task. */
function runningPeerTask(messages: readonly Message[]): PeerTask | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'user') continue
    const task = takenTask(message.uuid)
    if (task) return task
    if (originKind(message) === 'peer' || isTypedPrompt(message)) return null
  }
  return null
}

export function usePeerSession({
  messages,
  isLoading,
  waiting,
  model,
  toolPermissionContext,
  setAppState,
  addNotification,
  tasks,
}: Props): void {
  const latest = useRef({ messages, tasks })
  latest.current = { messages, tasks }
  /** The mode a bypass task replaced, while that task's turn runs. */
  const elevation = useRef<PermissionModeBeforeBypass | null>(null)
  // Other sessions see this session's own mode, not the one a task lent it.
  const ownMode = elevation.current
    ? elevation.current.mode
    : permissionModeWithSessionBypass(toolPermissionContext.mode)

  useEffect(() => {
    attachPeerSession(
      {
        onTask: task => {
          const uuid = randomUUID()
          rememberTakenTask(uuid, task)
          // `later`: never cuts into a running turn; it starts its own when idle.
          enqueue({
            value: formatTaskPrompt(task),
            mode: 'prompt',
            priority: 'later',
            skipSlashCommands: true,
            uuid,
            peer: true,
            origin: { kind: 'peer', from: task.from.name, session: task.from.sessionId },
          })
        },
        onReply: reply => {
          enqueuePendingNotification({
            value: formatReplyNotification(reply),
            mode: 'task-notification',
          })
        },
      },
      {
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        name: peerSessionName(),
        status: 'idle',
        provider: getAPIProvider(),
        model,
        permissionMode: ownMode,
      },
      readPeerSettings().inbound === 'on',
    )
    return detachPeerSession
    // Once per REPL; the effects below keep the card current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const status: PeerStatus = waiting ? 'waiting' : isLoading ? 'busy' : 'idle'
    updatePeerSelf({
      status,
      sessionId: getSessionId(),
      name: peerSessionName(),
      provider: getAPIProvider(),
      model,
      permissionMode: ownMode,
    })
  }, [isLoading, waiting, model, ownMode])

  // A task is over once the next task or prompt starts: answer it right away.
  useEffect(() => {
    if (takenTaskEntries().length > 0) answerEndedTasks(messages)
  }, [messages])

  useEffect(() => {
    if (isLoading) return
    const timer = setTimeout(() => {
      if (takenTaskEntries().length === 0) return
      answerFinishedTasks(latest.current.messages, latest.current.tasks)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [isLoading, tasks])

  // The turn of a task from a session with permission checks off runs with
  // them off here too (unless settings or policy forbid it, or a plan is
  // open); the mode before comes back when that turn is over.
  useEffect(() => {
    const task = isLoading ? runningPeerTask(messages) : null
    setPeerWorkingFor(task ? task.from.name : null)
    const wanted = task?.from.permissionMode === 'bypassPermissions'
    if (wanted && !elevation.current) {
      const { mode, isBypassPermissionsModeAvailable } = toolPermissionContext
      if (mode === 'plan' || isBypassPermissionsOnForSession(mode)) return
      if (!enableBypassPermissionsModeForSession({ setAppState })) return
      elevation.current = { mode, isBypassPermissionsModeAvailable }
      addNotification({
        key: 'peer-task-bypass',
        text: `Bypass Permissions on for this task: "${task!.from.name}" runs with permission checks off.`,
        color: 'warning',
        priority: 'high',
      })
    } else if (!wanted && elevation.current) {
      const before = elevation.current
      elevation.current = null
      endBypassPermissionsModeForSession({ setAppState }, before)
    }
  }, [isLoading, messages, toolPermissionContext, setAppState, addNotification])

  // An orchestrator's task budget counts tasks between the user's own prompts.
  const scanned = useRef(0)
  useEffect(() => {
    if (!isOrchestrator()) return
    if (messages.length < scanned.current) scanned.current = 0
    for (let i = scanned.current; i < messages.length; i++) {
      if (isTypedPrompt(messages[i]!)) resetTaskBudget()
    }
    scanned.current = messages.length
  }, [messages])
}
