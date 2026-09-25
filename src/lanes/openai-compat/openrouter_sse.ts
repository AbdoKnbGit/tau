import { OpenRouterToolCallError } from './openrouter_tools.js'

/** A recovery completion uses the same validated assembly path as streaming.
 * Only the delivery mode changes; arguments and finish reasons stay intact.
 */
export async function openRouterCompletionAsSSE(response: Response): Promise<Response> {
  let completion: any
  try { completion = await response.json() } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new OpenRouterToolCallError('The recovery response was not complete JSON. No tools were dispatched.')
  }
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
    throw new OpenRouterToolCallError('The recovery response was not a completion object.')
  }
  const choice = completion.choices?.[0]
  const failed = completion.error || choice?.error || choice?.finish_reason === 'error' || choice?.native_finish_reason === 'error'
  if (!failed && (!choice?.message || !(choice.finish_reason || choice.native_finish_reason))) {
    throw new OpenRouterToolCallError('The recovery response has no completed message. No tools were dispatched.')
  }
  if (choice) {
    const message = choice.message ?? {}
    const calls = message.tool_calls
    completion = { ...completion, choices: [{ ...choice, delta: {
      ...message,
      ...(typeof message.reasoning === 'string' && !message.reasoning_content
        ? { reasoning_content: message.reasoning } : {}),
      ...(Array.isArray(calls) ? { tool_calls: calls.map((call: any, index: number) => ({ ...call, index })) } : {}),
    } }] }
  }
  return new Response(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** SSE frames, not network packets or individual data lines, contain JSON.
 * Accept LF/CRLF/CR, comments, and multiline data without dropping fragments.
 */
export class OpenRouterSSEDecoder {
  private buffer = ''
  private data: string[] = []

  feed(text: string, end = false): string[] {
    this.buffer += text
    const events: string[] = []
    const line = (value: string) => {
      if (!value) {
        if (this.data.length) events.push(this.data.join('\n'))
        this.data = []
      } else if (value === 'data') this.data.push('')
      else if (value.startsWith('data:')) this.data.push(value.slice(5).replace(/^ /, ''))
    }
    for (;;) {
      const match = /[\r\n]/.exec(this.buffer)
      if (!match) break
      const i = match.index
      if (!end && this.buffer[i] === '\r' && i === this.buffer.length - 1) break
      line(this.buffer.slice(0, i))
      const width = this.buffer[i] === '\r' && this.buffer[i + 1] === '\n' ? 2 : 1
      this.buffer = this.buffer.slice(i + width)
    }
    if (end) {
      if (this.buffer) line(this.buffer)
      this.buffer = ''
      // A complete final JSON event may arrive without a trailing blank line.
      // The tool guard still requires an explicit generation finish signal.
      line('')
    }
    return events
  }
}

export async function* parseOpenRouterSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const frames = new OpenRouterSSEDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      for (const payload of frames.feed(done ? decoder.decode() : decoder.decode(value, { stream: true }), done)) {
        if (payload.trim() === '[DONE]') return
        if (!payload.trim()) continue
        let chunk
        try { chunk = JSON.parse(payload) } catch {
          throw new OpenRouterToolCallError('The stream contained an invalid JSON event; pending tools were not dispatched.')
        }
        yield chunk
      }
      if (done) return
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
