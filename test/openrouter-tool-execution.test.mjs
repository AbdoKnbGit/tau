import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { loadMcpRuntime, fixtureTool, executeBlock } from './helpers/mcp-built-runtime.mjs'

// Exercise the built CLI's real schema builder, both request paths, stream
// assembler, executor, and task storage. Only the external API is simulated.
const testDirectory = mkdtempSync(join(tmpdir(), 'tau-openrouter-tools-'))
process.env.CLAUDE_CONFIG_DIR = testDirectory
process.env.CLAUDE_CODE_TASK_LIST_ID = 'openrouter-contract-regression'
process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'
process.env.ENABLE_TOOL_SEARCH = 'true'
process.env.TAU_NATIVE_LAZY_TOOLS = 'true'
test.after(() => rmSync(testDirectory, { recursive: true, force: true }))

const r = await loadMcpRuntime({
  paths: ['src/utils/api.ts', 'src/utils/toolSearchRequestFilter.ts',
    'src/tools/TaskCreateTool/TaskCreateTool.ts', 'src/tools/TaskUpdateTool/TaskUpdateTool.ts',
    'src/tools/FileWriteTool/FileWriteTool.ts', 'src/tools/FileEditTool/FileEditTool.ts',
    'src/utils/forcedProvider.ts', 'src/utils/powerMode.ts',
    'src/services/api/providers/openrouter_provider.ts', 'src/lanes/shared/volatile_freeze.ts'],
  exports: ['toolToAPISchema', 'selectToolsForToolSearchRequest', 'TaskCreateTool', 'TaskUpdateTool',
    'FileWriteTool', 'FileEditTool', 'runWithForcedProvider', 'setSessionPowerMode',
    'OpenRouterProvider', 'resetSessionVolatileFreeze', 'getTaskListId', 'getTask', 'listTasks', 'getTasksDir',
    'getUsingYourToolsSection', 'normalizeMessagesForAPI'],
})
r.setSessionPowerMode('normal')
const model = 'example/model'
const source = [r.TaskCreateTool, r.TaskUpdateTool, r.FileWriteTool, r.FileEditTool,
  fixtureTool({ name: 'mcp__fixture__publish_record', isMcp: true, shouldDefer: true,
    inputJSONSchema: { type: 'object', properties: { recordKey: { type: 'string' },
      payload: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] } },
    required: ['recordKey', 'payload'], additionalProperties: false },
  })]
const permission = { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} }

test('OpenRouter workflow instructions agree with eager schemas; other provider guidance stays lazy', () => {
  const enabled = new Set(['ProjectWorkflow', 'GitHistorySearch', 'InspectSite', 'WebBrowser',
    'Browser', 'PackageManager', 'VisualDesignAudit'])
  const prompt = r.runWithForcedProvider({ provider: 'openrouter' }, () => r.getUsingYourToolsSection(enabled))
  assert.doesNotMatch(prompt, /ToolSearch|named deferred tool/)
  assert.match(prompt, /call ProjectWorkflow/)
  assert.match(prompt, /call Browser/)
  const control = r.runWithForcedProvider({ provider: 'opencode' }, () => r.getUsingYourToolsSection(enabled))
  assert.match(control, /load ProjectWorkflow with ToolSearch/)
})

async function schemas() {
  return r.runWithForcedProvider({ provider: 'openrouter' }, async () => {
    const selected = r.selectToolsForToolSearchRequest([{ name: 'ToolSearch' }, ...source], {
      provider: 'openrouter', model, useToolSearch: true, useNativeLaneToolSearch: true,
      deferredToolNames: new Set(source.map(t => t.name)), discoveredToolNames: new Set(),
    })
    assert.deepEqual(selected, source)
    return Promise.all(selected.map(tool => r.toolToAPISchema(tool, {
      getToolPermissionContext: async () => permission, tools: source, agents: [], model,
    })))
  })
}

