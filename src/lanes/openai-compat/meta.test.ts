/**
 * Meta provider: catalog, effort ladder, cache-safe request shape, encrypted
 * reasoning and phase replay, tool contracts, stream translation, request
 * lifecycle, pricing, the account check and /usage.
 *
 * The stream fixtures are Meta's own wire format: opencode's recorded
 * muse-spark-1.3 tool loop against api.meta.ai (2026-09-15), with the
 * encrypted payloads shortened.
 *
 * Run: bun run src/lanes/openai-compat/meta.test.ts
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every store this suite can touch points into a scratch directory BEFORE any
// module that reads them is loaded.
const fixture = mkdtempSync(join(tmpdir(), 'tau-meta-'))
process.env.TAU_META_THINKING_STORE = join(fixture, 'meta-thinking.json')
process.env.TAU_META_MODEL_CATALOG_STORE = join(fixture, 'meta-models.json')
for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR']) {
  process.env[name] = fixture
}
for (const name of ['CLAUDE_CODE_EFFORT_LEVEL', 'META_BASE_URL', 'META_API_KEY', 'META_MODEL_API_KEY', 'MODEL_API_KEY']) {
  delete process.env[name]
}
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
const noNetwork = (async () => {
  throw new Error('Meta tests must not access the network')
}) as unknown as typeof fetch
globalThis.fetch = noNetwork

const catalog = await import('../../utils/model/metaCatalog.js')
const thinking = await import('../../utils/model/metaThinking.js')
const route = await import('./meta_responses.js')
const account = await import('../../services/api/metaAccount.js')
const affinity = await import('../../services/api/cacheAffinity.js')
const deferral = await import('../../utils/toolDeferralPolicy.js')
const boundary = await import('../../utils/systemBoundaryProviders.js')
const vision = await import('../shared/vision_capability.js')
const agentAlias = await import('../../utils/model/agentAliasFallback.js')
const rateLimits = await import('../../services/api/providerRateLimits.js')

type Event = Record<string, any>

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    thinking._resetMetaThinkingForTests()
    catalog._resetMetaCatalogForTests()
    vision._resetVisionCapabilityForTest()
    route._resetMetaRouteForTests()
    rateLimits.resetProviderRateLimits()
    globalThis.fetch = noNetwork
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, hint: string): void {
  if (!condition) throw new Error(hint)
}

function eq(actual: unknown, expected: unknown, hint: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${hint}: got ${a}, want ${b}`)
}

async function rejects(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

const MODEL = 'muse-spark-1.3'
const SYSTEM = [
  'You are Tau, a coding agent.',
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
  '# Environment\nWorking directory: /repo\nToday: 2026-10-17',
].join('\n\n')

const TOOLS = [
  {
    name: 'Bash',
    description: 'Run a shell command.',
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'number' } },
      required: ['command'],
    },
  },
  {
    name: 'mcp__github__create_issue',
    description: 'Open a GitHub issue.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { const: 'bug' },
        labels: { type: 'array', items: { $ref: '#/$defs/label' } },
      },
      required: ['title'],
      $defs: { label: { type: 'string', description: 'A label name' } },
    },
  },
  { name: 'ToolSearch', description: 'Load deferred tools.', input_schema: { type: 'object', properties: {} } },
]

const REASONING_ID = 'rs_6aa8c8ab79c21b43c89d4e42:rs_01a0a34fdd357383894372aaafc05fe5'
const MESSAGE_ID = 'rs_01a0a34fdf127a10932f1e0a4165dbe3'
const CALL_ID = 'call_01a0a34fe06a7483847d12e73579230c'
const PREAMBLE = "I'll look up Paris's weather now."

/** Meta's turn one as recorded: reasoning, a commentary preamble, a call. */
function recordedTurnOne(): Event[] {
  const preamble = { annotations: [], logprobs: [], text: PREAMBLE, type: 'output_text' }
  const call = { arguments: '{"city":"Paris"}', call_id: CALL_ID, id: 'fc_01a0a34fe06a7483847d12e73579230c', name: 'lookup_weather', status: 'completed', type: 'function_call' }
  return [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_6aa8c8ab79c21b43c89d4e42', status: 'in_progress', output: [] } },
    { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_6aa8c8ab79c21b43c89d4e42', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, sequence_number: 2, item: { id: REASONING_ID, status: 'in_progress', summary: [], type: 'reasoning' } },
    { type: 'response.output_item.done', output_index: 0, sequence_number: 3, item: { encrypted_content: 'ENC-STREAMED', id: REASONING_ID, status: 'completed', summary: [], type: 'reasoning' } },
    { type: 'response.output_item.added', output_index: 1, sequence_number: 4, item: { content: [], id: MESSAGE_ID, phase: 'commentary', role: 'assistant', status: 'in_progress', type: 'message' } },
    { type: 'response.content_part.added', output_index: 1, content_index: 0, item_id: MESSAGE_ID, sequence_number: 5, part: { ...preamble, text: '' } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: MESSAGE_ID, sequence_number: 6, delta: PREAMBLE, logprobs: [] },
    { type: 'response.output_text.done', output_index: 1, content_index: 0, item_id: MESSAGE_ID, sequence_number: 7, text: PREAMBLE, logprobs: [] },
    { type: 'response.content_part.done', output_index: 1, content_index: 0, item_id: MESSAGE_ID, sequence_number: 8, part: preamble },
    { type: 'response.output_item.done', output_index: 1, sequence_number: 9, item: { content: [preamble], id: MESSAGE_ID, phase: 'commentary', role: 'assistant', status: 'completed', type: 'message' } },
    { type: 'response.output_item.added', output_index: 2, sequence_number: 10, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: call.id, sequence_number: 11, delta: '{"city":"Paris"}' },
    { type: 'response.function_call_arguments.done', output_index: 2, item_id: call.id, sequence_number: 12, arguments: '{"city":"Paris"}', name: 'lookup_weather' },
    { type: 'response.output_item.done', output_index: 2, sequence_number: 13, item: call },
    {
      type: 'response.completed',
      sequence_number: 14,
      response: {
        id: 'resp_6aa8c8ab79c21b43c89d4e42',
        status: 'completed',
        // Spark re-issues every item here, the reasoning with fresh content.
        output: [
          { encrypted_content: 'ENC-TERMINAL', id: REASONING_ID, status: 'completed', summary: [], type: 'reasoning' },
          { content: [preamble], id: MESSAGE_ID, phase: 'commentary', role: 'assistant', status: 'completed', type: 'message' },
          call,
        ],
        usage: {
          input_tokens: 570,
          input_tokens_details: { cached_tokens: 113 },
          output_tokens: 92,
          output_tokens_details: { reasoning_tokens: 25 },
          total_tokens: 662,
        },
      },
    },
  ]
}

function sse(events: Event[]): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Fold stream events into blocks the way claude.ts does (shallow copies). */
function assemble(events: Event[]): Event[] {
  const blocks: Event[] = []
  const json = new Map<number, string>()
  for (const event of events) {
    if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block }
    if (event.type === 'content_block_delta') {
      const block = blocks[event.index]!
      if (event.delta.type === 'text_delta') block.text = (block.text ?? '') + event.delta.text
      if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + event.delta.thinking
      if (event.delta.type === 'input_json_delta') json.set(event.index, (json.get(event.index) ?? '') + event.delta.partial_json)
    }
    if (event.type === 'content_block_stop' && json.has(event.index)) {
      blocks[event.index]!.input = JSON.parse(json.get(event.index)!)
    }
  }
  return blocks.filter(Boolean)
}

