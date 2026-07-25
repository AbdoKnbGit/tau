import { randomUUID } from 'crypto'

import type { GoalState } from './types.js'

export const DEFAULT_GOAL_MAX_TURNS = 15
export const MAX_GOAL_DESCRIPTION_CHARS = 2_000
export const MAX_GOAL_CHECK_CHARS = 2_000

export function nowIso(): string {
  return new Date().toISOString()
}

function stripQuotes(input: string): string {
  const trimmed = input.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export type ParsedGoalArgs =
  | { ok: true; description: string; checkCommand?: string; judge?: boolean }
  | { ok: false; error: string }

/**
 * Strips a standalone `--judge` flag from the description segment.
 *
 * Only the description segment is scanned: after `--check`, everything belongs
 * to the shell command, and a command may legitimately contain `--judge`
 * (`npm run lint -- --judge`). Callers must split on `--check` first.
 */
function takeJudgeFlag(segment: string): {
  rest: string
  judge: boolean
} {
  const marker = /(^|\s)--judge(?=\s|$)/.exec(segment)
  if (!marker) return { rest: segment, judge: false }
  const before = segment.slice(0, marker.index)
  const after = segment.slice(marker.index + marker[0].length)
  // Plain concatenation, no joining space: the match already consumed the
  // separator before the flag, so adding one back would leave a doubled space
  // in the middle of the description the user sees and the model reads.
  return { rest: before + after, judge: true }
}

/**
 * Parses `<description> [--judge] [--check <command>]`. Everything before
 * `--check` is the description; everything after is the command (the rest of the
 * string, so the command may itself contain spaces and flags). Both may be
 * quoted.
 *
 * `--check` is optional. When omitted the whole input is the description and the
 * goal runs in self-report mode. When present the command must be non-empty (a
 * bare `--check` is a typo, not a request for self-report mode).
 *
 * `--judge` adds model verification of the completion claim, and only means
 * something in self-report mode: with a check command the exit code already IS
 * the oracle, and a judge could only weaken it.
 */
export function parseGoalArgs(raw: string): ParsedGoalArgs {
  const marker = /(^|\s)--check(\s|=|$)/.exec(raw)

  if (!marker) {
    const { rest, judge } = takeJudgeFlag(raw)
    const description = stripQuotes(rest)
    if (!description) {
      return { ok: false, error: 'Goal description cannot be empty.' }
    }
    if (description.length > MAX_GOAL_DESCRIPTION_CHARS) {
      return {
        ok: false,
        error: `Goal description must be ${MAX_GOAL_DESCRIPTION_CHARS} characters or fewer.`,
      }
    }
    return judge ? { ok: true, description, judge } : { ok: true, description }
  }

  const splitAt = marker.index + marker[1].length
  const { rest, judge } = takeJudgeFlag(raw.slice(0, splitAt))
  const description = stripQuotes(rest)
  // '--check'.length skips the flag, +1 skips the following space or '='.
  const checkCommand = stripQuotes(raw.slice(splitAt + '--check'.length + 1))

  if (judge) {
    return {
      ok: false,
      error:
        '--judge and --check cannot be combined. The check command already decides completion; drop --check to have the goal verified by a model instead.',
    }
  }
  if (!description) {
    return { ok: false, error: 'Goal description cannot be empty.' }
  }
  if (description.length > MAX_GOAL_DESCRIPTION_CHARS) {
    return {
      ok: false,
      error: `Goal description must be ${MAX_GOAL_DESCRIPTION_CHARS} characters or fewer.`,
    }
  }
  if (!checkCommand) {
    return {
      ok: false,
      error:
        'Check command cannot be empty. Drop --check entirely to let the agent self-report completion.',
    }
  }
  if (checkCommand.length > MAX_GOAL_CHECK_CHARS) {
    return {
      ok: false,
      error: `Check command must be ${MAX_GOAL_CHECK_CHARS} characters or fewer.`,
    }
  }
  return { ok: true, description, checkCommand }
}

export function createGoalState(
  description: string,
  checkCommand: string | undefined,
  judge = false,
  now: string = nowIso(),
  maxTurns = DEFAULT_GOAL_MAX_TURNS,
): GoalState {
  const trimmedCheck = checkCommand?.trim()
  return {
    id: randomUUID(),
    description: description.trim(),
    checkCommand: trimmedCheck ? trimmedCheck : undefined,
    // A check command is the stronger oracle, so it wins outright — this keeps
    // a state built by a future caller that passes both from silently paying
    // for a judge that can never change the outcome.
    judge: judge && !trimmedCheck ? true : undefined,
    status: 'active',
    turnCount: 0,
    maxTurns,
    createdAt: now,
    updatedAt: now,
  }
}

export function pauseGoal(
  goal: GoalState,
  reason?: string,
  now: string = nowIso(),
): GoalState {
  if (goal.status !== 'active') return goal
  return {
    ...goal,
    status: 'paused',
    pausedAt: now,
    pausedReason: reason,
    updatedAt: now,
  }
}

export function resumeGoal(goal: GoalState, now: string = nowIso()): GoalState {
  if (goal.status !== 'paused') return goal
  return {
    ...goal,
    status: 'active',
    pausedAt: undefined,
    pausedReason: undefined,
    updatedAt: now,
    // Fresh budget on resume, and re-arm evaluation on the next turn.
    turnCount: 0,
    lastCheckedUuid: undefined,
    lastJudgeFeedback: undefined,
  }
}

export function achieveGoal(
  goal: GoalState,
  evaluatedUuid: string,
  now: string = nowIso(),
): GoalState {
  return {
    ...goal,
    status: 'achieved',
    achievedAt: now,
    updatedAt: now,
    turnCount: goal.turnCount + 1,
    lastCheckedUuid: evaluatedUuid,
  }
}

export function recordFailedCheck(
  goal: GoalState,
  evaluatedUuid: string,
  output: string,
  now: string = nowIso(),
): GoalState {
  return {
    ...goal,
    updatedAt: now,
    turnCount: goal.turnCount + 1,
    lastCheckedUuid: evaluatedUuid,
    lastCheckOutput: output,
    // Cleared, not carried: this turn made no completion claim, so a verdict
    // from an earlier turn would be stale guidance in the next nudge.
    lastJudgeFeedback: undefined,
  }
}

/**
 * The model said it was done and the judge disagreed. Same accounting as a
 * failed check (the turn is spent, the loop continues), but carries the
 * verdict's reason so the next nudge names the specific unmet requirement.
 */
export function recordRejectedClaim(
  goal: GoalState,
  evaluatedUuid: string,
  feedback: string | undefined,
  now: string = nowIso(),
): GoalState {
  return {
    ...goal,
    updatedAt: now,
    turnCount: goal.turnCount + 1,
    lastCheckedUuid: evaluatedUuid,
    lastJudgeFeedback: feedback,
  }
}