function assertContracts(body) {
  const actual = new Map(body.tools.map(t => [t.function.name, t.function.parameters]))
  assert.deepEqual([...actual.keys()], source.map(t => t.name))
  for (const [name, fields] of [
    [r.TaskCreateTool.name, ['subject', 'description']],
    [r.TaskUpdateTool.name, ['taskId']],
    [r.FileWriteTool.name, ['file_path', 'content']],
    [r.FileEditTool.name, ['file_path', 'old_string', 'new_string']],
    [source.at(-1).name, ['recordKey', 'payload']],
  ]) {
    if (body.model === 'openai/gpt-5') {
      assert.deepEqual(actual.get(name).required, Object.keys(actual.get(name).properties))
    } else assert.deepEqual(actual.get(name).required, fields, `${name} lost required fields`)
    for (const field of fields) assert.ok(actual.get(name).properties[field], `${name}.${field}`)
  }
  assert.deepEqual(actual.get(source.at(-1).name).properties.payload.required, ['score'])
}

async function request(route, tools, messages, calls, system = 'Initial full context', requestModel = model, failStream = false, responseReasoning = {}) {
  const previousFetch = globalThis.fetch
  let body
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body)
    bodies.push(body)
    assertContracts(body)
    const chunks = [
      { choices: [{ delta: { ...responseReasoning, ...(calls.length === 0 && { content: 'Completed.' }), tool_calls: calls.map((call, index) => ({
        index, id: `call_${messages.length}_${index}`, type: 'function',
        function: { name: call.name, arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input) },
      })) }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] },
    ]
    if (failStream && body.stream === false) {
      if (failStream === 'both') {
        return new Response(JSON.stringify({ id: 'generation-recovery-error', provider: 'fixture-provider',
          choices: [{ finish_reason: 'error', message: { role: 'assistant', content: '' } }],
        }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ id: 'recovered', model: requestModel,
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Task list ready.',
          tool_calls: chunks[0].choices[0].delta.tool_calls } }], usage: { prompt_tokens: 63664, completion_tokens: 70 },
      }), { headers: { 'content-type': 'application/json' } })
    }
    const outgoing = failStream ? [
      { choices: [{ delta: { content: '在 torch 安装期间，我来搭建这两个项目。先创建任务列表。' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'abandoned',
        function: { name: calls[0].name, arguments: '{"subject":"unfinished' } }] }, finish_reason: null }] },
      { id: 'generation-error', provider: 'fixture-provider', choices: [{ delta: {}, finish_reason: 'error' }] },
    ] : chunks
    return new Response(outgoing.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  }
  const params = { model: requestModel, tools, messages, system, max_tokens: 32768,
    sessionId: `openrouter-execution-${route}`, signal: new AbortController().signal, providerHint: 'openrouter' }
  try {
    let stream
    if (route === 'native') {
      const lane = new r.OpenAICompatLane()
      lane.registerProvider('openrouter', 'fixture-key', 'https://fixture.invalid/v1')
      stream = lane.streamAsProvider(params)
    } else {
      stream = await new r.OpenRouterProvider({ apiKey: 'fixture-key' }).stream(params)
    }
    return { body: () => body, bodies, message: await r.assembleFinalMessage(stream, requestModel) }
  } finally { globalThis.fetch = previousFetch }
}

async function execute(reply, tool, history) {
  const block = reply.message.content.find(b => b.type === 'tool_use')
  assert.ok(block, 'No executable tool call was assembled')
  const execution = await r.runWithForcedProvider({ provider: 'openrouter' },
    () => executeBlock(r, block, tool))
  assert.equal(execution.results.length, 1)
  history.push({ role: 'assistant', content: reply.message.content },
    { role: 'user', content: execution.results })
  return execution.results[0]
}

