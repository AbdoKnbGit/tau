import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAICompatLane } from './loop.js'
import { getTransformer } from './transformers/index.js'
import type { OpenAIChatRequest } from './transformers/shared_types.js'
import type { ProviderMessage } from '../../services/api/providers/base_provider.js'
import { directEffortLevels, setDirectEffort, getDirectEffort, cycleDirectEffort } from '../../utils/model/directProviderThinking.js'
import { deriveDirectCatalog, directProviderModels, getDirectModelMeta, listDirectProviderModels, warmDirectProviderCatalog, type DirectThinkingProvider } from '../../utils/model/directProviderCatalog.js'
import { getProviderCatalogContextWindow } from '../../utils/model/contextWindows.js'
import { supportsDeepSeekEffortSelection, setDeepSeekEffort } from '../../utils/model/deepseekThinking.js'
import { GlmProvider } from '../../services/api/providers/glm_provider.js'
import { MoonshotProvider } from '../../services/api/providers/moonshot_provider.js'
import { MiniMaxProvider } from '../../services/api/providers/minimax_provider.js'

const temp = mkdtempSync(join(tmpdir(), 'tau-direct-providers-'))
const envKeys = ['TAU_DIRECT_THINKING_STORE', 'TAU_DIRECT_MODEL_CATALOG_STORE', 'TAU_DEEPSEEK_THINKING_STORE', 'TAU_DISABLE_DIRECT_MODEL_CATALOG']
const oldEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))
process.env.TAU_DIRECT_THINKING_STORE = join(temp, 'thinking.json')
process.env.TAU_DIRECT_MODEL_CATALOG_STORE = join(temp, 'models.json')
process.env.TAU_DEEPSEEK_THINKING_STORE = join(temp, 'deepseek.json')
process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG = '1'
afterAll(() => {
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key]
    else process.env[key] = oldEnv[key]
  }
  rmSync(temp, { recursive: true, force: true })
})

test('latest native models have exact contexts and supported thinking ladders', () => {
  for (const [provider, id, context, levels] of [
    ['glm', 'glm-5.3', 1_000_000, ['low', 'high', 'max']],
    ['glm', 'glm-5.3-flash', 1_000_000, ['low', 'high', 'max']],
    ['glm', 'glm-5.2', 1_000_000, ['high', 'max']],
    ['glm', 'glm-4.7', 204_800, ['off', 'on']],
    ['moonshot', 'kimi-k3', 1_048_576, ['low', 'high', 'max']],
    ['moonshot', 'kimi-k2.7-code', 262_144, []],
    ['moonshot', 'kimi-k2.6', 262_144, ['off', 'on']],
    ['minimax', 'MiniMax-M3', 1_000_000, ['off', 'on']],
    ['minimax', 'MiniMax-M2.5', 204_800, []],
  ] as const) {
    expect(directProviderModels(provider).find(m => m.id === id)?.contextWindow).toBe(context)
    expect(getProviderCatalogContextWindow(id, provider)).toBe(context)
    expect(directEffortLevels(provider, id)).toEqual(levels)
  }
  expect(directProviderModels('deepseek').find(m => m.id === 'deepseek-flash')).toMatchObject({ name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 })
})

test('arrow choices persist per model and only send supported native fields', () => {
  for (const [provider, id] of [['glm', 'glm-5.3'], ['moonshot', 'kimi-k3']] as const) {
    setDirectEffort(provider, id, 'max')
    cycleDirectEffort(provider, id, 'right')
    expect(getDirectEffort(provider, id)).toBe('low')
    const body = shape(provider, id)
    expect(body.reasoning_effort).toBe('low')
    expect(body.thinking?.type).not.toBe('disabled')
    if (provider === 'moonshot') expect(body.thinking).toBeUndefined()
    setDirectEffort(provider, id, 'medium')
    expect(getDirectEffort(provider, id)).toBe('low')
  }
  expect(getDirectEffort('glm', 'glm-5.2')).toBe('max')
  setDirectEffort('minimax', 'MiniMax-M3', 'off')
  expect(shape('minimax', 'MiniMax-M3').thinking).toEqual({ type: 'disabled' })
  cycleDirectEffort('minimax', 'MiniMax-M3', 'left')
  expect(shape('minimax', 'MiniMax-M3').thinking).toEqual({ type: 'adaptive' })
  expect(shape('minimax', 'MiniMax-M2.7').thinking).toBeUndefined()
  expect(shape('glm', 'glm-unknown').thinking).toBeUndefined()
})

function shape(provider: DirectThinkingProvider | 'deepseek', model: string): OpenAIChatRequest & { max_completion_tokens?: number } {
  const body: OpenAIChatRequest = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 600_000, stream: true }
  return getTransformer(provider).transformRequest(body, { model, isReasoning: false, reasoningEffort: null })
}

