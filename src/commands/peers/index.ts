import type { Command } from '../../commands.js'

/**
 * /peers: tasks between Tau sessions on this machine (services/peers).
 * `/peers on` lets this session take tasks from a session started with
 * tau --orchestrate, `/peers off` stops it, and `/peers` lists the sessions
 * that take tasks.
 */
const peers = {
  type: 'local',
  name: 'peers',
  description: 'Take tasks from an orchestrator session, or list the sessions that do',
  argumentHint: '[on|off]',
  supportsNonInteractive: false,
  load: () => import('./peers.js'),
} satisfies Command

export default peers
