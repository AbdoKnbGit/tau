import type { ProviderContentBlock } from '../../services/api/providers/base_provider.js'

/** Provider state, never a tool argument. Persist with the first tool in a
 * completed batch so it survives transcript save/resume and block splitting. */
export type OpenRouterReasoning = {
  reasoning?: string
  reasoning_details?: Record<string, unknown>[]
}

export class OpenRouterReasoningCollector {
  private text = ''
  private details: Record<string, unknown>[] | undefined

  accept(delta: Record<string, any>, complete = false): void {
    const text = delta.reasoning ?? delta.reasoning_content ?? delta.thinking
    if (typeof text === 'string') this.text += text
    if (!Array.isArray(delta.reasoning_details)) return
    this.details ??= []
    for (const value of delta.reasoning_details) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const detail = structuredClone(value) as Record<string, unknown>
      const previous = this.details.at(-1)
      const field = detail.type === 'reasoning.text' ? 'text'
        : detail.type === 'reasoning.summary' ? 'summary' : undefined
      // Only adjacent fragments of the same logical text block can combine.
      // Index alone is insufficient: different detail types can share it.
      // Full responses and opaque/encrypted entries retain their exact order.
      const sameBlock = previous && previous.type === detail.type &&
        ['id', 'index', 'format'].every(key => previous[key] == null || detail[key] == null || previous[key] === detail[key])
      if (!complete && field && sameBlock) {
        const joined = String(previous[field] ?? '') + String(detail[field] ?? '')
        Object.assign(previous, detail, { [field]: joined })
      } else this.details.push(detail)
    }
  }

  snapshot(): OpenRouterReasoning | undefined {
    if (!this.text && this.details === undefined) return undefined
    return {
      ...(this.text && { reasoning: this.text }),
      ...(this.details !== undefined && { reasoning_details: structuredClone(this.details) }),
    }
  }
}

/** Echo original provider state once on the assistant message, not once per
 * parallel tool. Old transcripts can still replay their plaintext thinking. */
export function openRouterReasoningForBlocks(blocks: ProviderContentBlock[]): OpenRouterReasoning {
  const saved = blocks.find(block => block.type === 'tool_use' && block._openrouter_reasoning)?._openrouter_reasoning
  if (saved) {
    if (saved.reasoning_details?.length) return { reasoning_details: structuredClone(saved.reasoning_details) }
    return structuredClone(saved)
  }
  const text = blocks.filter(block => block.type === 'thinking')
    .map(block => block.thinking ?? '').join('')
  return text ? { reasoning: text } : {}
}
