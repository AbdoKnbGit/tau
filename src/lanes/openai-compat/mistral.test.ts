import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAICompatLane, _convertHistoryToOpenAIForTest } from './loop.js'
import { mistralTransformer } from './transformers/mistral.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'
import type { ProviderMessage, ProviderTool } from '../../services/api/providers/base_provider.js'
import { filterMistralCatalog, getMistralModelMeta, mistralStaticCatalog } from '../../utils/model/mistralCatalog.js'
import { cycleDirectEffort, directEffortLevels, directModelDetails, getDirectEffort, setDirectEffort } from '../../utils/model/directProviderThinking.js'
import { getProviderCatalogContextWindow } from '../../utils/model/contextWindows.js'
import { lookupCatalogPrice, resetCatalogForTests } from '../../utils/modelPricingCatalog.js'
import { modelAcceptsImages } from '../shared/vision_capability.js'
import { resetSessionVolatileFreeze } from '../shared/volatile_freeze.js'
import { registerForkedAgent, resolveProviderRequestSessionId } from '../../services/api/cacheAffinity.js'
import type { AgentId } from '../../types/ids.js'
import type { QuerySource } from '../../constants/querySource.js'

const temp = mkdtempSync(join(tmpdir(), 'tau-mistral-'))
const oldStore = process.env.TAU_DIRECT_THINKING_STORE
process.env.TAU_DIRECT_THINKING_STORE = join(temp, 'effort.json')
const originalFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = originalFetch
  if (oldStore === undefined) delete process.env.TAU_DIRECT_THINKING_STORE
  else process.env.TAU_DIRECT_THINKING_STORE = oldStore
  // This path is the unique test directory created above.
  rmSync(temp, { recursive: true, force: true })
  resetCatalogForTests()
})
beforeEach(() => {
  globalThis.fetch = originalFetch
  resetSessionVolatileFreeze()
  resetCatalogForTests({ version: 2, fetchedAt: Date.now(), providers: {}, limits: {} })
})

test('curated models, exact limits, modalities and offline prices agree', () => {
  expect(mistralTransformer.smallFastModel('mistral-large-4')).toBe('mistral-large-2512')
  const expected = [
    ['mistral-large-4', 1_048_576, 262_144, true, [0.68, 2.09, 0.07]],
    ['zai-glm-5-3', 1_048_576, 131_072, false, [1.4, 4.4, 0.14]],
    ['mistral-medium-3-5', 262_144, 262_144, true, [1.5, 7.5, 0.15]],
    ['mistral-large-2512', 262_144, 262_144, true, [0.5, 1.5, 0.05]],
  ] as const
  expect(mistralStaticCatalog().map(m => m.id)).toEqual(expected.map(row => row[0]))
  for (const [id, context, output, vision, rates] of expected) {
    const meta = getMistralModelMeta(id)!
    for (const alias of [id, ...meta.aliases]) {
      expect(getProviderCatalogContextWindow(alias, 'mistral')).toBe(context)
      expect(getMistralModelMeta(alias)?.maxOutputTokens).toBe(output)
      expect(modelAcceptsImages('mistral', alias)).toBe(vision)
      const price = lookupCatalogPrice('mistral', alias)!
      expect([price.inputTokens, price.outputTokens, price.promptCacheReadTokens]).toEqual([...rates])
    }
  }
  expect(lookupCatalogPrice('glm', 'zai-glm-5-3')).toBeNull()
})

test('fresh model prices replace the offline sale price, including native aliases', () => {
  resetCatalogForTests({ version: 2, fetchedAt: Date.now(), providers: { mistral: {
    'mistral-large-4': [1.36, 4.18, 0.14, null],
    'mistral-medium-2604': [1.6, 8, 0.16, null],
  } } })
  expect(lookupCatalogPrice('mistral', 'mistral-large-4-0')?.inputTokens).toBe(1.36)
  expect(lookupCatalogPrice('mistral', 'mistral-medium-3-5')?.inputTokens).toBe(1.6)
})

