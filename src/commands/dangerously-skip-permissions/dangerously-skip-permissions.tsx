import chalk from 'chalk'
import * as React from 'react'
import {
  setSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import {
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from '../../utils/permissions/permissionSetup.js'
import { hasSkipDangerousModePermissionPrompt } from '../../utils/settings/settings.js'
import { getLeaderToolUseConfirmQueue } from '../../utils/swarm/leaderPermissionBridge.js'

type Action = 'on' | 'off' | 'status' | 'help'
type BypassCommandMode = 'default' | 'bypassPermissions'
type DialogChoice = 'cancel' | 'enable'

function parseAction(args: string, currentMode: PermissionMode): Action | null {
  switch (args) {
    case '':
      return currentMode === 'bypassPermissions' ? 'off' : 'on'
    case 'on':
    case 'enable':
    case 'enabled':
    case 'true':
    case '1':
      return 'on'
    case 'off':
    case 'disable':
    case 'disabled':
    case 'false':
    case '0':
      return 'off'
    case 'status':
      return 'status'
    case 'help':
    case '-h':
    case '--help':
    case '?':
      return 'help'
    default:
      return null
  }
}

function modeLabel(mode: PermissionMode): string {
  return mode === 'bypassPermissions'
    ? chalk.green('ON')
    : chalk.red('OFF')
}

function getStatusMessage(context: LocalJSXCommandContext): string {
  const { toolPermissionContext } = context.getAppState()

  if (isBypassPermissionsModeDisabled()) {
    return `Bypass Permissions mode: ${chalk.red('disabled by settings or policy')}`
  }

  const lines = [
    `Bypass Permissions mode: ${modeLabel(toolPermissionContext.mode)}`,
  ]

  if (
    toolPermissionContext.mode !== 'bypassPermissions' &&
    toolPermissionContext.isBypassPermissionsModeAvailable
  ) {
    lines.push(
      chalk.dim(
        'Available for this session. Use /dangerously-skip-permissions on to enter it.',
      ),
    )
  }

  return lines.join('\n')
}

function showHelp(onDone: LocalJSXCommandOnDone): void {
  onDone(
    [
      `${chalk.bold('/dangerously-skip-permissions')} - Toggle Bypass Permissions mode for this session`,
      '',
      chalk.bold('Usage:'),
      `  ${chalk.cyan('/dangerously-skip-permissions')}         Toggle on/off`,
      `  ${chalk.cyan('/dangerously-skip-permissions on')}      Enable after confirmation`,
      `  ${chalk.cyan('/dangerously-skip-permissions off')}     Return to Default mode`,
      `  ${chalk.cyan('/dangerously-skip-permissions status')}  Show current state`,
      '',
      chalk.dim('This does not change your saved default permission mode.'),
    ].join('\n'),
    { display: 'system' },
  )
}

function recheckQueuedToolPermissions(): void {
  setImmediate(() => {
    getLeaderToolUseConfirmQueue()?.(currentQueue => {
      currentQueue.forEach(item => {
        void item.recheckPermission()
      })
      return currentQueue
    })
  })
}

function setPermissionMode(
  context: LocalJSXCommandContext,
  mode: BypassCommandMode,
  options: {
    isBypassPermissionsModeAvailable?: boolean
  } = {},
): void {
  context.setAppState(prev => {
    const preparedContext = transitionPermissionMode(
      prev.toolPermissionContext.mode,
      mode,
      prev.toolPermissionContext,
    )

    const nextContext = applyPermissionUpdate(preparedContext, {
      type: 'setMode',
      mode,
      destination: 'session',
    })

    return {
      ...prev,
      toolPermissionContext: {
        ...nextContext,
        ...(options.isBypassPermissionsModeAvailable === undefined
          ? {}
          : {
              isBypassPermissionsModeAvailable:
                options.isBypassPermissionsModeAvailable,
            }),
      },
    }
  })

  recheckQueuedToolPermissions()
}

function enableBypassPermissions(context: LocalJSXCommandContext): string {
  if (isBypassPermissionsModeDisabled()) {
    setSessionBypassPermissionsMode(false)
    return `Bypass Permissions mode cannot be enabled because it is ${chalk.red(
      'disabled by settings or policy',
    )}.`
  }

  setSessionBypassPermissionsMode(true)
  setPermissionMode(context, 'bypassPermissions', {
    isBypassPermissionsModeAvailable: true,
  })
  logEvent('tengu_bypass_permissions_command_enabled', {})

  return [
    `Bypass Permissions mode: ${chalk.green('ON')}`,
    chalk.dim(
      'Session only. Use /dangerously-skip-permissions off to return to Default mode.',
    ),
  ].join('\n')
}

function disableBypassPermissions(context: LocalJSXCommandContext): string {
  const { toolPermissionContext } = context.getAppState()
  setSessionBypassPermissionsMode(false)

  if (toolPermissionContext.mode !== 'bypassPermissions') {
    return `Bypass Permissions mode: ${chalk.red('OFF')}`
  }

  setPermissionMode(context, 'default')
  logEvent('tengu_bypass_permissions_command_disabled', {})

  return `Bypass Permissions mode: ${chalk.red('OFF')} ${chalk.dim('(Default mode)')}`
}

function EnableBypassDialog({
  onAccept,
  onCancel,
}: {
  onAccept: () => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <Dialog
      title="Enable Bypass Permissions mode?"
      color="error"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          Tau will not ask for your approval before running potentially
          dangerous commands.
        </Text>
        <Text>
          Use this only in a sandboxed container or VM that can be restored if
          damaged. You accept responsibility for actions taken while this mode
          is on.
        </Text>
        <Select
          options={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Enable for this session', value: 'enable' },
          ]}
          onCancel={onCancel}
          onChange={(value: string) => {
            const choice = value as DialogChoice
            if (choice === 'enable') {
              onAccept()
            } else {
              onCancel()
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

function EnableBypassFlow({
  context,
  onDone,
  skipConfirmation,
}: {
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
  skipConfirmation: boolean
}): React.ReactNode {
  const [confirmed, setConfirmed] = React.useState(skipConfirmation)
  const hasFiredRef = React.useRef(false)
  const contextRef = React.useRef(context)
  const onDoneRef = React.useRef(onDone)

  contextRef.current = context
  onDoneRef.current = onDone

  React.useEffect(() => {
    if (!confirmed || hasFiredRef.current) return
    hasFiredRef.current = true
    onDoneRef.current(enableBypassPermissions(contextRef.current), {
      display: 'system',
    })
  }, [confirmed])

  if (!confirmed) {
    return (
      <EnableBypassDialog
        onAccept={() => setConfirmed(true)}
        onCancel={() => {
          logEvent('tengu_bypass_permissions_command_cancelled', {})
          onDone('Bypass Permissions mode unchanged.', { display: 'system' })
        }}
      />
    )
  }

  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode | null> {
  const trimmedArgs = (args ?? '').trim().toLowerCase()
  const currentMode = context.getAppState().toolPermissionContext.mode

  const action =
    COMMON_HELP_ARGS.includes(trimmedArgs) || trimmedArgs === '?'
      ? 'help'
      : COMMON_INFO_ARGS.includes(trimmedArgs)
        ? 'status'
        : parseAction(trimmedArgs, currentMode)

  if (!action) {
    onDone(
      `Unknown argument "${trimmedArgs}". Use ${chalk.cyan(
        '/dangerously-skip-permissions on',
      )}, ${chalk.cyan('/dangerously-skip-permissions off')}, or ${chalk.cyan(
        '/dangerously-skip-permissions status',
      )}.`,
      { display: 'system' },
    )
    return null
  }

  if (action === 'help') {
    showHelp(onDone)
    return null
  }

  if (action === 'status') {
    onDone(getStatusMessage(context), { display: 'system' })
    return null
  }

  if (action === 'off') {
    onDone(disableBypassPermissions(context), { display: 'system' })
    return null
  }

  return (
    <EnableBypassFlow
      context={context}
      onDone={onDone}
      skipConfirmation={hasSkipDangerousModePermissionPrompt()}
    />
  )
}
