import type { Message } from '../types/message.js'

/**
 * Check if an object is a tool_reference block.
 * tool_reference is a beta feature not in the SDK types, so we need runtime checks.
 */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_reference'
  )
}

/**
 * Type guard for tool_reference block with tool_name.
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: 'tool_reference'; tool_name: string } {
  return (
    isToolReferenceBlock(obj) &&
    'tool_name' in (obj as object) &&
    typeof (obj as { tool_name: unknown }).tool_name === 'string'
  )
}

type ToolResultBlock = {
  type: 'tool_result'
  content: unknown[]
}

function isToolResultBlockWithContent(obj: unknown): obj is ToolResultBlock {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_result' &&
    'content' in obj &&
    Array.isArray((obj as { content: unknown }).content)
  )
}

export type DiscoveredToolScan = {
  names: Set<string>
  carriedFromBoundary: number
}

/**
 * Extract tool names from tool_reference and tool_use blocks in message history.
 *
 * When dynamic tool loading is enabled, MCP tools are not predeclared in the
 * tools array. Instead, they are discovered via ToolSearchTool which returns
 * tool_reference blocks. Models can also sometimes directly call a deferred
 * tool by name before seeing its schema. That call may fail validation, but
 * the assistant tool_use is still strong evidence that the tool must be loaded
 * on the next retry. This scan reads both forms.
 */
export function scanDiscoveredToolNames(messages: Message[]): DiscoveredToolScan {
  const names = new Set<string>()
  let carriedFromBoundary = 0

  for (const msg of messages) {
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const carried = msg.compactMetadata?.preCompactDiscoveredTools
      if (carried) {
        for (const name of carried) names.add(name)
        carriedFromBoundary += carried.length
      }
      continue
    }

    if (msg.type === 'assistant') {
      const content = msg.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (
          block.type === 'tool_use' &&
          typeof block.name === 'string' &&
          block.name.length > 0
        ) {
          names.add(block.name)
        }
      }
      continue
    }

    if (msg.type !== 'user') continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isToolResultBlockWithContent(block)) continue
      for (const item of block.content) {
        if (isToolReferenceWithName(item)) names.add(item.tool_name)
      }
    }
  }

  return { names, carriedFromBoundary }
}

export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  return scanDiscoveredToolNames(messages).names
}

/**
 * Extract only concrete ToolSearch evidence accepted by Anthropic's server-
 * native discovery protocol.
 *
 * A direct assistant tool_use is not a schema load on that transport. It must
 * therefore never satisfy the execution guard, even though client-native
 * lanes intentionally treat the same direct call as a signal to append the
 * schema on their next request. Compact-boundary summaries are also excluded:
 * once the reference-bearing message is gone, the server no longer has the
 * reference in context and the safe action is to select the tool again.
 */
export function extractToolReferenceNames(messages: Message[]): Set<string> {
  const names = new Set<string>()

  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isToolResultBlockWithContent(block)) continue
      for (const item of block.content) {
        if (isToolReferenceWithName(item)) names.add(item.tool_name)
      }
    }
  }

  return names
}
