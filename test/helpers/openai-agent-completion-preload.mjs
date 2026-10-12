// Deterministic Responses API for the real print-mode notification test.
// Every network request is handled locally; this never calls the original fetch.
import { appendFileSync } from 'node:fs'

let sequence = 0
let parentRound = 0
let releaseChild
const parentContinued = new Promise(resolve => { releaseChild = resolve })
const log = value => appendFileSync(process.env.TAU_NOTIFICATION_TEST_LOG, JSON.stringify(value) + '\n')

function response(action) {
  const id = `resp_notification_${++sequence}`
  const events = []
  const event = (type, fields) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  event('response.created', { response: { id } })
  if (typeof action === 'string') {
    const item = { type: 'message', id: `msg_${id}`, role: 'assistant', content: [{ type: 'output_text', text: action }] }
    event('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: action })
    event('response.output_item.done', { output_index: 0, item })
  } else {
    const item = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: action.name, arguments: JSON.stringify(action.input) }
    event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } })
    event('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments })
    event('response.output_item.done', { output_index: 0, item })
  }
  event('response.completed', { response: { id, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })
  return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } })
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.includes('/responses') || !init.body) {
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }
  const body = JSON.parse(String(init.body))
  const users = (body.input ?? []).filter(item => item.role === 'user')
  const initial = JSON.stringify(users[0]?.content ?? '')
  if (initial.includes('NOTIFICATION_CHILD')) {
    await parentContinued
    log({ kind: 'child-finished', model: body.model })
    return response('NOTIFICATION_CHILD_DONE')
  }
  if (!initial.includes('NOTIFICATION_PARENT')) return response('ok')
  // Tau may fold a queued reminder into the preceding tool result before
  // converting history to Responses items. It still reaches the next request.
  const incoming = (body.input ?? []).filter(item => item.role === 'user' || item.type === 'function_call_output')
  const notified = incoming.some(item => {
    const text = JSON.stringify(item)
    return text.includes('<task-notification>') && text.includes('NOTIFICATION_CHILD_DONE')
  })
  log({ kind: 'parent-request', round: parentRound, notified, model: body.model, input: body.input })
  if (parentRound++ === 0) {
    return response({ name: 'Agent', input: {
      subagent_type: 'general-purpose', description: 'Complete notification test',
      prompt: 'NOTIFICATION_CHILD: return the requested result.', run_in_background: true,
    } })
  }
  if (notified) return response('NOTIFICATION_DELIVERED_MIDTURN')
  if (parentRound > 5) return response('NOTIFICATION_MISSING')
  releaseChild()
  return response({ name: 'shell', input: {
    command: `"${process.execPath.replaceAll('\\', '/')}" -e "setTimeout(()=>{},1000)"`,
  } })
}
