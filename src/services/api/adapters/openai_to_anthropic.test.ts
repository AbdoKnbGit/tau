/**
 * Run: bun run src/services/api/adapters/openai_to_anthropic.test.ts
 */
import { openAIStreamToAnthropicEvents } from './openai_to_anthropic.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

const base = { id: 'gen-1', object: 'chat.completion.chunk', model: 'stealth/space-bunny-alpha' }
const toolDelta = (tc: Record<string, unknown>) => ({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [tc] }, finish_reason: null }] })
const finish = (usage?: Record<string, unknown>) => ({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'tool_calls' }], ...(usage && { usage }) })

// What Kilo's gateway (an OpenRouter proxy) sent in a live run: one tool call,
// then the finish chunk twice, the second carrying the accounting.
function kiloStream(): any[] {
  return [
    toolDelta({ index: 0, id: 'call-1', type: 'function', function: { name: 'Bash', arguments: '' } }),
    toolDelta({ index: 0, function: { arguments: '{"command": "node step.js one"' } }),
    toolDelta({ index: 0, function: { arguments: '}' } }),
    finish(),
    finish({ prompt_tokens: 2000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1500 } }),
  ]
}

async function events(chunks: any[], options?: { openRouter?: boolean }): Promise<any[]> {
  async function* source() { for (const c of chunks) yield c }
  const out: any[] = []
  for await (const ev of openAIStreamToAnthropicEvents(source(), options)) out.push(ev)
  return out
}

async function main(): Promise<void> {
  console.log('openai -> anthropic stream:')

  for (const openRouter of [false, true]) {
    await test(`a repeated finish chunk closes the tool block once (${openRouter ? 'OpenRouter' : 'plain'} mode)`, async () => {
      const out = await events(kiloStream(), { openRouter })
      const starts = out.filter(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use')
      assert(starts.length === 1, `tool starts=${starts.length}`)
      const stops = out.filter(e => e.type === 'content_block_stop' && e.index === starts[0].index)
      assert(stops.length === 1, `the tool block closed ${stops.length} times; each close runs the call`)
      assert(out.filter(e => e.type === 'message_stop').length === 1, 'message ended more than once')
      const usage = out.filter(e => e.type === 'message_delta').at(-1)?.usage
      assert(usage?.output_tokens === 20, `usage from the second finish chunk is kept: ${JSON.stringify(usage)}`)
    })
  }

  await test('a single finish chunk still ends the message as before', async () => {
    const chunks = kiloStream()
    chunks.splice(3, 1)
    const out = await events(chunks)
    assert(out.filter(e => e.type === 'content_block_stop').length === 1, 'one block stop')
    assert(out.filter(e => e.type === 'message_delta').length === 1, 'one message_delta')
    assert(out.filter(e => e.type === 'message_stop').length === 1, 'one message_stop')
    const usage = out.find(e => e.type === 'message_delta').usage
    assert(usage.input_tokens === 500 && usage.cache_read_input_tokens === 1500, `usage split ${JSON.stringify(usage)}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
