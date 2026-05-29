import * as React from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { HELP_TEXT, isLearnedAction, type LearnedAction } from './prompts.js'

type WizardProps = {
  onDone: LocalJSXCommandOnDone
}

const ACTION_RUNNING_MSG: Record<LearnedAction, string> = {
  view: 'Showing what Tau has learned…',
  learn: 'Reviewing this session for lessons…',
  edit: 'Opening a lesson to edit…',
  delete: 'Choosing a lesson to delete…',
}

/** Hand an action off to the hidden /learned-run engine. */
function runAction(onDone: LocalJSXCommandOnDone, action: LearnedAction): void {
  onDone(ACTION_RUNNING_MSG[action], {
    display: 'system',
    submitNextInput: true,
    nextInput: `/learned-run ${action}`,
  })
}

/**
 * Flip selfLearningEnabled in user settings. `force` pins a value (on/off);
 * omit it to toggle the current state.
 */
function applyToggle(onDone: LocalJSXCommandOnDone, force?: boolean): void {
  const enabled = getInitialSettings().selfLearningEnabled === true
  const next = force === undefined ? !enabled : force
  if (next === enabled) {
    onDone(`Self-learning is already ${enabled ? 'ON' : 'OFF'}.`, {
      display: 'system',
    })
    return
  }
  const result = updateSettingsForSource('userSettings', {
    selfLearningEnabled: next,
  })
  if (result.error) {
    onDone(`Failed to update self-learning: ${result.error.message}`, {
      display: 'system',
    })
    return
  }
  onDone(`Self-learning turned ${next ? 'ON' : 'OFF'} — takes effect next session.`, {
    display: 'system',
  })
}

function LearnedMenu({ onDone }: WizardProps): React.ReactNode {
  const enabled = getInitialSettings().selfLearningEnabled === true

  useKeybinding(
    'confirm:no',
    () => onDone('Closed /learned', { display: 'system' }),
    { context: 'Settings' },
  )

  const options = [
    {
      value: 'view',
      label: "What I've learned",
      description: 'Show every saved + staged lesson',
    },
    {
      value: 'learn',
      label: 'Learn from this session',
      description: 'Capture lessons from this conversation',
    },
    {
      value: 'edit',
      label: 'Edit a lesson',
      description: 'Reword a saved lesson',
    },
    {
      value: 'delete',
      label: 'Delete a lesson',
      description: "Remove a lesson that isn't worth keeping",
    },
    {
      value: 'toggle',
      label: enabled ? 'Turn self-learning OFF' : 'Turn self-learning ON',
      description: enabled
        ? 'Stop offering to save a lesson after big tasks'
        : 'Offer to save a lesson after big tasks',
    },
    { value: 'cancel', label: 'Cancel', description: 'Close the menu' },
  ]

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>/learned — what should I do?</Text>
      <Text dimColor>Self-learning is currently {enabled ? 'ON' : 'OFF'}.</Text>
      <Select
        options={options}
        onChange={value => {
          if (value === 'cancel') {
            onDone('Closed /learned', { display: 'system' })
            return
          }
          if (value === 'toggle') {
            applyToggle(onDone)
            return
          }
          if (isLearnedAction(value)) {
            runAction(onDone, value)
          }
        }}
        onCancel={() => onDone('Closed /learned', { display: 'system' })}
        visibleOptionCount={options.length}
      />
      <Text dimColor>↑/↓ to navigate · Enter to pick · Esc to cancel</Text>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = (args ?? '').trim().toLowerCase()

  if (trimmed === 'help' || trimmed === '-h' || trimmed === '--help') {
    onDone(HELP_TEXT, { display: 'system' })
    return null
  }

  // Direct invocation (power user / scripted): skip the menu.
  if (trimmed === 'toggle') {
    applyToggle(onDone)
    return null
  }
  if (trimmed === 'on' || trimmed === 'off') {
    applyToggle(onDone, trimmed === 'on')
    return null
  }
  if (isLearnedAction(trimmed)) {
    runAction(onDone, trimmed)
    return null
  }

  return <LearnedMenu onDone={onDone} />
}
