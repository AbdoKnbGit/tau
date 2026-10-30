import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isClaudeInChromeAvailable } from '../../utils/claudeInChrome/common.js'

const command: Command = {
  name: 'chrome',
  description: 'Tau in Chrome (Beta) settings',
  availability: ['claude-ai'],
  isEnabled: () => isClaudeInChromeAvailable() && !getIsNonInteractiveSession(),
  type: 'local-jsx',
  load: () => import('./chrome.js'),
}

export default command
