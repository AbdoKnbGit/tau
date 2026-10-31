// Loaded into the real CLI with node --import. It plays the model from a script and writes down every
// model request byte for byte, and nothing reaches the network. Everything else in the run is the real
// CLI: real tools, real permission checks, real request building.
import { appendFileSync, readFileSync } from 'node:fs'
import { toWireName } from './tool-names.mjs'
import { formatOfPath, MARKER, readRequest } from './wire.mjs'

const plan = JSON.parse(readFileSync(process.env.TAU_LAB_PLAN, 'utf8'))
const recordFile = process.env.TAU_LAB_RECORD
const usage = { input: 100, cached: 0, creation: 0, output: 5, ...plan.usage }
let step = 0
let mainRequests = 0
// A real provider never reuses an id, not even after a resume, and Tau rejects a repeated tool id.
let replyNumber = Date.now()

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const stream = (text, type = 'text/event-stream') => new Response(text, { status: 200, headers: { 'content-type': type } })

function maskedHeaders(input, init) {
  const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input?.headers : undefined) ?? {})
  return Object.fromEntries([...headers].map(([name, value]) => [name,
    /^(authorization|x-api-key)$/i.test(name) ? `${name === 'authorization' ? 'login' : 'key'}:${value.slice(-6)}` : value]))
}

// Scripted arguments use Tau's names; a route may call the same argument something else.
function argumentsFor(call, properties) {
  const out = {}
  for (const [key, value] of Object.entries(call.input ?? {})) {
    if (!Object.keys(properties).length || key in properties) out[key] = value
    else out[(/path/i.test(key) && Object.keys(properties).find(name => /path/i.test(name))) || key] = value
  }
  return out
}

function anthropicReply(body, calls, text) {
  const event = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`
  const out = [event({ type: 'message_start', message: { id: `msg_lab_${++replyNumber}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: usage.creation } } })]
  if (calls.length) {
    calls.forEach((call, index) => {
      out.push(event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_lab_${replyNumber}_${index}`, name: call.name, input: {} } }))
      out.push(event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }))
      out.push(event({ type: 'content_block_stop', index }))
    })
  } else {
    out.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    out.push(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
    out.push(event({ type: 'content_block_stop', index: 0 }))
  }
  out.push(event({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } }))
  out.push(event({ type: 'message_stop' }))
  return out.join('')
}

// A route that asks for one finished message rather than a stream.
function anthropicMessage(body, calls, text) {
  const id = ++replyNumber
  const content = calls.length
    ? calls.map((call, index) => ({ type: 'tool_use', id: `toolu_lab_${id}_${index}`, name: call.name, input: call.args }))
    : [{ type: 'text', text }]
  return { id: `msg_lab_${id}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cached, cache_creation_input_tokens: usage.creation } }
}

function geminiReply(body, calls, text) {
  const parts = calls.length ? calls.map(call => ({ functionCall: { name: call.name, args: call.args } })) : [{ text }]
  const response = {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: usage.input + usage.cached, cachedContentTokenCount: usage.cached, candidatesTokenCount: usage.output },
  }
  return `data: ${JSON.stringify(body.request ? { response } : response)}\n\n`
}

