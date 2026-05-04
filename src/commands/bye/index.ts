import type { Command } from '../../commands.js'
import { isHeyModeFeatureOn } from '../../voice/heyModeEnabled.js'

const bye = {
  type: 'local',
  name: 'bye',
  description: 'Disable hey voice conversation mode',
  isEnabled: () => isHeyModeFeatureOn(),
  isHidden: false,
  supportsNonInteractive: false,
  load: () => import('./bye.js'),
} satisfies Command

export default bye
