/**
 * xAI provider: catalog, effort ladder, cache-safe request shape, encrypted
 * reasoning replay, tool contracts, stream translation, pricing and billing
 * parsers.
 *
 * Run: bun run src/lanes/openai-compat/xai.test.ts
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every store this suite can touch points into a scratch directory BEFORE any
// module that reads them is loaded.
const fixture = mkdtempSync(join(tmpdir(), 'tau-xai-'))
process.env.TAU_XAI_THINKING_STORE = join(fixture, 'xai-thinking.json')
process.env.TAU_XAI_MODEL_CATALOG_STORE = join(fixture, 'xai-models.json')
for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR']) {
  process.env[name] = fixture
}
for (const name of ['CLAUDE_CODE_EFFORT_LEVEL', 'XAI_BASE_URL', 'XAI_API_KEY', 'XAI_MANAGEMENT_API_KEY']) {
  delete process.env[name]
}
process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
globalThis.fetch = (async () => {
  throw new Error('xAI tests must not access the network')
}) as typeof fetch

const catalog = await import('../../utils/model/xaiCatalog.js')
const thinking = await import('../../utils/model/xaiThinking.js')
const route = await import('./xai_responses.js')
const account = await import('../../services/api/xaiAccount.js')
const affinity = await import('../../services/api/cacheAffinity.js')
const deferral = await import('../../utils/toolDeferralPolicy.js')
const boundary = await import('../../utils/systemBoundaryProviders.js')
const vision = await import('../shared/vision_capability.js')
const agentAlias = await import('../../utils/model/agentAliasFallback.js')

type Event = Record<string, any>

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    thinking._resetXaiThinkingForTests()
    catalog._resetXaiCatalogForTests()
    vision._resetVisionCapabilityForTest()
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

/** One assistant turn: reasoning (with encrypted content), then a Bash call. */
function turnOneEvents(): Event[] {
  return [
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Listing files' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        status: 'completed',
        summary: [{ type: 'summary_text', text: 'Listing files' }],
        encrypted_content: 'ENC-1',
      },
    },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"command":"ls"}' },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: {
          input_tokens: 1262,
          input_tokens_details: { cached_tokens: 1000 },
          output_tokens: 67,
          output_tokens_details: { reasoning_tokens: 57 },
          total_tokens: 1329,
          cost_in_usd_ticks: 23_664_000,
        },
      },
    },
  ]
}

function runStream(events: Event[], model = 'grok-4.7'): { emitted: Event[]; stream: InstanceType<typeof route.XaiResponsesStream> } {
  const stream = new route.XaiResponsesStream(model, 'msg-1')
  const emitted: Event[] = []
  for (const event of events) emitted.push(...stream.push(event))
  emitted.push(...stream.finish())
  return { emitted, stream }
}

function request(messages: any[], overrides: Partial<Parameters<typeof route.buildXaiResponsesRequest>[0]> = {}) {
  return route.buildXaiResponsesRequest({
    model: 'grok-4.7',
    system: SYSTEM,
    messages,
    tools: TOOLS,
    maxTokens: 32_000,
    sessionId: 'sess-cache-1',
    ...overrides,
  })
}

console.log('xAI catalog:')

await test('snapshot lists the agent-capable text models, newest first', () => {
  eq(catalog.listXaiModelMeta().map(meta => meta.id), [
    'grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1',
    'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning',
  ], 'model ids')
  assert(!catalog.listXaiModelMeta().some(meta => meta.id.includes('multi-agent')), 'multi-agent row has no client tools')
})

await test('ladders, windows and output caps match docs.x.ai', () => {
  eq(catalog.xaiEffortsFor('grok-4.7'), ['low', 'medium', 'high', 'xhigh'], 'grok-4.7 ladder')
  eq(catalog.xaiEffortsFor('grok-4.5'), ['low', 'medium', 'high'], 'grok-4.5 has no xhigh')
  eq(catalog.xaiEffortsFor('grok-4.3'), ['none', 'low', 'medium', 'high'], 'grok-4.3 ladder')
  eq(catalog.xaiEffortsFor('grok-build-0.1'), [], 'grok-build-0.1 takes no effort')
  eq(catalog.getXaiContextWindow('grok-4.7'), 500_000, 'grok-4.7 window')
  eq(catalog.getXaiContextWindow('grok-4.3'), 1_000_000, 'grok-4.3 window')
  eq(catalog.xaiMaxOutputTokens('grok-4.3'), 30_000, 'grok-4.3 output cap')
  eq(catalog.getXaiModelMeta('xai/GROK-4.7')?.id, 'grok-4.7', 'vendor prefix and case are normalized')
})

