import chalk from 'chalk'
import * as React from 'react'
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useSettings } from '../../hooks/useSettings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, NoSelect, Text, useTheme } from '../../ink.js'
import { ClockContext } from '../../ink/components/ClockContext.js'
import { useTerminalViewport } from '../../ink/hooks/use-terminal-viewport.js'
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import type { Message } from '../../types/message.js'
import {
  CANCEL_MESSAGE,
  getMessagesAfterCompactBoundary,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE,
} from '../../utils/messages.js'
import { getPowerModeThemeMode } from '../../utils/modeTheme.js'
import { resolveImageColorDepth } from '../../utils/terminalImage.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import type { SpinnerMode } from '../Spinner.js'
import {
  composeRows,
  MASCOT_ROWS,
  mascotPalette,
  type Run,
  SPRITE_W,
  spriteFor,
} from './art.js'
import { isMascotEnabled, subscribeMascotEnabled } from './enabled.js'
import {
  activityForTools,
  advance,
  endedCleanly,
  endTurn,
  FRAME_MS,
  initialMascotState,
  latestFailureKey,
  type MascotSignals,
  type MascotState,
  type MessageLike,
  placeOnTrack,
  poseFor,
  toolNamesInProgress,
} from './motion.js'

/** Below this size the band would crowd the transcript out; it stays hidden. */
export const MIN_MASCOT_COLUMNS = SPRITE_W + 12
export const MIN_MASCOT_ROWS = 24
/** On wide terminals he walks the first stretch, not a marathon. */
const MAX_TRACK = 120

let colorsAvailable: boolean | undefined

/**
 * Half blocks need real colors, 256 at least. NO_COLOR, FORCE_COLOR=0, CI
 * logs, dumb and 8-color consoles get no band rather than a smear: the same
 * rules inline images follow, minus their own on/off switch.
 */
function mascotColorsAvailable(): boolean {
  if (colorsAvailable === undefined) {
    const env = { ...process.env }
    delete env.TAU_INLINE_IMAGES
    colorsAvailable =
      chalk.level >= 2 && resolveImageColorDepth(env, true) !== 'none'
  }
  return colorsAvailable
}

/**
 * Why the band can't show in a terminal this size, or undefined when it
 * can. Shared with /mascot, so turning him on never looks broken.
 */
export function mascotHiddenReason(
  columns: number,
  rows: number,
): string | undefined {
  if (!mascotColorsAvailable()) {
    return 'this terminal has no 256-color output (or NO_COLOR is set)'
  }
  if (columns < MIN_MASCOT_COLUMNS || rows < MIN_MASCOT_ROWS) {
    return `he needs at least ${MIN_MASCOT_COLUMNS}x${MIN_MASCOT_ROWS} and this terminal is ${columns}x${rows}`
  }
  return undefined
}

type Props = {
  messages: readonly Message[]
  inProgressToolUseIDs: ReadonlySet<string>
  streamMode: SpinnerMode
  isLoading: boolean
  /** Whether the REPL shows its spinner (hidden while a dialog waits). */
  spinnerShown: boolean
  /** A dialog is waiting for the person. */
  waiting: boolean
}

/**
 * Tau's mascot, walking above the prompt: the block figure from the logo,
 * holding up the τ and reacting to what Tau is doing. Opt-in through /mascot
 * or /config.
 *
 * Purely visual. Nothing here reaches the model, the transcript or the
 * request, so it cannot touch prompt caching.
 */
export const TauMascot = React.memo(function TauMascot(
  props: Props,
): React.ReactNode {
  // Memoized: the REPL re-renders on every keystroke, and none of that
  // concerns him.
  const enabled = useSyncExternalStore(subscribeMascotEnabled, isMascotEnabled)
  return enabled ? <MascotBand {...props} /> : null
})

// Where he was, kept across remounts: dialogs and slash commands hide the
// band for a while, and he should come back where he stood.
let lastState: MascotState | undefined

// Tool results that record the person's own choice: a rejected permission,
// an interrupt. Those are not failures.
const PERSONS_CHOICE = [
  REJECT_MESSAGE,
  CANCEL_MESSAGE,
  SUBAGENT_REJECT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  INTERRUPT_MESSAGE,
  PLAN_REJECTION_PREFIX,
].map(text => text.slice(0, 40))

function isPersonsChoice(resultText: string): boolean {
  const text = resultText.trimStart()
  return PERSONS_CHOICE.some(prefix => text.startsWith(prefix))
}

/** Share of the context in use, 0 to 1 of the point where it compacts. */
function contextUsed(messages: readonly Message[], model: string): number {
  try {
    const tokens = tokenCountFromLastAPIResponse(
      getMessagesAfterCompactBoundary(messages as Message[]),
    )
    if (!(tokens > 0)) return 0
    const { percentLeft } = calculateTokenWarningState(tokens, model)
    return Math.min(1, Math.max(0, 1 - percentLeft / 100))
  } catch {
    return 0
  }
}

function toColor(rgb: number): string {
  return `rgb(${(rgb >> 16) & 0xff},${(rgb >> 8) & 0xff},${rgb & 0xff})`
}

