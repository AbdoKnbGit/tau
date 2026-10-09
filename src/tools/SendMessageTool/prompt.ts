import { feature } from 'bun:bundle'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

export const DESCRIPTION = 'Send a message to a running agent, or continue one you already spawned'

/**
 * Only document the recipient kinds this build can route to.
 *
 * Subagent continuation is always available. Teammate names, broadcast, and
 * the shutdown / plan-approval protocol exist only when swarms are enabled;
 * cross-session peers only when the UDS inbox is compiled in. Describing an
 * unreachable address costs cached prompt bytes on every session and teaches
 * the model a call that cannot succeed.
 */
export function getPrompt(): string {
  const swarms = isAgentSwarmsEnabled()

  const subagentSection = `
Continue an agent you spawned with the Agent tool by its given \`name\` or returned \`agentId\`:

\`\`\`json
{"to": "auth-refactor", "summary": "narrow the scope", "message": "Skip the config module — another agent owns it. Finish the token path only."}
\`\`\`

Running agents receive messages at their next tool round. Finished/stopped agents resume their full-context transcript and notify you on completion.

Prefer continuing an existing agent for follow-ups: it retains context and, on providers caching per agent, reuses its warm prefix; new spawns start cold.`

  const teammateSection = swarms
    ? `

## Teammates

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

Address teammates by name (never UUID). \`"*"\` broadcasts to all teammates: expensive (linear in team size), use only when everyone genuinely needs it.
Messages arrive automatically; do not check an inbox. When relaying, do not quote the original; it is already rendered to the user.`
    : ''

  const udsSection = feature('UDS_INBOX')
    ? `

## Cross-session

Discover targets with \`ListPeers\`, then:

\`\`\`json
{"to": "uds:/tmp/cc-socks/1234.sock", "message": "check if tests pass over there"}
{"to": "bridge:session_01AbCd...", "message": "what branch are you on?"}
\`\`\`

Listed peers are alive and process messages; no "busy" state: messages enqueue and drain at the receiver's next tool round. Messages arrive as \`<cross-session-message from="...">\`. **To reply, copy its \`from\` attribute as your \`to\`.**`
    : ''

  const protocolSection = swarms
    ? `

## Protocol responses (legacy)

For a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, use the matching \`_response\` type, echo \`request_id\`, set \`approve\` true/false:

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

Approving shutdown terminates your process; rejecting a plan sends the teammate back to revise. Do not originate \`shutdown_request\` unless asked. Use TaskUpdate, not structured JSON status messages.`
    : ''

  return `
# SendMessage

Your plain text output is NOT visible to other agents — to reach one, you MUST call this tool.
${subagentSection}${teammateSection}${udsSection}${protocolSection}
`.trim()
}
