import { randomBytes } from 'node:crypto'
import type { AnthropicContentBlock, AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import type { LaneProviderCallParams, NormalizedUsage } from '../types.js'
import { openCodeRouteFor } from './opencode_anthropic_route.js'
import { filterToSingleShell } from './single_shell.js'

export function isOpencodeAnonymousModelId(id: string): boolean {
  const normalized = id.toLowerCase()
  return normalized.endsWith('-free')
    || normalized === 'big-pickle'
    || normalized === 'gpt-5-nano'
    || normalized === 'gpt-5.4-nano'
}

const sessions = new Map<string | undefined, string>()

/** Match opencode-dev's SessionID.descending(), keeping affinity across turns. */
function sessionFor(id?: string): string {
  if (id && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)) return id
  const existing = sessions.get(id)
  if (existing) return existing
  const time = BigInt.asUintN(48, ~(BigInt(Date.now()) * 0x1000n + 1n))
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const suffix = Array.from(randomBytes(14), byte => chars[byte % 62]).join('')
  const session = `ses_${time.toString(16).padStart(12, '0')}${suffix}`
  sessions.set(id, session)
  return session
}

// Only rename tools the caller actually supplied. Schemas, arguments and
// permissions stay with their original implementations; never add dummy tools.
const TOOL_NAMES: Readonly<Record<string, string>> = {
  Bash: 'bash', execute_command: 'bash',
  Read: 'read', read_file: 'read',
  Glob: 'glob', find_files: 'glob',
  Grep: 'grep', search_text: 'grep',
  Edit: 'edit', str_replace: 'edit', edit_file: 'edit', edit_block: 'edit',
  Write: 'write', write_file: 'write',
}

/** Wire compatibility for Zen free rows only; the caller checks the provider. */
export async function* streamOpenCodeZen(
  params: LaneProviderCallParams,
  send: (params: LaneProviderCallParams) => AsyncGenerator<AnthropicStreamEvent, NormalizedUsage>,
): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
  // Preserve the chat route's shell selection before Bash becomes `bash`.
  const tools = openCodeRouteFor('opencode', params.model) === 'chat'
    ? filterToSingleShell(params.tools) : params.tools
  const used = new Set(tools.map(tool => tool.name))
  const names = new Map<string, string>()
  const originals = new Map<string, string>()
  for (const tool of tools) {
    if (!Object.hasOwn(TOOL_NAMES, tool.name)) continue
    const name = TOOL_NAMES[tool.name]
    if (!name || used.has(name)) continue
    names.set(tool.name, name)
    originals.set(name, tool.name)
    used.add(name)
  }
  const restore = (block: AnthropicContentBlock): AnthropicContentBlock =>
    block.type === 'tool_use' && block.name && originals.has(block.name)
      ? { ...block, name: originals.get(block.name)! } : block
  const stream = send({
    ...params,
    sessionId: sessionFor(params.sessionId),
    // Preserve non-enumerable deferred-loading and advisory-input metadata.
    tools: tools.map(tool => names.has(tool.name) ? Object.create(Object.getPrototypeOf(tool), {
      ...Object.getOwnPropertyDescriptors(tool),
      name: { value: names.get(tool.name)!, enumerable: true, configurable: true, writable: true },
    }) : tool),
    messages: params.messages.map(message => renameHistory(message, names)),
  })
  const emittedCalls = new Set<string>()
  const duplicateBlocks = new Set<number>()
  try {
    while (true) {
      const next = await stream.next()
      if (next.done) return next.value
      const event = next.value
      // Some gateways repeat output_item.done. The route decoder can then
      // emit another complete block for the same call; never execute it twice.
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.content_block.id) {
        if (emittedCalls.has(event.content_block.id)) {
          if (event.index !== undefined) duplicateBlocks.add(event.index)
          continue
        }
        emittedCalls.add(event.content_block.id)
      }
      if (event.index !== undefined && duplicateBlocks.has(event.index)) {
        if (event.type === 'content_block_stop') duplicateBlocks.delete(event.index)
        continue
      }
      yield {
        ...event,
        ...(event.content_block && { content_block: restore(event.content_block) }),
        ...(event.message && { message: { ...event.message, content: event.message.content.map(restore) } }),
      }
    }
  } finally {
    // Forward early consumer cancellation to the underlying HTTP stream.
    await stream.return(undefined as never)
  }
}

// ToolSearch references and compaction metadata participate in lazy loading.
// Translate those alongside tool calls, without touching tool argument values.
function renameHistory<T>(value: T, names: ReadonlyMap<string, string>): T {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const name = record.type === 'tool_use' ? record.name : undefined
  const reference = record.type === 'tool_reference' ? record.tool_name : undefined
  const metadata = record.type === 'system' && record.subtype === 'compact_boundary'
    ? record.compactMetadata as { preCompactDiscoveredTools?: unknown } | undefined : undefined
  const discovered = metadata?.preCompactDiscoveredTools
  if (!Array.isArray(record.content) && !names.has(String(name)) && !names.has(String(reference)) && !Array.isArray(discovered)) return value
  return {
    ...record,
    ...(typeof name === 'string' && names.has(name) && { name: names.get(name) }),
    ...(typeof reference === 'string' && names.has(reference) && { tool_name: names.get(reference) }),
    ...(Array.isArray(record.content) && { content: record.content.map(block => renameHistory(block, names)) }),
    ...(Array.isArray(discovered) && { compactMetadata: {
      ...metadata,
      preCompactDiscoveredTools: discovered.map(name => typeof name === 'string' ? names.get(name) ?? name : name),
    } }),
  } as T
}
