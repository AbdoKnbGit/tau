import assert from 'node:assert/strict'
import { codexApi, CodexApiError } from './api.js'
import { codexLane } from './loop.js'

const original = codexApi.streamResponses
const requests: any[] = []
let attempts: Array<any[] | Error> = []
codexApi.streamResponses = async function* (request) {
  requests.push(structuredClone(request))
  const attempt = attempts.shift()
  assert(attempt, 'unexpected extra request')
  if (attempt instanceof Error) throw attempt
  for (const event of attempt) {
    if (event instanceof Error) throw event
    yield event
  }
}
const created = { type: 'response.created', response: { id: 'response' } }
const completed = { type: 'response.completed', response: { id: 'response', usage: { input_tokens: 128, output_tokens: 3 } } }
const reasoningStart = (index = 0) => ({ type: 'response.output_item.added', output_index: index, item: { type: 'reasoning', id: `rs-${index}` } })
const part = (index: number, output_index = 0) => ({ type: 'response.reasoning_summary_part.added', output_index, summary_index: index, part: { type: 'summary_text', text: '' } })
const delta = (text: string, index = 0, output_index = 0) => ({ type: 'response.reasoning_summary_text.delta', output_index, summary_index: index, delta: text })
const reasoningDone = (index = 0, encrypted = 'encrypted-success') => ({ type: 'response.output_item.done', output_index: index,
  item: { type: 'reasoning', id: `rs-${index}`, encrypted_content: encrypted, summary: [] } })
const textStart = { type: 'response.output_item.added', output_index: 3, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } }
const textDelta = { type: 'response.output_text.delta', output_index: 3, delta: 'OK' }
const textDone = { type: 'response.output_item.done', output_index: 3, item: { type: 'message', id: 'msg' } }
const success = [created, reasoningStart(), delta('Successful thought'), reasoningDone(), textStart, textDelta, textDone, completed]
const disconnected = () => Object.assign(new Error('websocket closed before the response completed'), { code: 'ECONNRESET' })
const failedThinking = [created, reasoningStart(), delta('Discard this failed thought'), reasoningDone(0, 'encrypted-failed')]
async function run(script: Array<any[] | Error>, model = 'gpt-6-sol', controller = new AbortController()) {
  attempts = script
  requests.length = 0
  const events = []
  for await (const event of codexLane.streamAsProvider({ model, messages: [{ role: 'user', content: 'Audit.' }],
    tools: [], effortValue: null, max_tokens: 100, sessionId: 'retry-test', signal: controller.signal })) events.push(event)
  return events
}
const text = (events: any[], type: string) => events.filter(e => e.type === 'content_block_delta' && e.delta?.type === type)
  .map(e => e.delta[type === 'text_delta' ? 'text' : 'thinking']).join('')
let count = 0
async function check(name: string, fn: () => Promise<void>) { await fn(); console.log(`ok ${name}`); count++ }

