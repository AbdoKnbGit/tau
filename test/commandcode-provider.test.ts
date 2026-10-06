import assert from 'node:assert/strict'
import { CommandCodeProvider } from '../src/services/api/providers/commandcode_provider.js'
import {
  commandCodeEffortLevelsForModel,
  supportsCommandCodeEffortSelection,
  getCommandCodeEffortLabel,
  getCommandCodeModelDisplayName,
} from '../src/utils/model/commandCodeThinking.js'
import { getProviderCatalogContextWindow } from '../src/utils/model/contextWindows.js'

async function runTests() {
  console.log('Testing CommandCodeProvider...')

  const provider = new CommandCodeProvider({
    apiKey: 'test-key-0123456789',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
  })

  // 1. Fallback model list test
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
  try {
    const models = await provider.listModels()
    const ids = models.map(m => m.id)
    assert(ids.includes('moonshotai/Kimi-K3'), 'fallback must include Kimi-K3')
    assert(ids.includes('gpt-5.6-luna'), 'fallback must include gpt-5.6-luna')
    assert(ids.includes('gpt-6-luna'), 'fallback must include gpt-6-luna')
    assert(ids.includes('moonshotai/Kimi-K2.6'), 'fallback must include Kimi-K2.6')
    assert(ids.includes('MiniMaxAI/MiniMax-M3'), 'fallback must include MiniMax-M3')

    const kimi3 = models.find(m => m.id === 'moonshotai/Kimi-K3')
    assert.equal(kimi3?.name, 'Kimi K3')
    assert.equal(kimi3?.contextWindow, 1_000_000)
    assert(kimi3?.tags?.includes('reasoning'), 'Kimi K3 must have reasoning tag')

    const luna5 = models.find(m => m.id === 'gpt-5.6-luna')
    assert.equal(luna5?.name, 'GPT-5.6 Luna')
    assert.equal(luna5?.contextWindow, 1_100_000)
    assert(luna5?.tags?.includes('fast'), 'luna must have fast tag')
    assert(luna5?.tags?.includes('recommended'), 'luna must have recommended tag')

    const qwenMax = models.find(m => m.id === 'Qwen/Qwen3.7-Max')
    assert.equal(qwenMax?.contextWindow, 1_000_000)

    const deepseekPro = models.find(m => m.id === 'deepseek/deepseek-v4-pro')
    assert.equal(deepseekPro?.contextWindow, 1_000_000)

    const kimi26 = models.find(m => m.id === 'moonshotai/Kimi-K2.6')
    assert.equal(kimi26?.contextWindow, 256_000)

    console.log('✓ Fallback model list test passed')
  } finally {
    globalThis.fetch = origFetch
  }

  // 2. Model routing test
  const intercepted: Array<{ url: string; body: any }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    let body = null
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null
    } catch {
      body = init?.body
    }
    intercepted.push({ url: String(url), body })
    return new Response(
      'data: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}\n\n' +
      'data: {"type":"text-delta","text":"hello"}\n\n' +
      'data: {"type":"finish","finishReason":"end_turn"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch

  try {
    // 2a. Luna model -> must route to /alpha/generate (Go Plan pool)
    const stream1 = await provider.stream({
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    for await (const _ of stream1) {}

    assert.equal(intercepted.length, 1)
    assert.match(intercepted[0].url, /\/alpha\/generate$/)
    assert.equal(intercepted[0].body.mode, 'custom-agent')
    assert.equal(intercepted[0].body.params.model, 'gpt-5.6-luna')
    assert.equal(typeof intercepted[0].body.config, 'object')
    assert(intercepted[0].body.config.workingDir)
    console.log('✓ Luna model routing to /alpha/generate passed')

    // 2b. Claude model -> /provider/v1/messages
    const stream2 = await provider.stream({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    for await (const _ of stream2) {}

    assert.equal(intercepted.length, 2)
    assert.match(intercepted[1].url, /\/messages$/)
    console.log('✓ Claude model routing to /messages passed')

    // 2c. Regular GPT model -> /provider/v1/chat/completions
    const stream3 = await provider.stream({
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    for await (const _ of stream3) {}

    assert.equal(intercepted.length, 3)
    assert.match(intercepted[2].url, /\/chat\/completions$/)
    console.log('✓ Regular GPT model routing to /chat/completions passed')
  } finally {
    globalThis.fetch = origFetch
  }

  // 3. Cache stability test: second turn in same session reuses settled context
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    let body = null
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null
    } catch {
      body = init?.body
    }
    intercepted.push({ url: String(url), body })
    return new Response(
      'data: {"type":"message_start","message":{"id":"m2","role":"assistant","content":[]}}\n\n' +
      'data: {"type":"finish","finishReason":"end_turn"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch

  try {
    const stream4 = await provider.stream({
      model: 'moonshotai/Kimi-K2.6',
      messages: [{ role: 'user', content: 'turn 2' }],
      max_tokens: 100,
    })
    for await (const _ of stream4) {}

    assert.equal(intercepted.length, 4)
    assert.deepEqual(intercepted[3].body.config, intercepted[0].body.config, 'cached context must be byte-identical')
    console.log('✓ Cache stability across turns passed')
  } finally {
    globalThis.fetch = origFetch
  }

  // 4. Session with fallback context when scan is slow / stalled
  const { regenerateSessionId } = await import('../src/bootstrap/state.js')
  regenerateSessionId()

  const provider2 = new CommandCodeProvider({
    apiKey: 'test-key-0123456789',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
  })

  let requestMade = false
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestMade = true
    return new Response(
      'data: {"type":"message_start","message":{"id":"m3","role":"assistant","content":[]}}\n\n' +
      'data: {"type":"text-delta","text":"fallback test"}\n\n' +
      'data: {"type":"finish","finishReason":"end_turn"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch

  try {
    const stream = await provider2.stream({
      model: 'moonshotai/Kimi-K2.6',
      messages: [{ role: 'user', content: 'testing fallback' }],
      max_tokens: 50,
    })
    for await (const _ of stream) {}
    assert(requestMade, 'request must be dispatched without hanging')
    console.log('✓ Fresh session environment context dispatched cleanly')
  } finally {
    globalThis.fetch = origFetch
  }

  // 5. Reasoning effort levels test
  assert.deepEqual(
    commandCodeEffortLevelsForModel('moonshotai/Kimi-K3'),
    ['default', 'low', 'high', 'max'],
    'Kimi K3 must support default, low, high, max effort',
  )
  assert.equal(supportsCommandCodeEffortSelection('moonshotai/Kimi-K3'), true)
  assert.equal(getCommandCodeEffortLabel('max'), 'Max')

  assert.deepEqual(
    commandCodeEffortLevelsForModel('moonshotai/Kimi-K2.6'),
    ['default', 'none', 'low', 'medium', 'high'],
  )
  assert.equal(supportsCommandCodeEffortSelection('moonshotai/Kimi-K2.6'), true)

  assert.deepEqual(
    commandCodeEffortLevelsForModel('deepseek/deepseek-v4-pro'),
    ['default', 'low', 'medium', 'high'],
  )
  assert.equal(supportsCommandCodeEffortSelection('deepseek/deepseek-v4-pro'), true)

  assert.deepEqual(
    commandCodeEffortLevelsForModel('Qwen/Qwen3.7-Max'),
    ['default', 'none', 'low', 'medium', 'high', 'max'],
  )
  assert.equal(supportsCommandCodeEffortSelection('Qwen/Qwen3.7-Max'), true)

  assert.deepEqual(
    commandCodeEffortLevelsForModel('gpt-6-luna'),
    ['default', 'none', 'minimal', 'low', 'medium', 'high'],
  )
  assert.equal(supportsCommandCodeEffortSelection('gpt-6-luna'), true)
  assert.equal(getCommandCodeEffortLabel('none'), 'Off')
  assert.equal(getCommandCodeEffortLabel('minimal'), 'Minimal')
  console.log('✓ Reasoning effort levels and labels test passed')

  // 6. Provider-scoped context windows test
  assert.equal(getProviderCatalogContextWindow('moonshotai/Kimi-K3', 'commandcode'), 1_000_000)
  assert.equal(getProviderCatalogContextWindow('Qwen/Qwen3.7-Max', 'commandcode'), 1_000_000)
  assert.equal(getProviderCatalogContextWindow('deepseek/deepseek-v4-pro', 'commandcode'), 1_000_000)
  assert.equal(getProviderCatalogContextWindow('MiniMaxAI/MiniMax-M3', 'commandcode'), 1_000_000)
  assert.equal(getProviderCatalogContextWindow('gpt-6-luna', 'commandcode'), 1_100_000)
  assert.equal(getProviderCatalogContextWindow('moonshotai/Kimi-K2.6', 'commandcode'), 256_000)
  assert.equal(getProviderCatalogContextWindow('grok-4.7', 'commandcode'), 500_000)
  assert.equal(getProviderCatalogContextWindow('gemini-3.8-flash', 'commandcode'), 1_000_000)
  assert.equal(getProviderCatalogContextWindow('step-5-preview', 'commandcode'), 1_000_000)
  assert.equal(getProviderCatalogContextWindow('mimo-v2.6-pro', 'commandcode'), 1_000_000)
  assert.equal(getProviderCatalogContextWindow('ling-3.1-flash', 'commandcode'), 262_000)
  assert.equal(getProviderCatalogContextWindow('jev', 'commandcode'), 32_000)
  console.log('✓ Provider-scoped context windows test passed')

  // 7. Full 85-model catalog tests
  const {
    COMMAND_CODE_85_MODELS,
    getCommandCodeCatalogCosts,
    getCommandCodeCatalogContextWindow,
    getCommandCodeCatalogEfforts,
  } = await import('../src/utils/model/commandCodeCatalog.js')

  assert.equal(COMMAND_CODE_85_MODELS.length, 85, 'Catalog must contain all 85 models from context.txt')

  // Check pricing for diverse models
  const grokCosts = getCommandCodeCatalogCosts('grok-4.7')
  assert.equal(grokCosts?.inputTokens, 2.0)
  assert.equal(grokCosts?.outputTokens, 6.0)

  const stepCosts = getCommandCodeCatalogCosts('step-5-preview')
  assert.equal(stepCosts?.inputTokens, 1.0)
  assert.equal(stepCosts?.outputTokens, 2.7)

  const mimoCosts = getCommandCodeCatalogCosts('mimo-v2.6-pro')
  assert.equal(mimoCosts?.inputTokens, 0.435)
  assert.equal(mimoCosts?.outputTokens, 0.87)

  const lingCosts = getCommandCodeCatalogCosts('ling-3.1-flash')
  assert.equal(lingCosts?.inputTokens, 0.0)

  // Check effort ladders for diverse models
  assert.deepEqual(getCommandCodeCatalogEfforts('grok-4.7'), ['default', 'none', 'low', 'high'])
  assert.deepEqual(getCommandCodeCatalogEfforts('gemini-3.8-flash'), ['default', 'none', 'low', 'medium', 'high'])
  assert.deepEqual(getCommandCodeCatalogEfforts('step-3.7-flash'), ['default', 'low', 'medium', 'high'])
  assert.deepEqual(getCommandCodeCatalogEfforts('ling-3.1-flash'), ['default'])
  console.log('✓ Full 85-model catalog pricing and reasoning test passed')

  console.log('\nAll CommandCodeProvider tests passed!')
}

runTests()
