#!/usr/bin/env node
// Standalone synthetic reproduction: no Tau imports, project reads, or tool execution.
// Dry run: node scripts/diagnose-openrouter-tools.mjs --model <OpenRouter model ID>
// Live: add --live and supply OPENROUTER_API_KEY in the environment.
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  model: { type: 'string' }, live: { type: 'boolean', default: false },
} })
if (!values.model) throw new Error('Pass --model <OpenRouter model ID>.')
const apiKey = process.env.OPENROUTER_API_KEY
if (values.live && !apiKey) throw new Error('Live testing requires OPENROUTER_API_KEY.')
const location = 'C:\\Temp\\synthetic-only.txt'
const longValue = Array.from({ length: 280 }, (_, i) =>
  `row ${i}: "quoted" \\path\\part; synthetic data`).join('\n')
const cases = [
  { label: 'long-stream-strict', value: longValue, stream: true, strict: true },
  { label: 'long-stream', value: longValue, stream: true },
  { label: 'short-stream', value: 'Synthetic record.', stream: true },
  { label: 'long-completion', value: longValue, stream: false },
]

for (const example of cases) {
  const body = {
    model: values.model,
    messages: [
      { role: 'system', content: 'Use the supplied tool to record exactly the user-provided data. Call it once. Do not summarize or abbreviate the value.' },
      { role: 'user', content: JSON.stringify({ location, value: example.value }) },
    ],
    tools: [{ type: 'function', function: {
      name: 'StoreRecord', description: 'Record the supplied location and value exactly.',
      parameters: { type: 'object', properties: {
        location: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      }, required: ['location', 'value'], additionalProperties: false },
      ...(example.strict && { strict: true }),
    } }],
    tool_choice: 'auto', max_tokens: 8192, temperature: 0,
    stream: example.stream,
    ...(example.stream && { stream_options: { include_usage: true } }),
    usage: { include: true },
    session_id: 'tau-synthetic-strict-comparison-20260923',
    prompt_cache_key: 'tau-synthetic-strict-comparison-20260923',
  }
  if (!values.live) {
    console.log(JSON.stringify({ label: example.label, dryRun: true, model: body.model,
      stream: body.stream, strict: example.strict ?? 'omitted', valueChars: example.value.length,
      requestSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }))
    continue
  }
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/AbdoKnbGit/tau', 'X-OpenRouter-Title': 'Tau' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    })
    const raw = await response.text()
    const isSSE = response.headers.get('content-type')?.includes('text/event-stream')
    const chunks = isSSE ? raw.split(/\r?\n\r?\n/).flatMap(frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n')
      return data && data !== '[DONE]' ? [JSON.parse(data)] : []
    }) : [JSON.parse(raw)]
    const calls = new Map()
    const result = { label: example.label, status: response.status }
    for (const chunk of chunks) {
      result.id = chunk.id ?? result.id
      result.provider = chunk.provider ?? result.provider
      result.usage = chunk.usage ?? result.usage
      const choice = chunk.choices?.[0]
      result.finish = choice?.finish_reason ?? result.finish
      const error = chunk.error ?? choice?.error
      if (error) result.error = { code: error.code, message: cleanError(error.message) }
      const parts = choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? []
      for (const [index, part] of parts.entries()) {
        const key = part.index ?? index
        const call = calls.get(key) ?? { name: '', arguments: '' }
        call.name = part.function?.name ?? call.name
        call.arguments += part.function?.arguments ?? ''
        calls.set(key, call)
      }
    }
    result.calls = [...calls.values()].map(call => {
      let input
      try { input = JSON.parse(call.arguments) } catch {}
      return { name: call.name, argumentChars: call.arguments.length,
        validJSON: !!input && typeof input === 'object' && !Array.isArray(input),
        exact: input?.location === location && input?.value === example.value,
        argumentsSha256: createHash('sha256').update(call.arguments).digest('hex') }
    })
    console.log(JSON.stringify(result))
  } catch (error) {
    console.log(JSON.stringify({ label: example.label, transportError: cleanError(error.message) }))
  }
}

function cleanError(message) {
  const text = String(message ?? '').replace(/[\x00-\x1f\x7f]/g, ' ')
  return (apiKey ? text.replaceAll(apiKey, '[redacted]') : text).slice(0, 500)
}
