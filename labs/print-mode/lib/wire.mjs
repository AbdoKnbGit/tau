// Reads one captured model request, whatever provider format it is in, into the same shape.
export const MARKER = 'LAB-PROMPT'

export function formatOfPath(pathname) {
  if (/generateContent/i.test(pathname)) return 'gemini'
  if (pathname.endsWith('/messages')) return 'anthropic'
  if (pathname.endsWith('/chat/completions')) return 'chat'
  if (pathname.endsWith('/responses')) return 'responses'
  if (pathname.endsWith('/api/chat')) return 'ollama'
  return 'other'
}

// A provider's cache markers move forward each turn by design, so they are not part of the prefix.
export function stripCacheMarkers(value) {
  if (Array.isArray(value)) return value.map(stripCacheMarkers)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'cache_control')
    .map(([key, inner]) => [key, stripCacheMarkers(inner)]))
}

const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part?.text ?? part?.content ?? '').join('\n')
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

// Fields that are random per run or per request and never part of a cache key.
const PER_RUN_FIELDS = new Set(['metadata', 'requestId', 'prompt_cache_key', 'user', 'session_id', 'sessionId', 'conversation_id', 'safety_identifier', 'labels', 'stream_options'])

function restOf(source, skip) {
  return JSON.stringify(stripCacheMarkers(Object.fromEntries(Object.entries(source)
    .filter(([key]) => !skip.includes(key) && !PER_RUN_FIELDS.has(key)))))
}

export function readRequest(record) {
  const body = JSON.parse(record.body)
  const { format } = record
  if (format === 'gemini') {
    const inner = body.request ?? body
    const declarations = (inner.tools ?? []).flatMap(tool => tool.functionDeclarations ?? [])
    return {
      format, body,
      tools: declarations.map(tool => ({ name: tool.name, properties: (tool.parameters ?? tool.parametersJsonSchema)?.properties ?? {} })),
      toolsJson: JSON.stringify(inner.tools ?? []),
      systemJson: JSON.stringify(inner.systemInstruction ?? ''),
      systemText: (inner.systemInstruction?.parts ?? []).map(part => part.text ?? '').join('\n'),
      configJson: restOf(inner, ['contents', 'tools', 'systemInstruction']),
      history: inner.contents ?? [],
      toolResults: (inner.contents ?? []).flatMap(content => content.parts ?? []).filter(part => part.functionResponse).map(part => ({
        text: JSON.stringify(part.functionResponse.response ?? {}),
        isError: !!part.functionResponse.response?.error,
      })),
      sessionKey: inner.sessionId ?? null,
      headers: record.headers,
    }
  }
  if (format === 'responses') {
    const input = Array.isArray(body.input) ? body.input : []
    return {
      format, body,
      tools: (body.tools ?? []).map(tool => ({ name: tool.name ?? tool.function?.name, properties: (tool.parameters ?? tool.function?.parameters)?.properties ?? {} })),
      toolsJson: JSON.stringify(body.tools ?? []),
      systemJson: JSON.stringify(body.instructions ?? ''),
      systemText: typeof body.instructions === 'string' ? body.instructions : '',
      configJson: restOf(body, ['input', 'tools', 'instructions', 'previous_response_id']),
      history: input,
      toolResults: input.filter(item => item?.type === 'function_call_output').map(item => ({ text: textOf(item.output), isError: false })),
      sessionKey: body.prompt_cache_key ?? null,
      headers: record.headers,
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (format === 'anthropic') {
    // Tau gives the newest message a cache marker, which needs the block form, and takes it off next
    // turn. The Messages API defines a string as one text block, so they are the same message.
    const stripped = stripCacheMarkers(messages).map(message => (typeof message.content === 'string'
      ? { ...message, content: [{ type: 'text', text: message.content }] }
      : message))
    return {
      format, body,
      tools: (body.tools ?? []).map(tool => ({ name: tool.name, properties: tool.input_schema?.properties ?? {} })),
      toolsJson: JSON.stringify(stripCacheMarkers(body.tools ?? [])),
      systemJson: JSON.stringify(stripCacheMarkers(body.system ?? '')),
      systemText: textOf(body.system),
      configJson: restOf(body, ['messages', 'tools', 'system']),
      history: stripped,
      toolResults: messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))
        .filter(block => block.type === 'tool_result')
        .map(block => ({ text: textOf(block.content), isError: !!block.is_error })),
      sessionKey: null,
      headers: record.headers,
    }
  }
  // OpenAI chat format and Ollama both carry the system prompt inside messages.
  return {
    format, body,
    tools: (body.tools ?? []).map(tool => ({ name: tool.function?.name ?? tool.name, properties: tool.function?.parameters?.properties ?? {} })),
    toolsJson: JSON.stringify(stripCacheMarkers(body.tools ?? [])),
    systemJson: JSON.stringify(stripCacheMarkers(messages.filter(message => message.role === 'system'))),
    systemText: messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n'),
    configJson: restOf(body, ['messages', 'tools']),
    // The same string and one-block form as above, on a route that passes Anthropic's markers through.
    history: stripCacheMarkers(messages).map(message => (Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === 'text'
      ? { ...message, content: message.content[0].text }
      : message)),
    toolResults: messages.filter(message => message.role === 'tool').map(message => ({ text: textOf(message.content), isError: false })),
    sessionKey: body.prompt_cache_key ?? null,
    headers: record.headers,
  }
}

// What a cache needs to stay the same: tools, system prompt and request settings.
export const prefixOf = request => `${request.toolsJson}\n${request.systemJson}\n${request.configJson}`

/** Where the prefix of two requests first differs, for a readable failure message. */
export function firstDifference(a, b) {
  for (const [label, x, y] of [['tools', a.toolsJson, b.toolsJson], ['system prompt', a.systemJson, b.systemJson], ['settings', a.configJson, b.configJson]]) {
    if (x === y) continue
    let at = 0
    while (at < x.length && x[at] === y[at]) at++
    return `${label} differ at byte ${at}: "${x.slice(Math.max(0, at - 30), at + 70)}" vs "${y.slice(Math.max(0, at - 30), at + 70)}"`
  }
  return null
}
