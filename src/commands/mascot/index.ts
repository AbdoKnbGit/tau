/**
 * Mascot command - minimal metadata only.
 * Implementation is lazy-loaded from mascot.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const mascot = {
  type: 'local-jsx',
  name: 'mascot',
  description: "Show or hide Tau's mascot above the prompt",
  immediate: true,
  argumentHint: '[on|off]',
  load: () => import('./mascot.js'),
} satisfies Command

export default mascot
