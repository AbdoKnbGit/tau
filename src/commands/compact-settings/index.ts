import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'compact-settings',
  description: 'Configure when automatic compaction runs',
  load: () => import('./compact-settings.js'),
} satisfies Command
