import type { OpenAIMessage } from '../adapters/anthropic_to_openai.js'
import type { ProviderMessage } from './base_provider.js'

/** Attach required tool-call reasoning without regrouping the existing prompt. */
export function preserveToolCallReasoning(
  messages: readonly OpenAIMessage[],
  history: readonly ProviderMessage[],
): OpenAIMessage[] {
  const reasoningByCall = new Map<string, string>()
  let pending = ''
  for (const message of history) {
    if (message.role !== 'assistant') {
      pending = ''
      continue
    }
    if (!Array.isArray(message.content)) continue
    const thinking = message.content
      .filter(block => block.type === 'thinking')
      .map(block => block.thinking ?? '')
      .join('')
    pending += thinking
    const calls = message.content.filter(block => block.type === 'tool_use')
    for (const call of calls) {
      if (call.id) reasoningByCall.set(call.id, pending)
    }
    if (calls.length > 0) pending = ''
  }
  return messages.map(message => {
    if (message.role !== 'assistant' || !message.tool_calls?.length) return message
    // Old non-thinking or cross-provider turns still need the protocol field.
    const reasoning = message.tool_calls
      .map(call => reasoningByCall.get(call.id))
      .find(value => value !== undefined) ?? ''
    return { ...message, reasoning_content: reasoning }
  })
}
