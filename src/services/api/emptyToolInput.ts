/**
 * A tool call with no arguments, on an Anthropic Messages stream.
 *
 * The server sends such a call as a tool_use block with no JSON in it:
 * content_block_start carries `input: {}`, the one delta is an empty
 * `partial_json`, then content_block_stop. A call cut off by the output cap
 * right after the tool name looks exactly the same until the message's stop
 * reason arrives, and that one is half a call: its arguments never came (see
 * services/mcp/decodeStatus.ts).
 *
 * So an empty block is held at its content_block_stop until the next event
 * shows the model finished it: another block starts, or the message ends with
 * `tool_use`. Then its arguments are delivered as `{}`, the same call every
 * other provider sends. On any other ending the block passes through as it
 * came, and tool execution refuses it as before.
 *
 * Only for a stream that comes from a Messages server. A lane writes its own
 * message_delta, which says nothing about how the reply it was built from
 * ended.
 */

type MessagesStreamEvent = {
  type: string
  index?: number
  content_block?: { type?: string; input?: unknown }
  delta?: { type?: string; partial_json?: string; stop_reason?: string | null }
}

/** The same rule for a caller that hands events over one at a time. */
export class EmptyToolInputSettler<T extends MessagesStreamEvent> {
  // JSON streamed so far, for each open tool_use block that started empty.
  private readonly streamed = new Map<number, string>()
  // The content_block_stop of an empty block, waiting for the next event.
  private held: T | undefined

  /** The events to pass on now, in order. */
  push(event: T): T[] {
    const out: T[] = []
    if (this.held) {
      // A ping says nothing about how the block ended. Keep waiting.
      if (event.type === 'ping') return [event]
      if (finishesTheBlockBefore(event)) {
        out.push({
          type: 'content_block_delta',
          index: this.held.index,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        } as T)
      }
      out.push(this.held)
      this.held = undefined
    }
    const { index } = event
    if (typeof index === 'number') {
      if (event.type === 'content_block_start') {
        // A start that already carries arguments is not this shape. Leave it alone.
        if (event.content_block?.type === 'tool_use' && carriesNoArguments(event.content_block.input)) {
          this.streamed.set(index, '')
        } else {
          this.streamed.delete(index)
        }
      } else if (event.type === 'content_block_delta') {
        const soFar = this.streamed.get(index)
        if (soFar !== undefined && event.delta?.type === 'input_json_delta') {
          this.streamed.set(index, soFar + (event.delta.partial_json ?? ''))
        }
      } else if (event.type === 'content_block_stop') {
        const whole = this.streamed.get(index)
        this.streamed.delete(index)
        if (whole !== undefined && whole.trim() === '') {
          this.held = event
          return out
        }
      }
    }
    out.push(event)
    return out
  }

  /** The stream ended or failed: nothing shows a held block was finished. */
  end(): T[] {
    const held = this.held
    this.held = undefined
    return held ? [held] : []
  }
}

export async function* settleEmptyToolInputs<T extends MessagesStreamEvent>(
  events: AsyncIterable<T>,
): AsyncGenerator<T, void, undefined> {
  const settler = new EmptyToolInputSettler<T>()
  for await (const event of events) yield* settler.push(event)
  yield* settler.end()
}

/** Does this event show that the model finished the block before it? */
function finishesTheBlockBefore(event: MessagesStreamEvent): boolean {
  return (
    event.type === 'content_block_start' ||
    (event.type === 'message_delta' && event.delta?.stop_reason === 'tool_use')
  )
}

function carriesNoArguments(input: unknown): boolean {
  if (input === undefined || input === '') return true
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0
  )
}
