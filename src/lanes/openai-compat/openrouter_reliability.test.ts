/** Run: bun run src/lanes/openai-compat/openrouter_reliability.test.ts */
import assert from 'node:assert/strict'
import type { ProviderContentBlock, ProviderMessage, ProviderTool } from '../../services/api/providers/base_provider.js'
import { OpenRouterProvider } from '../../services/api/providers/openrouter_provider.js'
import { OpenAICompatLane } from './loop.js'
import { OpenRouterToolCallError, OpenRouterUpstreamError, assertOpenRouterToolProgress } from './openrouter_tools.js'
import { resetSessionVolatileFreeze } from '../shared/volatile_freeze.js'
import { isFallbackEligibleThrownError, isFallbackEligibleAPIErrorMessage } from '../../utils/fallback/detect.js'
import { isRetryableProviderError, isRetryableNetworkError } from '../../services/api/transport_error.js'
import { selectToolsForToolSearchRequest } from '../../utils/toolSearchRequestFilter.js'
import { recordOpenRouterProviderDirectory, resolveOpenRouterProviderSlug } from '../../utils/model/openrouterProviders.js'
import { openrouterTransformer, recordOpenRouterServedProvider, _resetOpenRouterAutoPinForTest } from './transformers/openrouter.js'
import { anthropicMessagesToOpenAI } from '../../services/api/adapters/anthropic_to_openai.js'
import { openRouterToolIdMap, restoreOpenRouterToolIdMetadata } from './openrouter_tool_ids.js'
import { _setOpenRouterCapacityDelaysForTest } from './openrouter_retry.js'

process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'
const CAPACITY_DELAYS = [5, 5, 5, 5]
_setOpenRouterCapacityDelaysForTest(CAPACITY_DELAYS)
const tool: ProviderTool = {
  name: 'StoreRecord', description: 'Store a record.', input_schema: {
    type: 'object', properties: { location: { type: 'string' }, value: { type: 'string' } },
    required: ['location', 'value'], additionalProperties: false,
  },
}
const originalInput = { location: 'C:\\Users\\ok\\new cv\\record.txt', value: '"quoted"\n中文 😀\n\\literal' }
const user: ProviderMessage = { role: 'user', content: 'Store the record.' }
const finish = (reason = 'tool_calls') => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
const fragment = (index: number, args: unknown, name?: string, id = `call_${index}`) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index,
    ...(name && { id }), function: { ...(name && { name }), arguments: args },
  }] }, finish_reason: null }],
})
const clean = [fragment(0, JSON.stringify(originalInput), tool.name), finish()]
type Route = 'native' | 'legacy'

function completionFixture(chunks: any[]) {
  const calls = new Map<number, any>()
  const metadata: any = {}
  let content = '', reasoning = '', reason: string | null = null, nativeReason: string | null = null
  for (const chunk of chunks) {
    const { choices, ...rest } = chunk
    Object.assign(metadata, rest)
    const choice = choices?.[0]
    if (!choice) continue
    reason = choice.finish_reason ?? reason
    nativeReason = choice.native_finish_reason ?? nativeReason
    content += choice.delta?.content ?? ''
    reasoning += choice.delta?.reasoning_content ?? ''
    for (const part of choice.delta?.tool_calls ?? []) {
      const previous = calls.get(part.index) ?? { id: part.id, type: 'function', function: { name: part.function?.name, arguments: '' } }
      previous.function.arguments += part.function?.arguments ?? ''
      calls.set(part.index, previous)
    }
  }
  return { ...metadata, choices: [{ finish_reason: reason, native_finish_reason: nativeReason,
    message: { role: 'assistant', content, reasoning_content: reasoning, tool_calls: [...calls.values()] } }] }
}

function assertRecoveryRequest(bodies: any[], note?: RegExp) {
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].stream, true)
  assert.equal(bodies[1].stream, false)
  const { stream: _stream, stream_options: _options, ...original } = bodies[0]
  const { stream: _recoveryStream, ...recovery } = bodies[1]
  if (note) {
    // A cut-off tool call is explained in one extra message after the
    // unchanged conversation; nothing before it may differ.
    const last = recovery.messages.at(-1)
    assert.equal(last.role, 'user')
    assert.match(last.content, note)
    recovery.messages = recovery.messages.slice(0, -1)
  } else assert.equal(JSON.stringify(recovery.messages).includes('was cut off'), false)
  assert.deepEqual(recovery, original, 'only transport mode changes; prompt, schemas and cache identity must match')
}
const CUT_OFF = /<system-reminder>\nYour previous reply was cut off by the provider.*StoreRecord call.*did not run\.\n.*shorter arguments/s

async function request(route: Route, chunks: any[] = clean, options: {
  messages?: ProviderMessage[]; system?: string; tools?: ProviderTool[];
  sessionId?: string; querySource?: string; max_tokens?: number;
  provider?: 'openrouter' | 'deepseek'; wire?: string; packetSize?: number;
  model?: string; attempts?: any[][]; signal?: AbortSignal;
  completion?: unknown; recoveryWire?: string; onRecovery?: (init: any) => Promise<Response>;
  http?: ((() => Response) | undefined)[];
} = {}) {
  const fetchBefore = globalThis.fetch
  const events: any[] = []
  let progress = 0
  const record = (event: any) => event.type === 'openrouter_progress' ? progress++ : events.push(event)
  let body: any
  const bodies: any[] = []
  const wire = options.wire ?? chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(init.body)
    bodies.push(body)
    const attemptChunks = options.attempts?.[bodies.length - 1]
    const rejection = options.http?.[bodies.length - 1]
    if (rejection) return rejection()
    if (body.stream === false) {
      if (options.onRecovery) return options.onRecovery(init)
      return new Response(options.recoveryWire ?? JSON.stringify(options.completion ?? completionFixture(attemptChunks ?? chunks)),
        { headers: { 'content-type': 'application/json' } })
    }
    const attemptWire = attemptChunks
      ? attemptChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n' : wire
    const bytes = new TextEncoder().encode(attemptWire)
    const size = options.packetSize ?? bytes.length
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size))
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const params = { model: options.model ?? 'example/model', messages: options.messages ?? [user],
    system: options.system ?? 'Initial instructions.\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nInitial context.',
    tools: options.tools ?? [tool], max_tokens: options.max_tokens ?? 32768,
    sessionId: options.sessionId ?? 'reliability-session', querySource: options.querySource,
    signal: options.signal ?? new AbortController().signal,
  }
  let error: unknown
  try {
    if (route === 'native') {
      const lane = new OpenAICompatLane()
      const provider = options.provider ?? 'openrouter'
      lane.registerProvider(provider, 'test', 'https://example.invalid/v1')
      for await (const event of lane.streamAsProvider({ ...params, tools: params.tools,
        providerHint: provider })) record(event)
    } else {
      const stream = await new OpenRouterProvider({ apiKey: 'test' }).stream(params)
      for await (const event of stream) record(event)
    }
  } catch (caught) { error = caught } finally { globalThis.fetch = fetchBefore }
  return { body, bodies, events, error, progress }
}
const starts = (result: Awaited<ReturnType<typeof request>>) =>
  result.events.filter(event => event.type === 'content_block_start' && event.content_block.type === 'tool_use')
const stop = (result: Awaited<ReturnType<typeof request>>) =>
  result.events.find(event => event.type === 'message_delta')?.delta.stop_reason
const inputs = (result: Awaited<ReturnType<typeof request>>) => result.events
  .filter(event => event.delta?.type === 'input_json_delta')
  .map(event => JSON.parse(event.delta.partial_json))
