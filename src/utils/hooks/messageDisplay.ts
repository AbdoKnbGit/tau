import { randomUUID } from 'node:crypto'
import type { ToolUseContext } from '../../Tool.js'
import type { Message, StreamEvent, RequestStartEvent, TombstoneMessage, ToolUseSummaryMessage } from '../../types/message.js'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import { createBaseHookInput, executeHooks, hasHookForEvent } from '../hooks.js'
import { logForDebugging } from '../debug.js'

type DisplayEvent = Message | StreamEvent | RequestStartEvent | TombstoneMessage | ToolUseSummaryMessage
export type DisplayBatch = { turn_id: string; message_id: string; index: number; final: boolean; delta: string }

// Presentation metadata stays outside messages: logs, model history, copying
// the conversation, and verbose transcript mode all retain the original text.
const displayText = new WeakMap<object, string>()
export function getMessageDisplayText(block: { text: string }): string {
  return displayText.get(block) ?? block.text
}
export function getStreamDisplayText(delta: { text: string }): string {
  return displayText.get(delta) ?? delta.text
}
export function hasMessageDisplayText(block: object): boolean { return displayText.has(block) }

export function messageForDisplay<T extends { message: { content: unknown } }>(message: T): T {
  if (!Array.isArray(message.message.content)) return message
  const content = message.message.content.map(block => block.type === 'text'
    ? { ...block, text: getMessageDisplayText(block) } : block)
  return { ...message, message: { ...message.message, content } }
}

/** Sequential whole-line batches, followed by exactly one final remainder. */
export class MessageDisplayBuffer {
  private pending = ''
  private index = 0
  private ended = false
  private rendered = ''
  readonly messageId = randomUUID()
  constructor(
    private readonly turnId: string,
    private readonly transform: (batch: DisplayBatch) => Promise<string | undefined>,
  ) {}

  async append(text: string, final = false): Promise<string> {
    if (this.ended) return ''
    this.pending += text
    const end = final ? this.pending.length : this.pending.lastIndexOf('\n') + 1
    if (!final && end === 0) return ''
    const delta = this.pending.slice(0, end)
    this.pending = this.pending.slice(end)
    this.ended = final
    const batch = { turn_id: this.turnId, message_id: this.messageId, index: this.index++, final, delta }
    let output = delta
    try { output = (await this.transform(batch)) ?? delta }
    catch (error) { logForDebugging(`MessageDisplay hook failed; displaying original batch: ${error}`) }
    this.rendered += output
    return output
  }

  get text(): string { return this.rendered }
}

/** Decorates the shared query's presentation without changing its messages. */
export async function* withMessageDisplay<T>(
  source: AsyncGenerator<DisplayEvent, T>,
  context: ToolUseContext,
  // Injectable for regression tests; production always uses the real runner.
  transform?: (batch: DisplayBatch) => Promise<string | undefined>,
  headless = getIsNonInteractiveSession(),
): AsyncGenerator<DisplayEvent, T> {
  if (!transform && (context.agentId || !hasHookForEvent('MessageDisplay', context.getAppState(), getSessionId()))) {
    return yield* source
  }
  const turnId = randomUUID()
  const apply = transform ?? (async (batch: DisplayBatch) => {
    let replacement: string | undefined
    for await (const result of executeHooks({
      hookInput: {
        ...createBaseHookInput(context.getAppState().toolPermissionContext.mode, undefined, context),
        hook_event_name: 'MessageDisplay', ...batch,
      },
      toolUseID: batch.message_id,
      toolUseContext: context,
      signal: context.abortController.signal,
      forceSyncExecution: true,
    })) {
      if (result.displayContent !== undefined) replacement = result.displayContent
    }
    return replacement
  })
  const streams = new Map<number, MessageDisplayBuffer>()
  const completed: MessageDisplayBuffer[] = []
  let done = false
  try {
    while (true) {
      const next = await source.next()
      if (next.done) { done = true; return next.value }
      const message = next.value
      if (!headless && message.type === 'stream_event') {
        const event = message.event
        if (event.type === 'message_start') { streams.clear(); completed.length = 0 }
        if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          const buffer = new MessageDisplayBuffer(turnId, apply)
          streams.set(event.index, buffer)
          displayText.set(event.content_block, await buffer.append(event.content_block.text))
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          let buffer = streams.get(event.index)
          if (!buffer) { buffer = new MessageDisplayBuffer(turnId, apply); streams.set(event.index, buffer) }
          displayText.set(event.delta, await buffer.append(event.delta.text))
        } else if (event.type === 'content_block_stop') {
          const buffer = streams.get(event.index)
          if (buffer) {
            await buffer.append('', true)
            completed.push(buffer)
            streams.delete(event.index)
          }
        }
      } else if (message.type === 'assistant' && !message.isApiErrorMessage) {
        for (const block of message.message.content) {
          if (block.type !== 'text') continue
          // Native providers yield the completed assistant block before its
          // content_block_stop event. Other providers yield it afterwards.
          const buffer = headless ? undefined : completed.shift() ?? streams.values().next().value
          if (buffer) {
            await buffer.append('', true)
            displayText.set(block, buffer.text)
            for (const [index, active] of streams) if (active === buffer) streams.delete(index)
          } else {
            const whole = new MessageDisplayBuffer(turnId, apply)
            displayText.set(block, await whole.append(block.text, true))
          }
        }
      }
      yield message
    }
  } finally {
    // Preserve queryLoop's cancellation/finally behavior when the consumer
    // stops early, including tool executor cleanup and query lifecycle state.
    if (!done) await source.return(undefined as T)
  }
}
