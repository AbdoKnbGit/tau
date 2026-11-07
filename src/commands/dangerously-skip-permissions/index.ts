import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'

export default {
  type: 'local-jsx',
  name: 'dangerously-skip-permissions',
  aliases: ['bypass-permissions', 'skip-permissions'],
  description: `Toggle ${permissionModeTitle('bypassPermissions').toLowerCase()} for this session`,
  argumentHint: '[on|off|status]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./dangerously-skip-permissions.js'),
} satisfies Command
