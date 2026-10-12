import type { ProviderContentBlock } from '../../services/api/providers/base_provider.js'

/** Opaque provider state, persisted on assistant blocks for transcript resume. */
export type CodexReasoningState = {
  model: string
  items: Array<{
    id: string
    encrypted_content: string
    summary: Array<{ type: 'summary_text'; text: string }>
  }>
}

export function stripCodexReasoningFromBlock<T extends object>(block: T): T {
  if (!('_codex_reasoning' in block)) return block
  const { _codex_reasoning: _state, ...rest } = block
  return rest as T
}

/** Visible summaries are display-only. Replay opaque state once, in wire order. */
export function codexReasoningForBlocks(
  blocks: ProviderContentBlock[],
  model: string | undefined,
  seen: Set<string>,
): Array<{ type: 'reasoning'; encrypted_content: string; summary: [] }> {
  const items: Array<{ type: 'reasoning'; encrypted_content: string; summary: [] }> = []
  if (!model) return items
  for (const block of blocks) {
    const state = block._codex_reasoning
    if (state?.model !== model || !Array.isArray(state.items)) continue
    for (const item of state.items) {
      if (!item.id || typeof item.encrypted_content !== 'string' || !item.encrypted_content || seen.has(item.id)) continue
      seen.add(item.id)
      items.push({ type: 'reasoning', encrypted_content: item.encrypted_content, summary: [] })
    }
  }
  return items
}