await test('a live /v1/models listing replaces the snapshot and converts prices', () => {
  catalog.recordXaiLiveModels([
    {
      id: 'grok-5',
      aliases: ['grok-5-latest'],
      context_length: 2_000_000,
      created: 1_795_000_000,
      prompt_text_token_price: 30_000,
      cached_prompt_text_token_price: 3_000,
      completion_text_token_price: 150_000,
      prompt_text_token_price_long_context: 60_000,
      completion_text_token_price_long_context: 300_000,
      long_context_threshold: 256_000,
      capabilities: { reasoning_effort: ['low', 'high', 'max'], default_reasoning_effort: 'high' },
    },
    { id: 'grok-imagine-image', image_price: 200_000_000 },
    {
      id: 'grok-4.7',
      context_length: 500_000,
      created: 1_790_000_000,
      prompt_text_token_price: 20_000,
      cached_prompt_text_token_price: 5_000,
      completion_text_token_price: 60_000,
      capabilities: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'high' },
    },
  ])
  eq(catalog.listXaiModelMeta().map(meta => meta.id), ['grok-5', 'grok-4.7'], 'live rows, image model dropped')
  const meta = catalog.getXaiModelMeta('grok-5-latest')
  eq(meta?.id, 'grok-5', 'alias resolves')
  eq(meta?.price, { input: 3, output: 15, cachedInput: 0.3 }, 'cents per 100M tokens become USD per 1M')
  eq(meta?.longContext?.threshold, 256_000, 'long-context threshold')
  eq(meta?.efforts, ['low', 'high', 'max'], 'ladder from capabilities')
  eq(meta?.defaultEffort, 'high', 'default effort')
  eq(catalog.getXaiModelMeta('grok-4.7')?.longContext?.price, { input: 4, cachedInput: 1, output: 12 }, 'snapshot fills a tier the live row omits')
  eq(catalog.getXaiModelMeta('grok-4.5')?.efforts, ['low', 'medium', 'high'], 'snapshot still answers other ids')
})

await test('long-context and regional pricing', () => {
  eq(catalog.getXaiCatalogPrice('grok-4.7', 199_999), { input: 2, cachedInput: 0.5, output: 6 }, 'below 200k')
  eq(catalog.getXaiCatalogPrice('grok-4.7', 200_000), { input: 4, cachedInput: 1, output: 12 }, 'a prompt reaching 200k bills the whole request higher')
  const us = catalog.getXaiCatalogPrice('grok-4.7', 1_000, 'https://us.api.x.ai/v1')!
  assert(Math.abs(us.input - 2.2) < 1e-9 && Math.abs(us.output - 6.6) < 1e-9, 'US regional endpoint is 1.1x')
  eq(catalog.getXaiCatalogPrice('grok-unknown', 1_000), undefined, 'unknown model stays unpriced')
})

await test('computed cost matches what xAI billed for a recorded request', () => {
  // opencode's recorded grok-4.5 call: 1262 prompt (128 cached), 10 output,
  // usage.cost_in_usd_ticks = 23,664,000.
  const price = catalog.getXaiCatalogPrice('grok-4.5', 1262)!
  const usd = ((1262 - 128) * price.input + 128 * price.cachedInput + 10 * price.output) / 1_000_000
  assert(Math.abs(usd - 23_664_000 / 1e10) < 1e-12, `computed ${usd}`)
})

console.log('\nxAI effort:')

