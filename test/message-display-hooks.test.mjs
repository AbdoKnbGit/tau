import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fixtureContext, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const directory = mkdtempSync(join(tmpdir(), 'tau-message-display-'))
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
})
after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10 }))
const r = await loadMcpRuntime({
  paths: ['src/utils/hooks/messageDisplay.ts'],
  exports: ['MessageDisplayBuffer', 'withMessageDisplay', 'getMessageDisplayText', 'getStreamDisplayText', 'messageForDisplay'],
})

const stream = event => ({ type: 'stream_event', event })
const start = () => stream({ type: 'message_start' })
const beginText = (index = 0) => stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
const delta = (text, index = 0) => stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const stop = (index = 0) => stream({ type: 'content_block_stop', index })
const assistant = text => ({ type: 'assistant', uuid: `assistant-${text}`, message: { role: 'assistant', content: [{ type: 'text', text }] } })
async function* source(events, result = 'completed') {
  yield* events
  return result
}
async function collect(generator) {
  const messages = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { messages, result: next.value }
    messages.push(next.value)
  }
}

test('streaming batches keep whole lines, stable IDs and a single final remainder', async () => {
  const batches = []
  const buffer = new r.MessageDisplayBuffer('turn', async batch => {
    batches.push(batch)
    return batch.delta.toUpperCase()
  })
  assert.equal(await buffer.append('first'), '')
  assert.equal(await buffer.append(' line\nsecond\nremain'), 'FIRST LINE\nSECOND\n')
  assert.equal(await buffer.append('der'), '')
  assert.equal(await buffer.append('', true), 'REMAINDER')
  assert.equal(await buffer.append('ignored after final', true), '')
  assert.deepEqual(batches.map(({ index, final, delta }) => ({ index, final, delta })), [
    { index: 0, final: false, delta: 'first line\nsecond\n' },
    { index: 1, final: true, delta: 'remainder' },
  ])
  assert.equal(new Set(batches.map(batch => batch.message_id)).size, 1)
  assert.ok(batches.every(batch => batch.turn_id === 'turn'))
  assert.equal(buffer.text, 'FIRST LINE\nSECOND\nREMAINDER')
})

test('a newline-terminated message still sends exactly one empty final batch', async () => {
  const batches = []
  const buffer = new r.MessageDisplayBuffer('turn', async batch => { batches.push(batch) })
  assert.equal(await buffer.append('line\n'), 'line\n')
  assert.equal(await buffer.append('', true), '')
  await buffer.append('', true)
  assert.deepEqual(batches.map(batch => [batch.final, batch.delta]), [[false, 'line\n'], [true, '']])
})

for (const timing of ['native assistant before stop', 'adapter assistant after stop']) {
  test(`${timing}: final transformation runs once and never changes stored text`, async () => {
    const message = assistant('first\nremainder')
    const chunks = [delta('fir'), delta('st\nremain'), delta('der')]
    const events = [start(), beginText(), ...chunks,
      ...(timing.startsWith('native') ? [message, stop()] : [stop(), message]),
    ]
    const before = JSON.stringify(events)
    const batches = []
    const result = await collect(r.withMessageDisplay(source(events, { reason: 'completed' }), fixtureContext([]), async batch => {
      batches.push(batch)
      return batch.delta.toUpperCase()
    }, false))
    assert.deepEqual(result.result, { reason: 'completed' })
    assert.equal(result.messages.length, events.length)
    result.messages.forEach((event, index) => assert.equal(event, events[index]))
    assert.equal(batches.filter(batch => batch.final).length, 1)
    assert.equal(r.getMessageDisplayText(message.message.content[0]), 'FIRST\nREMAINDER')
    assert.deepEqual(chunks.map(chunk => r.getStreamDisplayText(chunk.event.delta)), ['', 'FIRST\n', ''])
    const rendered = r.messageForDisplay(message)
    assert.notEqual(rendered, message)
    assert.notEqual(rendered.message.content[0], message.message.content[0])
    assert.equal(rendered.message.content[0].text, 'FIRST\nREMAINDER')
    assert.equal(message.message.content[0].text, 'first\nremainder')
    assert.equal(JSON.stringify(events), before, 'transcript/copy/model history must remain unchanged')
  })
}

test('headless display transforms one complete batch and keeps stream events original', async () => {
  const message = assistant('first\nsecond')
  const chunk = delta('first\nsecond')
  const batches = []
  const events = [start(), beginText(), chunk, stop(), message]
  await collect(r.withMessageDisplay(source(events), fixtureContext([]), async batch => {
    batches.push(batch)
    return 'display only'
  }, true))
  assert.equal(batches.length, 1)
  assert.deepEqual({ index: batches[0].index, final: batches[0].final, delta: batches[0].delta }, { index: 0, final: true, delta: 'first\nsecond' })
  assert.equal(r.getStreamDisplayText(chunk.event.delta), 'first\nsecond')
  assert.equal(r.messageForDisplay(message).message.content[0].text, 'display only')
  assert.equal(message.message.content[0].text, 'first\nsecond')
})

test('initial text carried by content_block_start is retained in the transformed display', async () => {
  const begin = beginText()
  begin.event.content_block.text = 'initial '
  const message = assistant('initial remainder')
  const batches = []
  await collect(r.withMessageDisplay(source([
    start(), begin, delta('remainder'), stop(), message,
  ]), fixtureContext([]), async batch => { batches.push(batch); return batch.delta.toUpperCase() }, false))
  assert.deepEqual(batches.map(batch => batch.delta), ['initial remainder'])
  assert.equal(r.getMessageDisplayText(message.message.content[0]), 'INITIAL REMAINDER')
  assert.equal(begin.event.content_block.text, 'initial ')
  assert.equal(message.message.content[0].text, 'initial remainder')
})

test('empty replacements hide a batch; undefined values and hook failures preserve originals', async () => {
  const outcomes = [() => '', () => undefined, () => { throw new Error('fixture hook failed') }]
  for (const [index, transform] of outcomes.entries()) {
    const message = assistant(`original-${index}`)
    await collect(r.withMessageDisplay(source([message]), fixtureContext([]), async () => transform(), true))
    assert.equal(r.getMessageDisplayText(message.message.content[0]), index === 0 ? '' : `original-${index}`)
    assert.equal(message.message.content[0].text, `original-${index}`)
  }
})

test('stopping the display consumer closes the underlying query generator', async () => {
  let cleanedUp = 0
  async function* cancellable() {
    try {
      yield start()
      yield beginText()
    } finally { cleanedUp++ }
  }
  const wrapped = r.withMessageDisplay(cancellable(), fixtureContext([]), async () => undefined, false)
  assert.equal((await wrapped.next()).done, false)
  await wrapped.return('cancelled')
  assert.equal(cleanedUp, 1)
})

test('consecutive provider messages get distinct IDs and independent final batches', async () => {
  const messages = [assistant('one'), assistant('two')]
  const batches = []
  await collect(r.withMessageDisplay(source([
    start(), beginText(), delta('one'), stop(), messages[0],
    start(), beginText(), delta('two'), messages[1], stop(),
  ]), fixtureContext([]), async batch => { batches.push(batch); return `<${batch.delta}>` }, false))
  assert.deepEqual(batches.map(batch => [batch.index, batch.final, batch.delta]), [[0, true, 'one'], [0, true, 'two']])
  assert.notEqual(batches[0].message_id, batches[1].message_id)
  assert.equal(batches[0].turn_id, batches[1].turn_id)
  assert.deepEqual(messages.map(message => r.getMessageDisplayText(message.message.content[0])), ['<one>', '<two>'])
})
