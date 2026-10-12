import assert from 'node:assert/strict'
import { codexApi, type CodexStreamEvent } from './api.js'
import { codexLane, convertHistoryToCodex, resolveReasoning } from './loop.js'
import type { AnthropicContentBlock, ProviderMessage } from '../../services/api/providers/base_provider.js'

const originalStream = codexApi.streamResponses
const requests: any[] = []
let responseNumber = 0
codexApi.streamResponses = async function* (request) {
  requests.push(structuredClone(request))
  const id = `reason-${++responseNumber}`
  yield { type: 'response.created', response: { id: `response-${id}` } }
  yield { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id } }
  yield { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Inspecting files' } as CodexStreamEvent
  yield { type: 'response.output_item.done', output_index: 0, item: {
    type: 'reasoning', id, encrypted_content: `opaque-${id}`,
    summary: [{ type: 'summary_text', text: 'Inspecting files' }],
  } }
  for (let i = 1; i <= 2; i++) {
    const item = { type: 'function_call' as const, id: `fc-${id}-${i}`, call_id: `call-${id}-${i}`, name: 'read_file', arguments: '{"file_path":"fixture.txt"}' }
    yield { type: 'response.output_item.added', output_index: i, item }
    yield { type: 'response.function_call_arguments.done', output_index: i, item_id: item.id, arguments: item.arguments }
    yield { type: 'response.output_item.done', output_index: i, item }
  }
  yield { type: 'response.completed', response: { id: `response-${id}`, usage: {} } }
}

async function run(model: string, messages: ProviderMessage[]) {
  const blocks = new Map<number, AnthropicContentBlock>()
  for await (const event of codexLane.streamAsProvider({ model, messages, max_tokens: 100,
    tools: [], effortValue: null, signal: new AbortController().signal, sessionId: `reasoning-test-${model}` })) {
    // Match the production accumulator: shallow copies at start, JSON persisted at stop.
    if (event.type === 'content_block_start') blocks.set(event.index!, { ...event.content_block! })
    if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index!)!
      if (event.delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + event.delta.thinking
      if (event.delta?.type === 'input_json_delta') block.input = JSON.parse(event.delta.partial_json!)
    }
    if (event.type === 'content_block_stop') blocks.set(event.index!, JSON.parse(JSON.stringify(blocks.get(event.index!))))
  }
  return [...blocks.values()]
}

try {
  codexApi.configure({ apiKey: 'fixture-only', baseUrl: 'https://api.openai.com/v1' })
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'Read two files.' }]
    const blocks = await run(model, messages)
    const tools = blocks.filter(block => block.type === 'tool_use')
    assert.equal(tools[0]?._codex_reasoning?.model, model)
    assert.equal(tools[0]?._codex_reasoning?.items[0]?.summary[0]?.text, 'Inspecting files')
    assert.equal(tools[1]?._codex_reasoning, undefined)
    messages.push({ role: 'assistant', content: blocks })
    messages.push({ role: 'user', content: tools.map(block => ({ type: 'tool_result', tool_use_id: block.id, content: 'file contents' })) })
    await run(model, messages)
    const followup = requests.at(-1)
    assert.deepEqual(followup.reasoning, { summary: 'auto' })
    assert.deepEqual(followup.include, ['reasoning.encrypted_content'])
    const reasoning = followup.input.filter((item: any) => item.type === 'reasoning')
    assert.equal(reasoning.length, 1, 'split siblings must replay only once')
    assert.deepEqual(reasoning[0], { type: 'reasoning', encrypted_content: tools[0]!._codex_reasoning!.items[0]!.encrypted_content, summary: [] })
    const index = followup.input.findIndex((item: any) => item.type === 'reasoning')
    assert.equal(followup.input[index + 1].type, 'function_call')
    assert(!JSON.stringify(followup.input).includes('Inspecting files'))
    const prefix = structuredClone(followup.input)
    messages.push({ role: 'user', content: 'One more check.' })
    await run(model, messages)
    assert.deepEqual(requests.at(-1).input.slice(0, prefix.length), prefix, 'history must extend without rewriting its prefix')
    assert(!convertHistoryToCodex(messages, new Map(), 'different-model').some(item => item.type === 'reasoning'))
    // Thinking may be stripped by shared normalization; the tool still owns the state.
    assert.equal(convertHistoryToCodex([{ role: 'assistant', content: tools }], new Map(), model).filter(item => item.type === 'reasoning').length, 1)
  }
  assert.equal(resolveReasoning(undefined, 'gpt-4.1', 'high'), undefined)
  await run('gpt-4.1', [{ role: 'user', content: 'Hello.' }])
  assert.equal(requests.at(-1).reasoning, undefined)
  assert.equal(requests.at(-1).include, undefined)
  codexApi.configure({ apiKey: 'fixture-only', baseUrl: 'https://fixture.openai.azure.com/openai/v1' })
  await run('gpt-6-sol', [{ role: 'user', content: 'Hello.' }])
  assert.equal(requests.at(-1).store, true)
  assert.equal(requests.at(-1).reasoning, undefined, 'Azure keeps its existing default effort policy')
  console.log('Codex reasoning replay: passed (four models, resume, prefix, capabilities, Azure)')
} finally {
  codexApi.streamResponses = originalStream
  codexApi.clearChain()
}