function runStream(events: Event[], model = MODEL): { emitted: Event[]; stream: InstanceType<typeof route.MetaResponsesStream> } {
  const stream = new route.MetaResponsesStream(model, 'msg-1')
  const emitted: Event[] = []
  for (const event of events) emitted.push(...stream.push(event))
  emitted.push(...stream.finish())
  return { emitted, stream }
}

function request(messages: any[], overrides: Partial<Parameters<typeof route.buildMetaResponsesRequest>[0]> = {}) {
  return route.buildMetaResponsesRequest({
    model: MODEL,
    system: SYSTEM,
    messages,
    tools: TOOLS,
    maxTokens: 32_000,
    sessionId: 'sess-cache-1',
    ...overrides,
  })
}

function params(messages: any[]): any {
  return { model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 32_000, signal: new AbortController().signal }
}

async function drain(gen: AsyncGenerator<any, any>): Promise<{ events: Event[]; usage: any }> {
  const events: Event[] = []
  let step = await gen.next()
  while (!step.done) {
    events.push(step.value)
    step = await gen.next()
  }
  return { events, usage: step.value }
}

const PNG = 'iVBORw0KGgo='

console.log('Meta catalog:')

await test('snapshot lists the agent-capable Muse text models, newest first', () => {
  eq(catalog.listMetaModelMeta().map(meta => meta.id), [
    'muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.3-contributor',
    'muse-spark-1.2', 'muse-spark-1.2-contributor', 'muse-spark-1.1',
  ], 'model ids')
})

