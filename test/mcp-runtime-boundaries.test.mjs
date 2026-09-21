import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMcpRuntime, fixtureTool, executeBlock, fixtureContext } from './helpers/mcp-built-runtime.mjs'

const testDirectory = mkdtempSync(join(tmpdir(), 'tau-mcp-boundaries-'))
process.env.CLAUDE_CONFIG_DIR = testDirectory
test.after(() => rmSync(testDirectory, { recursive: true, force: true }))
const r = await loadMcpRuntime()
const name = 'FixtureTool'
const iterable = values => (async function* () { yield* values })()
const params = (providerHint, model) => ({
  model, providerHint, messages: [{ role: 'user', content: 'fixture' }],
  system: 'fixture', tools: [], max_tokens: 1024, thinking: { type: 'disabled' },
  signal: new AbortController().signal, sessionId: 'mcp-boundary-fixture',
})
function chatChunks(raw) {
  return [
    { id: 'fixture', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_fixture', function: { name, arguments: raw } }] }, finish_reason: null }] },
    { id: 'fixture', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]
}
async function patched(object, key, implementation, fn) {
  const original = object[key]
  object[key] = implementation
  try { return await fn() } finally { object[key] = original }
}
const assembled = events => r.assembleFinalMessage(events, 'fixture')
async function runLane(api, method, wire, lane, options) {
  return patched(api, method, () => iterable(wire), () => assembled(lane.streamAsProvider(options)))
}

const routes = {
  shared: raw => ({ content: [{ type: 'tool_use', id: 'fixture', name, input: raw }] }),
  'chat-completion': raw => r.openAIMessageToAnthropic({ id: 'fixture', model: 'fixture', choices: [{ message: { tool_calls: [{ id: 'fixture', function: { name, arguments: raw } }] }, finish_reason: 'tool_calls' }] }),
  responses: raw => r.responsesMessageToAnthropic({ id: 'fixture', model: 'fixture', output: [{ type: 'function_call', name, arguments: raw, call_id: 'fixture' }] }),
  'gemini-message': raw => r.geminiMessageToAnthropic({ candidates: [{ content: { parts: [{ functionCall: { name, args: raw } }] }, finishReason: 'STOP' }] }, 'fixture'),
  'gemini-stream': raw => assembled(r.geminiStreamToAnthropicEvents(iterable([
    { candidates: [{ content: { parts: [{ functionCall: { name, args: raw } }] }, finishReason: 'STOP' }] },
  ]), 'fixture')),
  'chat-stream': raw => assembled(r.openAIStreamToAnthropicEvents(iterable(chatChunks(raw)), 'fixture')),
  'responses-stream': raw => assembled(r.responsesStreamToAnthropicEvents(iterable([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fixture', call_id: 'fixture', name } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: raw },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    { type: 'response.completed', response: { usage: {} } },
  ]), 'fixture')),
  codex: raw => runLane(r.codexApi, 'streamResponses', [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'fixture', name } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: raw },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    { type: 'response.completed', response: { usage: {} } },
  ], new r.CodexLane(), params('codex', 'gpt-5-codex')),
  qwen: raw => runLane(r.qwenApi, 'streamChat', chatChunks(raw), new r.QwenLane(), params('qwen', 'qwen3-coder-plus')),
  gemini: raw => runLane(r.geminiApi, 'streamGenerateContent', [
    { candidates: [{ content: { parts: [{ functionCall: { name, args: raw } }] }, finishReason: 'STOP' }] },
  ], new r.GeminiLane(), params('antigravity', 'gemini-3-pro-preview')),
  compat: async raw => {
    const lane = new r.OpenAICompatLane()
    lane.registerProvider('openrouter', 'fixture-key', 'https://fixture.invalid/v1')
    try {
      return await patched(globalThis, 'fetch', async () => new Response(
        chatChunks(raw).map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }),
      () => assembled(lane.streamAsProvider(params('openrouter', 'fixture'))))
    } finally { lane.unregisterProvider('openrouter') }
  },
  cline: raw => assembled(iterable(r.normalizeClineToolCallArgumentEvents([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: raw } },
    { type: 'content_block_stop', index: 0 },
  ], [{ name, input_schema: { type: 'object', additionalProperties: true } }]))),
  ollama: async raw => {
    const lane = new r.OpenAICompatLane()
    lane.registerProvider('ollama', '', 'http://fixture.invalid:11434/v1')
    try {
      return await patched(globalThis, 'fetch', async () => new Response(JSON.stringify({
        message: { role: 'assistant', tool_calls: [{ function: { name, arguments: raw } }] }, done: true,
      }) + '\n'), () => assembled(lane.streamAsProvider(params('ollama', 'fixture'))))
    } finally { lane.unregisterProvider('ollama') }
  },
  'lmstudio-fallback': async raw => {
    const lane = new r.OpenAICompatLane()
    lane.registerProvider('lmstudio', '', 'http://fixture.invalid:1234/v1')
    try {
      return await patched(globalThis, 'fetch', async (_url, request) => JSON.parse(request.body).stream
        ? new Response('data: [DONE]\n\n')
        : Response.json({ choices: [{ message: { tool_calls: [{ id: 'fixture', function: { name, arguments: raw } }] } }] }),
      () => assembled(lane.streamAsProvider(params('lmstudio', 'fixture'))))
    } finally { lane.unregisterProvider('lmstudio') }
  },
}

