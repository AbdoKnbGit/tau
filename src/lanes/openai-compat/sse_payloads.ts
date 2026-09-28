/**
 * The `data:` payload of each server-sent event in a response body, in order.
 * Events split on a blank line; multi-line data joins with '\n'; `[DONE]` and
 * empty payloads are skipped. Same framing as the OpenCode /messages route.
 */
export async function* readSseDataPayloads(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const dataOf = (rawEvent: string): string =>
    rawEvent
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const data = dataOf(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (data && data !== '[DONE]') yield data
      }

      if (done) {
        const data = dataOf(buffer)
        if (data && data !== '[DONE]') yield data
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
