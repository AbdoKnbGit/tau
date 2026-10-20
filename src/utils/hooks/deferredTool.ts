import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getIsNonInteractiveSession, isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { createSystemMessage } from '../messages.js'
import { logForDebugging } from '../debug.js'

type DeferredBatch = { call?: ToolUseBlock; pending?: ToolUseBlock }
const batches = new WeakMap<AbortController, DeferredBatch>()

export function beginDeferredHookBatch(calls: readonly ToolUseBlock[], context: ToolUseContext): void {
  batches.set(context.abortController, {
    call: calls.length === 1 && getIsNonInteractiveSession() &&
      !context.agentId && !isSessionPersistenceDisabled() ? structuredClone(calls[0]) : undefined,
  })
}

export function deferHookToolCall(id: string, context: ToolUseContext): boolean {
  if (context.abortController.signal.aborted) return false
  const batch = batches.get(context.abortController)
  if (!batch?.call || batch.call.id !== id) {
    logForDebugging('Ignoring PreToolUse defer: it requires one tool call in a persistent headless main session.', { level: 'warn' })
    return false
  }
  batch.pending = batch.call
  return true
}

export function takeDeferredHookTool(context: ToolUseContext): ToolUseBlock | undefined {
  const batch = batches.get(context.abortController)
  batches.delete(context.abortController)
  return batch?.pending
}

export function deferredHookMarker(call: ToolUseBlock, assistant: AssistantMessage, unavailable = false) {
  return Object.assign(createSystemMessage(
    unavailable ? `Deferred tool "${call.name}" is unavailable.` : `Tool "${call.name}" deferred by PreToolUse hook.`,
    'info',
  ), {
    hookDeferredTool: { call, assistantUuid: assistant.uuid, unavailable },
  })
}

export function isDeferredHookMarker(message: Message): boolean {
  return message.type === 'system' && 'hookDeferredTool' in message
}

/** Accept only a marker backed by one still-unresolved call in this transcript. */
export function pendingDeferredHookTool(messages: readonly Message[]): {
  call: ToolUseBlock; assistant: AssistantMessage; unavailable: boolean
} | undefined {
  const marker = messages.findLast(isDeferredHookMarker)
  if (!marker || !('hookDeferredTool' in marker)) return
  const data = marker.hookDeferredTool as { call?: ToolUseBlock; assistantUuid?: string; unavailable?: boolean }
  if (!data || !data.call || typeof data.call.id !== 'string' || typeof data.call.name !== 'string') return
  const assistant = messages.find(message => message.type === 'assistant' &&
    (message.uuid === data.assistantUuid || message.message.content.some(block =>
      block.type === 'tool_use' && block.id === data.call!.id && block.name === data.call!.name)))
  if (!assistant || assistant.type !== 'assistant') return
  const calls = messages.flatMap(message => message.type === 'assistant' &&
    message.message.id === assistant.message.id
    ? message.message.content.filter(block => block.type === 'tool_use') : [])
  if (calls.length !== 1 || calls[0]?.id !== data.call.id || calls[0]?.name !== data.call.name) return
  if (messages.some(message => message.type === 'user' && Array.isArray(message.message.content) &&
    message.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === data.call!.id))) return
  // Use the original model call, never a marker's rewritten input.
  return { call: calls[0] as ToolUseBlock, assistant, unavailable: data.unavailable === true }
}
