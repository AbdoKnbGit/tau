// Wire formats of every provider lane: parse a request into a view (for the
// scripted model) and a canonical prompt (for the cache-prefix check), and
// build the streamed reply for a scripted action.

export const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(p => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : textOf(p?.content ?? p?.output))).filter(Boolean).join('\n')
    : c && typeof c === 'object' ? (typeof c.value === 'string' ? c.value : textOf(c.content ?? c.text ?? c.output ?? '')) : ''

// Cache markers move to the newest messages every request by design and are
// not part of the cached bytes.
export const stripMarkers = value => JSON.parse(JSON.stringify(value ?? null, (key, v) =>
  key === 'cache_control' || key === 'cachePoint' ? undefined : v))

const toolNames = {
  anthropic: b => (b.tools ?? []).map(t => t.name),
  chat: b => (b.tools ?? []).map(t => t.function?.name),
  responses: b => (b.tools ?? []).map(t => t.name),
  gemini: b => (b.tools ?? []).flatMap(t => t.functionDeclarations ?? []).map(d => d.name),
  kiro: b => (b.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools ?? []).map(t => t.toolSpecification?.name),
  alpha: b => (b.tools ?? []).map(t => t.name ?? t.function?.name),
}

// ── view: what the scripted model reads ──────────────────────────────────
export function view(format, body) {
  const b = format === 'antigravity' ? (body.request ?? {}) : format === 'alpha' ? (body.params ?? body) : body
  const v = viewOf(format, b)
  v.all = JSON.stringify(b)
  return v
}

function viewOf(format, b) {
  const f = format === 'antigravity' ? 'gemini' : format
  const tools = toolNames[f](b).filter(Boolean)
  if (f === 'anthropic') {
    const msgs = b.messages ?? []
    const last = msgs.at(-1)
    const blocks = Array.isArray(last?.content) ? last.content : []
    return {
      step: msgs.filter(m => m.role === 'assistant').length,
      results: blocks.filter(x => x.type === 'tool_result').map(x => ({ text: textOf(x.content), isError: x.is_error === true })),
      after: last?.role === 'user' ? textOf(last.content) : '',
      first: textOf(msgs[0]?.content), tools,
    }
  }
  if (f === 'chat' || f === 'alpha') {
    const msgs = b.messages ?? []
    const lastAssistant = msgs.map(m => m.role).lastIndexOf('assistant')
    const after = msgs.slice(lastAssistant + 1)
    return {
      step: msgs.filter(m => m.role === 'assistant').length,
      results: after.filter(m => m.role === 'tool').map(m => ({ text: textOf(m.content), isError: /tool_use_error/.test(textOf(m.content)) })),
      after: after.map(m => textOf(m.content)).join('\n'),
      first: textOf(msgs.find(m => m.role === 'user')?.content), tools,
    }
  }
  if (f === 'responses') {
    const items = b.input ?? []
    const isTurn = i => i.type === 'function_call' || i.type === 'custom_tool_call' || (i.type === 'message' && i.role === 'assistant')
    const lastTurn = items.map(isTurn).lastIndexOf(true)
    const after = items.slice(lastTurn + 1)
    const outText = i => typeof i.output === 'string' ? i.output : textOf(i.output)
    return {
      step: items.filter(isTurn).length,
      results: after.filter(i => i.type === 'function_call_output').map(i => ({ text: outText(i), isError: /tool_use_error/.test(outText(i)) })),
      after: after.map(i => i.type === 'function_call_output' ? outText(i) : textOf(i.content)).join('\n'),
      first: textOf(items.find(i => i.role === 'user')?.content), tools,
    }
  }
  if (f === 'gemini') {
    const contents = b.contents ?? []
    const lastModel = contents.map(c => c.role === 'model').lastIndexOf(true)
    const parts = contents.slice(lastModel + 1).flatMap(c => c.parts ?? [])
    const partText = p => {
      if (!p.functionResponse) return p.text ?? ''
      const r = p.functionResponse.response
      return typeof r?.content === 'string' ? r.content : typeof r?.output === 'string' ? r.output : JSON.stringify(r)
    }
    return {
      step: contents.filter(c => c.role === 'model').length,
      results: parts.filter(p => p.functionResponse).map(p => ({ text: partText(p), isError: /tool_use_error/.test(partText(p)) })),
      after: parts.map(partText).join('\n'),
      first: (contents.find(c => c.role === 'user')?.parts ?? []).map(partText).join('\n'), tools,
    }
  }
  if (f === 'kiro') {
    const state = b.conversationState ?? {}
    const history = state.history ?? []
    const current = state.currentMessage?.userInputMessage ?? {}
    const ctx = current.userInputMessageContext ?? {}
    const results = (ctx.toolResults ?? []).map(r => ({ text: textOf(r.content), isError: r.status === 'error' }))
    const firstUser = history.find(h => h.userInputMessage)?.userInputMessage?.content ?? current.content ?? ''
    return {
      step: history.filter(h => h.assistantResponseMessage).length,
      results,
      after: [results.map(r => r.text).join('\n'), current.content ?? ''].join('\n'),
      first: firstUser, tools,
    }
  }
  throw new Error(`unknown format ${format}`)
}