const normalized = (body: any) => body.messages.map((message: any) => ({ ...message,
  content: typeof message.content === 'string' ? message.content :
    message.content?.map((part: any) => part.text ?? '').join(''),
}))

function failures(input: Record<string, unknown>, decode = false): ProviderMessage[] {
  return [user, ...[1, 2].flatMap(index => [{ role: 'assistant', content: [{ type: 'tool_use',
    id: `old_${index}`, name: tool.name, input,
    ...(decode && { _tau_decode_status: { category: 'malformed' } }),
  }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `old_${index}`,
    content: 'The call failed.', is_error: true,
  }] }] as ProviderMessage[])]
}
let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  resetSessionVolatileFreeze()
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

await test('ID migration requires native transcript provenance and explicit originals take precedence', () => {
  const old = { type: 'tool_use' as const, id: 'toolu_compat_call_raw', name: tool.name, input: originalInput }
  assert.equal(restoreOpenRouterToolIdMetadata(old, 'msg_external'), old)
  assert.equal(restoreOpenRouterToolIdMetadata(old, undefined), old)
  const upgraded: ProviderContentBlock = restoreOpenRouterToolIdMetadata(old, 'compat-1234')
  assert.equal(upgraded._openrouter_tool_call_id, 'call_raw')
  assert.equal('_openrouter_tool_call_id' in old, false)
  const marked = { ...old, _openrouter_tool_call_id: old.id }
  assert.equal(restoreOpenRouterToolIdMetadata(marked, 'compat-1234'), marked)
  assert.equal(openRouterToolIdMap([{ role: 'assistant', content: [old] }]).get(old.id), old.id)
  const messages: ProviderMessage[] = [{ role: 'assistant', content: [upgraded] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: old.id, content: 'Done.' }] }]
  const control = anthropicMessagesToOpenAI(messages)
  assert.equal(control[0].tool_calls?.[0]?.id, old.id)
  assert.equal(control[1].tool_call_id, old.id)
})

