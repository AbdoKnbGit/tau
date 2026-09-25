import type { ProviderContentBlock, ProviderMessage } from '../../services/api/providers/base_provider.js'

/** Tool IDs are opaque provider values. The UI's compatibility wrapper must
 * never be replayed upstream. Keep both sides of each call/result pair mapped
 * together, without changing persisted internal IDs or tool arguments. */
export function openRouterToolIdMap(messages: ProviderMessage[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type !== 'tool_use' || !block.id) continue
      const original = block._openrouter_tool_call_id
      ids.set(block.id, typeof original === 'string' && original.length > 0 ? original : block.id)
    }
  }
  return ids
}

/** Older native transcripts saved only Tau's wrapped ID. Migrate an outbound
 * copy at the record boundary, where the native message ID establishes its
 * origin. New explicit metadata wins even if a provider ID itself starts with
 * the wrapper. Do not strip arbitrary IDs in ordinary provider messages. */
export function restoreOpenRouterToolIdMetadata<T extends ProviderContentBlock>(
  block: T,
  nativeMessageId: string | undefined,
): T {
  if (block.type !== 'tool_use' || block._openrouter_tool_call_id !== undefined) return block
  const prefix = 'toolu_compat_'
  if (!nativeMessageId?.startsWith('compat-') || !block.id?.startsWith(prefix) || block.id.length <= prefix.length) return block
  return { ...block, _openrouter_tool_call_id: block.id.slice(prefix.length) }
}