await test('picks persist per model and only for declared levels', () => {
  eq(thinking.getXaiEffort('grok-4.7', null), undefined, 'no pick: xAI default')
  thinking.setXaiEffort('grok-4.7', 'xhigh')
  eq(thinking.getXaiEffort('grok-4.7', null), 'xhigh', 'pick applies')
  thinking.setXaiEffort('grok-4.5', 'xhigh')
  assert(!thinking.hasExplicitXaiEffort('grok-4.5'), 'grok-4.5 has no xhigh to pick')
  assert(!thinking.supportsXaiEffortSelection('grok-4.20-0309-reasoning'), 'no chip without a ladder')
  eq(thinking.getXaiEffort('grok-4.6', 'medium'), 'medium', 'session effort inherited when the ladder has it')
  eq(thinking.getXaiEffort('grok-4.5', 'max'), undefined, 'an undeclared session level is never sent')
})

console.log('\nxAI request (cache safety):')

await test('carries the session id as prompt_cache_key and x-grok-conv-id', () => {
  const { body } = request([{ role: 'user', content: 'fix the bug' }], { effort: 'high' })
  eq(body.prompt_cache_key, 'sess-cache-1', 'prompt_cache_key')
  eq(route.xaiRequestHeaders('xai-key', 'sess-cache-1')['x-grok-conv-id'], 'sess-cache-1', 'header')
  eq(route.xaiRequestHeaders('xai-key', 'sess-cache-1').Authorization, 'Bearer xai-key', 'auth')
  eq(body.store, false, 'store')
  eq(body.include, ['reasoning.encrypted_content'], 'encrypted reasoning requested')
  eq(body.reasoning, { effort: 'high' }, 'effort')
  assert(!('previous_response_id' in body) && !('stop' in body), 'stateless, no stop sequences')
})

await test('stable system as instructions, frozen environment as the first input item', () => {
  const first = request([{ role: 'user', content: 'fix the bug' }])
  const instructions = String(first.body.instructions)
  assert(instructions.startsWith('<tool_usage_rules>'), 'tool rules lead')
  assert(instructions.includes('You are Tau, a coding agent.'), 'stable prompt present')
  assert(!instructions.includes('Working directory'), 'volatile text kept out of instructions')
  const input = first.body.input as Event[]
  eq(input[0], { type: 'message', role: 'system', content: '# Environment\nWorking directory: /repo\nToday: 2026-10-17' }, 'frozen block')

  const changed = SYSTEM.replace('2026-10-17', '2026-10-18')
  const second = request([{ role: 'user', content: 'fix the bug' }], { system: changed })
  eq((second.body.input as Event[])[0], input[0], 'a later volatile change does not move the prefix')
  eq(second.body.instructions, first.body.instructions, 'instructions byte-identical')
})

await test('every tool is declared with its contract; ToolSearch is not', () => {
  const { body } = request([{ role: 'user', content: 'go' }])
  const tools = body.tools as Event[]
  eq(tools.map(tool => tool.name), ['Bash', 'mcp__github__create_issue'], 'tool names')
  assert(tools.every(tool => tool.type === 'function' && tool.strict === false), 'strict false function tools')
  assert(tools.every(tool => String(tool.description).includes('STRICT PARAMETERS:')), 'summary in every description')
  assert(!('$schema' in tools[0]!.parameters), '$schema left off')
  eq(tools[1]!.parameters.properties.labels.items, { type: 'string', description: 'A label name' }, '$ref inlined')
  eq(tools[1]!.parameters.properties.kind, { enum: ['bug'] }, 'const kept as an enum')
  eq(body.tool_choice, 'auto', 'tool choice')
})

await test('next turn replays encrypted reasoning; the previous input stays a byte-identical prefix', () => {
  const user = { role: 'user', content: 'list the files' }
  const first = request([user])
  const { emitted } = runStream(turnOneEvents())
  const assistant = { role: 'assistant', content: assemble(emitted) }
  const toolUse = assistant.content.find(block => block.type === 'tool_use')!
  const second = request([
    user,
    assistant,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'a.ts\nb.ts' }] },
  ])
  const before = first.body.input as Event[]
  const after = second.body.input as Event[]
  eq(after.slice(0, before.length), before, 'prefix unchanged')
  eq(after.slice(before.length), [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Listing files' }],
      encrypted_content: 'ENC-1',
    },
    { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'a.ts\nb.ts' },
  ], 'appended items in wire order, reasoning once')
  eq(second.body.tools, first.body.tools, 'tool block unchanged')
  eq(second.body.instructions, first.body.instructions, 'instructions unchanged')
})