test('DeepSeek Flash alias reaches the existing effort transformer; per-model output caps apply', () => {
  expect(supportsDeepSeekEffortSelection('deepseek-flash')).toBe(true)
  setDeepSeekEffort('deepseek-flash', 'low')
  expect(shape('deepseek', 'deepseek-flash').reasoning_effort).toBe('low')
  expect(shape('minimax', 'MiniMax-M3').max_completion_tokens).toBe(512_000)
  expect(shape('minimax', 'MiniMax-M2.7').max_completion_tokens).toBe(131_072)
  expect(shape('glm', 'glm-5.3').max_tokens).toBe(131_072)
  expect(shape('moonshot', 'kimi-k3').max_tokens).toBe(131_072)
})

test('ID-only catalogs are enriched, live limits win, output limits are never context limits', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => Response.json({ data: [
      { id: 'MiniMax-M3', max_tokens: 2048 },
      { id: 'MiniMax-M2.7', context_length: 190_000 },
      { id: 'MiniMax-M9', max_tokens: 8192 },
      { id: 'MiniMax-M3' },
      { id: 'speech-01' },
    ] })) as unknown as typeof fetch
    const rows = await listDirectProviderModels('minimax', 'https://api.minimax.io/v1', {})
    expect(rows).toHaveLength(3)
    expect(rows.find(m => m.id === 'MiniMax-M3')?.contextWindow).toBe(1_000_000)
    expect(rows.find(m => m.id === 'MiniMax-M2.7')?.contextWindow).toBe(190_000)
    expect(rows.find(m => m.id === 'MiniMax-M9')?.contextWindow).toBeUndefined()
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect((await listDirectProviderModels('glm', 'https://open.bigmodel.cn/api/paas/v4', {})).some(m => m.id === 'glm-5.3')).toBe(true)
  } finally { globalThis.fetch = original }
})

const user: ProviderMessage = { role: 'user', content: 'inspect files' }
const assistant: ProviderMessage = { role: 'assistant', content: [
  { type: 'thinking', thinking: 'Inspect first.' }, { type: 'text', text: 'Checking.' },
  { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
] }
const result: ProviderMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file contents' }] }
const final: ProviderMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Done thinking.' }, { type: 'text', text: 'Done.' }] }
const boundary = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

for (const [provider, model, Provider, baseUrl] of [
  ['glm', 'glm-5.3', GlmProvider, 'https://open.bigmodel.cn/api/paas/v4'],
  ['moonshot', 'kimi-k3', MoonshotProvider, 'https://api.moonshot.ai/v1'],
  ['minimax', 'MiniMax-M3', MiniMaxProvider, 'https://api.minimax.io/v1'],
] as const) {
  test(`${provider}: native and legacy requests retain reasoning and stable cache prefixes across tool/user turns`, async () => {
    const original = globalThis.fetch
    const bodies: Array<OpenAIChatRequest> = []
    const lane = new OpenAICompatLane()
    lane.registerProvider(provider, 'fixture-key', baseUrl)
    const legacy = new Provider({ apiKey: 'fixture-key', baseUrl })
    try {
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        const reply = { choices: [{ delta: { content: 'OK' }, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 80 } } }
        return body.stream ? new Response(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(reply)
      }) as unknown as typeof fetch
      for (const transport of ['native', 'legacy']) {
        const offset = bodies.length
        for (const [index, messages] of [[user], [user, assistant, result], [user, assistant, result, final, user]].entries()) {
          const params = { model, messages, system: `Stable rules\n${boundary}\ngitStatus: ${index}`, max_tokens: 9000, sessionId: `${provider}-${transport}`, tools: [] }
          if (transport === 'legacy') await legacy.create(params)
          else {
            const events = []
            for await (const event of lane.streamAsProvider({ ...params, providerHint: provider, signal: new AbortController().signal })) events.push(event)
            expect(events.some(event => event.usage?.cache_read_input_tokens === 80 || event.message?.usage.cache_read_input_tokens === 80)).toBe(true)
          }
        }
        const [a, b, c] = bodies.slice(offset)
        expect(b!.messages.slice(0, a!.messages.length)).toEqual(a!.messages)
        expect(c!.messages.slice(0, b!.messages.length)).toEqual(b!.messages)
        expect(JSON.stringify(c)).not.toContain(boundary)
        const tool = c!.messages.find(m => m.tool_calls)
        const answer = c!.messages.find(m => typeof m.content === 'string' && m.content.endsWith('Done.'))
        if (provider === 'minimax') {
          expect(tool?.content).toBe('<think>Inspect first.</think>Checking.')
          expect(answer?.content).toBe('<think>Done thinking.</think>Done.')
        } else {
          expect(tool?.reasoning_content).toBe('Inspect first.')
          expect(answer?.reasoning_content).toBe('Done thinking.')
        }
        expect(c!.messages[c!.messages.indexOf(tool!) + 1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
      }
    } finally { globalThis.fetch = original; lane.unregisterProvider(provider) }
  })
}

test('catalog refresh discovers future models, persists metadata, and ignores malformed rows', async () => {
  const original = globalThis.fetch
  const payload = { moonshotai: { models: {
    'kimi-k4': { name: 'Kimi K4', limit: { context: 2_000_000, output: 200_000 }, modalities: { input: ['text'], output: ['text'] }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'max'] }], release_date: '2027-01-01' },
    broken: { limit: { context: -1, output: 1 } },
  } } }
  expect(Object.keys(deriveDirectCatalog(payload).moonshotai!)).toEqual(['kimi-k4'])
  try {
    delete process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG
    globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch
    await warmDirectProviderCatalog()
    expect(getDirectModelMeta('moonshot', 'kimi-k4')?.contextWindow).toBe(2_000_000)
    expect(directEffortLevels('moonshot', 'kimi-k4')).toEqual(['low', 'max'])
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    await warmDirectProviderCatalog()
    expect(getDirectModelMeta('moonshot', 'kimi-k4')?.contextWindow).toBe(2_000_000)
  } finally { globalThis.fetch = original; process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG = '1' }
})

