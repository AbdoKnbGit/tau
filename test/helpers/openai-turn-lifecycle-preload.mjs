// Local Responses fixture for the real stream-json CLI. Never calls original fetch.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const rounds = new Map()
const log = record => appendFileSync(process.env.TAU_TURN_LIFECYCLE_LOG, JSON.stringify(record) + '\n')

function response(turn, round) {
  const id = `resp_lifecycle_${turn}_${round}`
  const events = []
  const event = (type, fields) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  event('response.created', { response: { id } })
  if (round < 2) {
    const item = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'read_file',
      arguments: JSON.stringify({ file_path: join(process.cwd(), round === 0 ? 'alpha.txt' : 'beta.txt') }) }
    event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } })
    event('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments })
    event('response.output_item.done', { output_index: 0, item })
  } else {
    const text = `TURN_LIFECYCLE_DONE_${turn}`
    const item = { type: 'message', id: `msg_${id}`, role: 'assistant', content: [{ type: 'output_text', text }] }
    event('response.output_item.added', { output_index: 0, item: { ...item, content: [] } })
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
    event('response.output_item.done', { output_index: 0, item })
  }
  event('response.completed', { response: { id,
    usage: { input_tokens: 1500, output_tokens: 10, input_tokens_details: { cached_tokens: round ? 1024 : 0 } } } })
  return new Response(events.join(''), { headers: {
    'content-type': 'text/event-stream', 'x-codex-turn-state': `routing-${turn}-${round}`,
  } })
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.includes('/responses') || !init.body) {
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }
  const body = JSON.parse(String(init.body))
  const users = (body.input ?? []).filter(item => item.role === 'user')
  const prompts = users.map(item => JSON.stringify(item.content ?? ''))
  const turn = [...prompts].reverse().map(text => /TURN_LIFECYCLE_(FIRST|SECOND|RESUMED)/.exec(text)?.[1]).find(Boolean)
  if (!turn) throw new Error('Lifecycle fixture received an unexpected model request')
  const round = rounds.get(turn) ?? 0
  rounds.set(turn, round + 1)
  log({ turn, round, model: body.model, effort: body.reasoning?.effort,
    sessionId: body.prompt_cache_key, sentTurnState: new Headers(init.headers).get('x-codex-turn-state'),
    leakedTurnId: Object.hasOwn(body, 'turnId'),
    previousPrompts: ['FIRST', 'SECOND'].filter(previous => prompts.some(text => text.includes(`TURN_LIFECYCLE_${previous}`))),
    readResults: (body.input ?? []).filter(item => item.type === 'function_call_output').map(item => item.output),
  })
  if (round > 2) throw new Error(`Unexpected extra round for ${turn}`)
  return response(turn, round)
}
