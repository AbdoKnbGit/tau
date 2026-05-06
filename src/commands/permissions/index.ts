import type { Command } from '../../commands.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools', 'permission', 'perms', 'permetion'],
  description: 'Manage allow & deny tool permission rules',
  load: () => import('./permissions.js'),
} satisfies Command

export default permissions
