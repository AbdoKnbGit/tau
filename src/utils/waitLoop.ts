/**
 * Waiting-loop guard.
 *
 * A background task is running and the model wants its result. Instead of
 * waiting for the <task-notification> Tau sends when the task finishes, it
 * checks again: TaskOutput, a read of the task's log, a process or socket
 * probe, the same status command. Every check succeeds and reports "still
 * running", so nothing treats it as a failure and toolLedger's thrash detector
 * (the same failing call, over and over) never fires. One slow install kept a
 * model doing this for 246 tool calls, until the user interrupted it.
 *
 * This module counts those checks within one query loop (one user turn) and
 * decides when to point them out and when to end the turn. It names no tool,
 * command or operating system:
 *
 *   - A call checks on a task when its input names a running background task:
 *     the task id itself, or its log file (`<id>.output`), however the model
 *     reads it. Task ids are random, so a match is never a coincidence.
 *   - Any other call that repeats an earlier call exactly (same tool, same
 *     input) and gets exactly the same result learned nothing: it is probing
 *     something that is not changing.
 *
 * Checking something once or twice is normal. At WAIT_LOOP_NUDGE_AT checks the
 * model is told to stop; if it keeps checking while it is waiting on
 * background work, the turn ends after WAIT_LOOP_STOP_AFTER more. A repeated
 * probe with no background work running only earns the nudge: without
 * anything to wait for, it is a stuck approach, not a wait.
 *
 * A file edit restarts every count. Reading a dev server's log after each
 * change looks at the effect of the model's own work; waiting is checking
 * again with nothing done in between.
 *
 * Leaf module (constants, hash and toolLedger only), so waitLoop.test.ts runs
 * standalone.
 */

import {
  TASK_OUTPUT_MAX_TIMEOUT_MS,
  TASK_OUTPUT_TOOL_NAME,
} from '../tools/TaskOutputTool/constants.js'
import { djb2Hash } from './hash.js'
import { toolInputKey } from './toolLedger.js'

/** Checks of one thing in a turn before the model is told to stop. */
export const WAIT_LOOP_NUDGE_AT = 3

/**
 * Further checks, after a nudge about waiting, before the turn ends. Counted
 * across everything checked, so restarting the task under a new id or moving
 * to another probe does not start the count over.
 */
export const WAIT_LOOP_STOP_AFTER = 3

const DESCRIPTION_CHARS = 80
const PREVIEW_CHARS = 160
const LISTED_TASKS = 3

export type WaitLoopTask = { id: string; description: string }

export type WaitLoopCall = {
  name: string
  input: unknown
  /** The tool_result text the model received. */
  resultText: string
  isError: boolean
  /**
   * The call edits files (by the tool's own declaration). A check after an
   * edit looks at the effect of the model's own work, a dev server's log after
   * a change, say, and is not a wait.
   */
  changesFiles?: boolean
}

export type WaitLoopRound = {
  calls: readonly WaitLoopCall[]
  /** Background tasks still running after the round: what a call can check on. */
  running: readonly WaitLoopTask[]
  /** The running tasks this conversation started and is notified about. */
  waitingOn: readonly WaitLoopTask[]
}

export type WaitLoopSubject =
  | { kind: 'task'; task: WaitLoopTask }
  | { kind: 'call'; name: string; inputPreview: string; resultPreview: string }

export type WaitLoopFinding = {
  action: 'nudge' | 'stop'
  subject: WaitLoopSubject
  /** Times the subject was checked this turn. */
  count: number
  waitingOn: readonly WaitLoopTask[]
}

export type WaitLoopVerdict = { action: 'none' } | WaitLoopFinding

/**
 * Who reads the guidance. The main thread is woken by a task's notification
 * after its turn ends; a subagent's run is over once it ends.
 */
export type WaitLoopAudience = { canWaitForNotification: boolean }

/** The fields of a task's app state read here, structurally, to stay a leaf. */
type TaskLike = {
  id: string
  type: string
  status: string
  description: string
  isBackgrounded?: boolean
  /** local_bash: the agent that started it. Agent tasks: the agent itself. */
  agentId?: string
  agentType?: string
  /** local_bash: 'monitor' streams events until stopped. */
  kind?: string
}

