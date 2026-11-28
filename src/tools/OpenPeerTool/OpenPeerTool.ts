import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { openPeerSession } from '../../services/peers/open.js'
import { isOrchestrator } from '../../services/peers/runtime.js'
import { readPeerSettings } from '../../services/peers/settings.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { permissionModeWithSessionBypass } from '../../utils/permissions/bypassPermissionsMode.js'
import { DESCRIPTION, OPEN_PEER_TOOL_NAME, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z.string().describe('The task, written so it stands alone; say what done looks like'),
    session: z
      .string()
      .optional()
      .describe('Id of a closed session to reopen (ListPeers with closed: true lists them)'),
    folder: z
      .string()
      .optional()
      .describe('Absolute path of a folder for a new session, when not reopening one'),
    name: z.string().optional().describe('Name for a new session; defaults to the folder name'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output = { ok: boolean; message: string }

export const OpenPeerTool = buildTool({
  name: OPEN_PEER_TOOL_NAME,
  searchHint: 'open a Tau session in a new window and give it a task',
  maxResultSizeChars: 10_000,
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
    return OPEN_PEER_TOOL_NAME
  },
  // The orchestrator role is fixed at startup, so this never flips mid-session.
  isEnabled() {
    return isOrchestrator()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async validateInput(input, context) {
    const problem = context.agentId
      ? 'only the main session can open other Tau sessions'
      : !input.session?.trim() && !input.folder?.trim()
        ? 'give session (to reopen one) or folder (for a new one)'
        : !input.message.trim()
          ? 'message must not be empty'
          : null
    return problem ? { result: false, message: problem, errorCode: 9 } : { result: true }
  },
  // It starts a process the user will see, possibly in another project.
  async checkPermissions(input) {
    const what = input.session?.trim()
      ? `reopen session ${input.session.trim()}`
      : `open a new Tau session in ${input.folder?.trim()}`
    return { behavior: 'ask' as const, message: `Let the orchestrator ${what} in a new window and give it this task?` }
  },
  renderToolUseMessage(input) {
    return input.session ? `reopen ${input.session}` : `open ${input.folder ?? ''}`
  },
  async call(input, context) {
    const settings = readPeerSettings()
    const data = await openPeerSession(input, {
      sessionId: getSessionId(),
      permissionMode: permissionModeWithSessionBypass(context.getAppState().toolPermissionContext.mode),
      taskLimit: settings.taskLimit,
      replyLimit: settings.replyLimit,
      ...(settings.openCommand ? { openCommand: settings.openCommand } : {}),
    })
    return { data }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { ok, message } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: message,
      ...(ok ? {} : { is_error: true }),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
