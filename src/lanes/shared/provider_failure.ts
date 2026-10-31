import type {
  AnthropicContentBlock,
  AnthropicStreamEvent,
} from '../../services/api/providers/base_provider.js'

/**
 * The events for a failure a lane reports instead of a reply.
 *
 * The flag keeps it apart from the model's own text, so claude.ts can end the
 * turn as an API error: a script sees the failure in the exit code, and the
 * text never joins the conversation, where every later request would replay it
 * as the model's own words.
 */
export function providerFailureEvents(index: number, text: string): AnthropicStreamEvent[] {
  return [
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '', _tau_provider_failure: true },
    },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ]
}

export function isProviderFailureBlock(
  block: unknown,
): block is AnthropicContentBlock & { text: string } {
  return (block as AnthropicContentBlock | null)?._tau_provider_failure === true
    && typeof (block as AnthropicContentBlock).text === 'string'
}