test('a saved catalog answers /models without waiting on a models.dev refresh', async () => {
  const original = globalThis.fetch
  const store = process.env.TAU_DIRECT_MODEL_CATALOG_STORE
  let release: ((response: Response) => void) | undefined
  try {
    process.env.TAU_DIRECT_MODEL_CATALOG_STORE = join(temp, 'saved-models.json')
    writeFileSync(process.env.TAU_DIRECT_MODEL_CATALOG_STORE, JSON.stringify({
      version: 1,
      fetchedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
      catalog: { deepseek: { 'deepseek-v4-pro': {
        name: 'Saved V4 Pro', contextWindow: 900_000, maxOutputTokens: 384_000, reasoning: true,
        toggle: true, efforts: ['high', 'max'], released: '2026-08-12', vision: false, tools: true,
      } } },
    }))
    delete process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG
    // models.dev answers only when released, so a listing that waited on it would hang.
    globalThis.fetch = (async (url: RequestInfo | URL) => String(url).includes('models.dev')
      ? new Promise<Response>(resolve => { release = resolve })
      : Response.json({ data: [{ id: 'deepseek-v4-pro' }] })) as unknown as typeof fetch
    const rows = await listDirectProviderModels('deepseek', 'https://api.deepseek.com/v1', {})
    expect(rows.map(m => [m.id, m.name, m.contextWindow])).toEqual([['deepseek-v4-pro', 'Saved V4 Pro', 900_000]])
    expect(release).toBeDefined()
  } finally {
    release?.(new Response('', { status: 503 }))
    await warmDirectProviderCatalog()
    globalThis.fetch = original
    process.env.TAU_DIRECT_MODEL_CATALOG_STORE = store
    process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG = '1'
  }
})

test('a first run with nothing saved still waits for models.dev before listing', async () => {
  const original = globalThis.fetch
  const store = process.env.TAU_DIRECT_MODEL_CATALOG_STORE
  try {
    process.env.TAU_DIRECT_MODEL_CATALOG_STORE = join(temp, 'first-run-models.json')
    delete process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG
    const payload = { deepseek: { models: { 'deepseek-v5': {
      name: 'DeepSeek V5', limit: { context: 2_000_000, output: 64_000 },
      modalities: { input: ['text'], output: ['text'] }, reasoning: true, tool_call: true, release_date: '2026-12-01',
    } } } }
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (!String(url).includes('models.dev')) return Response.json({ data: [{ id: 'deepseek-v5' }] })
      await new Promise(resolve => setTimeout(resolve, 50))
      return Response.json(payload)
    }) as unknown as typeof fetch
    const rows = await listDirectProviderModels('deepseek', 'https://api.deepseek.com/v1', {})
    expect(rows.map(m => [m.id, m.name, m.contextWindow])).toEqual([['deepseek-v5', 'DeepSeek V5', 2_000_000]])
  } finally {
    globalThis.fetch = original
    process.env.TAU_DIRECT_MODEL_CATALOG_STORE = store
    process.env.TAU_DISABLE_DIRECT_MODEL_CATALOG = '1'
  }
})
