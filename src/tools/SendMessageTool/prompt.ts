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
Continue an agent you spawned with the Agent tool. Address it by the \`name\` you gave it, or by the \`agentId\` returned in its result:

\`\`\`json
{"to": "auth-refactor", "summary": "narrow the scope", "message": "Skip the config module — another agent owns it. Finish the token path only."}
\`\`\`

A **running** agent receives your message at its next tool round. A **finished or stopped** agent is resumed from its transcript with its full context intact, and you are notified when it completes again.

Prefer continuing an existing agent over spawning a fresh one for follow-up work: it already holds the context, and on providers that key their prompt cache per agent the resumed session reuses its warm prefix while a new spawn starts cold.`

  const teammateSection = swarms
    ? `

## Teammates

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates — expensive (linear in team size), use only when everyone genuinely needs it |

Messages from teammates are delivered automatically; you don't check an inbox. Refer to teammates by name, never by UUID. When relaying, don't quote the original — it's already rendered to the user.`
    : ''

  const udsSection = feature('UDS_INBOX')
    ? `

## Cross-session

Use \`ListPeers\` to discover targets, then:

\`\`\`json
{"to": "uds:/tmp/cc-socks/1234.sock", "message": "check if tests pass over there"}
{"to": "bridge:session_01AbCd...", "message": "what branch are you on?"}
\`\`\`

A listed peer is alive and will process your message — no "busy" state; messages enqueue and drain at the receiver's next tool round. Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.**`
    : ''

  const protocolSection = swarms
    ? `

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with the matching \`_response\` type — echo the \`request_id\`, set \`approve\` true/false:

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

Approving shutdown terminates your process. Rejecting plan sends the teammate back to revise. Don't originate \`shutdown_request\` unless asked. Don't send structured JSON status messages — use TaskUpdate.`
    : ''

  return `
# SendMessage

Your plain text output is NOT visible to other agents — to reach one, you MUST call this tool.
${subagentSection}${teammateSection}${udsSection}${protocolSection}
`.trim()
}