await test('encrypted reasoning is never replayed to another model', () => {
  const { emitted } = runStream(turnOneEvents())
  const { body } = request([
    { role: 'user', content: 'list the files' },
    { role: 'assistant', content: assemble(emitted) },
  ], { model: 'grok-4.3' })
  assert(!(body.input as Event[]).some(item => item.type === 'reasoning'), 'grok-4.3 must not receive grok-4.7 reasoning')
})

await test('a tool that appears mid-session is appended, not inserted', () => {
  request([{ role: 'user', content: 'go' }], { sessionId: 'sess-order' })
  const later = request([{ role: 'user', content: 'go' }], {
    sessionId: 'sess-order',
    tools: [
      { name: 'mcp__aaa__first', description: 'Sorted first.', input_schema: { type: 'object', properties: {} } },
      ...TOOLS,
    ],
  })
  eq((later.body.tools as Event[]).map(tool => tool.name), ['Bash', 'mcp__github__create_issue', 'mcp__aaa__first'], 'order')
})

await test('output cap follows the model and effort is only sent when set', () => {
  const { body } = request([{ role: 'user', content: 'go' }], { model: 'grok-4.3', maxTokens: 64_000 })
  eq(body.max_output_tokens, 30_000, 'clamped to grok-4.3 output cap')
  assert(!('reasoning' in body), 'no effort field without a pick')
})

console.log('\nxAI stream:')

await test('reasoning, tool call, usage and cost', () => {
  const { emitted, stream } = runStream(turnOneEvents())
  const starts = emitted.filter(event => event.type === 'content_block_start')
  eq(starts.map(event => event.content_block.type), ['thinking', 'tool_use'], 'block kinds')
  eq(starts[0]!.content_block._codex_reasoning.items.map((item: any) => item.id), ['rs_1'], 'thinking block holds the encrypted item')
  eq(starts[1]!.content_block.id, 'toolu_xai_call_1', 'tool_use id')
  eq(starts[1]!.content_block._codex_reasoning.items[0].encrypted_content, 'ENC-1', 'next block carries it too')
  const delta = emitted.find(event => event.type === 'message_delta')!
  eq(delta.delta.stop_reason, 'tool_use', 'stop reason')
  eq(delta.usage, { output_tokens: 67, input_tokens: 262, cache_read_input_tokens: 1000 }, 'additive usage')
  eq(stream.usage.thinking_tokens, 57, 'reasoning tokens')
  eq(stream.costTicks, 23_664_000, 'cost ticks')
  eq(emitted.at(-1)!.type, 'message_stop', 'closed')
})

await test('a message delivered whole, and an output-cap stop', () => {
  const { emitted } = runStream([
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 5 } } },
  ])
  eq(assemble(emitted), [{ type: 'text', text: 'Done.' }], 'text')
  eq(emitted.find(event => event.type === 'message_delta')!.delta.stop_reason, 'max_tokens', 'truncated')
})

await test('tool-call ids round-trip', () => {
  for (const id of ['call_1', 'call:1/x', 'b64_abc', 'ünïcode']) {
    eq(route.xaiCallIdForToolUse(route.tauToolUseIdForXaiCall(id)), id, id)
  }
  eq(route.xaiCallIdForToolUse('toolu_01ABC'), 'toolu_01ABC', 'ids from other routes pass through')
})

console.log('\nxAI errors:')

