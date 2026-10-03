/**
 * What Tau's mascot does, frame by frame.
 *
 * Pure functions with no app imports: the component feeds in signals derived
 * from the session (working, thinking, which tools run, failures, context
 * use) and draws whatever pose comes out.
 */

import type { Effect, Pose } from './art.js'

/**
 * How often the mascot steps while animating. The shared clock ticks every
 * 16 ms, so this lands on every 8th tick (128 ms), every other frame of the
 * spinner's own 50 ms animation.
 */
export const FRAME_MS = 120

/** A reaction to a tool stays up at least this many frames, so a quick read still shows. */
export const MIN_ACT_FRAMES = 12
/** Thinking holds the pose at least this long, so short thoughts don't flicker. */
export const MIN_THINK_FRAMES = 8
export const BONK_FRAMES = 14
export const DONE_FRAMES = 14
/** Context use where the τ starts to feel heavy, and where he can carry it no further. */
export const HEAVY_CONTEXT = 0.8
export const KNEEL_CONTEXT = 0.95
/** Below this much room to walk, he stays put. */
export const MIN_ROOM = 4
const RUN_SPEED = 2

export type Activity = 'edit' | 'run' | 'read' | 'think'

export type MascotSignals = {
  /** Tau is working and its spinner is up. */
  working: boolean
  /** A dialog is waiting for the person. */
  waiting: boolean
  /** The model is thinking. */
  thinking: boolean
  /** What the running tools look like, if anything. */
  activity: Activity | undefined
  /** The latest failed tool call; a new value means a new failure. */
  failureKey: string | undefined
  /** Context in use, 0 to 1 of the point where it compacts. */
  context: number
}

export type MascotState = {
  /** Left edge on the track, in columns. */
  x: number
  facing: 1 | -1
  /** Gait counter: advances only while he moves. */
  step: number
  /** Frames since the band started animating, for flicker and blinks. */
  frame: number
  act: { kind: Activity; frame: number } | undefined
  bonk: number | undefined
  /** Frames spent thinking, 0 when not. */
  think: number
  /** Frames into the end-of-turn celebration. */
  done: number | undefined
  /** The failure already reacted to, so each one is reacted to once. */
  seenFailure: string | undefined
}

export function initialMascotState(
  seenFailure: string | undefined,
): MascotState {
  return {
    x: 0,
    facing: 1,
    step: 0,
    frame: 0,
    act: undefined,
    bonk: undefined,
    think: 0,
    done: undefined,
    seenFailure,
  }
}

/** Keeps him on a track whose free room is `room` columns. */
export function placeOnTrack(state: MascotState, room: number): MascotState {
  const max = Math.max(0, room)
  if (state.x >= 0 && state.x <= max) return state
  return { ...state, x: Math.min(Math.max(state.x, 0), max) }
}

/** The turn ended: reactions are dropped, and a clean finish is celebrated. */
export function endTurn(state: MascotState, celebrate: boolean): MascotState {
  return {
    ...state,
    act: undefined,
    bonk: undefined,
    think: 0,
    done: celebrate ? 0 : undefined,
  }
}

/** One frame on. `room` is how far he can walk: the track less his width. */
export function advance(
  state: MascotState,
  signals: MascotSignals,
  room: number,
): MascotState {
  const next: MascotState = { ...state, frame: state.frame + 1 }

  if (
    signals.failureKey !== undefined &&
    signals.failureKey !== state.seenFailure
  ) {
    next.seenFailure = signals.failureKey
    if (signals.working && next.done === undefined) {
      // The failed tool's reaction ends with it; a tool still running picks
      // its reaction up again once he recovers.
      next.bonk = 0
      next.act = undefined
      return placeOnTrack(next, room)
    }
  }

  if (next.done !== undefined) {
    next.done += 1
    if (next.done >= DONE_FRAMES) next.done = undefined
    return placeOnTrack(next, room)
  }

  if (next.bonk !== undefined) {
    next.bonk += 1
    if (next.bonk >= BONK_FRAMES) next.bonk = undefined
    return placeOnTrack(next, room)
  }

  if (signals.activity !== undefined) {
    next.act =
      state.act?.kind === signals.activity
        ? { kind: signals.activity, frame: state.act.frame + 1 }
        : { kind: signals.activity, frame: 0 }
  } else if (state.act) {
    next.act =
      state.act.frame + 1 < MIN_ACT_FRAMES
        ? { ...state.act, frame: state.act.frame + 1 }
        : undefined
  }

  if (signals.thinking) next.think = state.think + 1
  else if (state.think > 0 && state.think < MIN_THINK_FRAMES)
    next.think = state.think + 1
  else next.think = 0

  const running = next.act?.kind === 'run'
  const moving =
    (next.act === undefined || running) &&
    next.think === 0 &&
    signals.context < KNEEL_CONTEXT
  if (!moving) return placeOnTrack(next, room)

  if (room < MIN_ROOM) {
    // No room to walk: stand, or run on the spot.
    return { ...next, x: 0, step: running ? next.step + 1 : next.step }
  }

  const speed = running
    ? RUN_SPEED
    : signals.context >= HEAVY_CONTEXT
      ? next.frame % 2
      : 1
  if (speed === 0) return placeOnTrack(next, room)
  let x = next.x + next.facing * speed
  let facing = next.facing
  if (x <= 0) {
    x = 0
    facing = 1
  } else if (x >= room) {
    x = room
    facing = -1
  }
  return { ...next, x, facing, step: next.step + 1 }
}