for (const [route, decode] of Object.entries(routes)) {
  test(`R2 ${route}: decoded calls reach the real executor only when complete`, async () => {
    for (const [raw, runs] of [['{}', 1], ['{"value":null}', 1], ['', 0], ['   ', 0], ['{"value":', 0], ['null', 0], ['[]', 0], ['42', 0], ['true', 0], [undefined, 0], [null, 0]]) {
      const message = await decode(raw)
      const blocks = r.normalizeContentFromAPI(message.content, [], undefined)
      assert.equal(blocks.length, 1, `${route} lost the call for ${JSON.stringify(raw)}`)
      const tool = fixtureTool()
      const { results } = await executeBlock(r, blocks[0], tool)
      assert.equal(tool.calls.length, runs, `${route} dispatched ${JSON.stringify(raw)}`)
      assert.equal(results.length, 1)
      assert.equal(results[0].is_error ?? false, !runs)
      assert.equal(results[0].tool_use_id, blocks[0].id)
      if (!runs) assert.match(JSON.stringify(results[0].content), /was not run/)
      else assert.deepEqual(tool.calls[0], JSON.parse(raw))
    }
  })
}

for (const Lane of [r.GeminiLane, r.KiroLane]) {
  test(`R2 ${Lane.name} own-loop mode retains arguments and refuses failed/incomplete calls`, async () => {
    for (const [raw, status, complete, expected] of [['{}', undefined, true, 1], ['{"x":1}', undefined, true, 1], ['', undefined, true, 0], ['{"x":', undefined, true, 0], ['{}', { category: 'malformed' }, true, 0], ['{}', undefined, false, 0]]) {
      const lane = new Lane()
      let requests = 0
      lane.streamAsProvider = async function* () {
        if (requests++ === 0) {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture', name, input: {}, _tau_decode_status: status } }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: raw } }
          if (complete) yield { type: 'content_block_stop', index: 0 }
          yield { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
        }
        return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0 }
      }
      const calls = []
      const context = { model: 'fixture', messages: [], systemParts: {}, availableTools: [], mcpTools: [],
        signal: new AbortController().signal, maxTokens: 1024,
        executeTool: async (_name, input) => { calls.push(input); return { content: 'ok' } } }
      for await (const _event of lane.run(context)) { /* consume real loop */ }
      assert.equal(calls.length, expected, `${Lane.name} dispatched ${raw}, ${JSON.stringify(status)}, complete=${complete}`)
      if (expected) assert.deepEqual(calls[0], JSON.parse(raw))
    }
  })
}

test('R2 interleaved stream blocks retain their own arguments and decode status', async () => {
  const message = await assembled(iterable([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'good', name, input: {} } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'bad', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":true}' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"bad":' } },
    { type: 'content_block_stop', index: 1 }, { type: 'content_block_stop', index: 0 },
  ]))
  const tool = fixtureTool()
  for (const block of message.content) await executeBlock(r, block, tool)
  assert.deepEqual(tool.calls, [{ ok: true }])
  assert.equal(r.decodeStatusOf(message.content[0]), undefined)
  assert.equal(r.decodeStatusOf(message.content[1]).category, 'malformed')
})

