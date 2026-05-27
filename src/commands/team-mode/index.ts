import type { Command } from '../../commands.js'
import {
  hasConfiguredTeamModeRoster,
  isTeamModeEnabled,
} from '../../utils/teamMode/state.js'

export default {
  type: 'local-jsx',
  name: 'team-mode',
  get description() {
    if (!hasConfiguredTeamModeRoster()) {
      return 'Configure a multi-provider team roster for auto-orchestration'
    }
    return isTeamModeEnabled()
      ? 'Team mode auto-orchestration is on'
      : 'Team mode auto-orchestration is off'
  },
  argumentHint: '[on|off|status|config|test|reset|fallback|help]',
  isEnabled: () => true,
  load: () => import('./team-mode.js'),
} satisfies Command
