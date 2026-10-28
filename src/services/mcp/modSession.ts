import type { getMcpToolsCommandsAndResources } from './client.js'
import type { ScopedMcpServerConfig } from './types.js'
import type { MCPServerConnection, ServerResource } from './types.js'
import type { Tool } from '../../Tool.js'
import type { Command } from '../../commands.js'
import { commandBelongsToServer, filterToolsByServer } from './utils.js'
import { acknowledgeMcpPublication } from './readiness.js'

export type ModMcpUpdate = Parameters<
  Parameters<typeof getMcpToolsCommandsAndResources>[0]
>[0]
type Publisher = (
  update: ModMcpUpdate,
  isCurrent?: (retired?: boolean) => boolean,
) => void
const publishers = new Map<Publisher, boolean>()
let sessionOptions: {
  strict: boolean
  dynamic: Record<string, ScopedMcpServerConfig>
} = { strict: false, dynamic: {} }

/** Preserve launch restrictions even in session.start, before a tool context exists. */
export function setModMcpSessionOptions(options: typeof sessionOptions): void {
  sessionOptions = options
}
export function getModMcpSessionOptions() {
  return sessionOptions
}

/** Publish through the session's existing connection owner and its listeners. */
export function registerModMcpPublisher(
  publish: Publisher,
  deferred = false,
): () => void {
  publishers.set(publish, deferred)
  return () => {
    publishers.delete(publish)
  }
}
export function publishModMcpUpdate(
  update: ModMcpUpdate,
  isCurrent?: (retired?: boolean) => boolean,
): boolean {
  if (isCurrent && !isCurrent()) return true
  for (const [publish, deferred] of publishers) {
    publish(update, isCurrent)
    if (!deferred) acknowledgeMcpPublication(update.client.name)
  }
  return publishers.size > 0
}

type McpState = {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
}

/** Keep unchanged catalog positions: repeated connection requests must not reorder tools. */
export function applyModMcpUpdate<T extends McpState>(
  current: T,
  update: ModMcpUpdate,
): T {
  function replace<C extends { name: string }>(
    items: C[],
    incoming: C[] | undefined,
    owns: (item: C) => boolean,
  ): C[] {
    if (incoming === undefined) return items
    const replacements = new Map(incoming.map(item => [item.name, item]))
    const result = items.flatMap(item => {
      const replacement = replacements.get(item.name)
      if (!owns(item)) {
        // Shared resource tools have no single server owner. Keep one copy,
        // but never consume another server's explicitly owned replacement.
        if (replacement && !owns(replacement)) replacements.delete(item.name)
        return [item]
      }
      replacements.delete(item.name)
      return replacement ? [replacement] : []
    })
    return [...result, ...replacements.values()]
  }
  const name = update.client.name
  const ownTools = new Set(filterToolsByServer(current.tools, name))
  const terminal =
    update.client.type === 'failed' || update.client.type === 'disabled'
  const resources = update.resources ?? (terminal ? [] : undefined)
  const { [name]: _removed, ...remainingResources } = current.resources
  return {
    ...current,
    clients: replace(
      current.clients,
      [update.client],
      client => client.name === name,
    ),
    tools: replace(
      current.tools,
      update.tools ?? (terminal ? [] : undefined),
      tool =>
        tool.mcpInfo ? tool.mcpInfo.serverName === name : ownTools.has(tool),
    ),
    commands: replace(
      current.commands,
      update.commands ?? (terminal ? [] : undefined),
      command => commandBelongsToServer(command, name),
    ),
    resources:
      resources === undefined
        ? current.resources
        : resources.length
          ? { ...current.resources, [name]: resources }
          : remainingResources,
  }
}
