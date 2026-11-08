// Loaded into the real CLI with node --import: it plays the model for the mod
// lab and writes down every model request. Nothing reaches the network. Its
// answers show what the mods did: a word turn.step hides, whether the section
// prompt.compose added reached the model, and tool calls on request.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const record = process.env.TAU_LAB_RECORD
let serial = Date.now()

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const sse = text => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** The person's last words (the last text block that is not a reminder, a
 * command's caveat or a command's tags), and whether the request answers a
 * tool call. */
function lastTurn(messages = []) {
  const last = messages.at(-1)
  const toolResult = Array.isArray(last?.content) && last.content.some(block => block?.type === 'tool_result')
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]
    if (message?.role !== 'user') continue
    const blocks = typeof message.content === 'string' ? [message.content]
      : Array.isArray(message.content) ? message.content.filter(block => block?.type === 'text').map(block => block.text) : []
    const text = blocks.map(block => String(block).replace(REMINDER, '').trim())
      .filter(block => block && !block.startsWith('Caveat:') && !block.startsWith('<')).at(-1)
    if (text) return { text, toolResult }
  }
  return { text: '', toolResult }
}

/** What the lab model does with a request. A side request (model.complete,
 * a title: no tools offered) gets a plain answer. */
function decide(body) {
  if (!(body.tools ?? []).length) return { text: 'LAB-SIDE-ANSWER: ready' }
  const { text, toolResult } = lastTurn(body.messages)
  if (toolResult) return { text: 'LAB-AFTER-TOOL: the tool answered, and the turn goes on.' }
  if (/LAB-TOOL/.test(text)) return { calls: [{ name: 'Read', input: { file_path: join(process.cwd(), 'notes.txt') } }] }
  // A command that writes, so the default permission mode asks first.
  if (/LAB-BASH/.test(text)) return { calls: [{ name: 'Bash', input: { command: 'echo lab-bash > lab-bash.txt', description: 'Write a file for the mod lab' } }] }
  const system = Array.isArray(body.system) ? body.system.map(block => block?.text ?? '').join('\n') : String(body.system ?? '')
  const word = system.includes('KIWI-42') ? 'KIWI-42' : 'missing'
  return { text: `LAB-ANSWER to "${text.slice(0, 40)}". The word SECRET-7 must never show. LAB-WORD=${word}` }
}

function streamed(body, plan) {
  const event = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`
  const id = ++serial
  const out = [event({ type: 'message_start', message: { id: `msg_lab_${id}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })]
  if (plan.calls) {
    plan.calls.forEach((call, index) => {
      out.push(event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_lab_${id}_${index}`, name: call.name, input: {} } }))
      out.push(event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }))
      out.push(event({ type: 'content_block_stop', index }))
    })
  } else {
    out.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    // Word by word, as a model streams: a hook sees several text chunks.
    for (const piece of plan.text.split(/(?<= )/))
      out.push(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }))
    out.push(event({ type: 'content_block_stop', index: 0 }))
  }
  out.push(event({ type: 'message_delta', delta: { stop_reason: plan.calls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }))
  out.push(event({ type: 'message_stop' }))
  return out.join('')
}

function whole(body, plan) {
  const id = ++serial
  const content = plan.calls
    ? plan.calls.map((call, index) => ({ type: 'tool_use', id: `toolu_lab_${id}_${index}`, name: call.name, input: call.input }))
    : [{ type: 'text', text: plan.text }]
  return { id: `msg_lab_${id}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: plan.calls ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
}

globalThis.fetch = async function fetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)))
  const method = init?.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET'
  let text = typeof init?.body === 'string' ? init.body : ''
  if (!text && method === 'POST' && typeof input === 'object' && typeof input?.clone === 'function') text = await input.clone().text().catch(() => '')
  if (url.pathname.includes('count_tokens')) return json({ input_tokens: 1 })
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  if (method !== 'POST' || !url.pathname.endsWith('/messages') || !Array.isArray(body?.messages)) return json({})
  const plan = decide(body)
  if (record) appendFileSync(record, JSON.stringify({
    model: body.model, stream: body.stream === true, tools: (body.tools ?? []).length,
    sawLabWord: JSON.stringify(body.system ?? '').includes('KIWI-42'), last: lastTurn(body.messages).text.slice(0, 80),
    answer: plan.calls ? plan.calls.map(call => call.name).join(',') : plan.text.slice(0, 80),
  }) + '\n')
  return body.stream === true ? sse(streamed(body, plan)) : json(whole(body, plan))
}
