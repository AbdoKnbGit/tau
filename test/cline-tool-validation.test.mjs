// Exercise the shipped Cline loop and real built-in schemas with a fake network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

// No catalog refresh or credentials are needed by this transport fixture.
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
const runtime = await loadMcpRuntime({
  paths: [
    'src/lanes/cline/loop.ts',
    'src/tools/TaskOutputTool/TaskOutputTool.tsx',
    'src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx',
    'src/utils/zodToJsonSchema.ts',
  ],
  exports: ['ClineLane', 'TaskOutputTool', 'AskUserQuestionTool', 'zodToJsonSchema'],
})

function providerTool(tool) {
  return { name: tool.name, description: 'Fixture', input_schema: runtime.zodToJsonSchema(tool.inputSchema) }
}

function reply(name, input, id) {
  const chunk = (delta, finish_reason = null) => ({
    id: 'completion', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason }],
  })
  const chunks = [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }] }),
    chunk({}, 'tool_calls'),
  ]
  return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function fixture(t, tools, inputs, { shape = 'anthropic', providerHint = 'cline' } = {}) {
  const lane = new runtime.ClineLane()
  lane._resolveAuth = async () => ({ token: 'fixture-token' })
  lane._apiRoot = () => 'https://cline.test'
  lane._promptCacheShape = async () => shape
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://cline.test/chat/completions', 'unexpected network request')
    const body = JSON.parse(options.body)
    bodies.push(body)
    assert.ok(inputs.length, 'repair budget exceeded')
    const { name = tools[0].name, input } = inputs.shift()
    return reply(name, input, `call-${bodies.length}`)
  })
  const params = {
    model: 'fixture-model', providerHint,
    system: 'Stable system prompt',
    messages: [{ role: 'user', content: 'Run the tool.' }],
    tools, max_tokens: 1000, signal: new AbortController().signal,
  }
  const run = async () => {
    const events = []
    for await (const event of lane.streamAsProvider(params)) events.push(event)
    return events
  }
  return { params, bodies, run }
}

function toolStarts(events) {
  return events.filter(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use')
}

for (const providerHint of ['cline', 'clinepass']) {
  test(`${providerHint}: real TaskOutput defaults need no repair request`, async t => {
    const tool = runtime.TaskOutputTool
    const tools = [providerTool(tool)]
    assert.ok(tools[0].input_schema.required.includes('block'))
    assert.ok(tools[0].input_schema.required.includes('timeout'))
    const input = { task_id: 'fixture-task' }
    const { run, bodies, params } = fixture(t, tools, [{ input }, { input }, { input }], { providerHint })
    const before = JSON.stringify(params)
    assert.equal(toolStarts(await run()).length, 1, 'valid call was blocked')
    assert.equal(bodies.length, 1, 'omitted defaults spent a repair retry')
    assert.equal(JSON.stringify(params), before, 'caller history or schema mutated')
    // Actual execution owns default application; the lane does not fill them.
    assert.deepEqual(tool.inputSchema.parse(input), { task_id: 'fixture-task', block: true, timeout: 30000 })
  })

  test(`${providerHint}: real AskUserQuestion nested defaults need no repair request`, async t => {
    const tool = runtime.AskUserQuestionTool
    const input = { questions: [{
      question: 'Choose a format?', header: 'Format',
      options: [{ label: 'Brief', description: 'A short answer' }, { label: 'Detailed', description: 'A long answer' }],
    }] }
    const { run, bodies } = fixture(t, [providerTool(tool)], [{ input }, { input }, { input }], { providerHint })
    assert.equal(toolStarts(await run()).length, 1, 'valid question was blocked')
    assert.equal(bodies.length, 1, 'omitted nested default spent a repair retry')
    assert.equal(tool.inputSchema.parse(input).questions[0].multiSelect, false)
  })
}

const requiredTool = {
  name: 'RequiredFixture', description: 'Fixture',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

for (const shape of ['anthropic', 'content-part', null]) {
  test(`repair requests append to the complete previous prefix (${shape ?? 'implicit cache'})`, async t => {
    const { run, bodies, params } = fixture(t, [requiredTool], [
      { input: {} }, { input: { command: {} } }, { input: { command: 'valid' } },
      { input: { command: 'next turn' } },
    ], { shape })
    const before = JSON.stringify(params)
    const starts = toolStarts(await run())
    assert.equal(starts.length, 1, 'only the repaired call may leave the lane')
    assert.equal(starts[0].content_block.id, 'call-3')
    assert.equal(bodies.length, 3)
    for (let i = 1; i < bodies.length; i++) {
      const previous = bodies[i - 1]
      const current = bodies[i]
      assert.equal(current.messages.length, previous.messages.length + 1)
      assert.equal(JSON.stringify(current.messages.slice(0, -1)), JSON.stringify(previous.messages),
        'repair rewrote the previous request prefix, including cache markers')
      const { messages: _previousMessages, ...previousSettings } = previous
      const { messages: _currentMessages, ...currentSettings } = current
      assert.deepEqual(currentSettings, previousSettings, 'tools or request settings changed')
      assert.match(current.messages.at(-1).content, new RegExp(`Attempt ${i}:`))
    }
    assert.match(bodies[1].messages.at(-1).content, /required "command"/)
    assert.match(bodies[2].messages.at(-1).content, /command must be string/)
    assert.equal(JSON.stringify(params), before)
    await run()
    assert.deepEqual(bodies[3], bodies[0], 'repair messages leaked into the next call')
  })
}

test('repeated invalid calls remain blocked after exactly two repair attempts', async t => {
  const { run, bodies } = fixture(t, [requiredTool], [{ input: {} }, { input: {} }, { input: {} }])
  const events = await run()
  assert.equal(bodies.length, 3)
  assert.equal(toolStarts(events).length, 0, 'an invalid call escaped to execution')
  assert.match(JSON.stringify(events), /blocked them before local execution/)
})