await test('ladders, windows, caps, prices and contributor mode match dev.meta.ai', () => {
  const all = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  eq(catalog.metaEffortsFor('muse-wonder-1.0'), all, 'Wonder takes max')
  eq(catalog.metaEffortsFor('muse-spark-1.3'), all, 'Spark 1.3 takes max')
  eq(catalog.metaEffortsFor('muse-spark-1.3-contributor'), all.slice(0, 5), 'max is not available with 1.3 Contributor')
  eq(catalog.metaEffortsFor('muse-spark-1.1'), all.slice(0, 5), 'Spark 1.1 stops at xhigh')
  assert(!catalog.listMetaModelMeta().some(meta => meta.efforts.includes('none')), 'none is a 400 on every Muse model')
  eq(catalog.getMetaModelMeta(MODEL)?.defaultEffort, 'high', 'recorded server default')
  eq(catalog.getMetaContextWindow('muse-wonder-1.0'), 1_048_576, 'window')
  eq(catalog.metaMaxOutputTokens(MODEL), 131_072, 'output cap')
  eq(catalog.getMetaCatalogPrice('muse-wonder-1.0'), { input: 4, cachedInput: 0.2, output: 20 }, 'Wonder rates')
  eq(catalog.getMetaCatalogPrice('muse-spark-1.2'), { input: 1.25, cachedInput: 0.15, output: 4.25 }, 'Spark rates')
  eq(catalog.getMetaCatalogPrice('muse-spark-1.3-contributor'), { input: 0.1, cachedInput: 0.002, output: 0.2 }, 'Contributor rates')
  assert(catalog.getMetaModelMeta('muse-spark-1.3-contributor')?.contributor, 'contributor flagged')
  assert(!catalog.getMetaModelMeta(MODEL)?.contributor, 'standard row is not')
  eq(catalog.getMetaModelMeta('meta/MUSE-SPARK-1.3')?.id, MODEL, 'vendor prefix and case are normalized')
})

await test('models.dev rows refresh ladders and add new models; non-chat rows drop', () => {
  catalog._resetMetaCatalogForTests({
    meta: {
      models: {
        'muse-spark-1.3': {
          id: 'muse-spark-1.3', name: 'Muse Spark 1.3', reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
          tool_call: true, modalities: { input: ['text', 'image', 'video', 'pdf', 'audio'], output: ['text'] },
          limit: { context: 1_048_576, output: 131_072 }, cost: { input: 1.25, output: 4.25, cache_read: 0.15 },
          release_date: '2026-09-02',
        },
        'muse-spark-1.4': {
          id: 'muse-spark-1.4', name: 'Muse Spark 1.4', reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }],
          tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 2_097_152, output: 262_144 }, cost: { input: 1, output: 4, cache_read: 0.1 },
          release_date: '2026-11-01',
        },
        'muse-image-1.0': { id: 'muse-image-1.0', modalities: { input: ['text', 'image'], output: ['image'] } },
      },
    },
  })
  const fresh = catalog.getMetaModelMeta('muse-spark-1.4')!
  eq(fresh.efforts, ['low', 'high', 'max'], 'published ladder, without none')
  eq(fresh.contextWindow, 2_097_152, 'published window')
  eq(fresh.price, { input: 1, output: 4, cachedInput: 0.1 }, 'published prices')
  assert(!fresh.fileInput && fresh.imageInput, 'modalities')
  eq(catalog.getMetaModelMeta(MODEL)?.defaultEffort, 'high', 'snapshot default kept over a models.dev row')
  assert(catalog.getMetaModelMeta('muse-image-1.0') === undefined, 'image model is not a chat model')
  eq(catalog.listMetaModelMeta()[0]?.id, 'muse-spark-1.4', 'newest first')
})

await test('a live listing decides which ids show; an undescribed Muse id sends nothing guessed', () => {
  catalog.recordMetaLiveModels([MODEL, 'muse-image-1.0', 'muse-voice-transcribe-1.0', 'sam-3.1', 'muse-spark-9.9'])
  eq(catalog.listMetaModelMeta().map(meta => meta.id), [MODEL, 'muse-spark-9.9'], 'chat ids only, described first')
  const unknown = catalog.listMetaModelMeta()[1]!
  eq(unknown.efforts, [], 'no ladder guessed')
  assert(unknown.price === undefined && !unknown.described, 'unpriced, undescribed')
  eq(catalog.getMetaContextWindow('muse-spark-9.9'), 1_048_576, 'documented Muse window')
  eq(catalog.getMetaContextWindow('other-model'), undefined, 'no window for a non-Muse id')
})

await test('computed cost of a recorded request', () => {
  // Turn two of the recorded tool loop: 695 prompt (497 cached), 59 output.
  const usd = route.metaRequestCostUsd(MODEL, {
    input_tokens: 695 - 497, cache_read_tokens: 497, output_tokens: 59, cache_write_tokens: 0, thinking_tokens: 37,
  } as any)!
  assert(Math.abs(usd - (198 * 1.25 + 497 * 0.15 + 59 * 4.25) / 1e6) < 1e-15, `computed ${usd}`)
  eq(route.metaRequestCostUsd('muse-spark-9.9', { input_tokens: 1, cache_read_tokens: 0, output_tokens: 1 } as any), undefined, 'unpriced id')
})

console.log('\nMeta effort:')