for (const route of ['native', 'legacy'] as const) {
  await test(`${route}: opaque tool IDs survive parallel calls and result replay exactly`, async () => {
    const ids = ['c17f97c6-66e1-4500-b4cd-a90e879dd4c2', 'call_provider_2',
      'toolu_compat_provider_owned', 'toolu_provider_4']
    const first = await request(route, [...ids.map((id, index) =>
      fragment(index, JSON.stringify(originalInput), tool.name, id)), finish()])
    assert.equal(first.error, undefined)
    const blocks = starts(first).map((event, index) => ({ ...event.content_block, input: inputs(first)[index] }))
    const messages: ProviderMessage[] = [user, { role: 'assistant', content: blocks },
      { role: 'user', content: [3, 1, 2, 0].map(index => ({ type: 'tool_result',
        tool_use_id: blocks[index].id, content: 'Stored.' })) }]
    const replay = await request(route, [{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }],
      { messages: JSON.parse(JSON.stringify(messages)) })
    assert.equal(replay.error, undefined)
    assert.deepEqual(replay.body.messages.find((message: any) => message.tool_calls)?.tool_calls.map((call: any) => call.id), ids)
    assert.deepEqual(replay.body.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.tool_call_id),
      [ids[3], ids[1], ids[2], ids[0]])
    assert.deepEqual(blocks.map(block => block._openrouter_tool_call_id), ids)
    assert.equal(JSON.stringify(replay.body).includes('_openrouter_tool_call_id'), false)
  })
  await test(`${route}: a resumed tool turn preserves prior reasoning on its assistant message`, async () => {
    const reasoning = 'Retain exactly: spaces  and\nUnicode 中文.'
    const messages: ProviderMessage[] = [user, { role: 'assistant', content: [
      { type: 'thinking', thinking: reasoning },
      { type: 'tool_use', id: 'prior-call', name: tool.name, input: originalInput },
    ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'prior-call', content: 'Stored.' }] }]
    const result = await request(route, clean, { messages })
    assert.equal(result.error, undefined)
    const prior = result.body.messages.find((message: any) => message.tool_calls?.[0]?.id === 'prior-call')
    assert.equal(prior.reasoning, reasoning)
    assert.deepEqual((messages[1]!.content as any[])[0], { type: 'thinking', thinking: reasoning })
  })
  await test(`${route}: streamed reasoning details survive parallel tools and JSON resume exactly once`, async () => {
    const detail = { type: 'reasoning.text', index: 0, id: 'r1', format: 'provider-v1', text: 'First ' }
    const chunks = [
      { choices: [{ delta: { reasoning: 'Original plain text.', reasoning_details: [detail] }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_details: [{ ...detail, text: 'second', signature: 'opaque-signature' }] }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_details: [
        { type: 'reasoning.encrypted', index: 0, id: 'enc1', data: 'opaque-1==' },
        { type: 'reasoning.encrypted', index: 0, id: 'enc2', data: 'opaque-2==' },
      ] }, finish_reason: null }] },
      fragment(0, JSON.stringify(originalInput), tool.name), fragment(1, JSON.stringify(originalInput), tool.name), finish(),
    ]
    const result = await request(route, chunks)
    assert.equal(result.error, undefined)
    const blocks = starts(result).map((event, index) => ({ ...event.content_block, input: inputs(result)[index] }))
    const expected = [{ ...detail, text: 'First second', signature: 'opaque-signature' },
      { type: 'reasoning.encrypted', index: 0, id: 'enc1', data: 'opaque-1==' },
      { type: 'reasoning.encrypted', index: 0, id: 'enc2', data: 'opaque-2==' }]
    assert.deepEqual(blocks[0]._openrouter_reasoning.reasoning_details, expected)
    assert.equal(blocks[1]._openrouter_reasoning, undefined)
    assert.deepEqual(inputs(result), [originalInput, originalInput])
    assert.deepEqual(result.events.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking), ['Original plain text.'])
    const messages = JSON.parse(JSON.stringify([user, { role: 'assistant', content: blocks },
      { role: 'user', content: blocks.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Stored.' })) }]))
    const replay = await request(route, clean, { messages })
    const assistant = replay.body.messages.find((m: any) => m.tool_calls?.length === 2)
    assert.deepEqual(assistant.reasoning_details, expected)
    assert.equal(assistant.reasoning, undefined, 'do not duplicate the plaintext alias alongside structured reasoning')
    assert.equal(JSON.stringify(replay.body).includes('_openrouter_reasoning'), false)
    const extended = await request(route, clean, { messages: [...messages, { role: 'user', content: 'Continue.' }] })
    assert.deepEqual(extended.body.messages.find((m: any) => m.tool_calls?.length === 2), assistant)
    assert.deepEqual(extended.body.tools, replay.body.tools)
    assert.equal(extended.body.prompt_cache_key, replay.body.prompt_cache_key)
  })
  await test(`${route}: full-response recovery retains separate reasoning blocks and drops failed reasoning`, async () => {
    const details = [
      { type: 'reasoning.summary', index: 0, summary: 'One.' },
      { type: 'reasoning.summary', index: 0, summary: 'Two.' },
      { type: 'reasoning.encrypted', data: 'opaque' },
    ]
    const result = await request(route, [{ choices: [{ delta: { reasoning: 'Abandoned',
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'abandoned' }] }, finish_reason: null }] }, finish('error')],
      { completion: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        reasoning_details: details, tool_calls: [{ id: 'recovery-call', type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(originalInput) } }],
      } }] } })
    assert.equal(result.error, undefined)
    assertRecoveryRequest(result.bodies)
    assert.deepEqual(starts(result)[0].content_block._openrouter_reasoning, { reasoning_details: details })
    assert.equal(JSON.stringify(result.events).toLowerCase().includes('abandoned'), false)
  })
  await test(`${route}: explicitly empty reasoning details stay present on the next tool turn`, async () => {
    const result = await request(route, [{ choices: [{ delta: { reasoning_details: [] }, finish_reason: null }] }, ...clean])
    assert.equal(result.error, undefined)
    assert.deepEqual(starts(result)[0].content_block._openrouter_reasoning, { reasoning_details: [] })
  })
  await test(`${route}: complete SSE frames survive CRLF, multiline data, and byte splitting`, async () => {
    const wire = ': OPENROUTER PROCESSING\r\n\r\n' + clean.map(chunk =>
      JSON.stringify(chunk, null, 2).split('\n').map(line => `data:${line}`).join('\r\n') + '\r\n\r\n').join('') +
      'data: [DONE]\r\n\r\n'
    const result = await request(route, clean, { wire, packetSize: 1 })
    assert.equal(result.error, undefined)
    assert.deepEqual(inputs(result), [originalInput])
  })
  await test(`${route}: strict optional nulls match the advertised schema in a parallel batch`, async () => {
    const optionalTool = { ...tool, input_schema: { ...tool.input_schema,
      properties: { ...(tool.input_schema.properties as Record<string, unknown>), note: { type: 'string' } },
    } }
    const values = Array.from({ length: 3 }, (_, index) => ({ ...originalInput, location: `record-${index}`, note: null }))
    const result = await request(route, [...values.map((input, index) => fragment(index, JSON.stringify(input), tool.name)), finish()],
      { tools: [optionalTool], model: 'openai/gpt-5' })
    assert.equal(result.error, undefined)
    assert.equal(starts(result).length, 3)
    assert.deepEqual(inputs(result), values.map(({ note: _note, ...value }) => value))
    assert(result.body.tools[0].function.parameters.required.includes('note'))
  })
  await test(`${route}: transient upstream failure retries once with unchanged input and no leaked tools`, async () => {
    const broken = [fragment(0, '{"location":"unfinished', tool.name), {
      id: 'gen-error', provider: 'example-upstream', error: { code: 502, message: 'Provider disconnected' },
      choices: [{ delta: {}, finish_reason: 'error' }],
    }]
    const result = await request(route, clean, { attempts: [broken, clean] })
    assert.equal(result.error, undefined)
    assert.equal(result.bodies.length, 2)
    assertRecoveryRequest(result.bodies, CUT_OFF)
    assert.equal(starts(result).length, 1)
    assert.equal(result.events.filter(e => e.type === 'message_start').length, 1)
    assert.deepEqual(inputs(result), [originalInput])
  })
  const saturated = (id: string) => ({ id, provider: 'Nvidia', error: { code: 502,
    message: 'Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)' },
    choices: [{ delta: {}, finish_reason: 'error' }] })
  await test(`${route}: a saturated provider gets the identical streaming request until it recovers`, async () => {
    const result = await request(route, clean, { attempts: [[saturated('gen-busy-1')],
      [fragment(0, '{"location":"unfinished', tool.name), saturated('gen-busy-2')], clean] })
    assert.equal(result.error, undefined)
    assert.equal(result.bodies.length, 3)
    for (const body of result.bodies) assert.deepEqual(body, result.bodies[0], 'same prompt, schemas and cache identity')
    assert.equal(result.bodies[0].stream, true)
    assert.equal(starts(result).length, 1)
    assert.deepEqual(inputs(result), [originalInput])
    assert.equal(result.events.filter(e => e.type === 'message_start').length, 1)
  })
  await test(`${route}: capacity retries are bounded and the error keeps the first and last generation`, async () => {
    const result = await request(route, clean, { attempts: [1, 2, 3, 4, 5].map(index => [saturated(`gen-busy-${index}`)]) })
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 1 + CAPACITY_DELAYS.length)
    assert(result.bodies.every(body => body.stream === true), 'waiting for capacity never changes delivery mode')
    assert.match(result.error.message, /ResourceExhausted.*Generation: gen-busy-5\. No tool ran\./)
    assert.match(result.error.message, /Recovery failed after 5 attempts \(streaming 5 times\) over \d+s while the provider reported rate limiting or no free capacity\./)
    assert.match(result.error.message, /Initial failure: generation gen-busy-1, provider Nvidia, code 502\./)
    assert.equal(result.events.length, 0)
    assert.equal(isRetryableProviderError(result.error), false)
    assert.equal(isRetryableNetworkError(result.error), false)
    assert.equal(isFallbackEligibleThrownError(result.error), false)
  })
  await test(`${route}: a daily cap is not retried and says when it resets`, async () => {
    const result = await request(route, [{ id: 'gen-daily', error: { code: 429,
      message: 'Rate limit exceeded: limit_rpd/example/model. Daily limit reached for example/model:free.',
      metadata: { headers: { 'X-RateLimit-Reset': String(Date.now() + 5 * 3_600_000) } } },
      choices: [{ delta: {}, finish_reason: 'error' }] }])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 1)
    assert.match(result.error.message, /Recovery was not attempted: the provider's limit resets in 5h 0m\./)
  })
  await test(`${route}: a limit that resets within a minute is waited out`, async () => {
    const began = Date.now()
    const result = await request(route, clean, { attempts: [[{ id: 'gen-minute', error: { code: 429,
      message: 'Rate limit exceeded: free-models-per-min.',
      metadata: { headers: { 'X-RateLimit-Reset': String(Date.now() + 400) } } },
      choices: [{ delta: {}, finish_reason: 'error' }] }], clean] })
    assert.equal(result.error, undefined)
    assert.equal(result.bodies.length, 2)
    assert(Date.now() - began >= 350, 'the retry waited for the stated reset')
  })
  await test(`${route}: Escape during a capacity wait sends nothing further`, async () => {
    _setOpenRouterCapacityDelaysForTest([60_000])
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25)
    try {
      const began = Date.now()
      const result = await request(route, [saturated('gen-busy')], { signal: controller.signal })
      assert.equal(result.bodies.length, 1)
      assert(Date.now() - began < 5_000, 'the wait ends at once')
      assert.equal(starts(result).length, 0)
    } finally {
      clearTimeout(timer)
      _setOpenRouterCapacityDelaysForTest(CAPACITY_DELAYS)
    }
  })
  const cut = [fragment(0, '{"location":"C:\\\\Temp\\\\out.txt","value":"row 1\\nrow', tool.name), finish('error')]
  await test(`${route}: the error names the tool call the provider cut off`, async () => {
    const result = await request(route, cut)
    assert(result.error instanceof OpenRouterUpstreamError)
    assertRecoveryRequest(result.bodies, CUT_OFF)
    assert.match(result.error.message, /The unfinished StoreRecord call was discarded; no tool ran\./)
    assert.match(result.error.message, /Recovery failed after 2 attempts \(streaming, then non-streaming\)\. The recovery told the model its tool call had been cut off and asked for shorter arguments\. Initial failure/)
    assert.equal(starts(result).length, 0)
  })
  await test(`${route}: a cut-off call is explained once and redone as a shorter complete call`, async () => {
    const shorter = { location: 'C:\\Temp\\out.txt', value: 'row 1' }
    const result = await request(route, clean, { attempts: [cut,
      [fragment(0, JSON.stringify(shorter), tool.name), finish()]] })
    assert.equal(result.error, undefined)
    assertRecoveryRequest(result.bodies, CUT_OFF)
    const note = result.bodies[1].messages.at(-1).content
    assert.match(note, /while you were still generating the arguments of a StoreRecord call \(location: C:\\Temp\\out\.txt\)\./)
    assert.equal(note.includes('row 1'), false, 'the cut-off content is never echoed or reconstructed')
    assert.equal(starts(result).length, 1)
    assert.deepEqual(inputs(result), [shorter])
  })
  await test(`${route}: a capacity wait after the explanation resends it unchanged`, async () => {
    const result = await request(route, clean, { attempts: [cut, [saturated('gen-busy')], clean] })
    assert.equal(result.error, undefined)
    assert.equal(result.bodies.length, 3)
    assert.equal(result.bodies[2].stream, true)
    assert.deepEqual(result.bodies[2].messages, result.bodies[1].messages)
    assert.match(result.bodies[2].messages.at(-1).content, CUT_OFF)
    assert.deepEqual(inputs(result), [originalInput])
  })
  await test(`${route}: a failure before any tool call adds no explanation`, async () => {
    const result = await request(route, clean, { attempts: [[{ choices: [{ delta: { content: 'Working.' }, finish_reason: null }] },
      finish('error')], clean] })
    assert.equal(result.error, undefined)
    assertRecoveryRequest(result.bodies)
  })
  await test(`${route}: repeated upstream errors stop after one recovery and retain details`, async () => {
    const result = await request(route, [{ id: 'gen-known', provider: 'upstream-name',
      error: { code: 500, message: 'Internal provider failure' }, choices: [{ delta: {}, finish_reason: 'error' }],
    }])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 2)
    assert.match(String(result.error), /500.*Internal provider failure.*upstream-name.*gen-known/)
    assert.equal(starts(result).length, 0)
    assert.equal(isRetryableProviderError(result.error), false)
    assert.equal(isFallbackEligibleThrownError(result.error), false)
  })
  await test(`${route}: bare error finish is an upstream failure, even without tool calls`, async () => {
    const result = await request(route, [finish('error')])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 2)
    assert.equal(result.events.length, 0)
  })
  await test(`${route}: the saved error distinguishes two failures and preserves both generation IDs`, async () => {
    const failure = (id: string) => ({ id, provider: 'example-upstream',
      choices: [{ delta: {}, finish_reason: 'error' }],
    })
    const result = await request(route, clean, { attempts: [[failure('gen-first')], [failure('gen-recovery')]] })
    assert(result.error instanceof OpenRouterUpstreamError)
    assertRecoveryRequest(result.bodies)
    assert.equal(result.error.generation, 'gen-recovery')
    assert.match(result.error.message, /Generation: gen-recovery/)
    assert.match(result.error.message, /Recovery failed after 2 attempts \(streaming, then non-streaming\)/)
    assert.match(result.error.message, /Initial failure: generation gen-first, provider example-upstream/)
    assert.equal(isFallbackEligibleAPIErrorMessage({ isApiErrorMessage: true, error: 'unknown',
      message: { content: [{ type: 'text', text: `API Error: ${result.error.message}` }] },
    } as any), false)
    assert.equal(result.events.length, 0)
  })
  await test(`${route}: an announcement before a failed tool batch recovers without duplicate text or calls`, async () => {
    const result = await request(route, [{ choices: [{ delta: { content: 'Working on the task.' }, finish_reason: null }] },
      fragment(0, '{"location":"unfinished', tool.name), finish('error')], { completion: {
      id: 'recovered', model: 'example/model', choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: 'Recovered announcement.',
        tool_calls: [{ id: 'recovered-call', type: 'function', function: { name: tool.name, arguments: JSON.stringify(originalInput) } }],
      } }], usage: { prompt_tokens: 63664, completion_tokens: 70 },
    } })
    assert.equal(result.error, undefined)
    assertRecoveryRequest(result.bodies, CUT_OFF)
    assert.equal(starts(result).length, 1)
    assert.deepEqual(inputs(result), [originalInput])
    assert.equal(result.events.filter(e => e.type === 'message_start').length, 1)
    assert.deepEqual(result.events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text), ['Recovered announcement.'])
    assert.equal(result.events.find(e => e.type === 'message_delta')?.usage.input_tokens, 63664)
    assert.equal(result.progress, 1, 'buffered network activity reaches the watchdog without duplicate content')
  })
  await test(`${route}: failure after preliminary reasoning retries without leaking abandoned reasoning or calls`, async () => {
    const broken = [{ choices: [{ delta: { reasoning_content: 'abandoned private reasoning' }, finish_reason: null }] },
      fragment(0, '{"location":"unfinished', tool.name), finish('error')]
    const result = await request(route, clean, { attempts: [broken, clean] })
    assert.equal(result.error, undefined)
    assert.equal(result.bodies.length, 2)
    assertRecoveryRequest(result.bodies, CUT_OFF)
    assert.equal(result.events.filter(e => e.type === 'message_start').length, 1)
    assert.equal(result.events.some(e => e.delta?.thinking?.includes('abandoned')), false)
    assert.deepEqual(inputs(result), [originalInput])
  })
  await test(`${route}: repeated reasoning failures stop after one recovery with no leaked output`, async () => {
    const result = await request(route, [{ choices: [{ delta: { reasoning_content: 'still working' }, finish_reason: null }] },
      finish('error')])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 2)
    assert.equal(result.events.length, 0)
  })
  await test(`${route}: large reasoning buffers flush once and disable replay`, async () => {
    const result = await request(route, [{ choices: [{ delta: { reasoning_content: 'x'.repeat(256 * 1024) }, finish_reason: null }] },
      finish('error')])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 1)
    assert.equal(result.events.filter(e => e.delta?.type === 'thinking_delta').length, 1)
    assert.match(result.error.message, /Recovery was not attempted: the buffer limit was reached/)
  })
  await test(`${route}: text-only requests still stream and do not replay visible text`, async () => {
    const result = await request(route, [{ choices: [{ delta: { content: 'Visible answer' }, finish_reason: null }] }, finish('error')], { tools: [] })
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 1)
    assert.equal(result.events.some(e => e.delta?.text === 'Visible answer'), true)
  })
  await test(`${route}: no recovery can replay an already dispatched tool batch`, async () => {
    const result = await request(route, [...clean, finish('error')])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 1)
    assert.equal(starts(result).length, 1)
    assert.match(result.error.message, /Recovery was not attempted: output was already published/)
  })
  await test(`${route}: malformed or incomplete full-completion recovery never dispatches tools`, async () => {
    for (const recoveryWire of ['{"choices":', JSON.stringify({ choices: [{ message: { tool_calls: [] } }] })]) {
      const result = await request(route, [finish('error')], { recoveryWire })
      assert(result.error instanceof OpenRouterToolCallError)
      assert.equal(result.bodies.length, 2)
      assert.equal(starts(result).length, 0)
      assert.match(result.error.message, /Recovery failed after 2 attempts/)
    }
  })
  await test(`${route}: cancellation aborts the full-completion recovery request`, async () => {
    const controller = new AbortController()
    let aborted = false
    const result = await request(route, [finish('error')], { signal: controller.signal,
      onRecovery: async init => {
        const rejection = new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => {
          aborted = true
          reject(init.signal.reason)
        }, { once: true }))
        controller.abort()
        return rejection
      },
    })
    assert.equal(aborted, true)
    assert.equal(result.bodies.length, 2)
    assert.equal(starts(result).length, 0)
  })
  await test(`${route}: recovery HTTP failures cannot restart an outer fallback loop`, async () => {
    for (const onRecovery of [
      ...[400, 402, 500].map(status => async () => new Response(JSON.stringify({ error: { message: 'Recovery unavailable' } }), { status })),
      async () => { throw new TypeError('fetch failed') },
    ]) {
      const result = await request(route, [finish('error')], { onRecovery })
      assert(result.error instanceof OpenRouterToolCallError)
      assert.equal(result.bodies.length, 2)
      assert.equal(isFallbackEligibleThrownError(result.error), false)
      assert.equal(isRetryableProviderError(result.error), false)
      assert.equal(isRetryableNetworkError(result.error), false)
      assert.equal(result.events.length, 0)
      assert.match(result.error.message, /Recovery failed after 2 attempts/)
    }
  })
  await test(`${route}: a truncated recovery completion cannot execute closed but incomplete arguments`, async () => {
    const result = await request(route, [finish('error')], { completion: {
      id: 'truncated-recovery', choices: [{ finish_reason: 'length', message: { role: 'assistant',
        tool_calls: [{ id: 'cut-call', type: 'function', function: { name: tool.name, arguments: JSON.stringify(originalInput) } }],
      } }],
    } })
    assert.equal(result.error, undefined)
    assert.equal(result.bodies.length, 2)
    assert.equal(starts(result).length, 0)
    assert.equal(stop(result), 'max_tokens')
  })
  await test(`${route}: terminal upstream codes do not retry or masquerade as tools`, async () => {
    const result = await request(route, [{ error: { code: 402, message: 'Insufficient credits' }, choices: [] }])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 1)
    assert.match(String(result.error), /402.*Insufficient credits/)
    assert.match(result.error.message, /Recovery was not attempted: the upstream error is not retryable/)
  })
  await test(`${route}: native error finish cannot be overridden by normalized tool_calls`, async () => {
    const result = await request(route, [fragment(0, JSON.stringify(originalInput), tool.name), {
      choices: [{ delta: {}, finish_reason: 'tool_calls', native_finish_reason: 'error' }],
    }])
    assert(result.error instanceof OpenRouterUpstreamError)
    assert.equal(result.bodies.length, 2)
    assert.equal(starts(result).length, 0)
  })
  await test(`${route}: cancellation during upstream recovery prevents another request`, async () => {
    const controller = new AbortController()
    const task = request(route, [finish('error')], { signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 25)
    try {
      const result = await task
      assert.equal(result.bodies.length, 1)
      assert.equal(starts(result).length, 0)
    } finally { clearTimeout(timer) }
  })
  await test(`${route}: context totals stay at 38k through Gemini cache writes and reads`, async () => {
    for (const [read, write] of [[0, 28000], [28000, 28000], [28000, 0]]) {
      const result = await request(route, [
        { model: 'google/gemini-fixture', choices: [{ delta: { content: 'OK' }, finish_reason: null }] }, finish('stop'),
        { model: 'google/gemini-fixture', choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 38000, completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } } },
      ], { model: 'google/gemini-fixture' })
      assert.equal(result.error, undefined)
      const deltas = result.events.filter(e => e.type === 'message_delta')
      assert.equal(deltas.length, 1)
      const usage = deltas[0].usage
      assert.equal(usage.input_tokens + (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0), 38000)
      assert.equal(usage.output_tokens, 8)
    }
  })
  await test(`${route}: non-Gemini cache read/write buckets remain disjoint`, async () => {
    const result = await request(route, [{ model: 'example/model', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 38000, completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 20000, cache_write_tokens: 8000 } } }])
    assert.equal(result.error, undefined)
    const usage = result.events.find(e => e.type === 'message_delta').usage
    assert.deepEqual(usage, { input_tokens: 10000, output_tokens: 8,
      cache_read_input_tokens: 20000, cache_creation_input_tokens: 8000 })
  })
  await test(`${route}: deferred schemas are all present initially, even with discovery forced on`, async () => {
    const prior = { search: process.env.ENABLE_TOOL_SEARCH, lazy: process.env.TAU_NATIVE_LAZY_TOOLS }
    process.env.ENABLE_TOOL_SEARCH = 'true'
    process.env.TAU_NATIVE_LAZY_TOOLS = 'true'
    try {
      const deferred = { ...tool, defer_loading: true }
      Object.defineProperty(deferred, '__tau_should_defer', { value: true })
      const extra = { ...deferred, name: 'mcp__example__update_record' }
      const source = [{ ...tool, name: 'ToolSearch' }, deferred, extra]
      for (const model of [undefined, 'example/model']) {
        const selected = selectToolsForToolSearchRequest(source as any, {
          useToolSearch: true, useNativeLaneToolSearch: true, provider: 'openrouter', model,
          deferredToolNames: new Set([deferred.name, extra.name]), discoveredToolNames: new Set(),
        })
        assert.deepEqual(selected.map(tool => tool.name), [deferred.name, extra.name])
      }
      // Bypass the upstream selector too: stale flags must be safe at the lane boundary.
      const initial = await request(route, clean, { tools: source })
      assert.equal(initial.error, undefined)
      assert(!JSON.stringify(initial.body.messages).includes('ToolSearch'), 'eager prompt still asks for unavailable discovery')
      assert.deepEqual(initial.body.tools.map((t: any) => t.function.name), [deferred.name, extra.name])
      for (const t of initial.body.tools) assert.deepEqual(t.function.parameters.required, ['location', 'value'])
      const later = await request(route, clean, { tools: [...source].reverse(),
        messages: [...failures({ value: 'missing location' }), { role: 'user', content: 'continue' }],
      })
      assert.equal(later.error, undefined)
      assert.deepEqual(later.body.tools, initial.body.tools)
    } finally {
      if (prior.search === undefined) delete process.env.ENABLE_TOOL_SEARCH
      else process.env.ENABLE_TOOL_SEARCH = prior.search
      if (prior.lazy === undefined) delete process.env.TAU_NATIVE_LAZY_TOOLS
      else process.env.TAU_NATIVE_LAZY_TOOLS = prior.lazy
    }
  })
  await test(`${route}: repeated invalid fields in one batch stop before any dispatch`, async () => {
    const result = await request(route, [...Array.from({ length: 6 }, (_, index) =>
      fragment(index, JSON.stringify({ title: `Guessed ${index}`, value: 'wrong field' }), tool.name)), finish()])
    assert(result.error instanceof OpenRouterToolCallError)
    assert.equal(starts(result).length, 0)
  })
  await test(`${route}: an undeclared tool cannot run`, async () => {
    const result = await request(route, [fragment(0, '{}', 'InventedTool'), finish()])
    assert(result.error instanceof OpenRouterToolCallError)
    assert.match(String(result.error), /not declared/)
    assert.equal(starts(result).length, 0)
  })
  await test(`${route}: fragmented Unicode and Windows paths arrive exactly`, async () => {
    const raw = JSON.stringify(originalInput)
    const chunks = [...raw].map((character, index) => fragment(0, character, index === 0 ? tool.name : undefined))
    const result = await request(route, [...chunks, finish()], { packetSize: 1 })
    assert.equal(result.error, undefined)
    assert.deepEqual(inputs(result), [originalInput])
    assert.equal(starts(result).length, 1)
  })
  await test(`${route}: interleaved calls retain their own arguments`, async () => {
    const result = await request(route, [fragment(1, '{"location":"b",', tool.name),
      fragment(0, '{"location":"a",', tool.name), fragment(1, '"value":"B"}'),
      fragment(0, '"value":"A"}'), finish(), finish()])
    assert.equal(result.error, undefined)
    assert.deepEqual(inputs(result), [{ location: 'a', value: 'A' }, { location: 'b', value: 'B' }])
  })
  await test(`${route}: reasoning closes before the completed tool batch`, async () => {
    const result = await request(route, [{ choices: [{ index: 0,
      delta: { reasoning_content: 'Working through the record.' }, finish_reason: null,
    }] }, ...clean])
    assert.equal(result.error, undefined)
    const opened = result.events.filter(event => event.type === 'content_block_start').map(event => event.index)
    const closed = result.events.filter(event => event.type === 'content_block_stop').map(event => event.index)
    assert.deepEqual(opened, [0, 1])
    assert.deepEqual(closed, [0, 1])
    assert.deepEqual(inputs(result), [originalInput])
  })
  await test(`${route}: no tool escapes an interrupted batch, even valid closed JSON`, async () => {
    const result = await request(route, [fragment(0, JSON.stringify(originalInput), tool.name),
      fragment(1, '{"location":"other","value":"partial"}', tool.name), finish('length')])
    assert.equal(result.error, undefined)
    assert.equal(starts(result).length, 0)
    assert.equal(stop(result), 'max_tokens')
  })
  await test(`${route}: native truncation outranks a normalized tool_calls finish`, async () => {
    const end = finish()
    const result = await request(route, [clean[0], { choices: [{ ...end.choices[0], native_finish_reason: 'MAX_TOKENS' }] }])
    assert.equal(starts(result).length, 0)
    assert.equal(stop(result), 'max_tokens')
  })
  await test(`${route}: ambiguous indexes and identifiers are rejected before dispatch`, async () => {
    for (const bad of [
      { function: { name: tool.name, arguments: '{}' } },
      { index: 0, id: 7, function: { name: tool.name, arguments: '{}' } },
      null,
    ]) {
      const result = await request(route, [{ choices: [{ delta: { tool_calls: [bad] } }] }, finish()])
      assert(result.error instanceof OpenRouterToolCallError)
      assert.equal(starts(result).length, 0)
    }
    const duplicate = await request(route, [fragment(0, '{}', tool.name, 'same'), fragment(1, '{}', tool.name, 'same'), finish()])
    assert(duplicate.error instanceof OpenRouterToolCallError)
    assert.equal(starts(duplicate).length, 0)
  })
  for (const ending of ['eof', 'done', 'error', 'bad-json', 'content_filter']) {
    await test(`${route}: ${ending} cannot flush pending tools`, async () => {
      const first = fragment(0, JSON.stringify(originalInput), tool.name)
      const suffix = ending === 'done' ? 'data: [DONE]\n\n' : ending === 'error'
        ? 'data: {"error":{"code":500}}\n\n' : ending === 'bad-json'
          ? 'data: {broken\n\n' : ending === 'content_filter' ? `data: ${JSON.stringify(finish('content_filter'))}\n\n` : ''
      const result = await request(route, [], { wire: `data: ${JSON.stringify(first)}\n\n${suffix}` })
      assert(result.error instanceof OpenRouterToolCallError)
      assert.equal(starts(result).length, 0)
      assert.equal(isRetryableNetworkError(result.error), false)
      assert.equal(isRetryableProviderError(result.error), false)
      assert.equal(isFallbackEligibleThrownError(result.error), false)
    })
  }
  await test(`${route}: malformed arguments are marked; no _raw repair`, async () => {
    const result = await request(route, [fragment(0, '{"location":"unfinished', tool.name), finish()])
    assert.equal(result.error, undefined)
    assert.equal(starts(result)[0].content_block._tau_decode_status?.category, 'malformed')
    assert.deepEqual(inputs(result), [{}])
  })
  await test(`${route}: third malformed attempt terminates before dispatch`, async () => {
    const result = await request(route, [fragment(0, '{"location":"another', tool.name), finish()],
      { messages: failures({}, true) })
    assert(result.error instanceof OpenRouterToolCallError)
    assert.equal(starts(result).length, 0)
  })
  await test(`${route}: third missing-field attempt terminates without guessed values`, async () => {
    const result = await request(route, [fragment(0, '{"value":"changed"}', tool.name), finish()],
      { messages: failures({ value: 'old' }) })
    assert(result.error instanceof OpenRouterToolCallError)
    assert.equal(starts(result).length, 0)
  })
  await test(`${route}: a corrected schema-valid retry succeeds`, async () => {
    const result = await request(route, clean, { messages: failures({ value: 'old' }) })
    assert.equal(result.error, undefined)
    assert.deepEqual(inputs(result), [originalInput])
  })
  await test(`${route}: full initial context and tool descriptions stay frozen`, async () => {
    const a = await request(route, [finish('stop')])
    const messages: ProviderMessage[] = [user, { role: 'assistant', content: 'a' }, { role: 'user', content: 'new live task' }]
    const b = await request(route, [finish('stop')], { messages, system: 'Changed rules.\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\nChanged git status.',
      tools: [{ ...tool, description: 'Changed description' }], max_tokens: 65536 })
    assert.deepEqual(normalized(b.body).slice(0, a.body.messages.length), normalized(a.body))
    assert.deepEqual(b.body.tools, a.body.tools)
    assert.equal(b.body.session_id, a.body.session_id)
    assert.equal(b.body.prompt_cache_key, a.body.prompt_cache_key)
    assert.equal(b.body.max_tokens, 65536)
    assert(JSON.stringify(b.body).includes('new live task'))
    assert(!JSON.stringify(b.body).includes('Changed'))
  })
  await test(`${route}: empty initial context cannot acquire a late prefix`, async () => {
    const a = await request(route, [finish('stop')], { system: '' })
    const b = await request(route, [finish('stop')], { system: 'Late system and context' })
    assert.deepEqual(b.body.messages, a.body.messages)
  })
  await test(`${route}: explicit reset and separate request purpose refresh context`, async () => {
    await request(route, [finish('stop')], { system: 'Initial' })
    const other = await request(route, [finish('stop')], { system: 'Helper instructions', querySource: 'helper' })
    assert(JSON.stringify(other.body.messages).includes('Helper instructions'))
    resetSessionVolatileFreeze()
    const reset = await request(route, [finish('stop')], { system: 'New deliberate instructions' })
    assert(JSON.stringify(reset.body.messages).includes('New deliberate instructions'))
  })
  await test(`${route}: separate sessions never share initial instructions`, async () => {
    await request(route, [finish('stop')], { system: 'Session A', sessionId: 'a' })
    const other = await request(route, [finish('stop')], { system: 'Session B', sessionId: 'b' })
    assert(JSON.stringify(other.body.messages).includes('Session B'))
    assert(!JSON.stringify(other.body.messages).includes('Session A'))
  })
  await test(`${route}: tool order is stable; removed tools and changed contracts stay live`, async () => {
    const extra = { ...tool, name: 'Other' }
    const a = await request(route, [finish('stop')], { tools: [tool, extra] })
    const b = await request(route, [finish('stop')], { tools: [extra, tool] })
    assert.deepEqual(b.body.tools, a.body.tools)
    const changed = { ...tool, input_schema: { ...tool.input_schema, required: ['value'] } }
    const c = await request(route, [finish('stop')], { tools: [changed] })
    assert.deepEqual(c.body.tools.map((entry: any) => entry.function.name), [tool.name])
    assert.deepEqual(c.body.tools[0].function.parameters.required, ['value'])
  })
}

