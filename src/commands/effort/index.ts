import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  argumentHint: '[none|low|medium|high|xhigh|max|auto]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
