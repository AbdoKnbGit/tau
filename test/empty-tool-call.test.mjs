// A tool call with no arguments.
//
// Claude sends one as an empty tool_use block on the Anthropic Messages wire, and as a
// functionCall with no `args` through Antigravity. Such a call runs with {} once the reply
// shows the model finished it. A reply cut off before the arguments arrived stays refused
// (never run half a call), and Tau's decode marker never reaches the Anthropic API, which
// answers that field with a 400 on every later request.
//
// Exercised through the built bundle and the built CLI. TAU_MCP_TEST_BUNDLE picks another build.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { executeBlock, fixtureTool, loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'
import { stopProcessTree } from './helpers/stop-process-tree.mjs'

const root = mkdtempSync(join(tmpdir(), 'tau-empty-call-'))
process.env.CLAUDE_CONFIG_DIR = join(root, 'runtime-config')
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

const cli = join(dirname(resolve(process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs')), 'cli.mjs')
const r = await loadMcpRuntime({
  paths: ['src/services/api/emptyToolInput.ts'],
  exports: ['settleEmptyToolInputs', 'normalizeMessagesForAPI'],
})

const name = 'FixtureTool'
const iterable = values => (async function* () { yield* values })()
const collect = async events => {
  const out = []
  for await (const event of events) out.push(event)
  return out
}

// ── The rule on a Messages stream ─────────────────────────────────────────────

const start = (index, input = {}) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name, input } })
const json = (index, partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
const stop = index => ({ type: 'content_block_stop', index })
const ending = stop_reason => ({ type: 'message_delta', delta: { stop_reason } })
const settle = events => collect(r.settleEmptyToolInputs(iterable(events)))

test('an empty tool_use block gets {} once the message ends with tool_use', async () => {
  assert.deepEqual(await settle([start(0), json(0, ''), stop(0), ending('tool_use')]),
    [start(0), json(0, ''), json(0, '{}'), stop(0), ending('tool_use')])
  assert.deepEqual(await settle([start(0), stop(0), ending('tool_use')]),
    [start(0), json(0, '{}'), stop(0), ending('tool_use')])
  assert.deepEqual(await settle([start(0), json(0, '  '), stop(0), ending('tool_use')]),
    [start(0), json(0, '  '), json(0, '{}'), stop(0), ending('tool_use')])
})

test('a following block also shows the empty block was finished, and a ping changes nothing', async () => {
  assert.deepEqual(await settle([start(0), json(0, ''), stop(0), start(1), json(1, '{"a":1}'), stop(1), ending('tool_use')]),
    [start(0), json(0, ''), json(0, '{}'), stop(0), start(1), json(1, '{"a":1}'), stop(1), ending('tool_use')])
  const ping = { type: 'ping' }
  assert.deepEqual(await settle([start(0), json(0, ''), stop(0), ping, ending('tool_use')]),
    [start(0), json(0, ''), ping, json(0, '{}'), stop(0), ending('tool_use')])
})

test('an empty block in a reply that was cut off or never ended is passed on as it came', async () => {
  for (const reason of ['max_tokens', 'model_context_window_exceeded', 'refusal', 'end_turn']) {
    const events = [start(0), json(0, ''), stop(0), ending(reason)]
    assert.deepEqual(await settle(events), events, reason)
  }
  const unfinished = [start(0), json(0, ''), stop(0)]
  assert.deepEqual(await settle(unfinished), unfinished)
})

test('blocks with arguments, starts that carry input, and text are left alone', async () => {
  const text = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    stop(0),
  ]
  for (const events of [
    [start(0), json(0, '{"a":1}'), stop(0), ending('tool_use')],
    [start(0, { a: 1 }), stop(0), ending('tool_use')],
    [...text, ending('end_turn')],
  ]) assert.deepEqual(await settle(events), events)
})

// ── The Gemini lane (Antigravity and Gemini) ──────────────────────────────────

const params = {
  model: 'gemini-3-pro-preview', providerHint: 'antigravity', messages: [{ role: 'user', content: 'fixture' }],
  system: 'fixture', tools: [], max_tokens: 1024, thinking: { type: 'disabled' },
  signal: new AbortController().signal, sessionId: 'empty-call-fixture',
}
async function gemini(chunks) {
  const original = r.geminiApi.streamGenerateContent
  r.geminiApi.streamGenerateContent = () => iterable(chunks)
  try {
    return await r.assembleFinalMessage(new r.GeminiLane().streamAsProvider(params), 'fixture')
  } finally {
    r.geminiApi.streamGenerateContent = original
  }
}
const chunk = (parts, finishReason) => ({ candidates: [{ content: { parts }, ...(finishReason && { finishReason }) }] })
const noArgs = { functionCall: { name } }
async function outcomes(message) {
  const out = []
  for (const block of r.normalizeContentFromAPI(message.content, [], undefined).filter(item => item.type === 'tool_use')) {
    const tool = fixtureTool()
    const { results } = await executeBlock(r, block, tool)
    out.push({ calls: tool.calls, refused: /was not run/.test(JSON.stringify(results[0]?.content)) })
  }
  return out
}