try {
  for (const model of ['gpt-6-sol', 'gpt-5.6-luna']) {
    await check(`${model}: retry discards partial thinking and preserves request bytes`, async () => {
      const events = await run([[...failedThinking, disconnected()], success], model)
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[1], requests[0])
      assert.equal(events.filter(e => e.type === 'message_start').length, 1)
      assert.equal(text(events, 'text_delta'), 'OK')
      assert.equal(text(events, 'thinking_delta'), 'Successful thought')
      assert(!JSON.stringify(events).includes('encrypted-failed'))
    })
    await check(`${model}: EOF retries once and reports a second failure`, async () => {
      const events = await run([failedThinking, [...failedThinking, disconnected()]], model)
      assert.equal(requests.length, 2)
      assert.match(text(events, 'text_delta'), /Codex API error.*closed/)
      assert.equal(text(events, 'thinking_delta'), '')
      assert(!JSON.stringify(events).includes('encrypted-failed'))
    })
    await check(`${model}: retry a transient server failure event`, async () => {
      const events = await run([[...failedThinking, { type: 'response.failed', response: { error: { code: 'server_error', message: 'Try again' } } }], success], model)
      assert.equal(requests.length, 2)
      assert.equal(text(events, 'text_delta'), 'OK')
    })
  }
  await check('no retry after text', async () => {
    const events = await run([[created, textStart, textDelta, disconnected()]])
    assert.equal(requests.length, 1)
    assert.match(text(events, 'text_delta'), /^OKCodex API error/)
  })
  await check('Node fetch body interruption retries by its nested transport cause', async () => {
    const error = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
    const events = await run([[...failedThinking, error], success])
    assert.equal(requests.length, 2)
    assert.equal(text(events, 'text_delta'), 'OK')
    assert(!JSON.stringify(events).includes('encrypted-failed'))
  })
  for (const type of ['function_call', 'custom_tool_call']) {
    const item = { type, id: 'fc', call_id: 'call', name: 'shell', arguments: '{"command":"echo ok"}', input: 'echo ok' }
    const added = { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '', input: '' } }
    const args = { type: type === 'function_call' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta',
      output_index: 1, delta: type === 'function_call' ? '{"command":' : 'echo' }
    const done = { type: 'response.output_item.done', output_index: 1, item }
    for (const model of ['gpt-6-sol', 'gpt-5.6-luna']) {
      await check(`${model}: unfinished ${type} retries without emitting failed reasoning or a tool`, async () => {
        const events = await run([[...failedThinking, added, args, disconnected()],
          [created, reasoningStart(), delta('Successful thought'), reasoningDone(), added, done, completed]], model)
        assert.equal(requests.length, 2)
        assert.deepEqual(requests[0], requests[1])
        assert.equal(text(events, 'thinking_delta'), 'Successful thought')
        assert(!JSON.stringify(events).includes('encrypted-failed'))
        assert.equal(events.filter(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use').length, 1)
        assert(!text(events, 'text_delta').includes('Codex API error'))
      })
    }
    await check(`no retry after a complete ${type} is emitted`, async () => {
      const events = await run([[...failedThinking, added, done, disconnected()]])
      assert.equal(requests.length, 1)
      assert.equal(events.filter(e => e.type === 'content_block_start' && e.content_block?.type === 'tool_use').length, 1)
      assert.match(text(events, 'text_delta'), /Codex API error.*closed/)
    })
  }
  await check('authentication and non-transient failures are not retried', async () => {
    const events = await run([[...failedThinking, new CodexApiError(401, 'Unauthorized')]])
    assert.equal(requests.length, 1)
    assert.match(text(events, 'text_delta'), /401/)
  })
  await check('cancellation is not retried', async () => {
    const events = await run([[...failedThinking, new DOMException('Aborted', 'AbortError')]])
    assert.equal(requests.length, 1)
    assert.equal(text(events, 'text_delta'), '')
  })
  await check('successful reasoning-only and output-capped replies are not retried', async () => {
    for (const terminal of [completed, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]) {
      const events = await run([[...failedThinking, terminal]])
      assert.equal(requests.length, 1)
      assert.equal(text(events, 'thinking_delta'), 'Discard this failed thought')
    }
  })
  await check('separate summary parts, including missing part events and empty parts', async () => {
    const events = await run([[created, reasoningStart(), part(0), delta('**A**'), delta(' continuation'),
      part(1), delta('', 1), delta('**B**', 1), delta('**C**', 2), part(3), part(4), delta('**D**', 4),
      reasoningDone(), reasoningStart(1), delta('Second item', 0, 1), reasoningDone(1), textStart, textDelta, textDone, completed]])
    assert.equal(text(events, 'thinking_delta'), '**A** continuation\n\n**B**\n\n**C**\n\n**D**Second item')
  })
  console.log(`${count} Codex stream checks passed`)
} finally {
  codexApi.streamResponses = original
  codexApi.clearChain()
}
