import {
  isMascotEnabled,
  setMascotEnabled,
} from '../../components/TauMascot/enabled.js'
import { mascotHiddenReason } from '../../components/TauMascot/TauMascot.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

const ON = ['on', 'show', 'enable', 'true', '1']
const OFF = ['off', 'hide', 'disable', 'false', '0']

/**
 * Turns the mascot on or off. The answer is a transient notification, never
 * a transcript message: nothing about the mascot reaches the model.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const choice = args.trim().toLowerCase()
  let enable: boolean
  if (choice === '' || choice === 'toggle') enable = !isMascotEnabled()
  else if (ON.includes(choice)) enable = true
  else if (OFF.includes(choice)) enable = false
  else {
    tell(context, `There's no "${args.trim()}". Use /mascot, /mascot on or /mascot off.`)
    onDone(undefined, { display: 'skip' })
    return null
  }

  setMascotEnabled(enable)
  tell(
    context,
    enable
      ? `Mascot on: he walks above the prompt while Tau works.${caveat(context)} /mascot off hides him.`
      : 'Mascot off. /mascot brings him back.',
  )
  onDone(undefined, { display: 'skip' })
  return null
}

/** Why he may stay hidden or still here, so turning him on never looks broken. */
function caveat(context: ToolUseContext): string {
  const hidden = mascotHiddenReason(
    process.stdout.columns ?? 0,
    process.stdout.rows ?? 0,
  )
  if (hidden) return ` He stays hidden for now: ${hidden}.`
  if (context.getAppState().settings.prefersReducedMotion) {
    return ' Reduce motion is on, so he stands still.'
  }
  return ''
}

function tell(context: ToolUseContext, text: string): void {
  context.addNotification?.({
    key: 'mascot',
    text,
    priority: 'immediate',
    timeoutMs: 6000,
  })
}