await test('picks persist per model and only for declared levels', () => {
  eq(thinking.getMetaEffort(MODEL, null), undefined, 'no pick: Meta default')
  thinking.setMetaEffort(MODEL, 'max')
  eq(thinking.getMetaEffort(MODEL, null), 'max', 'pick applies')
  thinking.setMetaEffort('muse-spark-1.3-contributor', 'max')
  assert(!thinking.hasExplicitMetaEffort('muse-spark-1.3-contributor'), 'Contributor has no max to pick')
  thinking.setMetaEffort(MODEL, 'none')
  eq(thinking.getMetaEffort(MODEL, null), 'max', 'none is never stored')
  eq(thinking.getMetaEffort('muse-spark-1.2', 'medium'), 'medium', 'session effort inherited when the ladder has it')
  eq(thinking.getMetaEffort('muse-spark-1.1', 'max'), undefined, 'an undeclared session level is never sent')
  assert(!thinking.supportsMetaEffortSelection('muse-spark-9.9'), 'no chip without a ladder')
})

console.log('\nMeta request (cache safety):')

await test('stateless replay, summaries, a prefix-named cache key and 24h retention', () => {
  const { body } = request([{ role: 'user', content: 'fix the bug' }], { effort: 'high' })
  eq(body.store, false, 'store')
  eq(body.include, ['reasoning.encrypted_content'], 'encrypted reasoning requested')
  eq(body.reasoning, { effort: 'high', summary: 'auto' }, 'effort and summaries')
  eq(body.prompt_cache_retention, '24h', 'retention')
  eq(body.tool_choice, 'auto', 'the only tool_choice Meta takes')
  for (const field of ['temperature', 'top_p', 'truncation', 'stop', 'previous_response_id', 'parallel_tool_calls', 'service_tier', 'user']) {
    assert(!(field in body), `${field} is never sent`)
  }
  const key = String(body.prompt_cache_key)
  assert(/^tau-[0-9a-f]{32}$/.test(key), `key shape: ${key}`)
  assert(!key.includes('sess-cache-1'), 'never the session id')
  eq(request([{ role: 'user', content: 'other task' }], { sessionId: 'sess-other' }).body.prompt_cache_key, key, 'another session with the same prefix shares the key')
  assert(request([{ role: 'user', content: 'x' }], { system: 'Different agent.' }).body.prompt_cache_key !== key, 'another prefix gets its own key')
  assert(request([{ role: 'user', content: 'x' }], { model: 'muse-wonder-1.0' }).body.prompt_cache_key !== key, 'another model gets its own key')
  eq(route.metaRequestHeaders('LLM_1_k'), { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer LLM_1_k' }, 'headers')
})

await test('stable system as instructions, frozen environment as the first input item', () => {
  const first = request([{ role: 'user', content: 'fix the bug' }])
  const instructions = String(first.body.instructions)
  assert(instructions.startsWith('<tool_usage_rules>'), 'tool rules lead')
  assert(instructions.includes('You are Tau, a coding agent.'), 'stable prompt present')
  assert(!instructions.includes('Working directory'), 'volatile text kept out of instructions')
  const input = first.body.input as Event[]
  eq(input[0], { type: 'message', role: 'system', content: '# Environment\nWorking directory: /repo\nToday: 2026-10-17' }, 'frozen block')
  const second = request([{ role: 'user', content: 'fix the bug' }], { system: SYSTEM.replace('2026-10-17', '2026-10-18') })
  eq((second.body.input as Event[])[0], input[0], 'a later volatile change does not move the prefix')
  eq(second.body.instructions, first.body.instructions, 'instructions byte-identical')
  eq(second.body.prompt_cache_key, first.body.prompt_cache_key, 'key unchanged')
})

await test('every tool is declared with its contract; ToolSearch is not; new tools append', () => {
  const { body } = request([{ role: 'user', content: 'go' }], { sessionId: 'sess-order' })
  const tools = body.tools as Event[]
  eq(tools.map(tool => tool.name), ['Bash', 'mcp__github__create_issue'], 'tool names')
  assert(tools.every(tool => tool.type === 'function' && tool.strict === false), 'strict false function tools')
  assert(tools.every(tool => String(tool.description).includes('STRICT PARAMETERS:')), 'summary in every description')
  assert(!('$schema' in tools[0]!.parameters), '$schema left off')
  eq(tools[1]!.parameters.properties.labels.items, { type: 'string', description: 'A label name' }, '$ref inlined')
  const later = request([{ role: 'user', content: 'go' }], {
    sessionId: 'sess-order',
    tools: [{ name: 'mcp__aaa__first', description: 'Sorted first.', input_schema: { type: 'object', properties: {} } }, ...TOOLS],
  })
  eq((later.body.tools as Event[]).map(tool => tool.name), ['Bash', 'mcp__github__create_issue', 'mcp__aaa__first'], 'appended, not inserted')
  eq(later.body.prompt_cache_key, body.prompt_cache_key, 'an appended tool keeps the key')
})

await test('the recorded turn replays as Meta expects; the previous input stays a byte-identical prefix', () => {
  const user = { role: 'user', content: 'Look up the current weather in Paris.' }
  const first = request([user])
  const { emitted } = runStream(recordedTurnOne())
  const assistant = { role: 'assistant', content: assemble(emitted) }
  const toolUse = assistant.content.find(block => block.type === 'tool_use')!
  const second = request([
    user,
    assistant,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '{"condition":"sunny","temperature":"18C"}' }] },
  ])
  const before = first.body.input as Event[]
  const after = second.body.input as Event[]
  eq(after.slice(0, before.length), before, 'prefix unchanged')
  eq(after.slice(before.length), [
    { type: 'reasoning', id: REASONING_ID, summary: [], encrypted_content: 'ENC-STREAMED' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PREAMBLE }], phase: 'commentary' },
    { type: 'function_call', call_id: CALL_ID, name: 'lookup_weather', arguments: '{"city":"Paris"}' },
    { type: 'function_call_output', call_id: CALL_ID, output: '{"condition":"sunny","temperature":"18C"}' },
  ], 'what Meta\'s recorded turn two sent: streamed reasoning, commentary phase, call, output')
  assert(!JSON.stringify(after).includes('ENC-TERMINAL'), 'the terminal snapshot\'s copy is never replayed')
  eq(second.body.tools, first.body.tools, 'tool block unchanged')
  eq(second.body.prompt_cache_key, first.body.prompt_cache_key, 'key unchanged')
})

