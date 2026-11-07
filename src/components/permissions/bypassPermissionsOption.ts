import {
  type PermissionMode,
  permissionModeTitle,
} from '../../utils/permissions/PermissionMode.js'
import { isBypassPermissionsModeDisabled } from '../../utils/permissions/permissionSetup.js'

export type BypassPermissionsOption = {
  label: string
  description: string
  disabled: boolean
}

/**
 * The "bypass permissions for this session" choice that every tool permission
 * prompt offers (Bash, PowerShell, file edits, and the generic prompt). Built
 * in one place so the wording comes from the mode's own title and each prompt
 * promises what enableBypassPermissionsFromPrompt actually does in that mode.
 *
 * `sessionMode` is the session's mode, not the asking agent's: in plan mode
 * the plan stays on, so the option says file edits wait for its approval.
 */
export function getBypassPermissionsOption(
  sessionMode: PermissionMode | undefined,
): BypassPermissionsOption {
  const disabled = isBypassPermissionsModeDisabled()
  const label = `Yes, and ${permissionModeTitle('bypassPermissions').toLowerCase()} for this session`
  if (disabled) {
    return { label, description: 'Disabled by settings or policy.', disabled }
  }
  // Prompts show the description inline after the label, so both stay as
  // short as the option they replaced or the row wraps at narrower widths.
  return {
    label,
    description:
      sessionMode === 'plan'
        ? 'Tau stops asking; edits wait for plan approval.'
        : 'Tau will stop asking before running tools.',
    disabled,
  }
}
