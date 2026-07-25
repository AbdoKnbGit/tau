import type { GoalState } from './types.js'

// Self-report markers. Used only when the goal has no check command: the model
// signals completion by emitting one of these on its own line. Chosen to be
// unlikely to appear incidentally in prose or code.
export const GOAL_COMPLETE_MARKER = '<<<GOAL_COMPLETE>>>'
export const GOAL_BLOCKED_MARKER = '<<<GOAL_BLOCKED>>>'

/**
 * Self-report detection. Only the LAST non-empty line is inspected, so a marker
 * the model merely mentions mid-reasoning does not count — only one it emits as
 * its closing line does.
 */
export function detectGoalSignal(text: string): 'complete' | 'blocked' | null {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  if (last.includes(GOAL_COMPLETE_MARKER)) return 'complete'
  if (last.includes(GOAL_BLOCKED_MARKER)) return 'blocked'
  return null
}

// Start instruction injected as a hidden (isMeta) message when the goal is set.
// It is APPENDED to the conversation — never rewrites history — so the prompt
// cache prefix is preserved.
export function buildGoalStartInstruction(goal: GoalState): string {
  const head = [
    'A session goal has been set.',
    '',
    `Goal: ${goal.description}`,
  ]
  const body = goal.checkCommand
    ? [
        `Completion is verified automatically by running: ${goal.checkCommand}`,
        '',
        'Work directly toward making that check command pass. Use tools as needed.',
      ]
    : [
        'There is no automatic check for this goal.',
        `When the goal is fully complete, end your message with a line containing exactly: ${GOAL_COMPLETE_MARKER}`,
        `If you are blocked and need a decision from the user, end with a line containing: ${GOAL_BLOCKED_MARKER}`,
        ...(goal.judge
          ? [
              '',
              'Your completion claim will be checked by a separate verifier that',
              'reads this whole conversation and judges it against the goal.',
              'Claiming completion early does not end the loop, it just costs a',
              'turn: verify your own work before emitting the marker.',
            ]
          : []),
        '',
        'Work directly toward the goal. Use tools as needed. Only emit the',
        'completion marker once the goal is genuinely done, not before.',
      ]
  const tail = [
    'Do not stop just because a turn ended: keep going until the goal is done,',
    'or until you are genuinely blocked and need a decision from the user.',
  ]
  return [...head, ...body, '', ...tail].join('\n')
}

// Continuation nudge appended after a turn where the goal was not yet complete.
// For check mode it includes the tail of the failing check output.
export function buildGoalContinuationInstruction(goal: GoalState): string {
  const lines = ['The goal is not complete yet.', '', `Goal: ${goal.description}`]

  if (goal.checkCommand) {
    lines.push(`Check command (still failing): ${goal.checkCommand}`)
    if (goal.lastCheckOutput) {
      lines.push('', 'Latest check output:', goal.lastCheckOutput, '')
    }
  } else {
    if (goal.lastJudgeFeedback) {
      // Lead with the rejection: it is the most actionable thing in the nudge,
      // and it tells the model its own completion claim was overruled.
      lines.push(
        '',
        'You reported completion and the verifier rejected it.',
        `Verifier feedback: ${goal.lastJudgeFeedback}`,
        '',
        'Address that specific point before claiming completion again.',
      )
    }
    lines.push(
      `Emit ${GOAL_COMPLETE_MARKER} on its own line only when fully done,`,
      `or ${GOAL_BLOCKED_MARKER} if you need a user decision.`,
    )
  }

  lines.push(
    `Turn ${goal.turnCount} of ${goal.maxTurns}.`,
    'Continue directly toward the goal. Do not recap unless useful.',
  )
  return lines.join('\n')
}