await test('history another model wrote gets the phase Meta requires', () => {
  const items = route.convertMetaHistory([
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_01ABCdef', name: 'Bash', input: { command: 'ls' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABCdef', content: 'a.ts' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'One file: a.ts.' }] },
  ] as any, MODEL)
  eq(items.map(item => [item.type, item.phase ?? null]), [
    ['message', null], ['message', 'commentary'], ['function_call', null], ['function_call_output', null], ['message', null],
  ], 'text before a call is commentary; the answer has no phase')
  eq(items[2]!.call_id, 'toolu_01ABCdef', 'a sendable foreign call id passes through')
})

await test('reasoning with no text gets the minimal assistant message Meta requires', () => {
  const items = route.convertMetaHistory([
    { role: 'user', content: 'think' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', _codex_reasoning: { model: MODEL, items: [{ id: 'rs_only', encrypted_content: 'E', summary: [] }] } },
    ] },
    { role: 'user', content: 'go on' },
  ] as any, MODEL)
  eq(items.map(item => item.type === 'message' ? `${item.role}:${JSON.stringify(item.content)}` : item.type), [
    'user:[{"type":"input_text","text":"think"}]',
    'reasoning',
    'assistant:[{"type":"output_text","text":"(no content)"}]',
    'user:[{"type":"input_text","text":"go on"}]',
  ], 'reasoning is answered before the next user message')
})

await test('encrypted reasoning is never replayed to another model', () => {
  const { emitted } = runStream(recordedTurnOne())
  const { body } = request([
    { role: 'user', content: 'weather' },
    { role: 'assistant', content: assemble(emitted) },
  ], { model: 'muse-wonder-1.0' })
  const input = body.input as Event[]
  assert(!input.some(item => item.type === 'reasoning'), 'muse-wonder-1.0 must not receive muse-spark-1.3 reasoning')
  eq(input.find(item => item.type === 'message' && item.role === 'assistant')?.phase, 'commentary', 'the preamble is still commentary')
})

await test('tool-result images travel in a user message; unsendable media become text', () => {
  const items = route.convertMetaHistory([
    { role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'toolu_meta_call_7', content: [
        { type: 'text', text: 'screenshot taken' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        { type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: 'AAAA' } },
      ],
    }, { type: 'text', text: 'what do you see?' }] },
  ] as any, MODEL)
  eq(items[0]!.type, 'function_call_output', 'output first')
  eq(items[0]!.call_id, 'call_7', 'Meta call id restored')
  assert(String(items[0]!.output).startsWith('screenshot taken\n'), 'text kept')
  assert(String(items[0]!.output).endsWith('[1 attachment in the next user message]'), 'pointer to the attachment')
  eq(items[1]!.role, 'user', 'then a user message')
  const attached = items[1]!.content as Event[]
  eq(attached[0], { type: 'input_text', text: 'Attachments from tool call call_7:' }, 'labelled')
  eq(attached[1], { type: 'input_image', image_url: `data:image/png;base64,${PNG}` }, 'png as input_image')
  eq(attached.at(-1), { type: 'input_text', text: 'what do you see?' }, 'the user\'s own text follows')
  assert(!JSON.stringify(items).includes('image/tiff;base64'), 'tiff is not sent as an image')
})