// ── canonical prompt: the bytes a provider can cache ─────────────────────
export function canonical(format, body) {
  const b = format === 'antigravity' ? (body.request ?? {}) : format === 'alpha' ? (body.params ?? body) : body
  const f = format === 'antigravity' ? 'gemini' : format
  switch (f) {
    case 'anthropic': return stripMarkers({ system: b.system, tools: b.tools, messages: b.messages })
    case 'chat': return stripMarkers({ system: null, tools: b.tools, messages: b.messages })
    case 'alpha': return stripMarkers({ system: b.system, tools: b.tools, messages: b.messages })
    case 'responses': return stripMarkers({ system: b.instructions, tools: b.tools, messages: b.input })
    case 'gemini': return stripMarkers({ system: b.systemInstruction, tools: b.tools, messages: b.contents })
    case 'kiro': {
      const state = b.conversationState ?? {}
      const current = state.currentMessage?.userInputMessage ?? {}
      return stripMarkers({ system: null, tools: current.userInputMessageContext?.tools, messages: state.history ?? [] })
    }
  }
}

// ── replies ──────────────────────────────────────────────────────────────
const NATIVE = {
  responses: { Bash: c => ({ name: 'shell', input: { command: c.command, ...(c.run_in_background && { run_in_background: true }) } }) },
  gemini: { Bash: c => ({ name: 'run_shell_command', input: { command: c.command, description: c.description, ...(c.run_in_background && { is_background: true }) } }) },
  kiro: { Bash: c => ({ name: 'shell', input: { command: c.command, description: c.description, ...(c.run_in_background && { run_in_background: true }) } }) },
}
export function nativeCall(format, call) {
  const f = format === 'antigravity' ? 'gemini' : format
  const map = NATIVE[f]?.[call.name]
  return map ? map(call.input) : call
}

let seq = 0
export function sseText(chunks) {
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')
}

export function chatReply(action, model) {
  const base = { id: `gen-c28-${++seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  const usage = { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
  if (typeof action === 'string') {
    return sseText([{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: action }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usage]) + 'data: [DONE]\n\n'
  }
  return sseText([
    ...action.map((c, i) => ({ ...base, choices: [{ index: 0, delta: { ...(i === 0 && { role: 'assistant' }), tool_calls: [{ index: i, id: `call_${seq}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }] }, finish_reason: null }] })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, usage]) + 'data: [DONE]\n\n'
}

export function geminiReply(action, wrap) {
  const parts = typeof action === 'string' ? [{ text: action }]
    : action.map(c => ({ functionCall: { name: c.name, args: c.input } }))
  const chunk = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 }, modelVersion: 'e2e' }
  return sseText([wrap ? { response: chunk, traceId: 'c28' } : chunk])
}

