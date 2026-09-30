// Anthropic Messages SSE reply, for providers whose gateway speaks the
// Anthropic wire format (e.g. AgentRouter's /v1/messages).
let seq = 0

export function anthropicReply(action, model) {
  const blocks = typeof action === 'string' ? [{ type: 'text', text: action }]
    : action.map((c, i) => ({ type: 'tool_use', id: `toolu_c28a_${++seq}_${i}`, name: c.name, input: c.input }))
  const stop = typeof action === 'string' ? 'end_turn' : 'tool_use'
  const usage = { input_tokens: 100, output_tokens: 10 }
  const out = []
  const ev = (type, data) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: `msg_c28a_${++seq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    ev('content_block_stop', { index })
  })
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } })
  ev('message_stop', {})
  return out.join('')
}
