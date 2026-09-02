import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs'

/**
 * Prefix on a tool_result whose arguments never matched the tool's schema.
 * Written by toolExecution.ts when Zod rejects the input and read back by the
 * display layer — keep both ends on this one constant.
 */
export const TOOL_INPUT_VALIDATION_ERROR_PREFIX = 'InputValidationError: '

/**
 * Did this tool_result come from schema validation rather than from the tool
 * itself? Such a call never ran: nothing was written, nothing was executed,
 * and the model gets the full error back and reissues the call. That makes it
 * a different thing from a real failure, and the UI renders it differently.
 *
 * Matches the wrapped form toolExecution.ts emits
 * (`<tool_use_error>InputValidationError: …</tool_use_error>`) and the bare
 * form, but only at the start of the message — a tool whose own output merely
 * quotes the phrase is a genuine failure and must keep its normal rendering.
 *
 * Deliberately a leaf module: the React error row imports this, and routing it
 * through toolErrors.ts would pull zod and the whole messages.ts graph into
 * the render path to test a string prefix.
 */
export function isToolInputValidationError(
  content: ToolResultBlockParam['content'],
): boolean {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(b => (b.type === 'text' ? b.text : '')).join('')
        : ''
  if (!text) return false
  const unwrapped =
    /<tool_use_error>([\s\S]*?)<\/tool_use_error>/.exec(text)?.[1] ?? text
  return unwrapped.trimStart().startsWith(TOOL_INPUT_VALIDATION_ERROR_PREFIX)
}