function chatReply(body, calls, text) {
  const id = `chatcmpl-lab-${++replyNumber}`
  const chunk = (delta, finish, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
  const tally = { usage: { prompt_tokens: usage.input + usage.cached, completion_tokens: usage.output, total_tokens: usage.input + usage.cached + usage.output, prompt_tokens_details: { cached_tokens: usage.cached } } }
  if (calls.length) {
    const toolCalls = calls.map((call, index) => ({ index, id: `call_lab_${replyNumber}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
    return chunk({ role: 'assistant', tool_calls: toolCalls }, null) + chunk({}, 'tool_calls', tally) + 'data: [DONE]\n\n'
  }
  return chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop', tally) + 'data: [DONE]\n\n'
}

function responsesReply(body, calls, text) {
  const id = `resp_lab_${++replyNumber}`
  const event = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`
  const base = { id, object: 'response', created_at: 1, model: body.model, status: 'in_progress', output: [] }
  const items = calls.length
    ? calls.map((call, index) => ({ type: 'function_call', id: `fc_lab_${replyNumber}_${index}`, call_id: `call_lab_${replyNumber}_${index}`, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' }))
    : [{ type: 'message', id: `msg_lab_${replyNumber}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]
  const out = [event({ type: 'response.created', response: base }), event({ type: 'response.in_progress', response: base })]
  items.forEach((item, output_index) => {
    out.push(event({ type: 'response.output_item.added', output_index, item: item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } }))
    if (item.type === 'function_call') {
      out.push(event({ type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments }))
      out.push(event({ type: 'response.function_call_arguments.done', output_index, item_id: item.id, arguments: item.arguments }))
    } else {
      out.push(event({ type: 'response.content_part.added', output_index, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }))
      out.push(event({ type: 'response.output_text.delta', output_index, item_id: item.id, content_index: 0, delta: text }))
      out.push(event({ type: 'response.output_text.done', output_index, item_id: item.id, content_index: 0, text }))
      out.push(event({ type: 'response.content_part.done', output_index, item_id: item.id, content_index: 0, part: item.content[0] }))
    }
    out.push(event({ type: 'response.output_item.done', output_index, item }))
  })
  out.push(event({ type: 'response.completed', response: { ...base, status: 'completed', output: items, usage: { input_tokens: usage.input + usage.cached, output_tokens: usage.output, total_tokens: usage.input + usage.cached + usage.output, input_tokens_details: { cached_tokens: usage.cached } } } }))
  return out.join('')
}

function ollamaReply(body, calls, text) {
  const done = { model: body.model, created_at: '2026-01-01T00:00:00Z', done: true, done_reason: 'stop', prompt_eval_count: usage.input, eval_count: usage.output }
  const message = calls.length
    ? { role: 'assistant', content: '', tool_calls: calls.map(call => ({ function: { name: call.name, arguments: call.args } })) }
    : { role: 'assistant', content: text }
  return `${JSON.stringify({ ...done, message })}\n`
}

globalThis.fetch = async function fetch(input, init) {
  const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)))
  const method = init?.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET'
  let text = typeof init?.body === 'string' ? init.body : ''
  if (!text && method === 'POST' && typeof input === 'object' && typeof input?.clone === 'function') text = await input.clone().text().catch(() => '')

  if (url.pathname.includes('loadCodeAssist')) return json({ cloudaicompanionProject: 'lab-project', currentTier: { id: 'free-tier' } })
  if (url.pathname.endsWith('/token')) return json({ access_token: 'lab-access', expires_in: 3600, token_type: 'Bearer' })
  if (url.pathname.includes('count_tokens')) return json({ input_tokens: 1 })

  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = undefined }
  const isMain = method === 'POST' && !!body && text.includes(MARKER)
  const isSide = method === 'POST' && !!body && !isMain
    && (Array.isArray(body.messages) || Array.isArray(body.contents) || Array.isArray(body.request?.contents))
  if (!isMain && !isSide) return json({})

  const format = formatOfPath(url.pathname)
  appendFileSync(recordFile, JSON.stringify({ side: isSide, format, host: url.host, path: url.pathname, headers: maskedHeaders(input, init), body: text }) + '\n')

  // Answers the way Google answers a system prompt identity it refuses.
  if (isMain && (plan.refuse ?? []).some(phrase => text.includes(phrase))) {
    return json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 429)
  }

  // The provider refuses the request. `after` lets earlier requests through, `times` the later ones.
  if (isMain && plan.reject) {
    const { status, body: errorBody, headers, after = 0, times = Infinity } = plan.reject
    const number = mainRequests++
    if (number >= after && number < after + times) {
      return new Response(JSON.stringify(errorBody), { status, headers: { 'content-type': 'application/json', ...headers } })
    }
  }

  const offered = format === 'other' ? [] : readRequest({ format, headers: {}, body: text }).tools
  const offeredNames = offered.map(tool => tool.name)
  const scripted = isMain ? (plan.steps?.[step++] ?? []) : []
  const calls = scripted.map(call => {
    const name = toWireName(call.tool, offeredNames, format)
    return { name, args: argumentsFor(call, offered.find(tool => tool.name === name)?.properties ?? {}) }
  })
  const answer = isMain ? (plan.finalText ?? 'LAB-DONE') : 'ok'
  if (format === 'gemini') return stream(geminiReply(body, calls, answer))
  if (format === 'anthropic' && body.stream !== true) return json(anthropicMessage(body, calls, answer))
  if (format === 'anthropic') return stream(anthropicReply(body, calls, answer))
  if (format === 'chat') return stream(chatReply(body, calls, answer))
  if (format === 'responses') return stream(responsesReply(body, calls, answer))
  if (format === 'ollama') return stream(ollamaReply(body, calls, answer), 'application/x-ndjson')
  return json({ error: { message: 'the lab has no script for this request format', type: 'invalid_request_error' } }, 400)
}
