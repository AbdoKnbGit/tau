import React from 'react'
import { describeAutoCompaction } from '../../services/compact/autoCompact.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  setConfiguredThresholdPercent,
  setConfiguredWindowCap,
} from '../../utils/compactionConfig.js'
import { formatTokenCount } from '../../utils/compactionSettings.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { CompactSettings } from './CompactSettings.js'

const HELP_ARGS = ['help', '-h', '--help']

const USAGE = `Usage: /compact-settings [status|reset]

Controls when automatic compaction runs. Both settings are expressed
relative to the active model's real context window, so one choice behaves
sensibly whether you are on a 200K model or a 1M one.

  Compact at    How full the usable window gets before older history is
                summarized. Lower means cheaper turns and more frequent
                summaries; "auto" compacts as late as is safely possible.

  Context cap   An absolute ceiling on context carried, applied as
                min(model window, cap). Bounds what a single turn can cost
                on a large-window model; inert on smaller models.

  status        Print what the current settings resolve to.
  reset         Restore both to auto.`

/** One-line summary of what the saved configuration means for this model. */
function describeCurrent(): string {
  const model = getMainLoopModel()
  const state = describeAutoCompaction(model)
  const lines = [
    `Model: ${model} · ${formatTokenCount(state.contextWindow)} context window`,
    `Compacts at: ${state.threshold.toLocaleString()} tokens (${state.thresholdShareOfWindow.toFixed(0)}% of the window)`,
    `Headroom left: ${state.headroomTokens.toLocaleString()} tokens, of which ${state.reservedTokens.toLocaleString()} is reserved for the summary itself`,
    `Threshold source: ${
      state.source === 'env-percent'
        ? 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (environment)'
        : state.source === 'percent'
          ? 'configured percentage'
          : 'auto'
    }`,
  ]
  if (state.windowCap !== undefined) {
    lines.push(
      `Context cap: ${formatTokenCount(state.windowCap)}${state.envOverridesCap ? ' (CLAUDE_CODE_AUTO_COMPACT_WINDOW)' : ''}${
        state.windowCap >= state.contextWindow
          ? ' — no effect, this model is already smaller'
          : ''
      }`,
    )
  } else {
    lines.push("Context cap: none — uses the model's full window")
  }
  if (state.clampedByReserve) {
    lines.push(
      'Note: the requested percentage was capped by the reserve compaction needs to run.',
    )
  }
  return lines.join('\n')
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const arg = args?.trim().toLowerCase() ?? ''

  if (HELP_ARGS.includes(arg)) {
    onDone(USAGE)
    return
  }

  if (arg === 'status' || arg === 'current') {
    onDone(describeCurrent())
    return
  }

  if (arg === 'reset' || arg === 'auto') {
    setConfiguredThresholdPercent(undefined)
    setConfiguredWindowCap(undefined)
    onDone(`Compaction settings reset to auto.\n\n${describeCurrent()}`)
    return
  }

  if (arg) {
    onDone(`Unrecognized argument: ${arg}\n\n${USAGE}`)
    return
  }

  return <CompactSettings onDone={onDone} />
}