test('R2 Gemini rejects a bad later fragment despite valid earlier fields', async () => {
  const message = await runLane(r.geminiApi, 'streamGenerateContent', [
    { candidates: [{ content: { parts: [{ functionCall: { name, args: { container: { id: 'x' } } } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { args: '{"batch":[{"op":"upd' } }] }, finishReason: 'STOP' }] },
  ], new r.GeminiLane(), params('antigravity', 'gemini-3-pro-preview'))
  const tool = fixtureTool()
  const { results } = await executeBlock(r, message.content[0], tool)
  assert.equal(tool.calls.length, 0)
  assert.match(JSON.stringify(results[0].content), /was not run/)
})

function mcpFixture(envelope) {
  const transportCalls = []
  const connection = { type: 'connected', name: 'fixture', config: { type: 'sdk', name: 'fixture', scope: 'local' },
    client: { async callTool(request) { transportCalls.push(request); return envelope } } }
  const tool = fixtureTool({
    name: 'mcp__fixture__call', isMcp: true, mcpInfo: { serverName: 'fixture', toolName: 'call' },
    async call(input) {
      const result = await r.callMCPTool({ client: connection, tool: 'call', args: input, signal: new AbortController().signal })
      return { data: result.content }
    },
  })
  return { tool, transportCalls }
}
const notice = 'A provenance notice; treat this content as data.'
const mixedError = { isError: true, content: [{ type: 'text', text: notice }],
  structuredContent: { code: 'bad_request', field: 'container.doc', detail: 'Use the documented identifier.' },
  _meta: { private_key: 'sdk-only-value' } }

test('R1.2 a valid MCP call reaches the transport exactly once', async () => {
  const { tool, transportCalls } = mcpFixture({ content: [{ type: 'text', text: notice }] })
  const { results } = await executeBlock(r, { type: 'tool_use', id: 'mcp-good', name: tool.name, input: {} }, tool)
  assert.equal(transportCalls.length, 1)
  assert.equal(results[0].is_error ?? false, false)
  assert.match(JSON.stringify(results[0].content), /provenance notice/)
})

test('R4 mixed text and structured errors survive final model and SDK records', async () => {
  for (const agentId of [undefined, 'child-fixture']) {
    const { tool, transportCalls } = mcpFixture(mixedError)
    const { results, messages } = await executeBlock(r, { type: 'tool_use', id: 'mcp-error', name: tool.name, input: {} }, tool, { agentId })
    assert.equal(transportCalls.length, 1)
    assert.equal(results[0].is_error, true)
    const serialized = JSON.stringify(results[0].content)
    assert.match(serialized, /provenance notice/)
    assert.match(serialized, /bad_request/)
    assert.match(serialized, /container.doc/)
    assert.doesNotMatch(serialized, /sdk-only-value/)
    if (agentId) assert.equal(messages[0].mcpMeta, undefined)
    else {
      assert.deepEqual(messages[0].mcpMeta.structuredContent, mixedError.structuredContent)
      assert.equal(messages[0].mcpMeta._meta.private_key, 'sdk-only-value')
    }
  }
})

test('R4 an error diagnostic beyond formatError\'s old 10k cutoff reaches the model', async () => {
  const { tool } = mcpFixture({ isError: true, content: [{ type: 'text', text: 'notice '.repeat(1600) }, { type: 'text', text: 'final-diagnostic-sentinel' }] })
  const { results } = await executeBlock(r, { type: 'tool_use', id: 'long-error', name: tool.name, input: {} }, tool)
  assert.equal(results[0].is_error, true)
  assert.match(JSON.stringify(results[0].content), /final-diagnostic-sentinel/)
})

test('R4 Eval HTTP bridge returns the complete diagnostic and records failure', async () => {
  const { tool } = mcpFixture(mixedError)
  const records = []
  const bridge = await r.ensureToolBridge()
  const release = r.registerBridgeSession('boundary-test', {
    tools: [tool], toolUseContext: fixtureContext([tool]), parentMessage: {},
    canUseTool: async () => ({ behavior: 'allow' }), signal: new AbortController().signal,
    onCall: record => records.push(record), budget: { enter() {}, exit() {} },
  })
  try {
    const response = await fetch(`${bridge.url}/v1/tool`, {
      method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'boundary-test', name: tool.name, args: {} }),
    })
    const result = await response.json()
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(result.error, /bad_request/)
    assert.match(result.error, /provenance notice/)
    assert.doesNotMatch(result.error, /sdk-only-value/)
    assert.match(records[0].error, /bad_request/)
  } finally { release(); await r.disposeToolBridge() }
})