export function alphaReply(action) {
  if (typeof action === 'string') {
    return sseText([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: action }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 10 } }])
  }
  return sseText([...action.map((c, i) => ({ type: 'tool-call', toolCallId: `toolu_alpha_${++seq}_${i}`, toolName: c.name, input: c.input })),
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 10 } }])
}

// AWS EventStream frames (application/vnd.amazon.eventstream), as
// CodeWhisperer streams them. CRCs are real so any strict parser accepts them.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function frame(eventType, payload) {
  const headers = []
  for (const [name, value] of [[':event-type', eventType], [':content-type', 'application/json'], [':message-type', 'event']]) {
    const n = Buffer.from(name)
    const v = Buffer.from(value)
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length)
    h.writeUInt8(n.length, 0); n.copy(h, 1); h.writeUInt8(7, 1 + n.length)
    h.writeUInt16BE(v.length, 2 + n.length); v.copy(h, 4 + n.length)
    headers.push(h)
  }
  const hbuf = Buffer.concat(headers)
  const pbuf = Buffer.from(JSON.stringify(payload))
  const total = 12 + hbuf.length + pbuf.length + 4
  const prelude = Buffer.alloc(8)
  prelude.writeUInt32BE(total, 0); prelude.writeUInt32BE(hbuf.length, 4)
  const preludeCrc = Buffer.alloc(4); preludeCrc.writeUInt32BE(crc32(prelude), 0)
  const body = Buffer.concat([prelude, preludeCrc, hbuf, pbuf])
  const msgCrc = Buffer.alloc(4); msgCrc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([body, msgCrc])
}
export function kiroReply(action) {
  const frames = []
  if (typeof action === 'string') {
    frames.push(frame('assistantResponseEvent', { content: action }))
  } else {
    action.forEach((c, i) => {
      const toolUseId = `tooluse_c28_${++seq}_${i}`
      frames.push(frame('toolUseEvent', { toolUseId, name: c.name, input: JSON.stringify(c.input) }))
      frames.push(frame('toolUseEvent', { toolUseId, name: c.name, stop: true }))
    })
  }
  frames.push(frame('messageStopEvent', {}))
  frames.push(frame('meteringEvent', { unit: 'credit', usage: 0.01 }))
  return Buffer.concat(frames)
}

// Ollama's native /api/chat: NDJSON, one object per line.
export function ollamaReply(action, model) {
  const base = { model, created_at: new Date().toISOString() }
  const message = typeof action === 'string'
    ? { role: 'assistant', content: action }
    : { role: 'assistant', content: '', tool_calls: action.map((c, i) => ({ id: `call_c28_${++seq}_${i}`, function: { name: c.name, arguments: c.input } })) }
  return [
    JSON.stringify({ ...base, message, done: false }),
    JSON.stringify({ ...base, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10 }),
  ].join(String.fromCharCode(10)) + String.fromCharCode(10)
}

// OpenAI Responses stream (the Codex lane), for runs served by the preload.
export function responsesReply(action) {
  const id = 'resp_c28_' + (++seq)
  const out = []
  const ev = (type, data) => out.push('event: ' + type + String.fromCharCode(10) + 'data: ' + JSON.stringify({ type, ...data }) + String.fromCharCode(10, 10))
  ev('response.created', { response: { id } })
  if (typeof action === 'string') {
    const item = { type: 'message', id: 'msg_' + id, role: 'assistant', content: [] }
    ev('response.output_item.added', { output_index: 0, item })
    ev('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: action })
    ev('response.output_item.done', { output_index: 0, item })
  } else {
    action.forEach((call, index) => {
      const item = { type: 'function_call', id: 'fc_' + id + '_' + index, call_id: 'call_' + id + '_' + index, name: call.name, arguments: '' }
      ev('response.output_item.added', { output_index: index, item })
      ev('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: JSON.stringify(call.input) })
      ev('response.output_item.done', { output_index: index, item: { ...item, arguments: JSON.stringify(call.input) } })
    })
  }
  ev('response.completed', { response: { id, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })
  return out.join('')
}