test('Gemini: a call with no args in a reply that finished with STOP runs with {}', async () => {
  assert.deepEqual(await outcomes(await gemini([chunk([noArgs], 'STOP')])), [{ calls: [{}], refused: false }])
  // The model moving on to its next part closes the call before it, too.
  assert.deepEqual(await outcomes(await gemini([chunk([noArgs, noArgs], 'STOP')])),
    [{ calls: [{}], refused: false }, { calls: [{}], refused: false }])
  assert.deepEqual(await outcomes(await gemini([chunk([noArgs]), chunk([{ text: 'done' }], 'STOP')])),
    [{ calls: [{}], refused: false }])
})

test('Gemini: the same call is refused when the reply did not finish with STOP', async () => {
  for (const finishReason of [undefined, 'OTHER', 'MALFORMED_FUNCTION_CALL']) {
    assert.deepEqual(await outcomes(await gemini([chunk([noArgs], finishReason)])),
      [{ calls: [], refused: true }], String(finishReason))
  }
  // Cut at the output cap: the call is dropped and the turn reports max_tokens.
  const cut = await gemini([chunk([noArgs], 'MAX_TOKENS')])
  assert.deepEqual(await outcomes(cut), [])
  assert.equal(cut.stop_reason, 'max_tokens')
})

// ── OpenCode's Claude rows relay the same Messages stream ─────────────────────

async function openCode(stopReason) {
  const lane = new r.OpenAICompatLane()
  lane.registerProvider('opencode', 'fixture-key', 'https://fixture.invalid/zen/v1')
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(messagesStream('claude-sonnet-4-6', [{ tool: name, json: '' }], stopReason),
    { headers: { 'content-type': 'text/event-stream' } })
  try {
    return await r.assembleFinalMessage(lane.streamAsProvider({
      ...params, model: 'claude-sonnet-4-6', providerHint: 'opencode',
      tools: [{ name, description: 'fixture', input_schema: { type: 'object', additionalProperties: true } }],
    }), 'fixture')
  } finally {
    globalThis.fetch = original
    lane.unregisterProvider('opencode')
  }
}

test('OpenCode Claude route: a finished empty call runs, a cut one is refused', async () => {
  assert.deepEqual(await outcomes(await openCode('tool_use')), [{ calls: [{}], refused: false }])
  assert.deepEqual(await outcomes(await openCode('max_tokens')), [{ calls: [], refused: true }])
})

// ── The decode marker on the outbound copy ────────────────────────────────────

test('the decode marker is dropped on the Anthropic Messages wire and kept for the lanes', () => {
  const marked = {
    type: 'tool_use', id: 'toolu_marked', name: 'mcp__fixture__inspect', input: {},
    _tau_decode_status: { category: 'malformed', fragmentLength: 10 },
  }
  const history = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'run it' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [marked], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_marked', content: 'not run', is_error: true }] } },
  ]
  const sent = provider => JSON.stringify(r.normalizeMessagesForAPI(history, [], { provider, model: 'claude-sonnet-4-6' }))
  for (const provider of ['firstParty', 'bedrock', 'vertex', 'foundry', 'agentrouter']) {
    assert.doesNotMatch(sent(provider), /_tau_decode_status/, provider)
  }
  // Lanes build their own wire messages, and OpenRouter's repeat guard reads the marker from history.
  for (const provider of ['openrouter', 'antigravity', 'openai', 'kiro']) {
    assert.match(sent(provider), /_tau_decode_status/, provider)
  }
  assert.ok(marked._tau_decode_status, 'the stored history keeps its marker')
})

// ── The built CLI against a stand-in for the Anthropic API ────────────────────

const fixtureKey = 'sk-ant-empty-call-fixture-key-0001'
const tool = 'mcp__fixture__inspect'
let replyNumber = 0

function messagesStream(model, blocks, stopReason) {
  const id = ++replyNumber
  const out = []
  const event = data => out.push(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  event({ type: 'message_start', message: { id: `msg_fixture_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } })
  blocks.forEach((block, index) => {
    if ('text' in block) {
      event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else {
      event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_fixture_${id}_${index}`, name: block.tool, input: {} } })
      event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.json } })
    }
    event({ type: 'content_block_stop', index })
  })
  event({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } })
  event({ type: 'message_stop' })
  return out.join('')
}