test('retired, small, low-context and duplicate rows never reappear in the picker', () => {
  const rejected = ['devstral-latest', 'devstral-medium-latest', 'devstral-2512', 'mistral-small-latest',
    'ministral-14b-2512', 'codestral-latest', 'magistral-medium-latest', 'zai-glm-5-2', 'mistral-ocr-latest']
  expect(filterMistralCatalog(rejected.map(id => ({ id })))).toEqual([])
  expect(filterMistralCatalog([
    { id: 'mistral-medium-latest' }, { id: 'mistral-medium-3-5' },
    { id: 'mistral-large-4', contextWindow: 128_000 }, { id: 'zai-glm-5-3' },
  ]).map(m => m.id)).toEqual(['zai-glm-5-3', 'mistral-medium-3-5'])
})

test('live availability is authoritative; offline fallback stays curated', async () => {
  const lane = new OpenAICompatLane()
  lane.registerProvider('mistral', 'fixture', 'https://api.mistral.ai/v1')
  globalThis.fetch = (async () => Response.json({ data: [
    { id: 'mistral-large-4', max_context_length: 1_048_576 },
    { id: 'zai-glm-5-3' },
    { id: 'mistral-medium-latest', status: 'retired' },
    { id: 'mistral-large-2512', capabilities: { function_calling: false } },
    { id: 'codestral-latest', max_context_length: 256_000 },
    { id: 'devstral-latest' },
  ] })) as unknown as typeof fetch
  expect((await lane.listModels('mistral')).map(m => [m.id, m.contextWindow])).toEqual([
    ['mistral-large-4', 1_048_576], ['zai-glm-5-3', 1_048_576],
  ])
  globalThis.fetch = (async () => Response.json({ data: [{ id: 'mistral-small-latest' }] })) as unknown as typeof fetch
  expect(await lane.listModels('mistral')).toEqual([])
  globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  expect(await lane.listModels('mistral')).toEqual(mistralStaticCatalog())
})

function shape(model: string, messages: OpenAIChatRequest['messages'] = [{ role: 'user', content: 'hello' }]): OpenAIChatRequest {
  return mistralTransformer.transformRequest({ model, messages, max_tokens: 999_999, reasoning_effort: 'medium', thinking: { type: 'enabled' } },
    { model, isReasoning: false, reasoningEffort: null })
}

test('picker cycles and persists only the model-specific effort values used on the wire', () => {
  for (const [id, efforts] of [
    ['mistral-large-4', ['none', 'high']],
    ['mistral-medium-3-5', ['none', 'high']],
    ['zai-glm-5-3', ['low', 'high', 'max']],
    ['mistral-large-2512', []],
  ] as const) {
    expect(directEffortLevels('mistral', id)).toEqual(efforts)
    for (const effort of efforts) {
      setDirectEffort('mistral', id, effort)
      expect(shape(id).reasoning_effort).toBe(effort)
      expect(shape(id).thinking).toBeUndefined()
      expect(shape(id).max_tokens).toBe(getMistralModelMeta(id)!.maxOutputTokens)
    }
  }
  setDirectEffort('mistral', 'zai-glm-5-3', 'max')
  cycleDirectEffort('mistral', 'zai-glm-5-3', 'right')
  expect(getDirectEffort('mistral', 'zai-glm-5-3')).toBe('low')
  setDirectEffort('mistral', 'zai-glm-5-3', 'none')
  expect(shape('zai-glm-5-3').reasoning_effort).toBe('low')
  expect(JSON.parse(readFileSync(process.env.TAU_DIRECT_THINKING_STORE!, 'utf8'))['mistral:zai-glm-5-3']).toBe('low')
  setDirectEffort('mistral', 'mistral-medium-latest', 'none')
  expect(shape('mistral-medium-3-5').reasoning_effort).toBe('none')
  expect(shape('mistral-large-2512').reasoning_effort).toBeUndefined()
  expect(directModelDetails('mistral', 'zai-glm-5-3', 1_048_576)).toContain('[Thinking: Low/High/Max]')
})

const user: ProviderMessage = { role: 'user', content: 'Inspect the source.' }
const assistant: ProviderMessage = { role: 'assistant', content: [
  { type: 'thinking', thinking: 'Inspect first.' }, { type: 'text', text: 'Checking.' },
  { type: 'tool_use', id: 'abcdefghi', name: 'Read', input: { path: 'a.ts' } },
] }
const result: ProviderMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abcdefghi', content: 'file contents' }] }
const answer: ProviderMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Done thinking.' }, { type: 'text', text: 'Done.' }] }
const makeTool = (name: string, description = 'Initial description'): ProviderTool => ({
  name, description, input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
})