const POSE: Pose = {
  dy: 0,
  dx: 0,
  legs: 'together',
  eyes: 'open',
  arm: 'hold',
  tau: 'palm',
  tauDx: 0,
  tauDy: 0,
  glow: false,
  effects: [],
}

function pose(over: Partial<Pose>): Pose {
  return { ...POSE, ...over }
}

const KNEEL_POSE: Pose = pose({
  dy: 2,
  legs: 'knees',
  arm: 'low',
  tauDy: 1,
  eyes: 'joy',
})

/**
 * The pose to draw. `animated` is false when the band is still: between
 * turns, while a dialog waits, or with reduced motion.
 */
export function poseFor(
  state: MascotState,
  signals: MascotSignals,
  animated: boolean,
): Pose {
  if (!animated) {
    if (signals.waiting) return pose({ eyes: 'down' })
    if (signals.context >= KNEEL_CONTEXT) return KNEEL_POSE
    return POSE
  }

  if (state.done !== undefined) {
    const d = state.done
    const lines: Effect[] = [d % 4 < 2 ? 'lines' : 'lines2']
    if (d < 2) return pose({ dy: 1, eyes: 'joy' })
    if (d < 6) return pose({ dy: -1, eyes: 'joy', effects: lines })
    if (d < 8) return pose({ dy: 1, eyes: 'joy', effects: lines })
    return pose({ eyes: 'joy', effects: lines })
  }

  if (state.bonk !== undefined) {
    const b = state.bonk
    const stars = (['stars0', 'stars1', 'stars2'] as const)[b % 3]!
    return pose({
      dx: b < 6 ? (b % 2 === 0 ? 1 : -1) : 0,
      eyes: 'joy',
      arm: 'low',
      tauDy: 1,
      effects: b < BONK_FRAMES - 2 ? [stars] : [],
    })
  }

  const act = state.act
  if (act?.kind === 'edit') {
    const phase = act.frame % 4
    if (phase < 2) {
      return pose({ arm: 'raise', tau: 'raised', effects: ['anvil'] })
    }
    return pose({
      arm: 'reach',
      tau: 'hammer',
      eyes: 'joy',
      effects: ['anvil', phase === 2 ? 'sparks' : 'sparks2'],
    })
  }
  if (act?.kind === 'run') {
    const odd = state.step % 2 === 1
    return pose({
      dy: 1,
      legs: odd ? 'strideB' : 'strideA',
      eyes: 'right',
      tauDx: -1,
      effects: [odd ? 'speed2' : 'speed'],
    })
  }
  if (act?.kind === 'read') {
    const lookingLeft = Math.floor(act.frame / 6) % 2 === 0
    return pose({
      glow: true,
      eyes: lookingLeft ? 'left' : 'right',
      effects: act.frame % 4 < 2 ? ['rays'] : [],
    })
  }
  if (act?.kind === 'think' || state.think > 0) {
    return pose({
      eyes: 'joy',
      effects: [state.frame % 4 < 2 ? 'lines' : 'lines2'],
    })
  }

  if (signals.context >= KNEEL_CONTEXT) {
    return {
      ...KNEEL_POSE,
      effects: state.frame % 6 < 3 ? ['sweat'] : [],
    }
  }

  const heavy = signals.context >= HEAVY_CONTEXT
  const phase = state.step % 4
  const stride = phase === 1 || phase === 3
  const blinking = state.frame % 40 >= 38
  return pose({
    dy: stride ? 1 : 0,
    legs: phase === 1 ? 'strideA' : phase === 3 ? 'strideB' : 'together',
    eyes: blinking ? 'blink' : heavy && stride ? 'joy' : 'open',
    tauDx: heavy ? (phase === 1 ? 1 : phase === 3 ? -1 : 0) : 0,
  })
}

// --- Signals from the transcript ---------------------------------------------