await test('past 50 images, the oldest give way', () => {
  const images = Array.from({ length: 52 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }))
  const items = route.convertMetaHistory([{ role: 'user', content: images }] as any, MODEL)
  const parts = items[0]!.content as Event[]
  eq(parts.filter(part => part.type === 'input_image').length, 50, 'fifty kept')
  eq(parts.slice(0, 2).map(part => part.type), ['input_text', 'input_text'], 'the two oldest replaced')
})

await test('call ids Meta cannot take are hashed the same way on both sides', () => {
  const long = `toolu_${'x'.repeat(80)}`
  const sent = route.metaCallIdForToolUse(long)
  assert(/^call_[0-9a-f]{40}$/.test(sent), `hashed: ${sent}`)
  eq(route.metaCallIdForToolUse(long), sent, 'deterministic')
  for (const id of ['call_1', 'call:1/x', 'b64_abc']) {
    eq(route.metaCallIdForToolUse(route.tauToolUseIdForMetaCall(id)), id, id)
  }
})

await test('output cap follows the model; effort and summaries only where they apply', () => {
  const { body } = request([{ role: 'user', content: 'go' }], { maxTokens: 500_000 })
  eq(body.max_output_tokens, 131_072, 'clamped to the Muse output cap')
  eq(body.reasoning, { summary: 'auto' }, 'no effort without a pick')
  const plain = request([{ role: 'user', content: 'go' }], { model: 'other-model' }).body
  assert(!('reasoning' in plain), 'no reasoning field for an id not known to reason')
})

console.log('\nMeta stream:')

await test('the recorded turn: reasoning, commentary, tool call, usage', () => {
  const { emitted, stream } = runStream(recordedTurnOne())
  const starts = emitted.filter(event => event.type === 'content_block_start')
  eq(starts.map(event => event.content_block.type), ['thinking', 'text', 'tool_use'], 'block kinds, once each')
  eq(starts[0]!.content_block._codex_reasoning.items.map((item: any) => item.encrypted_content), ['ENC-STREAMED'], 'thinking holds the streamed item')
  eq(starts[1]!.content_block._codex_reasoning.phase, 'commentary', 'text block carries its phase')
  eq(starts[1]!.content_block._codex_reasoning.items[0].id, REASONING_ID, 'and the reasoning that preceded it')
  eq(starts[2]!.content_block.id, `toolu_meta_${CALL_ID}`, 'tool_use id')
  const delta = emitted.find(event => event.type === 'message_delta')!
  eq(delta.delta.stop_reason, 'tool_use', 'stop reason')
  eq(delta.usage, { output_tokens: 92, input_tokens: 457, cache_read_input_tokens: 113 }, 'additive usage')
  eq(stream.usage.thinking_tokens, 25, 'reasoning tokens')
  eq(assemble(emitted)[1]!.text, PREAMBLE, 'text')
})

await test('items only the terminal snapshot carries are recovered once', () => {
  const { emitted } = runStream([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_t', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_t', summary: [], encrypted_content: 'E1' } },
    { type: 'response.completed', response: {
      output: [
        { type: 'reasoning', id: 'rs_t', summary: [], encrypted_content: 'E2' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Only here.' }] },
      ],
      usage: { input_tokens: 10, output_tokens: 3 },
    } },
  ])
  const blocks = assemble(emitted)
  eq(blocks.map(block => block.type), ['thinking', 'text'], 'no duplicate reasoning')
  eq(blocks[1]!.text, 'Only here.', 'terminal-only message recovered')
  eq(blocks[1]!._codex_reasoning.items[0].encrypted_content, 'E1', 'the streamed reasoning rides on it')
})

await test('a request end to end: URL, body, events, [DONE], spend and rate limits', async () => {
  let seen: { url: string; init: RequestInit } | undefined
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), init }
    return new Response(sse(recordedTurnOne()), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-ratelimit-limit-requests': '3000',
        'x-ratelimit-remaining-requests': '2999',
        'x-ratelimit-limit-tokens': '4000000',
        'x-ratelimit-remaining-tokens': '3999338',
      },
    })
  }) as unknown as typeof fetch
  const { events, usage } = await drain(route.streamMetaResponses(
    { apiKey: 'LLM_1607_secret', baseUrl: 'https://api.meta.ai/v1/' },
    params([{ role: 'user', content: 'weather in Paris' }]),
    'sess-e2e',
  ))
  eq(seen?.url, 'https://api.meta.ai/v1/responses', 'endpoint')
  eq((seen?.init.headers as Record<string, string>).Authorization, 'Bearer LLM_1607_secret', 'bearer key')
  const body = JSON.parse(String(seen?.init.body))
  eq([body.model, body.store, body.stream, body.prompt_cache_retention], [MODEL, false, true, '24h'], 'body')
  eq(assemble(events).map(block => block.type), ['thinking', 'text', 'tool_use'], 'events')
  eq(usage, { input_tokens: 457, output_tokens: 92, cache_read_tokens: 113, cache_write_tokens: 0, thinking_tokens: 25 }, 'usage')
  const spent = route.getMetaSessionSpend()
  eq(spent.requests, 1, 'one request')
  assert(Math.abs(spent.usd - (457 * 1.25 + 113 * 0.15 + 92 * 4.25) / 1e6) < 1e-15, `priced ${spent.usd}`)
  const limits = rateLimits.getProviderRateLimits()
  eq([limits?.provider, limits?.requests?.remaining, limits?.tokens?.limit], ['meta', 2999, 4_000_000], 'rate limits recorded')
})