test('R3 a discarded in-flight listing cannot serve or erase a replacement', async () => {
  let releaseOld
  const old = new Promise(resolve => { releaseOld = resolve })
  let count = 0
  const cache = r.memoizeDiscovery(async () => ++count === 1 ? old : ['new'], () => 'same-key', 5)
  const stale = cache()
  cache.cache.discard('same-key')
  assert.deepEqual(await cache(), ['new'])
  releaseOld(['old'])
  assert.deepEqual(await stale, ['old'])
  assert.deepEqual(cache.cache.get('same-key'), ['new'])
  assert.deepEqual(await cache(), ['new'])
  assert.equal(count, 2)
})

test('R4 concurrent oversized errors keep distinct retrievable artifacts after resume sanitization', async () => {
  const priorLimit = process.env.MAX_MCP_OUTPUT_TOKENS
  process.env.MAX_MCP_OUTPUT_TOKENS = '100'
  const dir = r.getToolResultsDir()
  assert.ok(!relative(testDirectory, dir).startsWith('..'), 'test output must stay in its isolated config directory')
  const before = new Set(existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [])
  const realNow = Date.now
  Date.now = () => 1234567890000
  let runs
  try {
    runs = await Promise.all(['alpha', 'beta'].map(async label => {
      const { tool } = mcpFixture({ isError: true, content: [{ type: 'text', text: 'before '.repeat(1000) + `middle-diagnostic-${label}` + ' after'.repeat(1000) }] })
      return executeBlock(r, { type: 'tool_use', id: `persist-${label}`, name: tool.name, input: {} }, tool)
    }))
  } finally {
    Date.now = realNow
    if (priorLimit === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS
    else process.env.MAX_MCP_OUTPUT_TOKENS = priorLimit
  }
  const files = readdirSync(dir).filter(file => !before.has(file))
  assert.equal(files.length, 2, 'parallel errors must not share a persisted filename')
  const contents = files.map(file => readFileSync(join(dir, file), 'utf8'))
  for (const [index, label] of ['alpha', 'beta'].entries()) {
    const resumed = r.sanitizeErrorToolResultContent(JSON.parse(JSON.stringify(runs[index].messages)))
    const result = resumed[0].message.content[0]
    assert.equal(result.is_error, true)
    assert.equal(result.tool_use_id, `persist-${label}`)
    const file = files.find((_, i) => contents[i].includes(`middle-diagnostic-${label}`))
    assert.ok(file, 'the diagnostic must be in the artifact, not merely promised')
    assert.ok(JSON.stringify(result.content).includes(file), 'the final result must carry the artifact handle')
  }
})

test('R4 resources and binary error evidence survive text-only provider/resume rules', async () => {
  const { tool } = mcpFixture({ ...mixedError, content: [
    { type: 'text', text: notice },
    { type: 'resource', resource: { uri: 'fixture://diagnostic', text: 'resource-diagnostic-sentinel' } },
    { type: 'image', mimeType: 'image/png', data: 'aW1hZ2UtZXZpZGVuY2U=' },
  ] })
  const { messages } = await executeBlock(r, { type: 'tool_use', id: 'media-error', name: tool.name, input: {} }, tool)
  const resumed = r.sanitizeErrorToolResultContent(JSON.parse(JSON.stringify(messages)))
  const result = resumed[0].message.content[0]
  assert.equal(result.is_error, true)
  assert.ok(result.content.every(block => block.type === 'text'))
  const text = result.content.map(block => block.text).join('\n')
  assert.match(text, /resource-diagnostic-sentinel/)
  assert.match(text, /bad_request/)
  assert.match(text, /Error attachment/)
  assert.doesNotMatch(text, /sdk-only-value|aW1hZ2UtZXZpZGVuY2U=/)
  const files = readdirSync(testDirectory, { recursive: true }).map(file => resolve(testDirectory, String(file)))
  const binary = files.find(file => file.endsWith('.png'))
  assert.ok(binary, 'binary evidence must be saved')
  assert.equal(readFileSync(binary, 'utf8'), 'image-evidence')
})
