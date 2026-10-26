import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandCodeProvider } from '../src/services/api/providers/commandcode_provider.js'
import {
  commandCodeEffortLevelsForModel,
  supportsCommandCodeEffortSelection,
  getCommandCodeEffortLabel,
  getCommandCodeModelDisplayName,
} from '../src/utils/model/commandCodeThinking.js'
import { getProviderCatalogContextWindow } from '../src/utils/model/contextWindows.js'
import { commandCodeRegistryImageInput, recordCommandCodeCatalog } from '../src/utils/model/commandCodeRegistry.js'
import { resetCatalogForTests } from '../src/utils/modelPricingCatalog.js'
import {
  _resetMediaExtractionForTest,
  _seedMediaExtractionForTest,
} from '../src/lanes/shared/media_extract.js'

async function runTests() {
  console.log('Testing CommandCodeProvider...')

  // Command Code's live catalog is saved under the config dir: keep this run
  // off the real one, in both directions.
  const configDir = mkdtempSync(join(tmpdir(), 'tau-commandcode-'))
  process.env.CLAUDE_CONFIG_DIR = configDir

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
    assert.equal(luna5?.contextWindow, 1_050_000)
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

  // 4b. /alpha/generate carries tool results as text only. A model that can
  // see gets a tool's images in the user message after the result, as an
  // attached image travels; PDFs, and images for a text-only model, arrive as
  // extracted text or a marker. Never as base64 text: a stringified
  // screenshot was billed as 100k+ tokens.
  const media = (type: 'image' | 'document', tag: string) => ({
    type,
    source: {
      type: 'base64',
      media_type: type === 'image' ? 'image/png' : 'application/pdf',
      data: tag.padEnd(4_000, 'A'),
    },
  })
  const shot = media('image', 'SHOTPNG')
  const crop = media('image', 'CROPPNG')
  const nestedPdf = media('document', 'NESTPDF')
  const topPdf = media('document', 'TOPPDF')
  const pasted = media('image', 'PASTEDPNG')
  // Seeded, so the prefetch never reaches OCR or a describer, and an empty
  // models.dev table, so nothing reads this machine's copy or downloads one.
  resetCatalogForTests({ version: 2, fetchedAt: Date.now(), providers: {}, limits: {}, ceilings: {}, images: {}, efforts: {} })
  _resetMediaExtractionForTest()
  _seedMediaExtractionForTest(shot, 'Build failed: 3 errors')
  _seedMediaExtractionForTest(crop, '', { reason: 'no text extractor is configured' })
  _seedMediaExtractionForTest(nestedPdf, 'Spec section 1')
  _seedMediaExtractionForTest(topPdf, 'Spec appendix')
  _seedMediaExtractionForTest(pasted, 'Pasted text')

  let alphaBody: any = null
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    alphaBody = JSON.parse(String(init?.body))
    return new Response(
      'data: {"type":"finish","finishReason":"end_turn"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch
  const sendHistory = async (model: string) => {
    const stream = await provider.stream({
      model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'what is on screen?' }, pasted] },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'shot.png' } },
          { type: 'tool_use', id: 'call_eval', name: 'Eval', input: { code: 'img.crop(box)' } },
          { type: 'tool_use', id: 'call_pdf', name: 'Read', input: { file_path: 'spec.pdf' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call_read', content: [shot] },
          { type: 'tool_result', tool_use_id: 'call_eval', content: [{ type: 'text', text: '<PIL.Image size=1200x440>' }, crop] },
          { type: 'tool_result', tool_use_id: 'call_pdf', content: [{ type: 'text', text: 'PDF read' }, nestedPdf] },
        ] },
        { role: 'user', content: [topPdf] },
      ] as any,
      max_tokens: 100,
    })
    for await (const _ of stream) {}

    const messages = alphaBody.params.messages
    for (const message of messages) {
      if (Array.isArray(message.content)) assert(!message.content.includes(null), `a ${message.role} block went out as null`)
    }
    const outputs = new Map<string, any>(messages
      .filter((m: any) => m.role === 'tool')
      .flatMap((m: any) => m.content)
      .map((part: any) => [part.toolCallId, part.output]))
    // Base64 may only ever ride as an image part's source, never inside text.
    const texts = JSON.stringify(messages.flatMap((m: any) => Array.isArray(m.content)
      ? m.content.map((part: any) => part.type === 'image' ? null : part)
      : [m.content]))
    for (const block of [shot, crop, nestedPdf, topPdf, pasted]) {
      assert.equal(texts.includes(block.source.data), false, `${block.source.data.slice(0, 7)} reached the prompt as base64 text`)
    }
    const imageSources = messages.flatMap((m: any) => Array.isArray(m.content)
      ? m.content.filter((part: any) => part.type === 'image').map((part: any) => part.source)
      : [])
    return { messages, outputs, imageSources }
  }

  try {
    // A vision model sees a Read or Eval image exactly as it sees an attached one.
    const vision = await sendHistory('deepseek/deepseek-v4.1-flash')
    assert.deepEqual(vision.imageSources, [pasted.source, shot.source, crop.source])
    assert.equal(vision.outputs.get('call_read').value, '[image attached below]')
    assert.equal(vision.outputs.get('call_eval').value, '<PIL.Image size=1200x440>\n[image attached below]')
    assert.match(vision.outputs.get('call_pdf').value, /^PDF read\n\[document content, extracted with OCR[^\n]*\]\nSpec section 1$/)
    const toolIndex = vision.messages.findIndex((m: any) => m.role === 'tool')
    const followUp = vision.messages[toolIndex + 1]
    assert.equal(followUp.role, 'user')
    assert.equal(followUp.content[0].text, 'Images from the tool result above:')
    assert.deepEqual(followUp.content.slice(1).map((part: any) => part.source), [shot.source, crop.source])
    assert.equal(vision.messages[0].content[1].type, 'image')
    assert.match(vision.messages.at(-1).content[0].text, /Spec appendix$/)
    console.log('✓ A vision model on /alpha/generate sees tool-result images as image parts')

    // A text-only model gets no image part at all, attached or from a tool.
    const textOnly = await sendHistory('zai-org/GLM-5.1')
    assert.deepEqual(textOnly.imageSources, [])
    assert.match(textOnly.messages[0].content[1].text, /^\[image content, extracted with OCR[^\n]*\]\nPasted text$/)
    assert.match(textOnly.outputs.get('call_read').value, /^\[image content, extracted with OCR[^\n]*\]\nBuild failed: 3 errors$/)
    assert.equal(
      textOnly.outputs.get('call_eval').value,
      '<PIL.Image size=1200x440>\n[image not sent (image/png): no text extractor is configured]',
    )
    console.log('✓ A text-only model on /alpha/generate gets images as text, never base64')

    // A later turn replays every sent message byte for byte: for a model that
    // sees (tool images hoisted after the result), for one that reads text,
    // and for one whose catalog row arrives between the turns. Cache markers
    // follow the last message by design and are left out of the comparison.
    const replayed = async (model: string, between?: () => void) => {
      const history: any[] = [
        { role: 'user', content: [{ type: 'text', text: 'what is on screen?' }, pasted] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_shot', name: 'Read', input: { file_path: 'shot.png' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_shot', content: [shot] }] },
      ]
      const send = async (messages: any[]) => {
        const stream = await provider.stream({ model, messages, max_tokens: 100 })
        for await (const _ of stream) {}
        return alphaBody.params.messages as any[]
      }
      const first = await send(history)
      between?.()
      const next = await send([
        ...history,
        { role: 'assistant', content: [{ type: 'text', text: 'The build failed.' }] },
        { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      ])
      const bytes = (messages: any[]) => JSON.stringify(messages, (key, value) => key === 'cache_control' ? undefined : value)
      assert.equal(bytes(next.slice(0, first.length)), bytes(first), `${model}: a replayed message changed`)
      return first
    }
    const seen = await replayed('moonshotai/Kimi-K3')
    assert(JSON.stringify(seen).includes('"type":"image"'), 'the vision model was sent its images')
    await replayed('zai-org/GLM-5.1')
    const late = await replayed('acme/late-model', () => recordCommandCodeCatalog([
      { id: 'acme/late-model', context_length: 128_000, inputModalities: ['text', 'image'] },
    ]))
    assert(!JSON.stringify(late).includes('"type":"image"'), 'the first answer holds for the session')
    assert.equal(commandCodeRegistryImageInput('acme/late-model'), true, 'later sessions get the new row')
    console.log('✓ Command Code replays sent messages byte for byte across turns')

    // The bundled registry answers only for the models it lists; anything
    // else is left to other evidence, and text when there is none.
    assert.equal(commandCodeRegistryImageInput('ZAI-ORG/glm-5.1'), false)
    assert.equal(commandCodeRegistryImageInput('deepseek/deepseek-v4-flash'), false)
    assert.equal(commandCodeRegistryImageInput('deepseek/deepseek-v4-pro-20270101'), false)
    assert.equal(commandCodeRegistryImageInput('inclusionai/ling-3.1-flash:free'), false)
    assert.equal(commandCodeRegistryImageInput('deepseek/deepseek-v4-flash-vision-exp'), true)
    assert.equal(commandCodeRegistryImageInput('moonshotai/Kimi-K3'), true)
    assert.equal(commandCodeRegistryImageInput('gpt-6-luna'), true)
    assert.equal(commandCodeRegistryImageInput('some-lab/brand-new-model'), undefined)
    console.log("✓ Command Code vision capability follows Command Code's catalog")
  } finally {
    globalThis.fetch = origFetch
    _resetMediaExtractionForTest()
  }

  // 4c. Context overflow reads as "Prompt is too long", on the alpha stream,
  // on the Anthropic stream, and as an HTTP error.
  const overflow = "This model's maximum context length is 1048576 tokens. However, you requested 1529900 tokens."
  const streamOf = (...events: object[]) => (async () => new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as unknown as typeof fetch
  const drain = async (model: string) => {
    const stream = await provider.stream({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 })
    for await (const _ of stream) {}
  }

  try {
    globalThis.fetch = streamOf({ type: 'error', error: { message: overflow } })
    await assert.rejects(drain('deepseek/deepseek-v4.1-flash'), {
      message: `Prompt is too long (commandcode): Command Code API stream error: ${overflow}`,
    })

    globalThis.fetch = streamOf({ type: 'error', error: { message: 'upstream unavailable' } })
    await assert.rejects(drain('deepseek/deepseek-v4.1-flash'), {
      message: 'Command Code API stream error: upstream unavailable',
    })

    globalThis.fetch = streamOf({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 1100000 tokens > 1000000 maximum' },
    })
    await assert.rejects(drain('claude-sonnet-4-6'), {
      message: 'Prompt is too long (commandcode): Command Code API stream error: prompt is too long: 1100000 tokens > 1000000 maximum',
    })

    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: overflow, code: 'context_length_exceeded' } }),
      { status: 400 },
    )) as unknown as typeof fetch
    await assert.rejects(drain('deepseek/deepseek-v4.1-flash'), {
      message: /^Prompt is too long \(commandcode 400\): This model's maximum context length/,
    })
    console.log('✓ Context overflow is reported as Prompt is too long')
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
  assert.equal(getProviderCatalogContextWindow('gpt-6-luna', 'commandcode'), 1_050_000)
  assert.equal(getProviderCatalogContextWindow('moonshotai/Kimi-K3.1-Pro', 'commandcode'), 1_048_576)
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
  assert.equal(lingCosts?.inputTokens, 0.3)
  assert.equal(lingCosts?.outputTokens, 0.9)

  // Prices and windows come from an exact row only: Kimi K3.1 Pro is not
  // Kimi K3, and MiniMax M3.1 Flash is not MiniMax M3.
  assert.equal(getCommandCodeCatalogCosts('moonshotai/Kimi-K3.1-Pro'), null)
  assert.equal(getCommandCodeCatalogContextWindow('minimax/minimax-m3.1-flash'), undefined)

  // Check effort ladders for diverse models
  assert.deepEqual(getCommandCodeCatalogEfforts('grok-4.7'), ['default', 'none', 'low', 'high'])
  assert.deepEqual(getCommandCodeCatalogEfforts('gemini-3.8-flash'), ['default', 'none', 'low', 'medium', 'high'])
  assert.deepEqual(getCommandCodeCatalogEfforts('step-3.7-flash'), ['default', 'low', 'medium', 'high'])
  assert.deepEqual(getCommandCodeCatalogEfforts('ling-3.1-flash'), ['default'])
  console.log('✓ Full 85-model catalog pricing and reasoning test passed')

  // 8. Command Code's own catalog prices, sizes and names each model by its
  // exact id or alias: the live copy listModels fetched, else the bundled one.
  const {
    commandCodeRegistryContextWindow,
    commandCodeRegistryPrice,
    _resetCommandCodeRegistryForTest,
  } = await import('../src/utils/model/commandCodeRegistry.js')
  const rates = (model: string, contextTokens = 0) => {
    const price = commandCodeRegistryPrice(model, contextTokens)
    return price && [
      price.inputTokens,
      price.outputTokens,
      price.promptCacheReadTokens,
      price.promptCacheWriteTokens,
    ]
  }

  // The bundled copy carries the pricing page's rates, Kimi K3.1 Pro included.
  assert.deepEqual(rates('moonshotai/Kimi-K3.1-Pro'), [2, 10, 0.2, 0])
  assert.deepEqual(rates('minimax/minimax-m3.1-flash'), [0.15, 0.6, 0.015, 0])
  assert.deepEqual(rates('claude-sonnet-5-5'), [2, 10, 0.1, 2.5])
  assert.deepEqual(rates('inclusionai/ling-3.1-flash'), [0.3, 0.9, 0.06, 0])
  assert.equal(commandCodeRegistryContextWindow('moonshotai/Kimi-K3.1-Pro'), 1_048_576)
  // Past a tier's threshold the whole prompt takes the higher rate.
  assert.deepEqual(rates('gpt-6.1-sol', 272_000), [2, 10, 0.1, 2.5])
  assert.deepEqual(rates('gpt-6.1-sol', 272_001), [4, 15, 0.2, 5])
  assert.deepEqual(rates('claude-haiku-5-5', 100_001), [0.5, 2.5, 0.05, 0.625])
  // Command Code's aliases and dated snapshots are the model they name.
  assert.deepEqual(rates('claude-opus-4-6'), rates('claude-opus-4-7'))
  assert.deepEqual(rates('deepseek/deepseek-v4-pro-20270101'), rates('deepseek/deepseek-v4-pro'))
  // A free model that lists no pricing costs nothing; an unlisted one is unpriced.
  assert.deepEqual(rates('inclusionai/ling-3.1-flash:free'), [0, 0, 0, 0])
  assert.equal(rates('moonshotai/Kimi-K3.2'), null)
  // Labels: none of these borrows its near-namesake's name any more.
  assert.equal(getCommandCodeModelDisplayName('moonshotai/Kimi-K3.1-Pro'), 'Kimi K3.1 Pro')
  assert.equal(getCommandCodeModelDisplayName('minimax/minimax-m3.1-flash'), 'MiniMax M3.1 Flash')
  assert.equal(getCommandCodeModelDisplayName('Qwen/Qwen3.8-Max-Prime'), 'Qwen 3.8 Max Prime')
  assert.equal(getCommandCodeModelDisplayName('moonshotai/Kimi-K3'), 'Kimi K3')

  // listModels reads the client view: it keeps every row's data, shows only
  // the rows /models lists, and saves the catalog for the next session.
  const requested: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    requested.push(String(url))
    return Response.json({ data: [
      { id: 'moonshotai/Kimi-K3.1-Pro', name: 'Kimi K3.1 Pro', context_length: 1_048_576, inputModalities: ['text', 'image'], pricing: { inputCost: 1.5, outputCost: 7.5, cacheReadCost: 0.15 } },
      { id: 'lab/new-model', name: 'New Model', context_length: 400_000, inputModalities: ['text'], pricing: { inputCost: 1, outputCost: 2, cacheReadCost: 0.1 } },
      { id: 'lab/new-model:free', name: 'New Model (Free)', hidden: true, context_length: 400_000, inputModalities: ['text'], display: { badge: 'free' } },
    ] })
  }) as typeof fetch
  try {
    const listed = (await provider.listModels()).map(model => model.id)
    assert.deepEqual(requested, ['https://api.commandcode.ai/provider/v1/models?view=client'])
    assert(listed.includes('lab/new-model'), 'a listed model is shown')
    assert(!listed.includes('lab/new-model:free'), 'a hidden model is not shown')
    assert.deepEqual(rates('moonshotai/Kimi-K3.1-Pro'), [1.5, 7.5, 0.15, 0])
    assert.deepEqual(rates('lab/new-model:free'), [0, 0, 0, 0])
    assert.equal(commandCodeRegistryImageInput('lab/new-model'), false)
    assert.equal(commandCodeRegistryContextWindow('lab/new-model'), 400_000)
    // A model the live copy leaves out keeps its bundled data.
    assert.deepEqual(rates('claude-sonnet-5-5'), [2, 10, 0.1, 2.5])

    const saved = join(configDir, 'cache', 'commandcode-models.json')
    const holdsNewModel = () => existsSync(saved) && readFileSync(saved, 'utf8').includes('lab/new-model')
    for (let tries = 0; tries < 200 && !holdsNewModel(); tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    _resetCommandCodeRegistryForTest()
    assert.deepEqual(rates('lab/new-model'), [1, 2, 0.1, 0], 'the next session starts from the saved catalog')

    // A gateway that serves only the plain list still lists models, and the
    // saved catalog stays as it was.
    requested.length = 0
    globalThis.fetch = (async (url: string | URL) => {
      requested.push(String(url))
      return String(url).endsWith('?view=client')
        ? new Response('unknown view', { status: 400 })
        : Response.json({ data: [{ id: 'lab/plain-only', context_length: 128_000 }] })
    }) as typeof fetch
    const plain = (await provider.listModels()).map(model => model.id)
    assert.deepEqual(requested.map(url => url.slice(url.lastIndexOf('/'))), ['/models?view=client', '/models'])
    assert(plain.includes('lab/plain-only'))
    assert.deepEqual(rates('lab/new-model'), [1, 2, 0.1, 0])
  } finally {
    globalThis.fetch = origFetch
  }
  console.log("✓ Command Code's own catalog prices, sizes and names models by exact id")

  console.log('\nAll CommandCodeProvider tests passed!')
}

runTests()