console.log('\nMeta errors:')

function failWith(status: number, error: Record<string, unknown>): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

await test('context overflow reads as "Prompt is too long" for reactive compaction', async () => {
  failWith(400, {
    message: 'You passed 1040000 input tokens and requested 131072 output tokens. However, the model\'s context length is limited to 1048576 tokens. Please reduce the length of the input prompt.',
    type: 'invalid_request_error', param: null, code: null,
  })
  const error = await rejects(drain(route.streamMetaResponses({ apiKey: 'LLM_1_k', baseUrl: '' }, params([{ role: 'user', content: 'x' }]), 's')))
  assert(String(error?.message).startsWith('Prompt is too long (meta 400): You passed 1040000 input tokens'), error?.message)
})

await test('401, 402 and stream failures surface with what to do next', async () => {
  failWith(401, { message: 'Unauthorized', type: 'authentication_error', param: null, code: 'invalid_api_key' })
  const auth = await rejects(drain(route.streamMetaResponses({ apiKey: 'LLM_1_k', baseUrl: '' }, params([{ role: 'user', content: 'x' }]), 's')))
  assert(/meta API error 401: Unauthorized \(invalid_api_key\) — run \/login meta/.test(auth?.message), auth?.message)
  failWith(402, { message: 'Insufficient balance', type: 'billing_error', param: null, code: 'billing_not_configured' })
  const billing = await rejects(drain(route.streamMetaResponses({ apiKey: 'LLM_1_k', baseUrl: '' }, params([{ role: 'user', content: 'x' }]), 's')))
  assert(String(billing?.message).includes('https://dev.meta.ai/billing'), billing?.message)
  globalThis.fetch = (async () => new Response(sse([{ type: 'error', code: 'service_overloaded', message: 'Busy' }]), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof fetch
  const overloaded = await rejects(drain(route.streamMetaResponses({ apiKey: 'LLM_1_k', baseUrl: '' }, params([{ role: 'user', content: 'x' }]), 's')))
  eq(overloaded?.status, 503, 'an overload before any output is retryable')
})

await test('a refused optional field is dropped and the turn retried; a refused MCP schema drops that tool', async () => {
  failWith(400, { message: 'Unsupported value', type: 'invalid_request_error', param: 'prompt_cache_retention', code: null })
  const dropped = await rejects(drain(route.streamMetaResponses({ apiKey: 'LLM_1_k', baseUrl: '' }, params([{ role: 'user', content: 'x' }]), 's')))
  assert(String(dropped?.message).includes('prompt_cache_retention'), dropped?.message)
  const next = request([{ role: 'user', content: 'x' }]).body
  assert(!('prompt_cache_retention' in next) && typeof next.prompt_cache_key === 'string', 'only that field dropped')

  const declared = request([{ role: 'user', content: 'x' }], { sessionId: 'sess-q' }).tools
  eq(route.findRejectedMetaTool(JSON.stringify({ error: { message: 'Invalid schema', param: 'tools[1].parameters' } }), declared)?.name,
    'mcp__github__create_issue', 'MCP tool found by index')
  eq(route.findRejectedMetaTool(JSON.stringify({ error: { message: 'Invalid schema', param: 'tools[0].parameters' } }), declared),
    undefined, 'a built-in tool is never left out')
  failWith(400, { message: 'Invalid tool schema', type: 'invalid_request_error', param: 'tools[1].parameters', code: null })
  await rejects(drain(route.streamMetaResponses({ apiKey: 'LLM_1_k', baseUrl: '' }, { ...params([{ role: 'user', content: 'x' }]) }, 'sess-q')))
  eq((request([{ role: 'user', content: 'x' }], { sessionId: 'sess-q' }).body.tools as Event[]).map(tool => tool.name), ['Bash'], 'quarantined')
})

await test('error detail and the documented overflow message', () => {
  eq(route.metaErrorDetail('{"error":{"code":"invalid_api_key","message":"Unauthorized","param":null,"type":"authentication_error"}}'),
    'Unauthorized (invalid_api_key)', 'the envelope api.meta.ai returns')
  assert(!route.isMetaContextExceeded(400, '{"error":{"message":"`top_p`: The number must be <= 1.0","param":"top_p"}}'), 'a plain validation error')
  eq(route.splitMetaSystem('Stable rules.\n\n# Environment\ncwd: /x'), { stable: 'Stable rules.', volatile: '# Environment\ncwd: /x' }, 'fallback split')
})

console.log('\nMeta routing policy:')

await test('stable session, per-agent sessions, eager tools, boundary marker', () => {
  assert(affinity.providerUsesStableRequestSession('meta'), 'stable session')
  eq(affinity.resolveProviderRequestSessionId({ provider: 'meta', rootSessionId: 'root', querySource: 'repl_main_thread' as any }), 'root', 'main thread')
  const agent = affinity.resolveProviderRequestSessionId({ provider: 'meta', rootSessionId: 'root', agentId: 'agent-1' as any, querySource: 'agent:custom' as any })
  assert(agent !== undefined && agent !== 'root' && agent.startsWith('tau-agent-'), `agent gets its own session, got ${agent}`)
  assert(deferral.providerUsesExactPrefixCache('meta'), 'exact prefix cache')
  assert(deferral.shouldDisableToolDeferralForProvider('meta', 'normal' as any), 'tools are never deferred')
  assert(boundary.providerSplitsSystemBoundary('meta'), 'boundary marker emitted')
})

await test('spawned agents: tier aliases inherit the live model; a pinned agent keeps its own', () => {
  for (const alias of ['haiku', 'sonnet', 'opus']) {
    eq(agentAlias.resolveAgentAliasPolicy(alias, 'muse-wonder-1.0', 'meta'), 'muse-wonder-1.0', `${alias} inherits the session model`)
  }
  eq(agentAlias.resolveAgentAliasPolicy(MODEL, 'muse-wonder-1.0', 'meta'), undefined, 'a concrete id is the caller\'s choice')
  assert(agentAlias.pinnedAgentModelOutranksAlias('haiku', MODEL, 'meta'), 'an agent pinned to Meta keeps its model over a spawn-time alias')
  assert(!agentAlias.resolvesAgentAliasIndependently('meta'), 'provider: meta needs a concrete model, never a tier alias')
})

console.log('\nMeta account:')

await test('the environment key: Meta\'s CLI name first; the generic name only in Meta\'s shape', () => {
  eq(account.metaApiKeyFromEnv({ META_API_KEY: 'LLM_1_a', META_MODEL_API_KEY: 'LLM_2_b' }), 'LLM_1_a', 'META_API_KEY first')
  eq(account.metaApiKeyFromEnv({ META_MODEL_API_KEY: 'LLM_2_b', MODEL_API_KEY: 'LLM_3_c' }), 'LLM_2_b', 'then models.dev\'s name')
  eq(account.metaApiKeyFromEnv({ MODEL_API_KEY: 'LLM_3_c' }), 'LLM_3_c', 'Meta docs\' name, in Meta\'s shape')
  eq(account.metaApiKeyFromEnv({ MODEL_API_KEY: 'sk-another-vendor' }), undefined, 'another vendor\'s key is not taken')
  eq(account.metaBaseUrlFromEnv({}), 'https://api.meta.ai/v1', 'default endpoint')
})

await test('key check: the models a key may call, or Meta\'s refusal', async () => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    eq(String(url), 'https://api.meta.ai/v1/models', 'endpoint')
    const auth = (init.headers as Record<string, string>).Authorization
    return auth === 'Bearer LLM_1_good'
      ? Response.json({ object: 'list', data: [{ id: MODEL, object: 'model', created: 1, owned_by: 'meta' }, { id: 'muse-image-1.0', object: 'model', created: 1, owned_by: 'meta' }] })
      : Response.json({ error: { code: 'invalid_api_key', message: 'Unauthorized', param: null, type: 'authentication_error' } }, { status: 401 })
  }) as unknown as typeof fetch
  eq(await account.checkMetaApiKey('LLM_1_good', 'https://api.meta.ai/v1/'), { ok: true, modelIds: [MODEL, 'muse-image-1.0'] }, 'listed')
  eq(await account.checkMetaApiKey('LLM_1_bad', 'https://api.meta.ai/v1'), { ok: false, status: 401, message: 'Unauthorized (invalid_api_key)' }, 'refused')
  const rows = await route.listMetaModels({ apiKey: 'LLM_1_good', baseUrl: 'https://api.meta.ai/v1' })
  eq(rows.map(row => row.id), [MODEL], 'the picker shows what the key may call, chat models only')
  eq(rows[0]!.tags, ['reasoning', 'tools', 'recommended'], 'Spark 1.3 is Meta\'s pick for new work')
})

await test('contributor rows say what the discount costs', async () => {
  globalThis.fetch = (async () => Response.json({ data: [{ id: 'muse-spark-1.3-contributor' }] })) as unknown as typeof fetch
  const rows = await route.listMetaModels({ apiKey: 'LLM_1_good', baseUrl: '' })
  eq(rows[0]!.name, 'Muse Spark 1.3 Contributor — Meta may train on your content', 'name')
})

// /usage is covered against the built bundle: test/meta-usage.test.mjs.

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