test('streaming chunks, tool history, cache prefix, tool definitions and usage survive consecutive turns', async () => {
  const lane = new OpenAICompatLane()
  lane.registerProvider('mistral', 'fixture', 'https://api.mistral.ai/v1')
  const bodies: OpenAIChatRequest[] = []
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const chunks = [
      { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Reason.' }] }] } }] },
      { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: ' More.' }] }, { type: 'text', text: 'Answer.' }] } }] },
      { choices: [{ delta: { content: ' End.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1013, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1008 } } },
    ]
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  for (const model of ['mistral-large-4', 'zai-glm-5-3']) {
    const offset = bodies.length
    for (const [i, messages] of [[user], [user, assistant, result], [user, assistant, result, answer, user]].entries()) {
      const tools = i ? [makeTool('Write', 'Changed description'), makeTool('Read', 'Changed description')] : [makeTool('Read'), makeTool('Write')]
      const events = []
      for await (const event of lane.streamAsProvider({ model, providerHint: 'mistral', messages,
        system: `Rules\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\ngitStatus: ${i}`, tools,
        max_tokens: 999_999, sessionId: `mistral-${model}`, signal: new AbortController().signal })) events.push(event)
      expect(events.map(e => e.delta?.thinking ?? '').join('')).toBe('Reason. More.')
      expect(events.map(e => e.delta?.text ?? '').join('')).toBe('Answer. End.')
      const usage = events.findLast(e => e.usage?.input_tokens !== undefined)!.usage!
      expect(usage).toMatchObject({ input_tokens: 5, cache_read_input_tokens: 1008, output_tokens: 30 })
      const price = lookupCatalogPrice('mistral', model)!
      const cost = (usage.input_tokens! * price.inputTokens + usage.cache_read_input_tokens! * price.promptCacheReadTokens + usage.output_tokens * price.outputTokens) / 1_000_000
      expect(cost).toBeCloseTo(model === 'mistral-large-4' ? 0.00013666 : 0.00028012, 10)
    }
    const [a, b, c] = bodies.slice(offset)
    expect(b!.messages.slice(0, a!.messages.length)).toEqual(a!.messages)
    expect(c!.messages.slice(0, b!.messages.length)).toEqual(b!.messages)
    expect(b!.tools).toEqual(a!.tools)
    expect(c!.tools).toEqual(a!.tools)
    expect(c!.prompt_cache_key).toBe(`mistral-${model}`)
    expect(JSON.stringify(c)).not.toContain('cache_control')
    expect(JSON.stringify(c)).not.toContain('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    expect(JSON.stringify(c)).not.toContain('reasoning_content')
    const tool = c!.messages.find(m => m.tool_calls)!
    expect(tool.content).toEqual([{ type: 'thinking', thinking: [{ type: 'text', text: 'Inspect first.' }] }, { type: 'text', text: 'Checking.' }])
    expect(c!.messages[c!.messages.indexOf(tool) + 1]).toMatchObject({ role: 'tool', name: 'Read', tool_call_id: 'abcdefghi' })
    expect(JSON.stringify(c!.messages)).toContain('Done thinking.')
  }
})

test('thinking-only assistant history is retained as a Mistral ThinkChunk', () => {
  const messages = _convertHistoryToOpenAIForTest([user, { role: 'assistant', content: [{ type: 'thinking', thinking: 'Keep this trace.' }] }], '', 'mistral', 'mistral-large-4')
  expect(shape('mistral-large-4', messages).messages.at(-1)?.content).toEqual([{ type: 'thinking', thinking: [{ type: 'text', text: 'Keep this trace.' }] }])
})

test('vision models keep pixels on the first request; hosted GLM stays text-only', () => {
  const message: ProviderMessage = { role: 'user', content: [{ type: 'image', source: {
    type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=',
  } }] }
  for (const id of ['mistral-large-4', 'mistral-medium-3-5', 'mistral-large-2512']) {
    const wire = _convertHistoryToOpenAIForTest([message], '', 'mistral', id)
    expect(JSON.stringify(wire)).toContain('data:image/png;base64,aW1hZ2U=')
  }
  expect(JSON.stringify(_convertHistoryToOpenAIForTest([message], '', 'mistral', 'zai-glm-5-3'))).not.toContain('data:image/png')
})

test('Mistral snapshots isolate helpers, honor tool changes and reset intentionally', async () => {
  const lane = new OpenAICompatLane()
  lane.registerProvider('glm', 'fixture', 'https://other-host.example/v1')
  lane.registerProvider('mistral', 'fixture', 'https://api.mistral.ai/v1')
  const bodies: OpenAIChatRequest[] = []
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    // No provider hint: zai-glm must route to Mistral, not the native GLM host.
    expect(String(url)).toBe('https://api.mistral.ai/v1/chat/completions')
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const send = async (system: string, tools: ProviderTool[], querySource = 'repl_main_thread') => {
    for await (const _ of lane.streamAsProvider({ model: 'zai-glm-5-3', messages: [user], system,
      tools, querySource, max_tokens: 100, sessionId: 'scope-test', signal: new AbortController().signal })) { /* drain */ }
    return bodies.at(-1)!
  }
  const read = makeTool('Read')
  const write = { ...makeTool('Write'), defer_loading: true }
  const first = await send('Main prompt', [read, write, makeTool('ToolSearch')])
  expect(first.tools!.map(t => t.function.name)).toEqual(['Read', 'Write'])
  const helper = await send('Helper prompt', [read], 'title')
  expect(helper.messages[0]!.content).toContain('Helper prompt')
  const second = await send('Changed main prompt', [read])
  expect(second.messages).toEqual(first.messages)
  expect(second.tools!.map(t => t.function.name)).toEqual(['Read'])
  const changed = makeTool('Read')
  changed.input_schema = { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] }
  const third = await send('Changed main prompt', [changed])
  expect(third.tools![0]!.function.parameters).not.toEqual(first.tools![0]!.function.parameters)
  resetSessionVolatileFreeze()
  const reset = await send('Fresh prompt', [makeTool('Read', 'Fresh description')])
  expect(reset.messages[0]!.content).toContain('Fresh prompt')
  expect(reset.tools![0]!.function.description).toContain('Fresh description')
})

test('same-type Mistral workers keep distinct wire prompts, with stable resume and parent helper prefixes', async () => {
  const lane = new OpenAICompatLane()
  lane.registerProvider('mistral', 'fixture', 'https://api.mistral.ai/v1')
  const bodies: OpenAIChatRequest[] = []
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const send = async (agentId: string | undefined, querySource: QuerySource, system: string, messages = [user]) => {
    const sessionId = resolveProviderRequestSessionId({ provider: 'mistral',
      rootSessionId: 'wire-isolation', agentId: agentId as AgentId | undefined, querySource })
    for await (const _ of lane.streamAsProvider({ model: 'mistral-large-2512',
      providerHint: 'mistral', sessionId, querySource, system, messages,
      tools: [makeTool('Read')], max_tokens: 100, signal: new AbortController().signal })) { /* drain */ }
    return bodies.at(-1)!
  }
  // Same model deliberately stresses main/worker isolation as well as A/B.
  const main = await send(undefined, 'repl_main_thread', 'Main instructions')
  const a = await send('a', 'agent:builtin:general-purpose', 'Worker A instructions')
  const b = await send('b', 'agent:builtin:general-purpose', 'Worker B instructions')
  expect(a.messages[0]!.content).toContain('Worker A instructions')
  expect(b.messages[0]!.content).toContain('Worker B instructions')
  expect(a.prompt_cache_key).not.toBe(b.prompt_cache_key)
  expect(a.prompt_cache_key).not.toBe(main.prompt_cache_key)

  const release = registerForkedAgent('a-helper' as AgentId, 'a' as AgentId)
  try {
    const helper = await send('a-helper', 'agent_summary', 'Worker A instructions', [user, answer])
    expect(helper.prompt_cache_key).toBe(a.prompt_cache_key)
    expect(helper.tools).toEqual(a.tools)
    expect(helper.messages.slice(0, a.messages.length)).toEqual(a.messages)
    const resumed = await send('a', 'agent:builtin:general-purpose', 'Worker A refreshed environment', [user, answer])
    expect(resumed.prompt_cache_key).toBe(a.prompt_cache_key)
    expect(resumed.messages.slice(0, a.messages.length)).toEqual(a.messages)
    const nextMain = await send(undefined, 'repl_main_thread', 'Main refreshed environment', [user, answer])
    expect(nextMain.prompt_cache_key).toBe(main.prompt_cache_key)
    expect(nextMain.messages.slice(0, main.messages.length)).toEqual(main.messages)
    expect(nextMain.tools).toEqual(main.tools)
  } finally { release() }
})
