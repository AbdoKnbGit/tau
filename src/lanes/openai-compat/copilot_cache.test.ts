/**
 * Copilot cache-affinity infrastructure tests.
 *
 * Run: bun run src/lanes/openai-compat/copilot_cache.test.ts
 */

import { OpenAICompatLane } from './loop.js'
import { LaneBackedProvider } from '../provider-bridge.js'
import type { AnthropicStreamEvent, ProviderMessage } from '../../services/api/providers/base_provider.js'

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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

type CapturedRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, any>
}

async function captureCopilotRequest(
  sessionId?: string,
  messages: ProviderMessage[] = [{ role: 'user', content: 'hello' }],
): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('copilot', 'copilot-token', 'https://api.githubcopilot.com')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'gpt-5.2',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'gpt-5.2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: {
            cached_tokens: 70,
            cache_write_tokens: 20,
          },
        },
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
      model: 'gpt-5.2',
      messages,
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId,
      providerHint: 'copilot',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('copilot')
  }
}

async function captureMistralRequest(sessionId?: string): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('mistral', 'mistral-token', 'https://api.mistral.ai/v1')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-mistral-test',
        object: 'chat.completion.chunk',
        model: 'mistral-large-latest',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-mistral-test',
        object: 'chat.completion.chunk',
        model: 'mistral-large-latest',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 128,
          completion_tokens: 5,
          total_tokens: 133,
          prompt_tokens_details: {
            cached_tokens: 64,
          },
        },
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
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId,
      providerHint: 'mistral',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('mistral')
  }
}

async function captureMoonshotRequest(sessionId?: string): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('moonshot', 'moonshot-token', 'https://api.moonshot.ai/v1')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-moonshot-test',
        object: 'chat.completion.chunk',
        model: 'kimi-k2.6',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-moonshot-test',
        object: 'chat.completion.chunk',
        model: 'kimi-k2.6',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 160,
          completion_tokens: 5,
          total_tokens: 165,
          cached_tokens: 96,
        },
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
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId,
      providerHint: 'moonshot',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('moonshot')
  }
}

async function captureFireworksRequest(
  sessionId?: string,
  throughBridge = false,
): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('fireworks', 'fireworks-token', 'https://api.fireworks.ai/inference/v1')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-fireworks',
        object: 'chat.completion.chunk',
        model: 'accounts/fireworks/models/minimax-m2p7',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-fireworks',
        object: 'chat.completion.chunk',
        model: 'accounts/fireworks/models/minimax-m2p7',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205 },
        // Fireworks reports cache hits only via perf_metrics for streaming.
        perf_metrics: { 'cached-prompt-tokens': 160 },
      },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'

    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = throughBridge
      ? await new LaneBackedProvider(lane, 'fireworks').stream({
          model: 'accounts/fireworks/models/minimax-m2p7',
          messages: [{ role: 'user', content: 'hello' }],
          system: 'stable system prompt',
          tools: [],
          max_tokens: 128,
          ...(sessionId ? { sessionId } : {}),
        } as any)
      : lane.streamAsProvider({
          model: 'accounts/fireworks/models/minimax-m2p7',
          messages: [{ role: 'user', content: 'hello' }],
          system: 'stable system prompt',
          tools: [],
          max_tokens: 128,
          signal: new AbortController().signal,
          sessionId,
          providerHint: 'fireworks',
        })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('fireworks')
  }
}

async function captureOpenRouterRequestWithSessionId(
  cacheRetention?: string,
  usage: Record<string, any> = {
    prompt_tokens: 100,
    completion_tokens: 7,
    total_tokens: 107,
    prompt_tokens_details: {
      cached_tokens: 80,
      cache_write_tokens: 30,
    },
  },
): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const oldClaudexRetention = process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION
  const oldOpenRouterRetention = process.env.OPENROUTER_CACHE_RETENTION
  if (cacheRetention === undefined) {
    delete process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION
    delete process.env.OPENROUTER_CACHE_RETENTION
  } else {
    process.env.CLAUDEX_OPENROUTER_CACHE_RETENTION = cacheRetention
    delete process.env.OPENROUTER_CACHE_RETENTION
  }

  const lane = new OpenAICompatLane()
  lane.registerProvider('openrouter', 'openrouter-token', 'https://openrouter.ai/api/v1')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'meta-llama/llama-3.3-70b-instruct',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'meta-llama/llama-3.3-70b-instruct',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
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
      model: 'meta-llama/llama-3.3-70b-instruct',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: 'openrouter',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('openrouter')
    restoreEnv('CLAUDEX_OPENROUTER_CACHE_RETENTION', oldClaudexRetention)
    restoreEnv('OPENROUTER_CACHE_RETENTION', oldOpenRouterRetention)
  }
}

type AgentRouterUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
  }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

async function captureAgentRouterRequest(
  sessionId?: string,
  usage: AgentRouterUsage = {
    prompt_tokens: 100,
    completion_tokens: 9,
    total_tokens: 109,
    prompt_tokens_details: { cached_tokens: 75, cache_write_tokens: 25 },
  },
): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('agentrouter', 'agentrouter-token', 'https://agentrouter.org/v1')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-agentrouter',
        object: 'chat.completion.chunk',
        model: 'claude-haiku-4-5-20251001',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-agentrouter',
        object: 'chat.completion.chunk',
        model: 'claude-haiku-4-5-20251001',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
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
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId,
      providerHint: 'agentrouter',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('agentrouter')
  }
}

async function captureModelRouterRequest(
  model = 'claude-3-5-haiku',
  usage: AgentRouterUsage = {
    prompt_tokens: 100,
    completion_tokens: 9,
    total_tokens: 109,
    cache_read_input_tokens: 75,
    cache_creation_input_tokens: 10,
  },
): Promise<{
  request: CapturedRequest
  events: AnthropicStreamEvent[]
}> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('modelrouter', 'modelrouter-token', 'https://api.lxg2it.com/v1')

  const oldFetch = globalThis.fetch
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }
    const sse = [
      {
        id: 'chatcmpl-modelrouter',
        object: 'chat.completion.chunk',
        model: request.body.model,
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-modelrouter',
        object: 'chat.completion.chunk',
        model: request.body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-model-router-model': request.body.model,
        'x-model-router-provider': 'anthropic',
      },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      system: 'stable system prompt',
      tools: [],
      max_tokens: 128,
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: 'modelrouter',
    })

    for await (const ev of stream) events.push(ev)
    assert(request !== null, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('modelrouter')
  }
}

