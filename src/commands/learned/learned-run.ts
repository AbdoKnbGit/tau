import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { buildLearnedPrompt, HELP_TEXT } from './prompts.js'

/**
 * Internal engine for the /learned menu. The navigable /learned picker
 * (learned.tsx) hands off here with the chosen action; this injects the
 * matching agent instructions. Hidden from typeahead — users see /learned.
 */
const command = {
  type: 'prompt',
  name: 'learned-run',
  description: 'Internal engine for the /learned menu',
  argumentHint: '<view|learn|edit|delete>',
  contentLength: 0,
  progressMessage: 'working through learned lessons',
  source: 'builtin',
  isEnabled: () => isAutoMemoryEnabled(),
  // Hidden from typeahead — users see /learned (the menu). Power users who
  // know about /learned-run can still type it directly.
  isHidden: true,
  // The model should not invoke this on its own; only the menu or the user does.
  disableModelInvocation: true,
  async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
    const trimmed = (args ?? '').trim()
    if (!trimmed) {
      return [{ type: 'text', text: HELP_TEXT }]
    }
    return [{ type: 'text', text: buildLearnedPrompt(trimmed) }]
  },
} satisfies Command

export default command
