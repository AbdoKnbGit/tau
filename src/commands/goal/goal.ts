import type { ToolUseContext } from '../../Tool.js'
import { buildGoalStartInstruction } from '../../services/goal/instructions.js'
import {
  createGoalState,
  parseGoalArgs,
  pauseGoal,
  resumeGoal,
} from '../../services/goal/state.js'
import { getGoal, setGoal } from '../../services/goal/store.js'
import type { GoalState } from '../../services/goal/types.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

const CLEAR_ALIASES = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
])

/** One line describing how this goal decides it is done. */
function completionLine(goal: GoalState): string {
  if (goal.checkCommand) return `Check: ${goal.checkCommand}`
  return goal.judge
    ? 'Completion: self-reported, verified by a model judge'
    : 'Completion: self-reported (marker or turn limit)'
}

function formatStatus(goal: GoalState | null): string {
  if (!goal) {
    return 'No goal set. Usage: /goal <description> [--judge] [--check <command>]'
  }
  const lines = [
    `Goal: ${goal.description}`,
    completionLine(goal),
    `Status: ${goal.status}`,
    `Turns: ${goal.turnCount}/${goal.maxTurns}`,
  ]
  if (goal.status === 'paused' && goal.pausedReason) {
    lines.push(`Paused: ${goal.pausedReason}`)
  }
  return lines.join('\n')
}

export const call = async (
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> => {
  const raw = (args ?? '').trim()
  const action = raw.toLowerCase()
  const currentGoal = getGoal()

  if (!raw || action === 'status') {
    onDone(formatStatus(currentGoal), { display: 'system' })
    return null
  }

  if (CLEAR_ALIASES.has(action)) {
    setGoal(null)
    onDone('Goal cleared.', { display: 'system' })
    return null
  }

  if (action === 'pause') {
    if (!currentGoal || currentGoal.status !== 'active') {
      onDone('No active goal to pause.', { display: 'system' })
      return null
    }
    setGoal(pauseGoal(currentGoal))
    onDone('Goal paused.', { display: 'system' })
    return null
  }

  if (action === 'resume') {
    if (!currentGoal || currentGoal.status !== 'paused') {
      onDone('No paused goal to resume.', { display: 'system' })
      return null
    }
    const resumed = resumeGoal(currentGoal)
    setGoal(resumed)
    onDone('Goal resumed.', {
      display: 'system',
      shouldQuery: true,
      metaMessages: [buildGoalStartInstruction(resumed)],
    })
    return null
  }

  const parsed = parseGoalArgs(raw)
  if (!parsed.ok) {
    onDone(parsed.error, { display: 'system' })
    return null
  }

  const goal = createGoalState(
    parsed.description,
    parsed.checkCommand,
    parsed.judge,
  )
  setGoal(goal)
  onDone(`Goal set: ${goal.description}\n${completionLine(goal)}`, {
    display: 'system',
    shouldQuery: true,
    metaMessages: [buildGoalStartInstruction(goal)],
  })
  return null
}
