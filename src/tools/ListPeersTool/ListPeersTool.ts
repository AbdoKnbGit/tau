import { z } from 'zod/v4'
import { describeClosedSession, listClosedSessions } from '../../services/peers/open.js'
import { isOrchestrator, listPeerLines } from '../../services/peers/runtime.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION, LIST_PEERS_TOOL_NAME, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    closed: z
      .boolean()
      .optional()
      .describe('Also list recent closed sessions, which OpenPeer can reopen'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output = { peers: string[]; closed?: string[] }

export const ListPeersTool = buildTool({
  name: LIST_PEERS_TOOL_NAME,
  searchHint: 'list other Tau sessions that take tasks',
  maxResultSizeChars: 20_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  userFacingName() {
    return LIST_PEERS_TOOL_NAME
  },
  // The orchestrator role is fixed at startup, so this never flips mid-session.
  isEnabled() {
    return isOrchestrator()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call(input) {
    const peers = await listPeerLines()
    if (!input.closed) return { data: { peers } }
    const closed = (await listClosedSessions()).map(s => describeClosedSession(s))
    return { data: { peers, closed } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { peers, closed } = content as Output
    const lines = peers.length
      ? [...peers]
      : ['No other Tau session on this machine takes tasks. The user can run /peers on in the session they want to use.']
    if (closed) {
      lines.push(
        '',
        closed.length
          ? `Closed sessions (OpenPeer reopens one by id):\n${closed.join('\n')}`
          : 'No closed sessions found.',
      )
    }
    return { tool_use_id: toolUseID, type: 'tool_result', content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
