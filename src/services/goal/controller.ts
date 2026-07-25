import { getOriginalCwd } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { runGoalCheck } from './check.js'
import {
  buildGoalContinuationInstruction,
  detectGoalSignal,
} from './instructions.js'
import { runGoalJudge } from './judge.js'
import {
  achieveGoal,
  nowIso,
  pauseGoal,
  recordFailedCheck,
  recordRejectedClaim,
} from './state.js'
import { getGoal, setGoal } from './store.js'
import type { GoalState } from './types.js'

export type GoalTurnDecision =
  | { kind: 'inactive' }
  | { kind: 'achieved'; systemText: string }
  | { kind: 'paused'; systemText: string }
  | { kind: 'continue'; systemText: string; continuationText: string }

export type GoalTerminalMessage = {
  uuid: string
  // Concatenated assistant text of the terminal message (self-report scan).
  text: string
}

function continueOrPauseAtLimit(evaluated: GoalState): GoalTurnDecision {
  if (evaluated.turnCount >= evaluated.maxTurns) {
    const paused = pauseGoal(
      evaluated,
      `reached the maximum of ${evaluated.maxTurns} turns without completing "${evaluated.description}". Resume with /goal resume.`,
      nowIso(),
    )
    setGoal(paused)
    return { kind: 'paused', systemText: `Goal paused: ${paused.pausedReason}` }
  }
  setGoal(evaluated)
  return {
    kind: 'continue',
    systemText: `Goal not complete (turn ${evaluated.turnCount}/${evaluated.maxTurns}); continuing.`,
    continuationText: buildGoalContinuationInstruction(evaluated),
  }
}

/**
 * Post-turn goal evaluation, called from the query loop where the main thread
 * would otherwise stop. Two modes:
 *  - check command present  → run it; exit 0 = achieved (objective, zero judge).
 *  - no check command       → scan the model's closing line for a completion
 *                             marker (self-report), turn limit as the backstop.
 *
 * The goal lives in the module singleton (store.ts), not app state, so decisions
 * made here survive back to the `/goal` command. Every early-return is a strict
 * no-op for the caller.
 */
export async function evaluateGoalTurn(
  toolUseContext: ToolUseContext,
  terminal: GoalTerminalMessage | undefined,
): Promise<GoalTurnDecision> {
  if (toolUseContext.agentId) return { kind: 'inactive' }

  const goal = getGoal()
  if (!goal || goal.status !== 'active') return { kind: 'inactive' }
  if (!terminal?.uuid) return { kind: 'inactive' }
  if (goal.lastCheckedUuid === terminal.uuid) return { kind: 'inactive' }
  if (toolUseContext.abortController.signal.aborted) return { kind: 'inactive' }

  // --- Self-report mode (no check command) ---
  if (!goal.checkCommand) {
    const signal = detectGoalSignal(terminal.text)
    if (signal === 'complete') {
      // The judge runs on the CLAIM, not on every turn: one fork per completion
      // marker, which for a well-behaved loop is exactly one for the whole goal.
      let unverified = false
      if (goal.judge) {
        const verdict = await runGoalJudge(goal, toolUseContext)

        // The verdict is a model call — re-check abort, same as after the check
        // command below.
        if (toolUseContext.abortController.signal.aborted) {
          return { kind: 'inactive' }
        }

        if (verdict && !verdict.passed) {
          logForDebugging(
            `Goal claim rejected by judge: ${verdict.feedback ?? '(no feedback)'}`,
          )
          const evaluated = recordRejectedClaim(
            goal,
            terminal.uuid,
            verdict.feedback,
          )
          return continueOrPauseAtLimit(evaluated)
        }
        // Null verdict (unavailable, unparseable, aborted fork) falls through
        // to the claim. Fail-open: a broken verifier degrades to plain
        // self-report rather than trapping the loop — but say so, because a
        // verification that silently did not happen is worse than one that
        // visibly did not.
        unverified = verdict === null
      }
      const achieved = achieveGoal(goal, terminal.uuid)
      setGoal(achieved)
      logForDebugging(`Goal achieved (self-reported): ${goal.description}`)
      return {
        kind: 'achieved',
        systemText: unverified
          ? `Goal achieved: ${goal.description} (self-reported; verifier unavailable, claim not checked)`
          : `Goal achieved: ${goal.description}`,
      }
    }
    if (signal === 'blocked') {
      const paused = pauseGoal(goal, 'the agent reported it is blocked and needs a decision.')
      setGoal(paused)
      return { kind: 'paused', systemText: `Goal paused: ${paused.pausedReason}` }
    }
    const evaluated = recordFailedCheck(goal, terminal.uuid, '')
    return continueOrPauseAtLimit(evaluated)
  }

  // --- Objective mode (check command) ---
  let result
  try {
    result = await runGoalCheck(goal.checkCommand, getOriginalCwd())
  } catch (error) {
    const paused = pauseGoal(
      goal,
      `check command errored: ${error instanceof Error ? error.message : String(error)}`,
    )
    setGoal(paused)
    return { kind: 'paused', systemText: `Goal paused: ${paused.pausedReason}` }
  }

  // The check may have taken a while — re-check abort before continuing.
  if (toolUseContext.abortController.signal.aborted) return { kind: 'inactive' }

  if (result.passed) {
    const achieved = achieveGoal(goal, terminal.uuid)
    setGoal(achieved)
    logForDebugging(`Goal achieved: ${goal.checkCommand} exited 0`)
    return { kind: 'achieved', systemText: `Goal achieved: ${goal.description}` }
  }

  if (result.timedOut) {
    const paused = pauseGoal(
      goal,
      `check command timed out (${goal.checkCommand}). Resume with /goal resume once it can complete.`,
    )
    setGoal(paused)
    return { kind: 'paused', systemText: `Goal paused: ${paused.pausedReason}` }
  }

  const evaluated = recordFailedCheck(goal, terminal.uuid, result.output)
  return continueOrPauseAtLimit(evaluated)
}