await test('context overflow and tool-schema rejections are recognized', () => {
  const body = JSON.stringify({ code: 'Client specified an invalid argument', error: "This model's maximum prompt length is 500000 but the request contains 612345 tokens." })
  assert(route.isXaiContextExceeded(400, body), 'context overflow')
  eq(route.xaiErrorDetail(body), "This model's maximum prompt length is 500000 but the request contains 612345 tokens.", 'detail')
  const tools = TOOLS.map(route.toXaiFunctionTool)
  eq(route.findRejectedXaiTool('Invalid tool schema for mcp__github__create_issue: grammar error', tools)?.name, 'mcp__github__create_issue', 'MCP tool named')
  eq(route.findRejectedXaiTool('Invalid tool schema for Bash', tools), undefined, 'built-in tools are never left out')
})

await test('system split without the boundary marker', () => {
  eq(route.splitXaiSystem('Stable rules.\n\n# Environment\ncwd: /x'), { stable: 'Stable rules.', volatile: '# Environment\ncwd: /x' }, 'fallback heading')
})

console.log('\nxAI routing policy:')

await test('stable session, per-agent sessions, eager tools, boundary marker', () => {
  assert(affinity.providerUsesStableRequestSession('xai'), 'stable session')
  eq(affinity.resolveProviderRequestSessionId({ provider: 'xai', rootSessionId: 'root', querySource: 'repl_main_thread' as any }), 'root', 'main thread')
  const agent = affinity.resolveProviderRequestSessionId({ provider: 'xai', rootSessionId: 'root', agentId: 'agent-1' as any, querySource: 'agent:custom' as any })
  assert(agent !== undefined && agent !== 'root' && agent.startsWith('tau-agent-'), `agent gets its own cache session, got ${agent}`)
  assert(deferral.providerUsesExactPrefixCache('xai'), 'exact prefix cache')
  assert(deferral.shouldDisableToolDeferralForProvider('xai', 'normal' as any), 'tools are never deferred')
  assert(boundary.providerSplitsSystemBoundary('xai'), 'boundary marker emitted')
})

await test('spawned agents: tier aliases inherit the live model; a pinned agent keeps its own', () => {
  for (const alias of ['haiku', 'sonnet', 'opus']) {
    eq(agentAlias.resolveAgentAliasPolicy(alias, 'grok-4.7', 'xai'), 'grok-4.7', `${alias} inherits the session model`)
  }
  eq(agentAlias.resolveAgentAliasPolicy('grok-4.3', 'grok-4.7', 'xai'), undefined, 'a concrete id is the caller\'s choice')
  assert(agentAlias.pinnedAgentModelOutranksAlias('haiku', 'grok-4.3', 'xai'), 'an agent pinned to xAI keeps its model over a spawn-time alias')
  assert(!agentAlias.resolvesAgentAliasIndependently('xai'), 'provider: xai needs a concrete model, never a tier alias')
})

console.log('\nxAI account:')

await test('API key, balance, invoice and usage responses', () => {
  const info = account.parseXaiApiKeyInfo({
    redacted_api_key: 'xai-...b14o', name: 'My API Key', team_id: 'team-1', api_key_id: 'k1',
    acls: ['api-key:model:*'], team_blocked: false, api_key_blocked: false, api_key_disabled: true,
  })!
  eq(info.teamId, 'team-1', 'team id')
  eq(account.xaiKeyBlockReason(info), 'the API key is disabled', 'disabled key')
  eq(account.parseXaiPrepaidBalance({ total: { val: '-1000' } }), 10, 'prepaid credit in dollars')
  eq(account.parseXaiInvoicePreview({
    coreInvoice: { amountAfterVat: '250' }, effectiveSpendingLimit: '20000', billingCycle: { year: 2026, month: 10 },
  }), { amountDue: 2.5, spendingLimit: 200, year: 2026, month: 10 }, 'invoice preview')
  eq(account.parseXaiUsageAnalytics({
    timeSeries: [
      { groupLabels: ['Chat grok-4.3'], dataPoints: [{ values: [0.25] }, { values: [0.5] }] },
      { groupLabels: ['Chat grok-4.7'], dataPoints: [{ values: [1.5] }] },
      { groupLabels: ['Idle'], dataPoints: [{ values: [0] }] },
    ],
  }), [{ label: 'Chat grok-4.7', usd: 1.5 }, { label: 'Chat grok-4.3', usd: 0.75 }], 'per-model spend')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
