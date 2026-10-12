import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { WebSocketServer } from 'ws'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const tempRoot = realpathSync(tmpdir())
const config = mkdtempSync(join(tempRoot, 'tau-reasoning-transport-'))
process.env.CLAUDE_CONFIG_DIR = config
process.env.DISABLE_TELEMETRY = '1'
process.env.NODE_ENV = 'test'
for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CHATGPT_ACCESS_TOKEN',
  'OPENAI_CHATGPT_ACCOUNT_ID', 'OPENAI_CHATGPT_ID_TOKEN', 'TAU_CODEX_WEBSOCKET',
  'OPENAI_REASONING_EFFORT', 'CLAUDE_CODE_EFFORT_LEVEL']) delete process.env[key]

const r = await loadMcpRuntime()
const seen = []
let socketConnections = 0
let drop = null

function events(body) {
  const id = `resp-${seen.length}`
  const reasoning = { type: 'reasoning', id: `rs-${id}`, encrypted_content: `opaque-${id}`,
    summary: [{ type: 'summary_text', text: 'Inspect the fixture.' }] }
  const call = { type: 'function_call', id: `fc-${id}`, call_id: `call-${id}`,
    name: 'read_file', arguments: JSON.stringify({ file_path: 'fixture.txt' }) }
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: reasoning.id, summary: [] } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: reasoning.summary[0].text },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.done', output_index: 1, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 1, item: call },
    { type: 'response.completed', response: { id, model: body.model, usage: { input_tokens: 2048,
      input_tokens_details: { cached_tokens: seen.length > 1 ? 1024 : 0 }, output_tokens: 16 } } },
  ]
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push({ transport: 'http', body })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const outgoing = events(body)
    if (drop && seen.length <= drop.count) {
      res.write(outgoing.slice(0, drop.cutAt).map(ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''))
      setTimeout(() => res.destroy(), 10)
    } else {
      res.end(outgoing.map(ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join(''))
    }
  })
})
const sockets = new WebSocketServer({ server })
sockets.on('connection', socket => {
  socketConnections++
  socket.on('message', bytes => {
    const body = JSON.parse(bytes.toString())
    seen.push({ transport: 'websocket', body })
    const outgoing = events(body)
    if (drop && seen.length <= drop.count) {
      for (const event of outgoing.slice(0, drop.cutAt)) socket.send(JSON.stringify(event))
      socket.close(1011, 'fixture interruption')
    } else {
      for (const event of outgoing) socket.send(JSON.stringify(event))
    }
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

test.after(async () => {
  r.codexApi.clearChain()
  for (const socket of sockets.clients) socket.terminate()
  await new Promise(resolve => sockets.close(resolve))
  await new Promise(resolve => server.close(resolve))
  const child = relative(tempRoot, realpathSync(config))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(config, { recursive: true, force: true })
})

for (const transport of ['http', 'websocket']) {
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra']) {
    test(`${model} persists and replays reasoning over ${transport}`, async () => {
      r.codexApi.clearChain()
      seen.length = 0
      socketConnections = 0
      drop = null
      const lane = new r.CodexLane()
      lane.configure({ baseUrl, apiKey: transport === 'http' ? 'api-key-fixture' : '',
        chatgptAccessToken: transport === 'websocket' ? 'oauth-fixture' : '' })
      const messages = [{ role: 'user', content: 'Inspect fixture.txt.' }]
      const send = requestModel => r.assembleFinalMessage(lane.streamAsProvider({
        model: requestModel, messages, system: 'Fixture instructions', tools: [{ name: 'Read',
          description: 'Read a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
        max_tokens: 100, effortValue: null, sessionId: `fixture-${transport}-${model}`,
        signal: new AbortController().signal,
      }), requestModel)
      const answer = await send(model)
      const reasoningState = answer.content.find(block => block._codex_reasoning)?._codex_reasoning
      assert.equal(reasoningState?.model, model)
      assert.deepEqual(reasoningState?.items[0], { id: 'rs-resp-1', encrypted_content: 'opaque-resp-1',
        summary: [{ type: 'summary_text', text: 'Inspect the fixture.' }] })
      const call = answer.content.find(block => block.type === 'tool_use')
      assert.equal(call.name, 'Read')
      // JSON is the persisted transcript boundary: no in-memory object identity survives.
      messages.push(JSON.parse(JSON.stringify({ role: 'assistant', content: answer.content })),
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'fixture contents' }] })
      await send(model)
      assert.ok(seen.every(row => row.transport === transport))
      assert.deepEqual(seen[0].body.reasoning, { summary: 'auto' })
      assert.deepEqual(seen[0].body.include, ['reasoning.encrypted_content'])
      const replay = seen[1].body.input
      assert.deepEqual(replay.slice(0, seen[0].body.input.length), seen[0].body.input)
      const index = replay.findIndex(item => item.type === 'reasoning')
      assert.ok(index >= 0)
      assert.deepEqual(replay[index], { type: 'reasoning', encrypted_content: 'opaque-resp-1', summary: [] })
      assert.equal(replay[index + 1].type, 'function_call')
      assert.equal(replay.filter(item => item.type === 'reasoning').length, 1)
      if (transport === 'websocket') assert.equal(socketConnections, 1)
      await send(model === 'gpt-6-sol' ? 'gpt-5.6-terra' : 'gpt-6-sol')
      assert.equal(seen[2].body.input.some(item => item.type === 'reasoning'), false, 'model switches must omit old state')
    })
  }

  for (const scenario of [
    { label: 'retries a reasoning-only interruption once', count: 1, cutAt: 4, attempts: 2, recovers: true },
    { label: 'stops after a second reasoning-only interruption', count: 2, cutAt: 4, attempts: 2, recovers: false },
    { label: 'retries an unfinished tool call without emitting it', count: 1, cutAt: 5, attempts: 2, recovers: true },
    { label: 'retries finished arguments before the tool call is emitted', count: 1, cutAt: 6, attempts: 2, recovers: true },
    { label: 'stops after a second unfinished tool call without emitting either', count: 2, cutAt: 5, attempts: 2, recovers: false },
    { label: 'does not retry after a complete tool call is emitted', count: 1, cutAt: 7, attempts: 1, recovers: false },
  ]) {
    test(`${transport} ${scenario.label}`, async () => {
      r.codexApi.clearChain()
      seen.length = 0
      socketConnections = 0
      drop = scenario
      const lane = new r.CodexLane()
      lane.configure({ baseUrl, apiKey: transport === 'http' ? 'api-key-fixture' : '',
        chatgptAccessToken: transport === 'websocket' ? 'oauth-fixture' : '' })
      let answer, failure
      try {
        answer = await r.assembleFinalMessage(lane.streamAsProvider({
          model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'Inspect fixture.txt.' }],
          system: 'Fixture instructions', tools: [], max_tokens: 100, effortValue: null,
          sessionId: `retry-${transport}-${scenario.count}-${scenario.cutAt}`,
          signal: new AbortController().signal,
        }), 'gpt-5.6-terra')
      } catch (error) { failure = error }
      assert.equal(seen.length, scenario.attempts)
      if (scenario.recovers) {
        assert.equal(failure, undefined)
        const calls = answer.content.filter(block => block.type === 'tool_use')
        assert.equal(calls.length, 1, 'only the successful attempt may emit an executable tool')
        assert.equal(calls[0].id, 'toolu_codex_call-resp-2')
        const states = answer.content.flatMap(block => block._codex_reasoning?.items ?? [])
        assert.ok(states.length > 0)
        assert.ok(states.every(item => item.encrypted_content === 'opaque-resp-2'), 'failed attempt leaked reasoning')
        assert.deepEqual(seen[0].body, seen[1].body, 'retry changed request bytes')
      } else {
        assert.ok(failure || answer.content.some(block => block.type === 'text' && /error/i.test(block.text)))
        if (answer) {
          assert.equal(answer.content.filter(block => block.type === 'tool_use').length, scenario.cutAt === 7 ? 1 : 0)
          if (scenario.cutAt < 7) assert.ok(!answer.content.some(block => block._codex_reasoning?.items.length))
          if (transport === 'websocket') assert.match(JSON.stringify(answer.content), /code 1011: fixture interruption/)
        }
      }
    })
  }
}
