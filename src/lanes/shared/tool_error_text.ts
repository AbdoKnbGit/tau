/**
 * Mark failed tool results in their text, for lane wires that cannot flag them.
 *
 * Tau records a failed tool call as a tool_result with `is_error: true`. The
 * Anthropic wire carries that flag, and so do Kiro (`status: 'error'`) and
 * Cursor (`isError`). OpenAI-style tool messages, the Responses API's
 * function_call_output and Gemini's functionResponse have no such field, so
 * there the flag is dropped and an error thrown by a tool (a crashed PDF tool,
 * a missing file) reads like the tool's normal output. Validation errors
 * already arrive wrapped in `<tool_use_error>`; this gives thrown errors the
 * same wrapper, so a model on any wire can tell a failure from a result.
 *
 * Pure and deterministic: the same history always gives the same text, so the
 * serialized prefix and the prompt cache stay stable across turns. The stored
 * conversation is never changed, only the copy handed to the lane.
 */
import type {
  ProviderContentBlock,
  ProviderMessage,
} from '../../services/api/providers/base_provider.js'

const OPEN = '<tool_use_error>'
const CLOSE = '</tool_use_error>'

function markBlock(block: ProviderContentBlock): ProviderContentBlock {
  if (block.type !== 'tool_result' || block.is_error !== true) return block
  const { content } = block
  if (typeof content === 'string' || content === undefined) {
    const text = content ?? ''
    return text.includes(OPEN) ? block : { ...block, content: `${OPEN}${text}${CLOSE}` }
  }
  // Error results are text-only by construction (the Anthropic API rejects
  // anything else), but keep any other block where it is.
  const textIndexes = content.flatMap((b, i) => (b.type === 'text' ? [i] : []))
  if (textIndexes.some(i => content[i]!.text?.includes(OPEN))) return block
  if (textIndexes.length === 0) {
    return { ...block, content: [{ type: 'text', text: `${OPEN}${CLOSE}` }, ...content] }
  }
  const first = textIndexes[0]!
  const last = textIndexes[textIndexes.length - 1]!
  return {
    ...block,
    content: content.map((b, i) => {
      if (i !== first && i !== last) return b
      const text = `${i === first ? OPEN : ''}${b.text ?? ''}${i === last ? CLOSE : ''}`
      return { ...b, text }
    }),
  }
}

/**
 * The messages with every failed tool result's text wrapped in
 * `<tool_use_error>` (unless it already is). Returns the same array when
 * nothing needed marking.
 */
export function markFailedToolResults(
  messages: ProviderMessage[],
): ProviderMessage[] {
  let changed = false
  const out = messages.map(message => {
    if (typeof message.content === 'string') return message
    const content = message.content.map(markBlock)
    if (content.every((b, i) => b === message.content[i])) return message
    changed = true
    return { ...message, content }
  })
  return changed ? out : messages
}