/**
 * Task types that run until they are shut down rather than finishing, so there
 * is no completion to wait for. print.ts leaves teammates out of its wait for
 * the same reason.
 */
const LONG_LIVED_TYPES = new Set(['in_process_teammate', 'monitor_mcp'])

/**
 * Split app-state tasks for one conversation: every running background task a
 * call could check on, and the ones this conversation started, which are what
 * it waits on. `agentId` is the asking conversation's (undefined for the main
 * thread).
 */
export function backgroundTasksFor(
  tasks: Readonly<Record<string, TaskLike>> | undefined,
  agentId: string | undefined,
): { running: WaitLoopTask[]; waitingOn: WaitLoopTask[] } {
  const running: WaitLoopTask[] = []
  const waitingOn: WaitLoopTask[] = []
  for (const task of Object.values(tasks ?? {})) {
    if (task.status !== 'running' && task.status !== 'pending') continue
    // A foreground command is the tool call still in progress, not a wait.
    if (task.isBackgrounded === false) continue
    if (LONG_LIVED_TYPES.has(task.type) || task.kind === 'monitor') continue
    // The backgrounded main session, and the asking agent's own task.
    if (task.agentType === 'main-session') continue
    if (
      agentId !== undefined &&
      task.type !== 'local_bash' &&
      (task.id === agentId || task.agentId === agentId)
    ) {
      continue
    }
    const entry = { id: task.id, description: task.description }
    running.push(entry)
    // A shell task records who started it. Other task types do not, so they
    // count as the main thread's; a dream is housekeeping nobody waits for.
    const ours =
      task.type === 'local_bash'
        ? task.agentId === agentId
        : agentId === undefined && task.type !== 'dream'
    if (ours) waitingOn.push(entry)
  }
  return { running, waitingOn }
}

/** tool_result content is a string, or blocks of which only text carries meaning. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

type Observation = {
  key: string
  subject: WaitLoopSubject
  /** What a repeat must match to count. Absent for a task: every check counts. */
  state?: string
}

type Track = {
  count: number
  state?: string
  subject: WaitLoopSubject
  nudged: boolean
  /** Round of the latest check, to tell whether an edit came after it. */
  lastRound: number
}

/**
 * Counts checks across the rounds of one query loop. One instance per loop:
 * the counts describe this turn and leak nowhere else.
 */
export class WaitLoopGuard {
  readonly #nudgeAt: number
  readonly #stopAfter: number
  readonly #tracks = new Map<string, Track>()
  #round = 0
  /** Round of the first nudge about waiting; checks after it count toward the stop. */
  #armedRound: number | null = null
  #checksSinceArmed = 0
  /** Latest round with a successful file edit. */
  #lastWorkRound = 0

  constructor(options: { nudgeAt?: number; stopAfter?: number } = {}) {
    this.#nudgeAt = options.nudgeAt ?? WAIT_LOOP_NUDGE_AT
    this.#stopAfter = options.stopAfter ?? WAIT_LOOP_STOP_AFTER
  }