for (const route of ['native', 'legacy']) {
  test(`${route}: saved native tool IDs migrate without changing stored records or other providers`, async () => {
    r.resetSessionVolatileFreeze()
    const tools = await schemas()
    const ids = ['c17f97c6-66e1-4500-b4cd-a90e879dd4c2', 'call_provider_2',
      'toolu_compat_provider_owned', 'toolu_provider_4']
    const localIds = ids.map(id => id.startsWith('toolu_') ? id : `toolu_compat_${id}`)
    const records = [
      { type: 'user', uuid: 'initial', message: { role: 'user', content: 'Update the records.' } },
      ...ids.map((id, index) => ({ type: 'assistant', uuid: `assistant-${index}`,
        message: { id: 'compat-1234', model, role: 'assistant', content: [{ type: 'tool_use',
          id: localIds[index], name: r.TaskUpdateTool.name, input: { taskId: String(index + 1) },
          // New transcripts explicitly distinguish a provider-owned prefix.
          ...(index === 2 && { _openrouter_tool_call_id: id }),
        }] } })),
      ...[3, 1, 2, 0].map(index => ({ type: 'user', uuid: `result-${index}`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: localIds[index], content: 'Updated.' }] } })),
    ]
    const saved = JSON.stringify(records)
    const normalize = provider => r.runWithForcedProvider({ provider }, () => r.normalizeMessagesForAPI(records, source))
    const normalized = normalize('openrouter')
    const result = await request(route, tools, normalized.map(record => record.message), [])
    const wire = result.body().messages
    assert.deepEqual(wire.find(message => message.tool_calls)?.tool_calls.map(call => call.id), ids)
    assert.deepEqual(wire.filter(message => message.role === 'tool').map(message => message.tool_call_id),
      [ids[3], ids[1], ids[2], ids[0]])
    assert.equal(JSON.stringify(wire).includes('_openrouter_tool_call_id'), false)
    const again = await request(route, tools, normalized.map(record => record.message), [])
    assert.deepEqual(again.body().messages, result.body().messages)
    assert.deepEqual(again.body().tools, result.body().tools)
    assert.equal(again.body().prompt_cache_key, result.body().prompt_cache_key)
    for (const provider of ['firstParty', 'openai', 'deepseek']) {
      const switched = normalize(provider)
      assert.equal(JSON.stringify(switched).includes('_openrouter_tool_call_id'), false)
      assert.deepEqual(switched.flatMap(record => record.message.content ?? [])
        .filter(block => block.type === 'tool_use').map(block => block.id), localIds)
    }
    assert.equal(JSON.stringify(records), saved)
  })
  test(`${route}: reasoning survives the built normalizer, real task execution, and resumed tool result`, async () => {
    r.resetSessionVolatileFreeze()
    const tools = await schemas()
    const history = [{ role: 'user', content: 'Create a task and use its result.' }]
    const details = [{ type: 'reasoning.encrypted', id: 'thought-1', index: 0, format: 'provider-v1', data: 'opaque-state==' }]
    const reply = await request(route, tools, history, [{ name: r.TaskCreateTool.name,
      input: { subject: `Reasoning ${route}`, description: 'Isolated reasoning round trip' },
    }], 'Reasoning fixture', model, false, { reasoning: 'Original reasoning.', reasoning_details: details })
    const result = await execute(reply, r.TaskCreateTool, history)
    assert.notEqual(result.is_error, true)
    const records = JSON.parse(JSON.stringify(history.map((message, index) => ({ type: message.role,
      uuid: `fixture-${index}`, timestamp: new Date(0).toISOString(),
      message: { ...message, ...(message.role === 'assistant' && { id: reply.message.id, model }) },
    }))))
    const normalized = r.runWithForcedProvider({ provider: 'openrouter' }, () => r.normalizeMessagesForAPI(records, source))
    const resumed = normalized.map(record => ({ role: record.message.role, content: record.message.content }))
    const next = await request(route, tools, resumed, [])
    const assistant = next.body().messages.find(message => message.tool_calls?.length)
    assert.deepEqual(assistant.reasoning_details, details)
    assert.equal(assistant.reasoning, undefined)
    assert.equal(assistant.tool_calls[0].id, 'call_1_0')
    assert.equal(next.body().messages.find(message => message.role === 'tool').tool_call_id, 'call_1_0')
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), {
      subject: `Reasoning ${route}`, description: 'Isolated reasoning round trip',
    })
    assert.equal(JSON.stringify(next.body()).includes('_openrouter_reasoning'), false)
    for (const provider of ['firstParty', 'openai', 'deepseek']) {
      const switched = r.runWithForcedProvider({ provider }, () => r.normalizeMessagesForAPI(records, source))
      assert.equal(JSON.stringify(switched).includes('_openrouter_reasoning'), false)
      assert.equal(JSON.stringify(switched).includes('_openrouter_tool_call_id'), false)
    }
    assert.ok(JSON.stringify(records).includes('opaque-state=='), 'provider switching must not mutate persisted state')
  })
  test(`${route}: the installed bundle retains both failed attempts and executes no task`, async () => {
    r.resetSessionVolatileFreeze()
    const tools = await schemas()
    const before = await r.listTasks(r.getTaskListId())
    await assert.rejects(() => request(route, tools, [{ role: 'user', content: 'Create one task.' }],
      [{ name: r.TaskCreateTool.name, input: { subject: 'Must not run', description: 'Failed generation' } }],
      'Failure fixture', model, 'both'), error => {
      assert.match(error.message, /Generation: generation-recovery-error/)
      assert.match(error.message, /Recovery failed after 2 attempts \(streaming, then non-streaming\)/)
      assert.match(error.message, /Initial failure: generation generation-error, provider fixture-provider/)
      return true
    })
    assert.deepEqual(await r.listTasks(r.getTaskListId()), before)
  })
  test(`${route}: announced task batch recovers after stream failure and creates exactly one real task`, async () => {
    r.resetSessionVolatileFreeze()
    const tools = await schemas()
    const before = (await r.listTasks(r.getTaskListId())).length
    const history = [{ role: 'user', content: 'First create a task list.' }]
    const reply = await request(route, tools, history, [{ name: r.TaskCreateTool.name,
      input: { subject: `Recovered ${route}`, description: 'Real isolated task execution after recovery' },
    }], 'Recovery fixture', model, true)
    assert.equal(reply.bodies.length, 2)
    assert.equal(reply.bodies[0].stream, true)
    assert.equal(reply.bodies[1].stream, false)
    // The cut-off TaskCreate is explained in one message after the unchanged conversation.
    assert.deepEqual(reply.bodies[0].messages, reply.bodies[1].messages.slice(0, -1))
    assert.match(reply.bodies[1].messages.at(-1).content, /cut off .* TaskCreate call\. .*did not run/s)
    assert.deepEqual(reply.bodies[0].tools, reply.bodies[1].tools)
    assert.equal(reply.message.content.filter(b => b.type === 'tool_use').length, 1)
    assert.deepEqual(reply.message.content.filter(b => b.type === 'text').map(b => b.text), ['Task list ready.'])
    assert.equal((await r.listTasks(r.getTaskListId())).length, before, 'no execution during failed generation or recovery')
    const result = await execute(reply, r.TaskCreateTool, history)
    assert.notEqual(result.is_error, true, JSON.stringify(result))
    assert.equal((await r.listTasks(r.getTaskListId())).length, before + 1)
  })
  test(`${route}: strict optional nulls reach the real executor as omitted fields`, async () => {
    r.resetSessionVolatileFreeze()
    const tools = await schemas()
    const history = [{ role: 'user', content: 'Create a task with no optional metadata.' }]
    const reply = await request(route, tools, history, [{ name: r.TaskCreateTool.name,
      input: { subject: `Strict ${route}`, description: 'Optional fields unset', activeForm: null, metadata: null },
    }], 'Strict schema test', 'openai/gpt-5')
    const block = reply.message.content.find(b => b.type === 'tool_use')
    assert.deepEqual(block.input, { subject: `Strict ${route}`, description: 'Optional fields unset' })
    const result = await execute(reply, r.TaskCreateTool, history)
    assert.notEqual(result.is_error, true, JSON.stringify(result))
    const id = /Task #(\S+) created successfully/.exec(result.content)?.[1]
    assert.ok(id)
    assert.equal((await r.getTask(r.getTaskListId(), id)).subject, `Strict ${route}`)
  })
  test(`${route}: full initial schemas survive real create/update execution with stable cache prefix`, async () => {
    r.resetSessionVolatileFreeze()
    const tools = await schemas()
    assert.ok(tools.every(t => t.__tau_should_defer !== true && !t.defer_loading))
    // Stale lane callers still must be eager; ToolSearch's presence must not prune.
    const staleTools = [{ name: 'ToolSearch', description: 'search', input_schema: { type: 'object' } },
      ...tools.map(t => ({ ...t, defer_loading: true, __tau_should_defer: true }))]
    const history = [{ role: 'user', content: 'Create a task, then mark the returned ID in progress.' }]
    const created = await request(route, staleTools, history, [{ name: r.TaskCreateTool.name,
      input: { subject: `Schema regression ${route}`, description: 'Check actual task persistence' } }])
    const result = await execute(created, r.TaskCreateTool, history)
    assert.notEqual(result.is_error, true, JSON.stringify(result))
    const id = /Task #(\S+) created successfully/.exec(result.content)?.[1]
    assert.ok(id, 'The next tool must receive the actual created ID')
    assert.equal((await r.getTask(r.getTaskListId(), id)).status, 'pending')

    const updated = await request(route, [...staleTools].reverse(), history,
      [{ name: r.TaskUpdateTool.name, input: { taskId: id, status: 'in_progress' } }], 'Changed later context')
    const updatedResult = await execute(updated, r.TaskUpdateTool, history)
    assert.notEqual(updatedResult.is_error, true, JSON.stringify(updatedResult))
    assert.equal((await r.getTask(r.getTaskListId(), id)).status, 'in_progress')
    assert.deepEqual(updated.body().tools, created.body().tools)
    assert.deepEqual(updated.body().messages.slice(0, created.body().messages.length), created.body().messages)
    assert.equal(updated.body().prompt_cache_key, created.body().prompt_cache_key)
    assert.ok(!JSON.stringify(updated.body()).includes('Changed later context'))
    const taskRelative = relative(testDirectory, r.getTasksDir(r.getTaskListId()))
    assert.ok(taskRelative && !taskRelative.startsWith('..') && !isAbsolute(taskRelative))
  })

  test(`${route}: guessed fields do not create tasks and repeated batches stop`, async () => {
    r.resetSessionVolatileFreeze()
    const tools = await schemas()
    const before = await r.listTasks(r.getTaskListId())
    const history = [{ role: 'user', content: 'Create tasks' }]
    const invalid = await request(route, tools, history, [{ name: r.TaskCreateTool.name,
      input: { title: 'Wrong field', description: 'Should not run' } }])
    const result = await execute(invalid, r.TaskCreateTool, history)
    assert.equal(result.is_error, true)
    assert.match(JSON.stringify(result), /subject/)
    assert.doesNotMatch(JSON.stringify(result), /schema was not (declared|sent)/)
    assert.deepEqual(await r.listTasks(r.getTaskListId()), before)
    await assert.rejects(() => request(route, tools, history, Array.from({ length: 6 }, (_, i) => ({
      name: r.TaskCreateTool.name, input: { title: `Another guess ${i}`, description: 'Still wrong' },
    }))), /OpenRouter tool-call error:.*failed twice/)
    assert.deepEqual(await r.listTasks(r.getTaskListId()), before)
  })
}
