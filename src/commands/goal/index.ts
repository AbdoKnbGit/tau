import type { Command } from '../../commands.js'

const goal = {
  type: 'local-jsx',
  name: 'goal',
  description:
    'Set a goal that auto-continues until a check command passes or a judge accepts it',
  argumentHint:
    '<description> [--judge] [--check <command>] | status | pause | resume | clear',
  load: () => import('./goal.js'),
} satisfies Command

export default goal