  /**
   * Record one round of tool calls. A thing counts once per round however many
   * calls touched it: TaskOutput plus a read of the same task's log, issued
   * together, is one decision to check.
   */
  observeRound(round: WaitLoopRound): WaitLoopVerdict {
    this.#round++
    // Real work restarts every count: what follows it is looking at its effect.
    if (round.calls.some(call => call.changesFiles && !call.isError)) {
      this.#lastWorkRound = this.#round
      this.#checksSinceArmed = 0
    }
    const touched = new Set<string>()
    const repeated: Track[] = []
    for (const call of round.calls) {
      for (const { key, state, subject } of observe(call, round.running)) {
        if (touched.has(key)) continue
        touched.add(key)
        const track = this.#tracks.get(key)
        if (!track) {
          this.#tracks.set(key, {
            count: 1,
            state,
            subject,
            nudged: false,
            lastRound: this.#round,
          })
          continue
        }
        const workedSince = this.#lastWorkRound > track.lastRound
        track.lastRound = this.#round
        if (workedSince || state !== track.state) {
          // An edit since, or a different result: something new. Count afresh.
          track.count = 1
          track.state = state
          track.subject = subject
        } else {
          track.count++
          track.subject = subject
          repeated.push(track)
        }
      }
    }

    // Checks that are waiting: on a running task, or a repeated probe while
    // this conversation has background work running.
    const waiting = round.waitingOn.length > 0
    const waitChecks = repeated.filter(
      track => track.subject.kind === 'task' || waiting,
    )

    // Checks made in the nudge's own round came before the model read it.
    if (
      this.#armedRound !== null &&
      this.#armedRound < this.#round &&
      waitChecks.length > 0
    ) {
      this.#checksSinceArmed += waitChecks.length
      if (this.#checksSinceArmed >= this.#stopAfter) {
        const track = mostChecked(waitChecks)
        return {
          action: 'stop',
          subject: track.subject,
          count: track.count,
          waitingOn: round.waitingOn,
        }
      }
    }

    // Once the countdown runs, a further wait would only repeat the same advice.
    const due = repeated.filter(
      track =>
        !track.nudged &&
        track.count >= this.#nudgeAt &&
        !(this.#armedRound !== null && waitChecks.includes(track)),
    )
    if (due.length === 0) return { action: 'none' }
    const track = mostChecked(due)
    track.nudged = true
    if (this.#armedRound === null && waitChecks.includes(track)) {
      this.#armedRound = this.#round
    }
    return {
      action: 'nudge',
      subject: track.subject,
      count: track.count,
      waitingOn: round.waitingOn,
    }
  }
}

function observe(
  call: WaitLoopCall,
  running: readonly WaitLoopTask[],
): Observation[] {
  const tasks = referencedTasks(call.input, running)
  if (tasks.length > 0) {
    return tasks.map(task => ({
      key: `task\0${task.id}`,
      subject: { kind: 'task', task },
    }))
  }
  return [
    {
      key: `call\0${call.name}\0${toolInputKey(call.input)}`,
      state: `${call.isError ? 'error' : 'ok'}\0${call.resultText.length}:${djb2Hash(call.resultText)}`,
      subject: {
        kind: 'call',
        name: call.name,
        inputPreview: inputPreview(call.input),
        resultPreview: resultPreview(call.resultText),
      },
    },
  ]
}

/** Running tasks the input names: by id, or by their log file's name. */
function referencedTasks(
  input: unknown,
  running: readonly WaitLoopTask[],
): WaitLoopTask[] {
  if (running.length === 0) return []
  const strings: string[] = []
  collectStrings(input, strings, 0)
  return running.filter(task =>
    strings.some(
      text => text.trim() === task.id || text.includes(`${task.id}.output`),
    ),
  )
}

function collectStrings(value: unknown, out: string[], depth: number): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (depth >= 8 || !value || typeof value !== 'object') return
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(item, out, depth + 1)
  }
}