function renderRun(run: Run, key: number): React.ReactNode {
  if (run.fg === undefined && run.bg === undefined) return run.text
  return (
    <Text
      key={key}
      color={run.fg === undefined ? undefined : toColor(run.fg)}
      backgroundColor={run.bg === undefined ? undefined : toColor(run.bg)}
    >
      {run.text}
    </Text>
  )
}

function MascotBand({
  messages,
  inProgressToolUseIDs,
  streamMode,
  isLoading,
  spinnerShown,
  waiting,
}: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [themeName] = useTheme()
  const reducedMotion = useSettings().prefersReducedMotion ?? false
  const model = useMainLoopModel()
  const clock = useContext(ClockContext)
  const [ref, , , isFullyVisibleNow] = useTerminalViewport()
  const [, setFrame] = useState(0)

  const fits = mascotHiddenReason(columns, rows) === undefined
  const track = Math.max(SPRITE_W, Math.min(MAX_TRACK, columns - 2))
  const room = track - SPRITE_W

  const toolNames = useMemo(
    () =>
      toolNamesInProgress(
        messages as readonly MessageLike[],
        inProgressToolUseIDs,
      ),
    [messages, inProgressToolUseIDs],
  )
  const failureKey = useMemo(
    () => latestFailureKey(messages as readonly MessageLike[], isPersonsChoice),
    [messages],
  )
  const context = useMemo(() => contextUsed(messages, model), [messages, model])

  const working = isLoading && spinnerShown
  const signals: MascotSignals = {
    working,
    waiting,
    thinking: streamMode === 'thinking',
    activity: working ? activityForTools(toolNames) : undefined,
    failureKey,
    context,
  }
  const signalsRef = useRef(signals)
  signalsRef.current = signals
  const roomRef = useRef(room)
  roomRef.current = room

  const stateRef = useRef<MascotState | null>(null)
  if (stateRef.current === null) {
    // Back where he stood, with nothing pending from before: failures that
    // happened while the band was hidden are not reacted to now.
    stateRef.current = placeOnTrack(
      lastState
        ? { ...endTurn(lastState, false), seenFailure: failureKey }
        : initialMascotState(failureKey),
      room,
    )
  }
  const current = stateRef.current

  // A turn just ended: drop the reactions, and celebrate a clean finish. A
  // new turn cuts a celebration short.
  const wasLoading = useRef(isLoading)
  useEffect(() => {
    const state = stateRef.current
    if (wasLoading.current && !isLoading && state) {
      const celebrate =
        !reducedMotion && endedCleanly(messages as readonly MessageLike[])
      stateRef.current = endTurn(state, celebrate)
      lastState = stateRef.current
      setFrame(n => n + 1)
    } else if (!wasLoading.current && isLoading && state?.done !== undefined) {
      stateRef.current = { ...state, done: undefined }
      lastState = stateRef.current
    }
    wasLoading.current = isLoading
    // Runs on the loading edge only; messages are read as of that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading])

  // Failures that show up while he isn't working (a resumed or cleared
  // session, a tool that failed as the turn ended) are noted, not reacted to.
  useEffect(() => {
    const state = stateRef.current
    if (!working && state && state.seenFailure !== failureKey) {
      stateRef.current = { ...state, seenFailure: failureKey }
      lastState = stateRef.current
    }
  }, [failureKey, working])

  const animated =
    fits && !reducedMotion && (working || current.done !== undefined)

  // Steps ride the shared animation clock, so the band pauses with the
  // spinner when the terminal loses focus and costs nothing between turns.
  useEffect(() => {
    if (!clock || !animated) return
    let last = clock.now()
    return clock.subscribe(() => {
      const now = clock.now()
      if (now - last < FRAME_MS) return
      last = now
      // Never change a row that may sit in scrollback: log-update can only
      // reach it with a full terminal reset.
      if (!isFullyVisibleNow() || !stateRef.current) return
      stateRef.current = advance(
        stateRef.current,
        signalsRef.current,
        roomRef.current,
      )
      lastState = stateRef.current
      setFrame(n => n + 1)
    }, true)
  }, [clock, animated, isFullyVisibleNow])

  // While part of the band sits in scrollback, show exactly what was there:
  // any other change would force a full reset. A resize resets anyway, so a
  // new width always redraws.
  const frozen = useRef<{ node: React.ReactNode; columns: number } | null>(
    null,
  )
  if (!fits) {
    frozen.current = null
    return null
  }
  if (
    frozen.current &&
    frozen.current.columns === columns &&
    !isFullyVisibleNow()
  ) {
    return frozen.current.node
  }

  const state = current
  const palette = mascotPalette(
    themeName === 'light' ? 'light' : 'dark',
    getPowerModeThemeMode(),
  )
  const sprite = spriteFor(poseFor(state, signals, animated), state.facing, palette)
  const lines = composeRows(sprite, Math.min(state.x, Math.max(0, room)), track)
  const node = (
    <NoSelect flexDirection="column" flexShrink={0}>
      <Box ref={ref} flexDirection="column" flexShrink={0} height={MASCOT_ROWS}>
        {lines.map((runs, row) => (
          <Text key={row} wrap="truncate">
            {runs.map(renderRun)}
          </Text>
        ))}
      </Box>
    </NoSelect>
  )
  frozen.current = { node, columns }
  return node
}