async function main(): Promise<void> {
  console.log('openai-compat cache affinity:')

  await test('sends prompt_cache_key and affinity headers from session id', async () => {
    const { request } = await captureCopilotRequest('session-fixed')
    assert(request.url === 'https://api.githubcopilot.com/chat/completions', `url=${request.url}`)
    assert(request.body.prompt_cache_key === 'session-fixed', `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.headers.session_id === 'session-fixed', `session_id=${request.headers.session_id}`)
    assert(request.headers['x-client-request-id'] === 'session-fixed',
      `x-client-request-id=${request.headers['x-client-request-id']}`)
    assert(request.headers['x-session-affinity'] === 'session-fixed',
      `x-session-affinity=${request.headers['x-session-affinity']}`)
  })

  await test('does not send cache key when session id is absent', async () => {
    const { request } = await captureCopilotRequest()
    assert(request.body.prompt_cache_key === undefined, `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.headers.session_id === undefined, `session_id=${request.headers.session_id}`)
  })

  await test('splits cache read and cache write usage buckets', async () => {
    const { events } = await captureCopilotRequest('session-fixed')
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    assert(finalDelta?.usage?.input_tokens === 30, `input_tokens=${finalDelta?.usage?.input_tokens}`)
    assert(finalDelta?.usage?.cache_read_input_tokens === 50,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === 20,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
  })

  await test('mistral sends prompt_cache_key from session id', async () => {
    const { request } = await captureMistralRequest('session-fixed')
    assert(request.url === 'https://api.mistral.ai/v1/chat/completions', `url=${request.url}`)
    assert(request.body.prompt_cache_key === 'session-fixed',
      `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.prompt_cache_retention === undefined,
      `prompt_cache_retention=${request.body.prompt_cache_retention}`)
    const serialized = JSON.stringify(request.body.messages)
    assert(!serialized.includes('cache_control'), `cache_control leaked into Mistral request: ${serialized}`)
  })

  await test('mistral maps cached_tokens into cache read usage', async () => {
    const { events } = await captureMistralRequest('session-fixed')
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    assert(finalDelta?.usage?.input_tokens === 64, `input_tokens=${finalDelta?.usage?.input_tokens}`)
    assert(finalDelta?.usage?.cache_read_input_tokens === 64,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === undefined,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
  })

  await test('moonshot sends prompt_cache_key from session id', async () => {
    const { request } = await captureMoonshotRequest('session-fixed')
    assert(request.url === 'https://api.moonshot.ai/v1/chat/completions', `url=${request.url}`)
    assert(request.body.prompt_cache_key === 'session-fixed',
      `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.prompt_cache_retention === undefined,
      `prompt_cache_retention=${request.body.prompt_cache_retention}`)
  })

  await test('moonshot maps top-level cached_tokens into cache read usage', async () => {
    const { events } = await captureMoonshotRequest('session-fixed')
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    assert(finalDelta?.usage?.input_tokens === 64, `input_tokens=${finalDelta?.usage?.input_tokens}`)
    assert(finalDelta?.usage?.cache_read_input_tokens === 96,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === undefined,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
  })

  await test('repairs unresolved tool calls before sending Copilot request', async () => {
    const { request } = await captureCopilotRequest('session-fixed', [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_compat_call_answered', name: 'Read', input: {} },
          { type: 'tool_use', id: 'toolu_compat_call_missing', name: 'Grep', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_compat_call_answered', content: 'ok' },
        ],
      },
      { role: 'user', content: 'continue' },
    ])

    const assistant = request.body.messages.find((message: any) => message.role === 'assistant')
    const toolMessages = request.body.messages.filter((message: any) => message.role === 'tool')
    assert(assistant?.tool_calls?.length === 1,
      `tool_calls=${JSON.stringify(assistant?.tool_calls)}`)
    assert(assistant.tool_calls[0].id === 'toolu_compat_call_answered',
      `tool_call_id=${assistant.tool_calls[0].id}`)
    assert(toolMessages.length === 1, `tool_messages=${JSON.stringify(toolMessages)}`)
    assert(toolMessages[0].tool_call_id === 'toolu_compat_call_answered',
      `tool_call_id=${toolMessages[0].tool_call_id}`)
  })

  await test('fireworks pins replica via x-session-affinity header + user field', async () => {
    const { request } = await captureFireworksRequest('session-fixed')
    assert(request.url === 'https://api.fireworks.ai/inference/v1/chat/completions', `url=${request.url}`)
    // The routing-affinity header is THE fix for unstable cache hits: it keeps
    // every turn on the same warm replica (Fireworks' cache is per-replica).
    assert(request.headers['x-session-affinity'] === 'session-fixed',
      `x-session-affinity=${request.headers['x-session-affinity']}`)
    // Body-level fallback for the same routing purpose.
    assert(request.body.user === 'session-fixed', `user=${request.body.user}`)
    // prompt_cache_key (prefix isolation) + perf_metrics flag still present.
    assert(request.body.prompt_cache_key === 'session-fixed',
      `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.perf_metrics_in_response === true,
      `perf_metrics_in_response=${request.body.perf_metrics_in_response}`)
  })

  await test('fireworks real provider bridge preserves affinity into the HTTP request', async () => {
    const { request } = await captureFireworksRequest(undefined, true)
    const affinity = request.headers['x-session-affinity']
    assert(typeof affinity === 'string' && affinity.length > 0,
      `x-session-affinity=${affinity}`)
    assert(request.body.user === affinity, `user=${request.body.user}`)
    assert(request.body.prompt_cache_key === affinity,
      `prompt_cache_key=${request.body.prompt_cache_key}`)
  })

  await test('fireworks omits affinity hints when sessionId is absent', async () => {
    const { request } = await captureFireworksRequest()
    assert(request.headers['x-session-affinity'] === undefined,
      `x-session-affinity=${request.headers['x-session-affinity']}`)
    assert(request.body.user === undefined, `user=${request.body.user}`)
    assert(request.body.prompt_cache_key === undefined,
      `prompt_cache_key=${request.body.prompt_cache_key}`)
  })

  await test('fireworks folds perf_metrics cached-prompt-tokens into cache read', async () => {
    const { events } = await captureFireworksRequest('session-fixed')
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    // prompt=200, cached=160 → fresh input=40, read=160.
    assert(finalDelta?.usage?.input_tokens === 40, `input_tokens=${finalDelta?.usage?.input_tokens}`)
    assert(finalDelta?.usage?.cache_read_input_tokens === 160,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
  })

  await test('sends OpenRouter cache key without Copilot affinity headers', async () => {
    const { request } = await captureOpenRouterRequestWithSessionId()
    const sessionKey = 'session-fixed:meta-llama/llama-3.3-70b-instruct'
    assert(request.body.session_id === sessionKey, `session_id=${request.body.session_id}`)
    assert(request.body.prompt_cache_key === sessionKey, `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.prompt_cache_retention === undefined,
      `prompt_cache_retention=${request.body.prompt_cache_retention}`)
    assert(request.headers['x-session-id'] === sessionKey, `x-session-id=${request.headers['x-session-id']}`)
    assert(request.headers.session_id === undefined, `session_id=${request.headers.session_id}`)
    assert(request.headers['x-client-request-id'] === undefined,
      `x-client-request-id=${request.headers['x-client-request-id']}`)
    assert(request.headers['x-session-affinity'] === undefined,
      `x-session-affinity=${request.headers['x-session-affinity']}`)
  })

  await test('normalizes OpenRouter cache read and write usage', async () => {
    const { events } = await captureOpenRouterRequestWithSessionId()
    const usageDelta = events.find((ev: any) =>
      ev.type === 'message_delta' && ev.usage?.output_tokens === 7
    ) as any
    assert(usageDelta !== undefined, `events=${JSON.stringify(events)}`)
    assert(usageDelta.usage.input_tokens === 20, `input_tokens=${usageDelta.usage.input_tokens}`)
    assert(usageDelta.usage.cache_read_input_tokens === 50,
      `cache_read_input_tokens=${usageDelta.usage.cache_read_input_tokens}`)
    assert(usageDelta.usage.cache_creation_input_tokens === 30,
      `cache_creation_input_tokens=${usageDelta.usage.cache_creation_input_tokens}`)
  })

  await test('normalizes OpenRouter explicit cache_read_tokens usage', async () => {
    const { events } = await captureOpenRouterRequestWithSessionId(undefined, {
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: {
        cache_read_tokens: 60,
        cache_write_tokens: 10,
      },
    })
    const usageDelta = events.find((ev: any) =>
      ev.type === 'message_delta' && ev.usage?.output_tokens === 7
    ) as any
    assert(usageDelta !== undefined, `events=${JSON.stringify(events)}`)
    assert(usageDelta.usage.input_tokens === 30, `input_tokens=${usageDelta.usage.input_tokens}`)
    assert(usageDelta.usage.cache_read_input_tokens === 60,
      `cache_read_input_tokens=${usageDelta.usage.cache_read_input_tokens}`)
    assert(usageDelta.usage.cache_creation_input_tokens === 10,
      `cache_creation_input_tokens=${usageDelta.usage.cache_creation_input_tokens}`)
  })

  await test('can opt OpenRouter into long cache retention', async () => {
    const { request } = await captureOpenRouterRequestWithSessionId('long')
    assert(request.body.prompt_cache_key === 'session-fixed:meta-llama/llama-3.3-70b-instruct', `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.prompt_cache_retention === '24h',
      `prompt_cache_retention=${request.body.prompt_cache_retention}`)
  })

  await test('agentrouter sends prompt_cache_key + usage flag for Claude rows', async () => {
    const { request } = await captureAgentRouterRequest('session-fixed')
    assert(request.url === 'https://agentrouter.org/v1/chat/completions', `url=${request.url}`)
    assert(request.body.prompt_cache_key === 'session-fixed',
      `prompt_cache_key=${request.body.prompt_cache_key}`)
    assert(request.body.usage?.include === true,
      `usage.include=${JSON.stringify(request.body.usage)}`)
    // No Copilot-style affinity headers — those are gateway-specific.
    assert(request.headers.session_id === undefined, `session_id=${request.headers.session_id}`)
    assert(request.headers['x-session-affinity'] === undefined,
      `x-session-affinity=${request.headers['x-session-affinity']}`)
  })

  await test('agentrouter stamps cache_control on Claude rows (rolling 3-breakpoint)', async () => {
    const { request } = await captureAgentRouterRequest('session-fixed')
    const sys = request.body.messages.find((m: any) => m.role === 'system')
    assert(Array.isArray(sys?.content), `system content not promoted to parts: ${JSON.stringify(sys?.content)}`)
    const lastSystemPart = sys.content[sys.content.length - 1]
    assert(lastSystemPart?.cache_control?.type === 'ephemeral',
      `system last part missing cache_control: ${JSON.stringify(lastSystemPart)}`)
    const user = request.body.messages.find((m: any) => m.role === 'user')
    assert(Array.isArray(user?.content), `user content not promoted to parts: ${JSON.stringify(user?.content)}`)
    const lastUserPart = user.content[user.content.length - 1]
    assert(lastUserPart?.cache_control?.type === 'ephemeral',
      `user last part missing cache_control: ${JSON.stringify(lastUserPart)}`)
  })

  await test('agentrouter omits prompt_cache_key when sessionId is absent', async () => {
    const { request } = await captureAgentRouterRequest()
    assert(request.body.prompt_cache_key === undefined,
      `prompt_cache_key=${request.body.prompt_cache_key}`)
  })

  await test('agentrouter splits cache read and cache write usage buckets', async () => {
    const { events } = await captureAgentRouterRequest('session-fixed')
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    // prompt=100, cached=75, cache_write=25 → fresh=25, read=50, write=25.
    assert(finalDelta?.usage?.input_tokens === 25,
      `input_tokens=${finalDelta?.usage?.input_tokens}`)
    assert(finalDelta?.usage?.cache_read_input_tokens === 50,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === 25,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
  })

  await test('agentrouter reads Anthropic-native usage shape (cache_read/creation_input_tokens)', async () => {
    // The gateway forwards Anthropic responses verbatim, so usage often
    // arrives as additive cache_read_input_tokens + cache_creation_input_tokens
    // alongside the OpenAI-style prompt_tokens total. Without the fold the
    // user saw cache_hit=0% even on warm sessions where latency had clearly
    // dropped.
    const { events } = await captureAgentRouterRequest('session-fixed', {
      prompt_tokens: 700_000,
      completion_tokens: 4_661,
      total_tokens: 704_661,
      cache_read_input_tokens: 600_000,
      cache_creation_input_tokens: 50_000,
    })
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    // 700k total = 50k fresh + 600k read + 50k write.
    assert(finalDelta?.usage?.input_tokens === 50_000,
      `input_tokens=${finalDelta?.usage?.input_tokens}`)
    assert(finalDelta?.usage?.cache_read_input_tokens === 600_000,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === 50_000,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
  })

  await test('agentrouter Anthropic-native fields override OpenAI-style cached_tokens=0', async () => {
    // Real-world failure mode: the gateway sets cached_tokens=0 (so the
    // OpenAI-style parse comes up empty) but still emits the Anthropic
    // additive fields. The fold has to win in that conflict.
    const { events } = await captureAgentRouterRequest('session-fixed', {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 0 },
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    })
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    assert(finalDelta?.usage?.cache_read_input_tokens === 60,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === 10,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
    assert(finalDelta?.usage?.input_tokens === 30,
      `input_tokens=${finalDelta?.usage?.input_tokens}`)
  })

  await test('modelrouter sends exact pinned model instead of legacy alias', async () => {
    const { request } = await captureModelRouterRequest('claude-3-5-haiku')
    assert(request.url === 'https://api.lxg2it.com/v1/chat/completions', `url=${request.url}`)
    assert(request.body.model === 'claude-haiku-4-5', `model=${request.body.model}`)
    assert(request.body.prefer === undefined, `prefer=${request.body.prefer}`)
  })

  await test('modelrouter maps gpt-oss-120b to exact Bedrock pin', async () => {
    const { request } = await captureModelRouterRequest('gpt-oss-120b')
    assert(request.body.model === 'openai.gpt-oss-120b-1:0', `model=${request.body.model}`)
    assert(request.body.prefer === undefined, `prefer=${request.body.prefer}`)
  })

  await test('modelrouter stamps cache_control on Anthropic pins', async () => {
    const { request } = await captureModelRouterRequest('claude-3-5-haiku')
    const sys = request.body.messages.find((m: any) => m.role === 'system')
    assert(Array.isArray(sys?.content), `system content not promoted to parts: ${JSON.stringify(sys?.content)}`)
    const lastSystemPart = sys.content[sys.content.length - 1]
    assert(lastSystemPart?.cache_control?.type === 'ephemeral',
      `system last part missing cache_control: ${JSON.stringify(lastSystemPart)}`)
    const user = request.body.messages.find((m: any) => m.role === 'user')
    assert(Array.isArray(user?.content), `user content not promoted to parts: ${JSON.stringify(user?.content)}`)
    const lastUserPart = user.content[user.content.length - 1]
    assert(lastUserPart?.cache_control?.type === 'ephemeral',
      `user last part missing cache_control: ${JSON.stringify(lastUserPart)}`)
  })

  await test('modelrouter reads Anthropic-native cache usage shape', async () => {
    const { events } = await captureModelRouterRequest('claude-3-5-haiku', {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 0 },
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    })
    const finalDelta = events.findLast(ev => ev.type === 'message_delta')
    assert(finalDelta?.usage?.cache_read_input_tokens === 60,
      `cache_read_input_tokens=${finalDelta?.usage?.cache_read_input_tokens}`)
    assert(finalDelta?.usage?.cache_creation_input_tokens === 10,
      `cache_creation_input_tokens=${finalDelta?.usage?.cache_creation_input_tokens}`)
    assert(finalDelta?.usage?.input_tokens === 30,
      `input_tokens=${finalDelta?.usage?.input_tokens}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