/** A task outranks a probe; among equals, the one checked most. */
function mostChecked(tracks: readonly Track[]): Track {
  return tracks.reduce((best, track) => {
    const isTask = track.subject.kind === 'task'
    const bestIsTask = best.subject.kind === 'task'
    if (isTask !== bestIsTask) return isTask ? track : best
    return track.count > best.count ? track : best
  })
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function inputPreview(input: unknown): string {
  // A shell call reads best as its command line.
  const command =
    input && typeof input === 'object' && 'command' in input
      ? (input as { command?: unknown }).command
      : undefined
  if (typeof command === 'string') return oneLine(command, PREVIEW_CHARS)
  let text: string
  try {
    text = JSON.stringify(input) ?? String(input)
  } catch {
    text = String(input)
  }
  return oneLine(text, PREVIEW_CHARS)
}

function resultPreview(resultText: string): string {
  const firstLine = resultText.split('\n').find(line => line.trim()) ?? ''
  return firstLine ? oneLine(firstLine, PREVIEW_CHARS) : '(no output)'
}

function describeTask(task: WaitLoopTask): string {
  const description = oneLine(task.description, DESCRIPTION_CHARS)
  return description
    ? `background task ${task.id} ("${description}")`
    : `background task ${task.id}`
}

function describeSubject(subject: WaitLoopSubject): string {
  return subject.kind === 'task'
    ? describeTask(subject.task)
    : `the same ${subject.name} call (${subject.inputPreview})`
}

function listTasks(tasks: readonly WaitLoopTask[]): string {
  const shown = tasks.slice(0, LISTED_TASKS).map(describeTask)
  const more = tasks.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/** What is still running, unless it is the subject itself (already named). */
function stillRunning(finding: WaitLoopFinding): string | null {
  const { subject, waitingOn } = finding
  if (waitingOn.length === 0) return null
  if (
    subject.kind === 'task' &&
    waitingOn.length === 1 &&
    waitingOn[0]!.id === subject.task.id
  ) {
    return 'It is still running'
  }
  return `Still running: ${listTasks(waitingOn)}`
}

const NOTIFICATION = '<task-notification>'
const CHECKS = `${TASK_OUTPUT_TOOL_NAME}, reading its output file, sleeping, or probing its process or network activity`

function waitAdvice(audience: WaitLoopAudience, what: string): string {
  return audience.canWaitForNotification
    ? `Tau sends you a ${NOTIFICATION} when it finishes, so stop checking on it (${CHECKS}). If this request has other work left, do that. Otherwise tell the user ${what}, and end your turn.`
    : `Stop polling it (${CHECKS}). If you need its result, wait for it once with ${TASK_OUTPUT_TOOL_NAME} (block: true, timeout up to ${TASK_OUTPUT_MAX_TIMEOUT_MS} ms). Otherwise report ${what}, and finish.`
}

/**
 * The nudge appended after the round that reached WAIT_LOOP_NUDGE_AT. It
 * makes the repetition visible and says what waiting looks like here.
 */
export function buildWaitLoopNudge(
  finding: WaitLoopFinding,
  audience: WaitLoopAudience,
): string {
  const { subject, count } = finding
  if (subject.kind === 'task') {
    return [
      `You have checked ${describeTask(subject.task)} ${count} times, and it is still running. Checking again will not make it finish sooner.`,
      '',
      waitAdvice(audience, 'it is still running'),
    ].join('\n')
  }
  const lines = [
    `You have run ${subject.name} ${count} times with the same input and got the same result each time:`,
    subject.inputPreview,
    `→ ${subject.resultPreview}`,
    '',
  ]
  lines.push(
    finding.waitingOn.length > 0
      ? `It is not telling you anything new. Still running: ${listTasks(finding.waitingOn)}. ${waitAdvice(audience, 'what is still running')}`
      : 'Repeating it will not produce anything new. Change the approach, or stop and tell the user what is blocking you.',
  )
  return lines.join('\n')
}

/**
 * Appended when the model keeps checking after a nudge: one more response,
 * without tools, to report where things stand.
 */
export function buildWaitLoopFinalInstruction(
  finding: WaitLoopFinding,
  audience: WaitLoopAudience,
): string {
  const lead = `you kept checking on ${describeSubject(finding.subject)} after being asked to stop. Do not call any more tools; they will not run.`
  if (!audience.canWaitForNotification) {
    return `Tau is ending this run: ${lead} Reply with your result so far: what you found, and what is still running.`
  }
  const status =
    finding.waitingOn.length > 0
      ? `what is done, what is still running, and that you will pick it up when its ${NOTIFICATION} arrives`
      : 'what is done, and what is blocking you'
  return `Tau is ending this turn: ${lead} Reply to the user with a short status: ${status}.`
}

/** The result of each call the model made anyway in its final response. */
export function buildWaitLoopNotRunResult(
  finding: WaitLoopFinding,
  audience: WaitLoopAudience,
): string {
  const running = stillRunning(finding)
  const tail =
    running === null
      ? ''
      : audience.canWaitForNotification
        ? ` ${running}; Tau sends a ${NOTIFICATION} when it finishes.`
        : ` ${running}.`
  return `Not run: Tau ended this turn because you kept checking on ${describeSubject(finding.subject)} instead of waiting.${tail}`
}

/** What the user sees when Tau ends the turn. */
export function buildWaitLoopStopNotice(
  finding: WaitLoopFinding,
  audience: WaitLoopAudience,
): string {
  const running = stillRunning(finding)
  const tail =
    running === null
      ? ''
      : audience.canWaitForNotification
        ? ` ${running}; the agent picks it up when it finishes.`
        : ` ${running}.`
  return `Stopped the agent: it kept checking on ${describeSubject(finding.subject)} after being asked to wait.${tail}`
}
