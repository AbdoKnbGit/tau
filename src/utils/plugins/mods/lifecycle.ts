import { randomUUID } from 'node:crypto'
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { ToolUseContext } from '../../../Tool.js'
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message, RequestStartEvent, StreamEvent, TombstoneMessage, ToolUseSummaryMessage } from '../../../types/message.js'
import { createAssistantMessage, createSystemMessage } from '../../messages.js'
import { logForDebugging } from '../../debug.js'
import { dispatchModEvent, hasModEvent } from './manager.js'
import type { ModRecord } from './runtime.js'
import { withModToolContext } from './toolContext.js'

type TurnMessage = Message | RequestStartEvent | StreamEvent | TombstoneMessage | ToolUseSummaryMessage

/** All top-level SDK text is submitted; attachments keep their order and identity. */
export function submittedPromptText(input: string | ContentBlockParam[]): string {
  return typeof input === 'string' ? input : input.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
export function replaceSubmittedPromptText(input: string | ContentBlockParam[], text: string): string | ContentBlockParam[] {
  if (typeof input === 'string') return text
  if (text === submittedPromptText(input)) return input
  const index = input.findLastIndex(block => block.type === 'text')
  if (index < 0) return text ? [...input, { type: 'text', text }] : input
  return input.flatMap<ContentBlockParam>((block, i) => block.type !== 'text' ? [block] : i === index ? [{ ...block, text }] : [])
}

export async function inToolContext<T>(context: ToolUseContext, canUseTool: CanUseToolFn | undefined, action: () => Promise<T>, assistant?: AssistantMessage): Promise<T> {
  const permission = canUseTool ?? (await import('../../permissions/permissions.js')).hasPermissionsToUseTool
  return withModToolContext({
    toolUseContext: context,
    canUseTool: permission,
    assistantMessage: assistant ?? context.messages.findLast(message => message.type === 'assistant') ?? createAssistantMessage({ content: [] }),
  }, action)
}

export async function submitModPrompt(event: ModRecord, context: ToolUseContext, canUseTool?: CanUseToolFn): Promise<ModRecord> {
  return inToolContext(context, canUseTool, async () => await dispatchModEvent(
    'prompt.submit', event,
    async e => ({ text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }),
    context.abortController.signal,
  ) as ModRecord)
}

/** Observe the complete shared query, rather than individual model requests. */
export async function* withModTurnLifecycle<T>(
  source: AsyncGenerator<TurnMessage, T>,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): AsyncGenerator<TurnMessage, T> {
  if (!hasModEvent('turn.start') && !hasModEvent('turn.complete')) return yield* source
  const turnId = randomUUID()
  const startedAt = Date.now()
  const requests = new Map<string, AssistantMessage>()
  const streamedUsage = new Map<string, Record<string, number>>()
  const responseText = new Map<string, string>()
  let responseId: string | undefined
  let streamingResponseId: string | undefined
  let assistant: AssistantMessage | undefined
  let done = false
  let terminal: T
  let completeText = ''
  try {
    if (!context.agentId && hasModEvent('turn.start'))
      await inToolContext(context, canUseTool, () => dispatchModEvent('turn.start', { turnId }, async e => ({ turnId: e.turnId }), context.abortController.signal))
    while (true) {
      const next = await source.next()
      if (next.done) { done = true; terminal = next.value; break }
      const message = next.value
      if (message.type === 'stream_request_start') streamingResponseId = undefined
      if (message.type === 'assistant' && !message.isApiErrorMessage) {
        assistant = message
        const id = message.message.id || message.uuid
        if (id !== responseId) { responseId = id; responseText.clear() }
        responseText.set(message.uuid, message.message.content.filter((block: ContentBlockParam): block is TextBlockParam => block.type === 'text').map((block: TextBlockParam) => block.text).join('\n'))
        // Native streaming fills final usage after yielding the assistant block.
        // Retain the response, then read its final usage after the stream closes.
        requests.set(id, message)
      }
      if (message.type === 'stream_event' && message.event.type === 'message_start') streamingResponseId = message.event.message.id
      const usageResponseId = streamingResponseId ?? responseId
      if (message.type === 'stream_event' && message.event.type === 'message_delta' && usageResponseId) {
        const finalUsage = streamedUsage.get(usageResponseId) ?? {}
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
          const count = message.event.usage[key as keyof typeof message.event.usage]
          if (typeof count === 'number' && Number.isFinite(count) && (count > 0 || key === 'output_tokens')) finalUsage[key] = count
        }
        streamedUsage.set(usageResponseId, finalUsage)
      }
      yield message
    }
  } finally {
    try {
      if (!done) await source.return(undefined as T)
    } finally {
      if (hasModEvent('turn.complete')) {
        let usage: Record<string, number> | null = null
        for (const [id, request] of requests) {
          const finalUsage = streamedUsage.get(id)
          if (!request.message.usage && !finalUsage) continue
          usage ??= { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
          for (const key of Object.keys(usage)) {
            const count = finalUsage?.[key] ?? request.message.usage?.[key as keyof typeof request.message.usage]
            if (typeof count === 'number' && Number.isFinite(count)) usage[key] = (usage[key] ?? 0) + count
          }
        }
        try {
          // Completion must run even when the turn's abort signal is already set.
          const result = await inToolContext(context, canUseTool, async () => await dispatchModEvent('turn.complete', {
            turnId, ...(context.agentId ? { agentId: context.agentId } : {}),
            answer: [...responseText.values()].filter(Boolean).join('\n'),
            durationMs: Math.max(0, Date.now() - startedAt),
            isAborted: context.abortController.signal.aborted || !done,
            usage,
          }, async () => ({ text: '' })) as ModRecord, assistant)
          completeText = result.text
        } catch (error) {
          logForDebugging(`Mod turn.complete failed: ${String(error)}`)
        }
      }
    }
  }
  // Informational messages are presentation only and are excluded from API history.
  if (completeText) yield createSystemMessage(completeText, 'info')
  return terminal!
}
