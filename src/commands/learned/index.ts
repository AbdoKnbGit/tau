import type { Command } from '../../commands.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'

/**
 * /learned — the self-learning control hub, rendered as a native navigable
 * menu (CustomSelect), not an AskUserQuestion. The user arrows through the
 * list and picks; each choice either flips a setting locally or hands off to
 * the hidden /learned-run engine for the agent to do the work.
 */
const learned = {
  type: 'local-jsx',
  name: 'learned',
  description: 'Review and manage what Tau learns automatically',
  argumentHint: '[view|learn|edit|delete|toggle]',
  // Visible whenever auto-memory is on, so the user can also toggle
  // self-learning on/off from the menu.
  isEnabled: () => isAutoMemoryEnabled(),
  load: () => import('./learned.js'),
} satisfies Command

export default learned