/** Runs the CLI once. `script` is the model's first reply; every later main request gets "DONE". */
async function cliRun(script) {
  const home = mkdtempSync(join(root, 'case-'))
  const config = join(home, 'config')
  const workspace = join(home, 'workspace')
  mkdirSync(config, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(config, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', activeProvider: 'firstParty',
    customApiKeyResponses: { approved: [fixtureKey.slice(-20)], rejected: [] },
  }))
  const mcpConfig = join(home, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [resolve('test/fixtures/mcp-launch-server.mjs')] } } }))

  const bodies = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part
    if (request.method !== 'POST' || !request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"input_tokens":1}')
      return
    }
    const body = JSON.parse(raw)
    const main = (body.tools ?? []).some(item => item.name === tool)
    if (main) bodies.push(raw)
    // What the real API answers for a field it does not define.
    if (raw.includes('_tau_decode_status')) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0.tool_use._tau_decode_status: Extra inputs are not permitted' } }))
      return
    }
    const [blocks, stopReason] = main && bodies.length === 1 ? script : [[{ text: main ? 'DONE' : 'ok' }], 'end_turn']
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesStream(body.model, blocks, stopReason))
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `msg_fixture_${++replyNumber}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
    }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|GOOGLE_|TAU_|CLAUDEX|CODEX_|CI$|ENABLE_TOOL_SEARCH|NODE_OPTIONS$|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(key)))
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, 'cache'),
      NODE_ENV: 'production', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', TAU_SKIP_PREFLIGHT: '1', NO_PROXY: '127.0.0.1,localhost',
      ANTHROPIC_API_KEY: fixtureKey, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ENABLE_TOOL_SEARCH: 'false',
    })
    const child = spawn(process.execPath, [cli, '-p', 'Call the fixture tool.', '--output-format', 'json',
      '--mcp-config', mcpConfig, '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence',
      '--allowedTools', tool, '--model', 'claude-sonnet-4-6'], {
      cwd: workspace, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', part => { stdout += part })
    child.stderr.on('data', part => { stderr += part })
    const timer = setTimeout(() => stopProcessTree(child), 90_000)
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
      return { code, stdout, stderr, bodies }
    } finally {
      clearTimeout(timer)
    }
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

/** Each fixture call in the last request, and what Tau answered for it. */
function calls(bodies) {
  const messages = JSON.parse(bodies.at(-1)).messages
  const blocks = role => messages.filter(message => message.role === role && Array.isArray(message.content)).flatMap(message => message.content)
  const results = blocks('user').filter(block => block.type === 'tool_result')
  return blocks('assistant').filter(block => block.type === 'tool_use' && block.name === tool).map(use => {
    const result = results.find(block => block.tool_use_id === use.id)
    const text = typeof result?.content === 'string' ? result.content
      : (result?.content ?? []).map(part => part.text ?? '').join('')
    return { input: use.input, ran: /"cwd"/.test(text), refused: /was not run/.test(text) }
  })
}

function assertNoMarker(run) {
  assert.ok(run.bodies.length >= 2, `expected a follow-up request; exit ${run.code}: ${run.stderr.slice(-400)}`)
  run.bodies.forEach((body, index) => assert.doesNotMatch(body, /_tau_decode_status/, `request ${index + 1} carried the decode marker`))
}

test('first party: a finished call with no arguments runs and is sent back as {}', { timeout: 120_000 }, async () => {
  const run = await cliRun([[{ tool, json: '' }], 'tool_use'])
  assertNoMarker(run)
  assert.deepEqual(calls(run.bodies), [{ input: {}, ran: true, refused: false }])
  assert.equal(run.code, 0, run.stderr.slice(-600))
})

test('first party: a call cut off by max_tokens before its arguments is still refused', { timeout: 120_000 }, async () => {
  const run = await cliRun([[{ tool, json: '' }], 'max_tokens'])
  assertNoMarker(run)
  assert.deepEqual(calls(run.bodies).map(call => ({ ran: call.ran, refused: call.refused })), [{ ran: false, refused: true }])
  assert.equal(run.code, 0, run.stderr.slice(-600))
})

test('first party: a call whose JSON broke off is refused and the session goes on', { timeout: 120_000 }, async () => {
  const run = await cliRun([[{ tool, json: '{"target":' }], 'tool_use'])
  assertNoMarker(run)
  assert.deepEqual(calls(run.bodies).map(call => ({ ran: call.ran, refused: call.refused })), [{ ran: false, refused: true }])
  assert.equal(run.code, 0, run.stderr.slice(-600))
})