type BlockLike = {
  type: string
  id?: string
  name?: string
  text?: string
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

/** The parts of a transcript message the mascot reads. */
export type MessageLike = {
  type: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  message?: { content?: string | readonly BlockLike[] }
}

// How far back each scan looks: the answers are always near the end.
const TOOL_SCAN = 40
const FAILURE_SCAN = 40
const END_SCAN = 30

const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'ApplyPatch',
  'apply_patch',
  'replace',
  'write_file',
  'edit_file',
  'edit_block',
  'str_replace',
])
const RUN_TOOLS = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'PowerShell',
  'Pty',
  'Eval',
  'REPL',
  'TaskOutput',
  'Monitor',
  'PackageManager',
  'shell',
  'run_shell_command',
  'execute_command',
])
const READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'Browser',
  'WebBrowser',
  'InspectSite',
  'CodebaseRetrieval',
  'GitHistorySearch',
  'RepoContextScout',
  'NativeGitSummary',
  'FileDiff',
  'ToolSearch',
  'ToolOutputRetrieve',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'read_file',
  'list_directory',
  'glob',
  'grep_search',
  'search_file_content',
  'search_files',
  'search_code',
  'search_text',
  'find_files',
  'web_fetch',
  'web_search',
  'google_web_search',
])
const DELEGATE_TOOLS = new Set(['Agent', 'Task', 'SendMessage', 'Workflow'])

const MCP_READ = /(^|_)(read|get|list|search|find|fetch|view|query|show|lookup|describe)/
const MCP_WRITE = /(^|_)(create|update|write|send|push|merge|delete|add|edit|set|post|insert|upload|commit|remove)/

function activityOfTool(name: string): Activity | undefined {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (RUN_TOOLS.has(name)) return 'run'
  if (READ_TOOLS.has(name)) return 'read'
  if (DELEGATE_TOOLS.has(name)) return 'think'
  if (name.startsWith('mcp__')) {
    const action = name.slice(name.lastIndexOf('__') + 2).toLowerCase()
    if (MCP_READ.test(action)) return 'read'
    if (MCP_WRITE.test(action)) return 'edit'
    return 'run'
  }
  return undefined
}

const ACTIVITY_RANK: Record<Activity, number> = {
  edit: 4,
  run: 3,
  read: 2,
  think: 1,
}

/** The activity to show for the tools running now: the most hands-on one wins. */
export function activityForTools(
  names: readonly string[],
): Activity | undefined {
  let best: Activity | undefined
  for (const name of names) {
    const activity = activityOfTool(name)
    if (activity && (!best || ACTIVITY_RANK[activity] > ACTIVITY_RANK[best])) {
      best = activity
    }
  }
  return best
}

/** Names of the tool calls in `ids`, found in the latest assistant messages. */
export function toolNamesInProgress(
  messages: readonly MessageLike[],
  ids: ReadonlySet<string>,
): string[] {
  if (ids.size === 0) return []
  const names: string[] = []
  const stop = Math.max(0, messages.length - TOOL_SCAN)
  for (let i = messages.length - 1; i >= stop && names.length < ids.size; i--) {
    const message = messages[i]!
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        ids.has(block.id)
      ) {
        names.push(block.name)
      }
    }
  }
  return names
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as BlockLike).type === 'text' &&
        typeof (part as BlockLike).text === 'string'
      ) {
        return (part as BlockLike).text!
      }
    }
  }
  return ''
}

/**
 * The id of the latest tool call that failed, skipping results the person
 * chose (a rejected permission, an interrupt): those are not failures.
 */
export function latestFailureKey(
  messages: readonly MessageLike[],
  isPersonsChoice: (resultText: string) => boolean,
): string | undefined {
  const stop = Math.max(0, messages.length - FAILURE_SCAN)
  for (let i = messages.length - 1; i >= stop; i--) {
    const message = messages[i]!
    if (message.type !== 'user') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]!
      if (
        block.type !== 'tool_result' ||
        block.is_error !== true ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue
      }
      if (isPersonsChoice(resultText(block.content))) continue
      return block.tool_use_id
    }
  }
  return undefined
}

/**
 * Whether the turn that just ended finished with an answer, rather than an
 * API error or an interrupt.
 */
export function endedCleanly(messages: readonly MessageLike[]): boolean {
  const stop = Math.max(0, messages.length - END_SCAN)
  for (let i = messages.length - 1; i >= stop; i--) {
    const message = messages[i]!
    if (message.type === 'assistant') {
      if (message.isApiErrorMessage) return false
      const content = message.message?.content
      if (typeof content === 'string') return content.trim().length > 0
      if (!Array.isArray(content)) return false
      return content.some(
        block =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim().length > 0,
      )
    }
    if (message.type === 'user' && !message.isMeta) return false
  }
  return false
}
