import assert from 'node:assert/strict'
import { CommandCodeProvider } from '../src/services/api/providers/commandcode_provider.js'

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
    assert(ids.includes('gpt-5.6-luna'), 'fallback must include gpt-5.6-luna')
    assert(ids.includes('gpt-6-luna'), 'fallback must include gpt-6-luna')
    assert(ids.includes('moonshotai/Kimi-K2.6'), 'fallback must include Kimi-K2.6')
    assert(ids.includes('MiniMaxAI/MiniMax-M3'), 'fallback must include MiniMax-M3')

    const luna5 = models.find(m => m.id === 'gpt-5.6-luna')
    assert.equal(luna5?.name, 'GPT-5.6 Luna')
    assert(luna5?.tags?.includes('fast'), 'luna must have fast tag')
    assert(luna5?.tags?.includes('recommended'), 'luna must have recommended tag')
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

  console.log('\nAll CommandCodeProvider tests passed!')
}

runTests()
