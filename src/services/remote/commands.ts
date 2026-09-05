/**
 * The slash-command catalogue the phone shows in its palette.
 *
 * Every command is listed, runnable or not. Hiding the blocked ones would be
 * dishonest — you would type `/model` on the phone, see nothing happen, and
 * have no idea why. Listing them with a reason is the difference between "this
 * remote is broken" and "that one needs the keyboard".
 *
 * Runnability mirrors isBridgeSafeCommand(), which is the predicate the
 * inbound queue actually enforces, so the palette can never promise something
 * the router will then refuse.
 */

import { getCommandName, type Command } from '../../types/command.js'

export type RemoteCommand = {
  name: string
  description: string
  argumentHint?: string
  runnable: boolean
  /** Why it can't run from a phone. Present only when runnable is false. */
  reason?: string
}

function reasonFor(cmd: Command): string | undefined {
  if (cmd.type === 'local-jsx') {
    return 'opens a terminal dialog'
  }
  if (cmd.type === 'local') {
    return 'not enabled for remote'
  }
  return undefined
}

/**
 * The runnable predicate is injected rather than imported. Reaching into
 * commands.ts for isBridgeSafeCommand would drag the entire command registry
 * — and through it the sandbox adapter — into this module's graph, for a
 * function whose whole job is shaping a list.
 */
export function listRemoteCommands(
  commands: readonly Command[],
  isRunnable: (cmd: Command) => boolean,
): RemoteCommand[] {
  const out: RemoteCommand[] = []
  for (const cmd of commands) {
    if (cmd.isHidden) continue
    let name: string
    try {
      name = getCommandName(cmd)
    } catch {
      continue
    }
    if (!name) continue

    // isEnabled() reads feature gates and config; a throw here must not take
    // down the snapshot that carries the whole transcript.
    try {
      if (cmd.isEnabled?.() === false) continue
    } catch {
      continue
    }

    const runnable = isRunnable(cmd)
    out.push({
      name,
      description: cmd.description ?? '',
      argumentHint: cmd.argumentHint,
      runnable,
      ...(runnable ? {} : { reason: reasonFor(cmd) }),
    })
  }
  return out.sort((a, b) => {
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
