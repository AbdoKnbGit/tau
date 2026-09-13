import type { Command } from '../../commands.js'

const files = {
  type: 'local',
  name: 'files',
  description: 'List the files Tau currently counts as read',
  supportsNonInteractive: true,
  load: () => import('./files.js'),
} satisfies Command

export default files
