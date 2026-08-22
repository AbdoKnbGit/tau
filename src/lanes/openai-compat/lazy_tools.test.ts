/**
 * Run: bun run src/lanes/openai-compat/lazy_tools.test.ts
 */

import type {
  AnthropicStreamEvent,
  ProviderMessage,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import { _resetStickyLoadedToolsForTest } from '../shared/lazy_tools_core.js'
import { selectOpenAICompatToolsForRequest } from './lazy_tools.js'
import { OpenAICompatLane } from './loop.js'

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

function tool(name: string, deferred = false): ProviderTool {
  const t: ProviderTool = {
    name,
    description: `${name} description`,
    input_schema: { type: 'object', properties: {} },
  }
  Object.defineProperty(t, '__tau_should_defer', {
    value: deferred,
    enumerable: false,
  })
  return t
}

function toolNames(body: Record<string, any>): string[] {
  return (body.tools ?? []).map((t: any) => t.function?.name).filter(Boolean)
}

async function captureBody(
  tools: ProviderTool[],
  messages: ProviderMessage[] = [{ role: 'user', content: 'hello' }],
): Promise<Record<string, any>> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('deepseek', 'sk-test', 'https://api.deepseek.com/v1')

  const oldFetch = globalThis.fetch
  let body: Record<string, any> | null = null
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
    const sse = [
      {
        id: 'x',
        object: 'chat.completion.chunk',
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'x',
        object: 'chat.completion.chunk',
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: 'deepseek-chat',
      messages,
      system: 'stable system',
      tools,
      max_tokens: 64,
      signal: new AbortController().signal,
      providerHint: 'deepseek',
    })
    for await (const ev of stream) events.push(ev)
    assert(body !== null, 'request body was not captured')
    return body
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('deepseek')
  }
}

function loadedMessage(...toolNames: string[]): ProviderMessage {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: toolNames.map(
        name => ({ type: 'tool_reference', tool_name: name }) as any,
      ),
    }],
  }
}

function compactBoundary(...toolNames: string[]): ProviderMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: {
      preCompactDiscoveredTools: toolNames,
    },
  } as unknown as ProviderMessage
}

console.log('openai-compat lazy tools:')

await test('keeps undiscovered deferred tools out of request schemas', async () => {
  const body = await captureBody([
    tool('Read'),
    tool('ToolSearch'),
    tool('InspectSite', true),
  ])

  assert(toolNames(body).join(',') === 'Read,ToolSearch', toolNames(body).join(','))
})

await test('includes deferred tools after ToolSearch loaded them', async () => {
  const body = await captureBody(
    [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)],
    [loadedMessage('InspectSite')],
  )

  assert(
    toolNames(body).join(',') === 'Read,ToolSearch,InspectSite',
    toolNames(body).join(','),
  )
})

await test('missing ToolSearch automatically falls back to eager schemas', async () => {
  const selected = selectOpenAICompatToolsForRequest([
    tool('Read'),
    tool('NotebookEdit', true),
  ], [])

  assert(
    selected.map(t => t.name).join(',') === 'Read,NotebookEdit',
    selected.map(t => t.name).join(','),
  )
})

await test('includes deferred tools carried by compact boundary metadata', async () => {
  const selected = selectOpenAICompatToolsForRequest(
    [tool('Read'), tool('ToolSearch'), tool('TaskCreate', true)],
    [compactBoundary('TaskCreate')],
  )

  assert(
    selected.map(t => t.name).join(',') === 'Read,ToolSearch,TaskCreate',
    selected.map(t => t.name).join(','),
  )
})

await test('a deferred tool placed BEFORE the base appends after it', async () => {
  // InspectSite is deferred and sits at index 0. A plain filter keeps it there
  // and shifts the whole tool block right when it loads; append-only ordering
  // must render the stable base first and append InspectSite last.
  const body = await captureBody(
    [tool('InspectSite', true), tool('Read'), tool('ToolSearch'), tool('Edit')],
    [loadedMessage('InspectSite')],
  )

  assert(
    toolNames(body).join(',') === 'Read,ToolSearch,Edit,InspectSite',
    toolNames(body).join(','),
  )
})

await test('deferred tools append in LOAD order, not array-index order', async () => {
  const body = await captureBody(
    [tool('Read'), tool('ToolSearch'), tool('Alpha', true), tool('Beta', true)],
    [loadedMessage('Beta', 'Alpha')],
  )

  assert(
    toolNames(body).join(',') === 'Read,ToolSearch,Beta,Alpha',
    toolNames(body).join(','),
  )
})

await test('undiscovered deferred additions do not change request schemas', async () => {
  const base = await captureBody([
    tool('Read'),
    tool('ToolSearch'),
    tool('InspectSite', true),
  ])
  const withExtra = await captureBody([
    tool('Read'),
    tool('ToolSearch'),
    tool('InspectSite', true),
    tool('DeployPreview', true),
  ])

  assert(
    JSON.stringify(toolNames(base)) === JSON.stringify(toolNames(withExtra)),
    `${toolNames(base)} vs ${toolNames(withExtra)}`,
  )
})

await test('a loaded tool survives compaction erasing its history evidence', async () => {
  _resetStickyLoadedToolsForTest()
  const source = [tool('Read'), tool('ToolSearch'), tool('InspectSite', true)]

  // Turn N: history shows the load → tool appended (direct-call form so the
  // session key is exercised the way loop.ts passes it).
  const loaded = selectOpenAICompatToolsForRequest(
    source,
    [loadedMessage('InspectSite')],
    'sess-sticky',
  )
  assert(
    loaded.map(t => t.name).join(',') === 'Read,ToolSearch,InspectSite',
    loaded.map(t => t.name).join(','),
  )

  // Turn N+1: compaction wiped the tool_reference evidence — the same session
  // must keep the tool at the same appended position (no tool-block rewrite,
  // no silently-vanishing tool).
  const afterCompaction = selectOpenAICompatToolsForRequest(source, [], 'sess-sticky')
  assert(
    afterCompaction.map(t => t.name).join(',') === 'Read,ToolSearch,InspectSite',
    afterCompaction.map(t => t.name).join(','),
  )

  // Other sessions stay unaffected.
  const other = selectOpenAICompatToolsForRequest(source, [], 'sess-other')
  assert(
    other.map(t => t.name).join(',') === 'Read,ToolSearch',
    other.map(t => t.name).join(','),
  )
})

await test('ENABLE_TOOL_SEARCH=false keeps full tool behavior', async () => {
  const previous = process.env.ENABLE_TOOL_SEARCH
  process.env.ENABLE_TOOL_SEARCH = 'false'
  try {
    const body = await captureBody([
      tool('Read'),
      tool('ToolSearch'),
      tool('InspectSite', true),
    ])

    assert(
      toolNames(body).join(',') === 'Read,ToolSearch,InspectSite',
      toolNames(body).join(','),
    )
  } finally {
    if (previous === undefined) delete process.env.ENABLE_TOOL_SEARCH
    else process.env.ENABLE_TOOL_SEARCH = previous
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
