import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID } from 'node:crypto'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { executePostToolBatchHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'

/** Collect model-visible results, including errors, in the requested call order. */
export function collectPostToolBatchCalls(
  toolUses: readonly ToolUseBlock[],
  messages: readonly Message[],
) {
  const results = new Map<string, ToolResultBlockParam>()
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type === 'tool_result') results.set(block.tool_use_id, block)
    }
  }
  return toolUses.flatMap(toolUse => {
    const result = results.get(toolUse.id)
    return result
      ? [{
          tool_name: toolUse.name,
          tool_input: toolUse.input,
          tool_use_id: toolUse.id,
          tool_response: result.content ?? '',
        }]
      : []
  })
}

/** Called once after both streamed and deferred tool results have settled. */
export async function* runPostToolBatchHooks(
  toolUses: readonly ToolUseBlock[],
  results: readonly Message[],
  toolUseContext: ToolUseContext,
): AsyncGenerator<Message> {
  if (toolUses.length === 0 || toolUseContext.abortController.signal.aborted) {
    return
  }
  const toolCalls = collectPostToolBatchCalls(toolUses, results)
  // Incomplete/cancelled batches must not masquerade as completed ones.
  if (toolCalls.length !== toolUses.length) return
  const toolUseID = randomUUID()
  // A block (JSON decision or exit code 2) and continue:false both stop the
  // loop before the next model call. The first reason is shown as a warning
  // and stays in the conversation; every hook still finishes and delivers
  // its context first.
  let stopReason: string | undefined

  try {
    for await (const result of executePostToolBatchHooks(toolCalls, toolUseContext)) {
      // The engine emits JSON block verdicts both as blockingError and as an
      // attachment. The stop message below carries the verdict once.
      if (
        result.message &&
        !(result.message.type === 'attachment' &&
          result.message.attachment.type === 'hook_blocking_error')
      ) yield result.message
      if (result.additionalContexts?.length) {
        yield createAttachmentMessage({
          type: 'hook_additional_context',
          content: result.additionalContexts,
          hookName: 'PostToolBatch',
          hookEvent: 'PostToolBatch',
          toolUseID,
        })
      }
      if (result.blockingError) {
        stopReason ??= result.blockingError.blockingError
      }
      if (result.preventContinuation) {
        stopReason ??= result.stopReason || 'Execution stopped by PostToolBatch hook'
      }
    }
  } catch (error) {
    logError(error)
  }
  if (stopReason !== undefined) {
    yield createAttachmentMessage({
      type: 'hook_stopped_continuation',
      message: stopReason,
      hookName: 'PostToolBatch',
      hookEvent: 'PostToolBatch',
      toolUseID,
    })
  }
}
