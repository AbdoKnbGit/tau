import { logEvent } from '../services/analytics/index.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import { LIST_MCP_RESOURCES_TOOL_NAME } from '../tools/ListMcpResourcesTool/prompt.js'
import type { Message } from '../types/message.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

export type McpInstructionsDelta = {
  /** Server names — for stateless-scan reconstruction. */
  addedNames: string[]
  /** Rendered "## {name}\n{instructions}" blocks for addedNames. */
  addedBlocks: string[]
  /**
   * The addedNames announced earlier with different text (a server that
   * reconnected with new instructions). Their block replaces the earlier one.
   */
  updatedNames?: string[]
  removedNames: string[]
}

/**
 * Client-authored instruction block to announce when a server connects,
 * in addition to (or instead of) the server's own `InitializeResult.instructions`.
 * Lets first-party servers (e.g., claude-in-chrome) carry client-side
 * context the server itself doesn't know about.
 */
export type ClientSideInstruction = {
  serverName: string
  block: string
}

/**
 * True → MCP server instructions reach the model as reminders in the
 * conversation: query.ts announces them before each request, from the same
 * server state that request's tools come from, appended to the newest message
 * so nothing already sent changes. False → prompts.ts keeps its per-turn
 * system-prompt section, which rewrites the cached prefix when a server
 * connects late and never reaches the lanes that freeze that section.
 *
 * On by default. CLAUDE_CODE_MCP_INSTR_DELTA=0 turns it off (=1 forces it on).
 * CLAUDE_CODE_DISABLE_ATTACHMENTS also turns it off: no reminder is sent then,
 * so the system-prompt section is the only way the instructions arrive.
 */
export function isMcpInstructionsDeltaEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return false
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS)
}

/**
 * The servers whose instructions belong with a request that carries `tools`:
 * connected servers the request can use (one of their tools is in it, or it
 * carries the MCP resource tools and the server has resources), plus servers
 * that are reconnecting, which keep what they already announced until the
 * reconnect settles. Every other server counts as gone for this request.
 */
export function mcpServersForTools(
  mcpClients: readonly MCPServerConnection[],
  tools: ReadonlyArray<{ name: string; mcpInfo?: { serverName: string } }>,
): MCPServerConnection[] {
  const offered = new Set<string>()
  let resourceTools = false
  for (const tool of tools) {
    if (tool.mcpInfo) offered.add(tool.mcpInfo.serverName)
    else if (
      tool.name === LIST_MCP_RESOURCES_TOOL_NAME ||
      tool.name === 'ReadMcpResourceTool'
    ) resourceTools = true
  }
  return mcpClients.filter(
    c =>
      c.type === 'pending' ||
      (c.type === 'connected' &&
        (offered.has(c.name) || (resourceTools && !!c.capabilities?.resources))),
  )
}

/**
 * Diff the servers that have instructions (server-authored via
 * InitializeResult, or client-side synthesized) against what this
 * conversation has already been told. Null if nothing changed.
 *
 * Compares the text, not only the name: a server that reconnects between two
 * scans can come back with different instructions, or none, and nothing else
 * would tell the model. A server that is reconnecting ('pending') keeps its
 * announcement; one that is gone, or connected without instructions, has its
 * earlier instructions retracted.
 */
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  // Name → the block the model was last shown for that server.
  const announced = new Map<string, string>()
  let attachmentCount = 0
  let midCount = 0
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    if (msg.attachment.type !== 'mcp_instructions_delta') continue
    midCount++
    const { addedNames, addedBlocks, removedNames } = msg.attachment
    addedNames.forEach((n, i) => announced.set(n, addedBlocks[i] ?? ''))
    for (const n of removedNames) announced.delete(n)
  }

  const connected = mcpClients.filter(
    (c): c is ConnectedMCPServer => c.type === 'connected',
  )
  const connectedNames = new Set(connected.map(c => c.name))
  const reconnecting = new Set(
    mcpClients.filter(c => c.type === 'pending').map(c => c.name),
  )

  // Servers with instructions to announce (either channel). A server can
  // have both: server-authored instructions + a client-side block appended.
  const blocks = new Map<string, string>()
  for (const c of connected) {
    if (c.instructions) blocks.set(c.name, `## ${c.name}\n${c.instructions}`)
  }
  for (const ci of clientSideInstructions) {
    if (!connectedNames.has(ci.serverName)) continue
    const existing = blocks.get(ci.serverName)
    blocks.set(
      ci.serverName,
      existing
        ? `${existing}\n\n${ci.block}`
        : `## ${ci.serverName}\n${ci.block}`,
    )
  }

  const added: Array<{ name: string; block: string }> = []
  const updated: string[] = []
  for (const [name, block] of blocks) {
    const previous = announced.get(name)
    if (previous === block) continue
    added.push({ name, block })
    if (previous !== undefined) updated.push(name)
  }

  const removed: string[] = []
  for (const n of announced.keys()) {
    if (!blocks.has(n) && !reconnecting.has(n)) removed.push(n)
  }

  if (added.length === 0 && removed.length === 0) return null

  // Same diagnostic fields as tengu_deferred_tools_pool_change — same
  // scan-fails-in-prod bug, same attachment persistence path.
  logEvent('tengu_mcp_instructions_pool_change', {
    addedCount: added.length,
    updatedCount: updated.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    clientSideCount: clientSideInstructions.length,
    messagesLength: messages.length,
    attachmentCount,
    midCount,
  })

  added.sort((a, b) => a.name.localeCompare(b.name))
  return {
    addedNames: added.map(a => a.name),
    addedBlocks: added.map(a => a.block),
    ...(updated.length > 0 && { updatedNames: updated.sort() }),
    removedNames: removed.sort(),
  }
}