const rejection = (status: number, error: Record<string, unknown>, headers?: Record<string, string>) =>
  () => new Response(JSON.stringify({ error }), { status, headers })
await test('native: an HTTP rejection surfaces as an error, never as assistant text', async () => {
  for (const [status, error, expected] of [
    [404, { code: 404, message: 'No endpoints found that support tool use. Try disabling "Agent".',
      metadata: { failed_routing_step: 'Filter by Tool Compatibility' } },
      /^openrouter API error 404: No endpoints found that support tool use\. Try disabling "Agent"\.$/],
    [403, { code: 403, message: 'example/model:free is only available on agentic harnesses.' },
      /^openrouter API error 403: example\/model:free is only available on agentic harnesses\.$/],
    [404, { code: 404, message: 'Ling-2.6-1T is no longer available as a free model.' },
      /^openrouter API error 404: Ling-2\.6-1T is no longer available as a free model\.$/],
    [413, { code: 413, message: 'Provider returned error', metadata: { provider_name: 'OpenInference',
      raw: '{"error":{"message":"Request too large","type":"invalid_request_error"}}' } },
      /^openrouter API error 413 \(OpenInference\): Request too large$/],
    [400, { code: 400, message: 'This endpoint\'s maximum context length is 131072 tokens.' },
      /^Prompt is too long \(openrouter 400\)/],
  ] as const) {
    const result = await request('native', clean, { http: [rejection(status, error)] })
    assert(result.error instanceof OpenRouterUpstreamError, `${status} must throw`)
    assert.match(result.error.message, expected)
    assert.equal(result.bodies.length, 1, `${status} is not resent`)
    assert.equal(result.events.length, 0, 'the rejection never becomes the model\'s own words')
    assert.equal(isRetryableProviderError(result.error), false)
    assert.equal(isRetryableNetworkError(result.error), false)
  }
})
await test('native: a rate-limited upstream pool is waited out with the same streaming request', async () => {
  const limited = rejection(429, { code: 429, message: 'Provider returned error', metadata: {
    raw: 'example/model:free is temporarily rate-limited upstream. Please retry shortly.',
    provider_name: 'Poolside', limit_source: 'upstream_provider_shared_pool' } })
  const recovered = await request('native', clean, { http: [limited, limited] })
  assert.equal(recovered.error, undefined)
  assert.equal(recovered.bodies.length, 3)
  for (const body of recovered.bodies) assert.deepEqual(body, recovered.bodies[0])
  assert.deepEqual(inputs(recovered), [originalInput])
  const persistent = await request('native', clean, { http: Array(5).fill(limited) })
  assert(persistent.error instanceof OpenRouterUpstreamError)
  assert.equal(persistent.bodies.length, 5)
  assert.match(persistent.error.message, new RegExp('^openrouter API error 429 \\(Poolside\\): example/model:free is ' +
    'temporarily rate-limited upstream\\. Please retry shortly\\. Recovery failed after 5 attempts \\(streaming 5 times\\) ' +
    'over \\d+s while the provider reported rate limiting or no free capacity\\. Initial failure: provider Poolside, code 429\\.'))
  // The retries already happened here; no outer fallback chain starts again.
  assert.equal(isFallbackEligibleAPIErrorMessage({ isApiErrorMessage: true, error: 'unknown',
    message: { content: [{ type: 'text', text: `API Error: ${persistent.error.message}` }] } } as any), false)
  // A first-attempt rejection keeps its existing /fallback eligibility.
  const unpaid = await request('native', clean, { http: [rejection(402, { code: 402, message: 'Insufficient credits' })] })
  assert.equal(isFallbackEligibleAPIErrorMessage({ isApiErrorMessage: true, error: 'unknown',
    message: { content: [{ type: 'text', text: `API Error: ${String((unpaid.error as Error).message)}` }] } } as any), true)
})
await test('native: a daily cap or a distant Retry-After fails at once with the reset time', async () => {
  const daily = await request('native', clean, { http: [rejection(429, { code: 429,
    message: 'Rate limit exceeded: limit_rpd/minimax/minimax-m3. Daily limit reached for minimax/minimax-m3:free via GMICloud.',
    metadata: { headers: { 'X-RateLimit-Reset': String(Date.now() + 90 * 60_000) }, limit_source: 'openrouter_shared_capacity' } })] })
  assert(daily.error instanceof OpenRouterUpstreamError)
  assert.equal(daily.bodies.length, 1)
  assert.match(daily.error.message, /Daily limit reached.*Recovery was not attempted: the provider's limit resets in 1h 30m\.$/)
  const distant = await request('native', clean, { http: [rejection(503, { code: 503, message: 'Service unavailable' },
    { 'retry-after': '600' })] })
  assert.equal(distant.bodies.length, 1)
  assert.match(String(distant.error), /Recovery was not attempted: the provider's limit resets in 10m\.$/)
})

await test('exact repeated execution errors stop; a successful intervening read permits retry', () => {
  const history = failures(originalInput)
  assert.throws(() => assertOpenRouterToolProgress(history, [tool], tool.name, JSON.stringify(originalInput)), OpenRouterToolCallError)
  history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fresh-read', content: 'Current state' }] })
  assert.doesNotThrow(() => assertOpenRouterToolProgress(history, [tool], tool.name, JSON.stringify(originalInput)))
})
await test('unrelated successful calls cannot reset repeated argument failures', () => {
  const history = failures({ value: 'missing location' })
  history.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'ReadState', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Fresh state' }] })
  assert.throws(() => assertOpenRouterToolProgress(history, [tool], tool.name, '{"value":"different"}'), OpenRouterToolCallError)
  assert.doesNotThrow(() => assertOpenRouterToolProgress(history, [tool], tool.name, JSON.stringify(originalInput)))
})
await test('changing schema-valid arguments after repeated execution failures requires fresh evidence', () => {
  const history = failures(originalInput)
  const changed = { ...originalInput, value: 'another speculative replacement' }
  assert.throws(() => assertOpenRouterToolProgress(history, [tool], tool.name, changed), OpenRouterToolCallError)
  history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'inspection', content: 'Current state' }] })
  assert.doesNotThrow(() => assertOpenRouterToolProgress(history, [tool], tool.name, changed))
})
await test('DeepSeek keeps its existing context and stream behavior', async () => {
  await request('native', [finish('stop')], { system: 'Original rules', provider: 'deepseek' })
  const result = await request('native', clean, { system: 'Changed rules', provider: 'deepseek' })
  assert(JSON.stringify(result.body.messages).includes('Changed rules'))
  assert.deepEqual(inputs(result), [originalInput])
})
await test('legacy create shares truncation, decode status and loop protection', async () => {
  const oldFetch = globalThis.fetch
  let reason = 'tool_calls'
  let args = JSON.stringify(originalInput)
  const reasoningDetails = [{ type: 'reasoning.encrypted', id: 'state', data: 'opaque-state' }]
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'fixture', model: 'example/model',
    choices: [{ index: 0, finish_reason: reason, message: { role: 'assistant', content: null,
      reasoning_details: reasoningDetails,
      tool_calls: [{ id: 'fixture', type: 'function', function: { name: tool.name, arguments: args } }],
    } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
  }))) as unknown as typeof fetch
  try {
    const provider = new OpenRouterProvider({ apiKey: 'test' })
    const params = { model: 'example/model', messages: [user], tools: [tool], max_tokens: 32768 }
    const valid = await provider.create(params)
    assert.deepEqual(valid.content.find(block => block.type === 'tool_use')?.input, originalInput)
    assert.deepEqual(valid.content.find(block => block.type === 'tool_use')?._openrouter_reasoning,
      { reasoning_details: reasoningDetails })
    reason = 'length'
    const truncated = await provider.create(params)
    assert.equal(truncated.stop_reason, 'max_tokens')
    assert.equal(truncated.content.some(block => block.type === 'tool_use'), false)
    reason = 'tool_calls'
    args = '{"location":"cut'
    const malformed = await provider.create(params)
    assert.equal(malformed.content.find(block => block.type === 'tool_use')?._tau_decode_status?.category, 'malformed')
    await assert.rejects(() => provider.create({ ...params, messages: failures({}, true) }), OpenRouterToolCallError)
  } finally { globalThis.fetch = oldFetch }
})
await test('OpenRouter reasoning state is not replayed by other provider adapters', async () => {
  const messages: ProviderMessage[] = [user, { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Prior plain reasoning.' },
    { type: 'tool_use', id: 'prior', name: tool.name, input: originalInput,
      _openrouter_reasoning: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'OR-only-secret' }] } },
  ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'prior', content: 'Stored.' }] }]
  const ordinary = anthropicMessagesToOpenAI(messages)
  const cached = anthropicMessagesToOpenAI(messages, '', { preserveCacheControl: true })
  for (const wire of [ordinary, cached]) {
    assert.equal(JSON.stringify(wire).includes('OR-only-secret'), false)
    assert.equal(wire.some(m => 'reasoning' in m || 'reasoning_details' in m), false)
  }
  const direct = await request('native', clean, { provider: 'deepseek', messages })
  assert.equal(JSON.stringify(direct.body).includes('OR-only-secret'), false)
})

