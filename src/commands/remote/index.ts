import type { Command } from '../../commands.js'

const remote = {
  type: 'local-jsx',
  name: 'remote',
  aliases: ['phone'],
  description: 'Continue this session from your phone — scan a QR to pair',
  argumentHint: '[local|global|status|off]',
  isSensitive: true,
  // Pairing must not wait for a stop point. The whole promise of /remote is
  // "step away without stopping the agent", so it runs immediately, mid-turn,
  // and never enters the prompt queue where it would sit behind the run.
  immediate: true,
  load: () => import('./remote.js'),
} satisfies Command

export default remote
