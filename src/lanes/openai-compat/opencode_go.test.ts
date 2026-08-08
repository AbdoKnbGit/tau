/**
 * Focused OpenCode Go transport regressions.
 *
 * Run: bun run src/lanes/openai-compat/opencode_go.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APIConnectionError } from '@anthropic-ai/sdk'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { OpenAICompatLane } from './loop.js'

type CapturedRequest = {
  url: string
  headers: Record<string, string>
  rawBody: string
  body: Record<string, any>
}

async function captureRequest(
  model: string,
  provider: 'opencode' | 'opencodego' = 'opencodego',
): Promise<{ request: CapturedRequest; events: AnthropicStreamEvent[] }> {
  const lane = new OpenAICompatLane()
  const baseUrl = provider === 'opencodego'
    ? 'https://opencode.ai/zen/go/v1'
    : 'https://opencode.ai/zen/v1'
  lane.registerProvider(provider, 'test-opencode-key', baseUrl)

  const oldFetch = globalThis.fetch
  const oldClient = process.env.OPENCODE_CLIENT
  process.env.OPENCODE_CLIENT = 'opencode-tau/test'
  let request: CapturedRequest | null = null

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    request = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      rawBody: String(init?.body ?? ''),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
    }

    if (String(url).endsWith('/messages')) {
      const sse = [
        'event: message_start',
        `data: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: 'msg_go_qwen',
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        })}`,
        '',
        'event: content_block_start',
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })}`,
        '',
        'event: content_block_delta',
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        })}`,
        '',
        'event: content_block_stop',
        `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        '',
        'event: message_delta',
        `data: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        })}`,
        '',
        'event: message_stop',
        `data: ${JSON.stringify({ type: 'message_stop' })}`,
        '',
        '',
      ].join('\n')
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    const chunks = [
      {
        id: 'chatcmpl_go_glm',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_go_glm',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    ]
    const sse = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
      + 'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch

  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model,
      messages: [{ role: 'user', content: 'hey' }],
      system: 'You are a coding agent.',
      tools: [],
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 512 },
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: provider,
    })
    for await (const event of stream) events.push(event)
    assert(request, 'fetch was not called')
    return { request, events }
  } finally {
    globalThis.fetch = oldFetch
    if (oldClient === undefined) delete process.env.OPENCODE_CLIENT
    else process.env.OPENCODE_CLIENT = oldClient
    lane.unregisterProvider(provider)
  }
}

async function main(): Promise<void> {
  // Isolate the OpenCode effort store so a developer's real ~/.claude store
  // (which may now carry a GLM-5.2 effort) can't perturb the default-effort
  // GLM assertions below.
  process.env.TAU_OPENCODE_THINKING_STORE = join(
    mkdtempSync(join(tmpdir(), 'tau-opencode-go-')),
    'store.json',
  )

  const qwen = await captureRequest('qwen3.7-max')
  assert.equal(qwen.request.url, 'https://opencode.ai/zen/go/v1/messages')
  assert.equal(qwen.request.headers['x-api-key'], 'test-opencode-key')
  assert.equal(qwen.request.headers.Authorization, undefined)
  assert.equal(qwen.request.body.thinking, undefined)
  assert.equal(qwen.request.body.reasoning, undefined)
  assert.equal(qwen.request.body.reasoning_effort, undefined)
  // Explicit cache_control breakpoints: system tail + last messages. The
  // alibaba upstream only caches when these markers are present.
  assert.deepEqual(qwen.request.body.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'hey', cache_control: { type: 'ephemeral' } }],
  }])
  assert.deepEqual(qwen.request.body.system, [{
    type: 'text',
    text: 'You are a coding agent.',
    cache_control: { type: 'ephemeral' },
  }])
  assert(qwen.events.some(event =>
    event.type === 'content_block_delta'
    && event.delta.type === 'text_delta'
    && event.delta.text === 'ok'))

  // qwen3.6-plus takes the same Anthropic route on Go AND on Zen — the row
  // only caches there (thinking is per-user effort store, so not asserted).
  const qwen36 = await captureRequest('qwen3.6-plus')
  assert.equal(qwen36.request.url, 'https://opencode.ai/zen/go/v1/messages')
  assert.deepEqual(qwen36.request.body.messages[0].content[0].cache_control, { type: 'ephemeral' })

  const qwen36Zen = await captureRequest('qwen3.6-plus', 'opencode')
  assert.equal(qwen36Zen.request.url, 'https://opencode.ai/zen/v1/messages')
  assert.deepEqual(qwen36Zen.request.body.system[0].cache_control, { type: 'ephemeral' })

  // Transient upstream 500s ("InternalError: Request timed out.") on the
  // /messages route must be retried, not surfaced — live-measured ~1-in-8
  // failure rate that recovers on immediate retry.
  {
    const lane = new OpenAICompatLane()
    lane.registerProvider('opencodego', 'test-opencode-key', 'https://opencode.ai/zen/go/v1')
    const oldFetch = globalThis.fetch
    const oldClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = 'opencode-tau/test'
    let calls = 0
    globalThis.fetch = (async (): Promise<Response> => {
      calls += 1
      if (calls === 1) {
        return new Response(
          'event:error\ndata:{"code":"InternalError","message":"Request timed out.","request_id":"probe"}\n\n',
          { status: 500, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      const sse = [
        `data: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: 'msg_retry', type: 'message', role: 'assistant', content: [],
            model: 'qwen3.6-plus', stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        })}`,
        '',
        `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        '',
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}`,
        '',
        `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
        '',
        `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })}`,
        '',
        `data: ${JSON.stringify({ type: 'message_stop' })}`,
        '',
        '',
      ].join('\n')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const events: AnthropicStreamEvent[] = []
      const stream = lane.streamAsProvider({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hey' }],
        system: 'You are a coding agent.',
        tools: [],
        max_tokens: 64,
        thinking: { type: 'enabled', budget_tokens: 512 },
        signal: new AbortController().signal,
        sessionId: 'session-fixed',
        providerHint: 'opencodego',
      })
      for await (const event of stream) events.push(event)
      assert.equal(calls, 2, 'expected exactly one retry after the transient 500')
      const text = events
        .filter(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta')
        .map((event: any) => event.delta.text)
        .join('')
      assert(text.includes('ok'), 'expected model text after retry')
      assert(!text.includes('500'), 'transient 500 must not leak into the conversation')
    } finally {
      globalThis.fetch = oldFetch
      if (oldClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = oldClient
      lane.unregisterProvider('opencodego')
    }
  }

  // A connection failure must escape the lane as a retryable exception. The
  // shared retry controller then repeats the identical provider turn instead
  // of persisting an assistant error and requiring a cache-shifting "continue".
  {
    const lane = new OpenAICompatLane()
    lane.registerProvider('opencode', 'test-opencode-key', 'https://opencode.ai/zen/v1')
    const oldFetch = globalThis.fetch
    const oldClient = process.env.OPENCODE_CLIENT
    process.env.OPENCODE_CLIENT = 'opencode-tau/test'
    const requests: CapturedRequest[] = []
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        rawBody: String(init?.body ?? ''),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any>,
      })
      if (requests.length === 1) throw new TypeError('fetch failed')

      const chunks = [
        {
          id: 'chatcmpl_connection_retry',
          object: 'chat.completion.chunk',
          model: 'glm-5.2',
          choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl_connection_retry',
          object: 'chat.completion.chunk',
          model: 'glm-5.2',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      ]
      const sse = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
        + 'data: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      let connectionError: unknown
      let events: AnthropicStreamEvent[] | undefined
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const attemptEvents: AnthropicStreamEvent[] = []
          const stream = lane.streamAsProvider({
            model: 'glm-5.2',
            messages: [{ role: 'user', content: 'keep the prefix stable' }],
            system: 'You are a coding agent.',
            tools: [],
            max_tokens: 1024,
            thinking: { type: 'disabled' },
            signal: new AbortController().signal,
            sessionId: 'session-fixed',
            providerHint: 'opencode',
          })
          for await (const event of stream) attemptEvents.push(event)
          // Assign only the successful attempt; the failed transport must
          // not have emitted a synthetic assistant error into history.
          events = attemptEvents
          break
        } catch (error) {
          connectionError = error
        }
      }

      assert(connectionError instanceof APIConnectionError, 'connection failure must be retryable')
      assert.match(connectionError.message, /opencode API connection error: fetch failed/)
      assert.equal(requests.length, 2, 'expected a retry to issue the same provider turn')
      assert.equal(requests[1]!.rawBody, requests[0]!.rawBody, 'retry must keep the prompt body byte-stable')
      assert.equal(requests[0]!.headers['x-opencode-session'], 'session-fixed')
      assert.equal(requests[1]!.headers['x-opencode-session'], 'session-fixed')
      assert.equal(requests[0]!.headers['x-opencode-request'], requests[1]!.headers['x-opencode-request'])
      const text = events
        .filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
        .map((event: any) => event.delta.text)
        .join('')
      assert.equal(text, 'recovered')
    } finally {
      globalThis.fetch = oldFetch
      if (oldClient === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = oldClient
      lane.unregisterProvider('opencode')
    }
  }

  const glm = await captureRequest('glm-5.2')
  assert.equal(glm.request.url, 'https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(glm.request.body.thinking, undefined)
  assert.equal(glm.request.body.reasoning, undefined)
  assert.equal(glm.request.body.reasoning_effort, undefined)
  assert.equal(glm.request.body.enable_thinking, undefined)
  assert.equal(glm.request.body.chat_template_args, undefined)
  // glm-5.2's strict upstream 400s on the non-standard `usage` field
  // ("Extra inputs are not permitted, field: 'usage'"), so the Go transformer
  // drops it (the standard stream_options.include_usage still carries usage).
  assert.equal(glm.request.body.usage, undefined)

  console.log('OpenCode Go focused transport tests passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