await test('exhausted OpenRouter recovery stays terminal after conversion to an API error message', () => {
  const error = new OpenRouterToolCallError('The recovery request failed: OpenRouter API error 503: unavailable')
  for (const kind of ['unknown', 'server_error']) {
    assert.equal(isFallbackEligibleAPIErrorMessage({ isApiErrorMessage: true, error: kind,
      message: { content: [{ type: 'text', text: `API Error: ${error.message}` }] },
    } as any), false)
  }
  assert.equal(isFallbackEligibleThrownError(new Error('deepseek API error 503: unavailable')), true)
  assert.equal(isRetryableNetworkError(new Error('fetch failed')), true)
})
await test('routing uses directory slugs rather than guessed display-name normalization', async () => {
  const oldFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response(JSON.stringify({ data: [
      { name: 'AtlasCloud', slug: 'atlas-cloud' }, { name: 'Google', slug: 'google-vertex' },
    ] }))
  }) as unknown as typeof fetch
  try {
    assert.equal(await resolveOpenRouterProviderSlug('AtlasCloud'), 'atlas-cloud')
    assert.equal(await resolveOpenRouterProviderSlug('Google'), 'google-vertex')
    assert.equal(await resolveOpenRouterProviderSlug('Invented Host'), undefined)
    assert.equal(fetches, 1)
    _resetOpenRouterAutoPinForTest()
    await recordOpenRouterServedProvider('slug-session', 'fixture/model', 'AtlasCloud')
    const body = { model: 'fixture/model', messages: [], stream: true }
    openrouterTransformer.transformRequest(body, { model: body.model, sessionId: 'slug-session', isReasoning: false, reasoningEffort: null })
    assert.deepEqual((body as any).provider.order, ['atlas-cloud'])
    recordOpenRouterProviderDirectory({ data: [{ name: 'AtlasCloud', slug: 'bad slug' }] })
    assert.equal(await resolveOpenRouterProviderSlug('AtlasCloud'), 'atlas-cloud', 'malformed directory cannot erase verified data')
  } finally { globalThis.fetch = oldFetch; _resetOpenRouterAutoPinForTest() }
})
await test('native: a provider that failed mid-answer is not asked for first again; the next success re-pins', async () => {
  _resetOpenRouterAutoPinForTest()
  recordOpenRouterProviderDirectory({ data: [{ name: 'Provider A', slug: 'provider-a' }, { name: 'Provider B', slug: 'provider-b' }] })
  await recordOpenRouterServedProvider('pin-session', 'example/model', 'Provider A')
  const failedAtA = [fragment(0, '{"location":"unfinished', tool.name),
    { id: 'gen-a', provider: 'Provider A', choices: [{ delta: {}, finish_reason: 'error' }] }]
  const servedByB = [{ id: 'gen-b', provider: 'Provider B', ...fragment(0, JSON.stringify(originalInput), tool.name) }, finish()]
  const result = await request('native', clean, { sessionId: 'pin-session', attempts: [failedAtA, servedByB] })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.bodies[0].provider, { order: ['provider-a'] })
  assert.equal(result.bodies[1].provider, undefined, 'the retry leaves routing to OpenRouter')
  // Only the routing preference and the cut-off note differ; the prompt does not.
  const { provider: _pinned, stream: _stream, stream_options: _options, ...first } = result.bodies[0]
  const { stream: _recovery, ...retry } = result.bodies[1]
  assert.deepEqual({ ...retry, messages: retry.messages.slice(0, -1) }, first)
  const next = await request('native', clean, { sessionId: 'pin-session' })
  assert.deepEqual(next.bodies[0].provider, { order: ['provider-b'] }, 'the provider that served the success is pinned')
})
await test('native: provider rate limits unpin too; limits from OpenRouter itself, rejections and explicit orders are left alone', async () => {
  _resetOpenRouterAutoPinForTest()
  await recordOpenRouterServedProvider('pin-capacity', 'example/model', 'Provider A')
  const limited = rejection(429, { code: 429, message: 'Provider returned error',
    metadata: { raw: 'Rate limited upstream.', provider_name: 'Provider A' } })
  const waited = await request('native', clean, { sessionId: 'pin-capacity', http: [limited] })
  assert.equal(waited.error, undefined)
  assert.deepEqual(waited.bodies.map(body => body.provider), [{ order: ['provider-a'] }, undefined])

  await recordOpenRouterServedProvider('pin-own-limit', 'example/model', 'Provider A')
  const ownLimit = rejection(429, { code: 429, message: 'Rate limit exceeded: free-models-per-min.' })
  const own = await request('native', clean, { sessionId: 'pin-own-limit', http: [ownLimit] })
  assert.equal(own.error, undefined)
  assert.deepEqual(own.bodies.map(body => body.provider), [{ order: ['provider-a'] }, { order: ['provider-a'] }],
    'an OpenRouter limit that names no provider is not the provider failing')

  await recordOpenRouterServedProvider('pin-terminal', 'example/model', 'Provider A')
  const unpaid = await request('native', clean, { sessionId: 'pin-terminal',
    http: [rejection(402, { code: 402, message: 'Insufficient credits' })] })
  assert(unpaid.error instanceof OpenRouterUpstreamError)
  const after = await request('native', clean, { sessionId: 'pin-terminal' })
  assert.deepEqual(after.bodies[0].provider, { order: ['provider-a'] }, 'a 402 is not the provider failing')

  process.env.OPENROUTER_PROVIDER_ORDER = 'provider-a'
  try {
    const explicit = await request('native', clean, { sessionId: 'pin-explicit', attempts: [[{ id: 'gen-x',
      provider: 'Provider A', error: { code: 502, message: 'Upstream error' },
      choices: [{ delta: {}, finish_reason: 'error' }] }], clean] })
    assert.equal(explicit.error, undefined)
    assert.deepEqual(explicit.bodies.map(body => body.provider.order), [['provider-a'], ['provider-a']],
      'an explicit order always applies')
  } finally {
    delete process.env.OPENROUTER_PROVIDER_ORDER
    _resetOpenRouterAutoPinForTest()
  }
})
console.log(`\n${passed} passed`)
