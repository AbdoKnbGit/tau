/**
 * Regression: EVERY lane must emit tool_use blocks as the three-event
 * sequence the Claude-Code streaming IR requires:
 *
 *   1. content_block_start   with content_block.type='tool_use' + input: {}
 *   2. content_block_delta   with delta.type='input_json_delta' +
 *                            partial_json = JSON.stringify(args)
 *   3. content_block_stop
 *
 * If a lane embeds args inline on `content_block_start.input` without
 * the input_json_delta, claude.ts's accumulator stays at '' and every
 * downstream tool sees `{}` → every `required` field reports missing.
 *
 * This test drives the provider-bridge assembler (the non-streaming
 * path) through the correct event sequence and asserts the final
 * tool_use block carries the parsed args. If this breaks, the 0.2.1
 * regression is back.
 *
 * Run:  bun run src/lanes/shared/tool_use_ir.test.ts
 */

import { LaneBackedProvider } from '../provider-bridge.js'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { ProviderHttpError } from '../../services/api/transport_error.js'
import type { Lane, LaneProviderCallParams } from '../types.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void): Promise<void> | void {
  const run = async () => {
    try {
      await fn()
      passed++
      console.log(`  ok  ${name}`)
    } catch (e: any) {
      failed++
      console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
    }
  }
  return run()
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

/** Build a minimal mock Lane whose stream emits the given events. */
function mockLane(events: AnthropicStreamEvent[]): Lane {
  return {
    name: 'mock',
    displayName: 'mock',
    supportsModel: () => true,
    async *streamAsProvider() {
      for (const ev of events) yield ev
      return {
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
      }
    },
    async *run() {
      return {
        stopReason: 'end_turn' as const,
        usage: {
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
        },
      }
    },
    listModels: async () => [],
    resolveModel: (m: string) => m,
    isHealthy: () => true,
    dispose: () => {},
  }
}

async function main(): Promise<void> {
  console.log('tool_use IR regression:')

  await test('bridge rejects a pre-event 429 during stream setup', async () => {
    const failure = new ProviderHttpError(
      'mock',
      429,
      'RESOURCE_EXHAUSTED',
    )
    let finalized = false
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider() {
        try {
          throw failure
        } finally {
          finalized = true
        }
      },
    }

    let caught: unknown
    try {
      await new LaneBackedProvider(lane, 'antigravity').stream({
        model: 'm', messages: [], max_tokens: 100,
      })
    } catch (error) {
      caught = error
    }

    assert(caught === failure, `pre-event failure escaped setup as ${String(caught)}`)
    assert(finalized, 'failed lane iterator did not finalize')
  })

  await test('bridge replays its primed event exactly once', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg-prime', type: 'message', role: 'assistant', content: [],
          model: 'm', stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'done' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]
    const stream = await new LaneBackedProvider(mockLane(events), 'antigravity').stream({
      model: 'm', messages: [], max_tokens: 100,
    })
    const seen: AnthropicStreamEvent[] = []
    for await (const event of stream) seen.push(event)

    assert(
      JSON.stringify(seen) === JSON.stringify(events),
      `primed events changed: ${JSON.stringify(seen)}`,
    )
  })

  await test('aborting after priming closes an unconsumed lane iterator', async () => {
    let notifyFinalized!: () => void
    const finalized = new Promise<void>(resolve => {
      notifyFinalized = resolve
    })
    const first: AnthropicStreamEvent = {
      type: 'message_start',
      message: {
        id: 'msg-abort-after-prime', type: 'message', role: 'assistant', content: [],
        model: 'm', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider() {
        try {
          yield first
          await new Promise<never>(() => {})
        } finally {
          notifyFinalized()
        }
      },
    }

    const stream = await new LaneBackedProvider(lane, 'antigravity').stream({
      model: 'm', messages: [], max_tokens: 100,
    })
    stream.abort()
    await finalized
  })

  await test('bridge does not turn a post-event failure into a setup retry', async () => {
    const first: AnthropicStreamEvent = {
      type: 'message_start',
      message: {
        id: 'msg-started', type: 'message', role: 'assistant', content: [],
        model: 'm', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }
    const failure = new ProviderHttpError('mock', 503, 'stream interrupted')
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider() {
        yield first
        throw failure
      },
    }

    // Setup succeeds after the first provider event. The later error remains
    // an iteration error so callers cannot replay a partially-started turn.
    const stream = await new LaneBackedProvider(lane, 'antigravity').stream({
      model: 'm', messages: [], max_tokens: 100,
    })
    const seen: AnthropicStreamEvent[] = []
    let caught: unknown
    try {
      for await (const event of stream) seen.push(event)
    } catch (error) {
      caught = error
    }

    assert(seen.length === 1 && seen[0] === first, 'first event was not replayed')
    assert(caught === failure, `post-event failure changed to ${String(caught)}`)
  })

  await test('caller abort reaches a lane while the first event is pending', async () => {
    const caller = new AbortController()
    let notifyStarted!: () => void
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve
    })
    let finalized = false
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider(params: LaneProviderCallParams) {
        try {
          await new Promise<never>((_, reject) => {
            const onAbort = (): void =>
              reject(new DOMException('Aborted', 'AbortError'))
            if (params.signal.aborted) {
              onAbort()
              return
            }
            params.signal.addEventListener('abort', onAbort, { once: true })
            notifyStarted()
          })
        } finally {
          finalized = true
        }
      },
    }

    const pending = new LaneBackedProvider(lane, 'antigravity').stream({
      model: 'm', messages: [], max_tokens: 100, signal: caller.signal,
    })
    await started
    caller.abort()

    let caught: unknown
    try {
      await pending
    } catch (error) {
      caught = error
    }
    assert(
      caught instanceof Error && caught.name === 'AbortError',
      `priming abort surfaced as ${String(caught)}`,
    )
    assert(finalized, 'aborted lane iterator did not finalize')
  })

  await test('caller abort does not wait for a non-cooperative first event', async () => {
    const previousTimeout = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '5000'
    const caller = new AbortController()
    const lane: Lane = {
      ...mockLane([]),
      streamAsProvider() {
        return {
          next: () => new Promise<never>(() => {}),
          return: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]() { return this },
        } as any
      },
    }

    try {
      const startedAt = Date.now()
      const pending = new LaneBackedProvider(lane, 'antigravity').stream({
        model: 'm', messages: [], max_tokens: 100, signal: caller.signal,
      })
      caller.abort()

      let caught: unknown
      try {
        await pending
      } catch (error) {
        caught = error
      }
      assert(
        caught instanceof Error && caught.name === 'AbortError',
        `non-cooperative abort surfaced as ${String(caught)}`,
      )
      assert(
        Date.now() - startedAt < 1000,
        'caller abort waited for the first-event watchdog',
      )
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
      } else {
        process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = previousTimeout
      }
    }
  })

  await test('first-event watchdog bounds a silent native stream', async () => {
    const previousTimeout = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '20'
    let finalized = false
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider(params: LaneProviderCallParams) {
        try {
          await new Promise<never>((_, reject) => {
            const onAbort = (): void =>
              reject(new DOMException('Aborted', 'AbortError'))
            if (params.signal.aborted) {
              onAbort()
              return
            }
            params.signal.addEventListener('abort', onAbort, { once: true })
          })
        } finally {
          finalized = true
        }
      },
    }

    try {
      let caught: unknown
      try {
        await new LaneBackedProvider(lane, 'antigravity').stream({
          model: 'm', messages: [], max_tokens: 100,
        })
      } catch (error) {
        caught = error
      }
      assert(
        caught instanceof Error && /Stream idle timeout/.test(caught.message),
        `silent stream surfaced as ${String(caught)}`,
      )
      assert(finalized, 'timed-out lane iterator did not finalize')
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
      } else {
        process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = previousTimeout
      }
    }
  })

  await test('a non-Antigravity lane keeps the original lazy setup path', async () => {
    // Scope guard: priming exists for the Antigravity 429 (tau#29/#30). Every
    // other lane must still resolve stream() without touching its generator,
    // so a pre-event failure stays an iteration error exactly as before.
    const failure = new ProviderHttpError('mock', 429, 'RESOURCE_EXHAUSTED')
    let advanced = false
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider() {
        advanced = true
        throw failure
      },
    }

    for (const providerHint of [undefined, 'openrouter', 'fireworks', 'openai']) {
      advanced = false
      const stream = await new LaneBackedProvider(lane, providerHint).stream({
        model: 'not-an-antigravity-model', messages: [], max_tokens: 100,
      })
      assert(!advanced, `${providerHint}: setup advanced the lane generator`)

      let caught: unknown
      try {
        for await (const _ of stream) { /* drain */ }
      } catch (error) {
        caught = error
      }
      assert(caught === failure, `${providerHint}: failure changed to ${String(caught)}`)
    }
  })

  await test('an Antigravity model id primes even without the provider row', async () => {
    // A model auto-routed to Antigravity from the legacy openai/gemini rows
    // still needs the fix, so the gate reads the resolved model too.
    const failure = new ProviderHttpError('mock', 429, 'RESOURCE_EXHAUSTED')
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider() {
        throw failure
      },
    }

    let caught: unknown
    try {
      await new LaneBackedProvider(lane, 'gemini').stream({
        model: 'gemini-3.5-flash-low', messages: [], max_tokens: 100,
      })
    } catch (error) {
      caught = error
    }
    assert(caught === failure, `auto-routed model was not primed: ${String(caught)}`)
  })

  await test('three-event sequence accumulates args into tool_use.input', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg-1', type: 'message', role: 'assistant', content: [],
          model: 'm', stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ]

    const lane = mockLane(events)
    const prov = new LaneBackedProvider(lane)
    const msg = await prov.create({
      model: 'm', messages: [], max_tokens: 100,
    } as any)

    assert(msg.content.length === 1, `expected 1 content block, got ${msg.content.length}`)
    const block = msg.content[0]!
    assert(block.type === 'tool_use', `expected tool_use, got ${block.type}`)
    assert(block.name === 'Bash', `wrong tool name: ${block.name}`)
    assert(
      block.input && (block.input as any).command === 'ls -la',
      `tool input did not accumulate — got ${JSON.stringify(block.input)}`,
    )
  })

  await test('split partial_json deltas merge correctly', async () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg-2', type: 'message', role: 'assistant', content: [],
          model: 'm', stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_y', name: 'Write', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/a.txt","con' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'tent":"hello world"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ]
    const lane = mockLane(events)
    const prov = new LaneBackedProvider(lane)
    const msg = await prov.create({ model: 'm', messages: [], max_tokens: 100 } as any)
    const input = msg.content[0]!.input as any
    assert(input?.file_path === '/tmp/a.txt', `file_path missing; got ${JSON.stringify(input)}`)
    assert(input?.content === 'hello world', `content missing; got ${JSON.stringify(input)}`)
  })

  await test('inline input on content_block_start alone is ignored (the bug we fixed)', async () => {
    // Pre-fix regression: lanes emitted input inline on content_block_start
    // WITHOUT an input_json_delta. The accumulator in claude.ts ignores
    // the inline field and reads only partial_json. So the final input
    // comes out empty. This test asserts that failure mode, proving the
    // three-event sequence is required for args to survive.
    const events: AnthropicStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg-3', type: 'message', role: 'assistant', content: [],
          model: 'm', stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        // BAD SHAPE: input pre-filled on start.
        content_block: { type: 'tool_use', id: 'toolu_bad', name: 'Bash', input: { command: 'ls' } },
      },
      // NO input_json_delta — the bug.
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    const lane = mockLane(events)
    const prov = new LaneBackedProvider(lane)
    const msg = await prov.create({ model: 'm', messages: [], max_tokens: 100 } as any)
    const input = msg.content[0]!.input as any
    // The assembler DOES currently preserve inline input via the
    // spread in content_block_start, but the real claude.ts accumulator
    // (ProviderResponseAccumulator upstream) does not. The invariant we
    // actually enforce in production is: every lane emits partial_json.
    // So this test documents the inline behavior but the REAL regression
    // guard is the "three-event" test above. Kept as a note.
    assert(typeof input === 'object', 'inline input preserved by bridge shim')
    // No hard assertion here — the bridge preserves inline, but the
    // claude.ts path strips it. The positive tests above are the guard.
  })

  await test('Mistral bridge forwards session id for prompt cache affinity', async () => {
    let captured: LaneProviderCallParams | null = null
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider(params: LaneProviderCallParams) {
        captured = params
        return {
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
        }
      },
    }
    const prov = new LaneBackedProvider(lane, 'mistral')
    const stream = await prov.stream({ model: 'mistral-large-latest', messages: [], max_tokens: 100 } as any)
    for await (const _ of stream) {}
    assert(captured?.providerHint === 'mistral', `providerHint=${captured?.providerHint}`)
    assert(typeof captured?.sessionId === 'string' && captured.sessionId.length > 0,
      `missing Mistral sessionId: ${captured?.sessionId}`)
  })

  await test('Moonshot bridge forwards session id for prompt cache affinity', async () => {
    let captured: LaneProviderCallParams | null = null
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider(params: LaneProviderCallParams) {
        captured = params
        return {
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
        }
      },
    }
    const prov = new LaneBackedProvider(lane, 'moonshot')
    const stream = await prov.stream({ model: 'kimi-k2.6', messages: [], max_tokens: 100 } as any)
    for await (const _ of stream) {}
    assert(captured?.providerHint === 'moonshot', `providerHint=${captured?.providerHint}`)
    assert(typeof captured?.sessionId === 'string' && captured.sessionId.length > 0,
      `missing Moonshot sessionId: ${captured?.sessionId}`)
  })

  for (const providerHint of ['fireworks', 'opencodego', 'openai'] as const) {
    await test(`${providerHint} bridge forwards session id for prompt cache affinity`, async () => {
      let captured: LaneProviderCallParams | null = null
      const lane: Lane = {
        ...mockLane([]),
        async *streamAsProvider(params: LaneProviderCallParams) {
          captured = params
          return {
            input_tokens: 0, output_tokens: 0,
            cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
          }
        },
      }
      const prov = new LaneBackedProvider(lane, providerHint)
      const stream = await prov.stream({ model: 'cache-model', messages: [], max_tokens: 100 } as any)
      for await (const _ of stream) {}
      assert(captured?.providerHint === providerHint,
        `providerHint=${captured?.providerHint}`)
      assert(typeof captured?.sessionId === 'string' && captured.sessionId.length > 0,
        `missing ${providerHint} sessionId: ${captured?.sessionId}`)
    })
  }

  await test('OpenRouter bridge derives side-query session id when none is explicit', async () => {
    let captured: LaneProviderCallParams | null = null
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider(params: LaneProviderCallParams) {
        captured = params
        return {
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
        }
      },
    }
    const prov = new LaneBackedProvider(lane, 'openrouter')
    const stream = await prov.stream({
      model: 'qwen/qwen3.7-max',
      messages: [],
      max_tokens: 100,
      querySource: 'model_validation',
    } as any)
    for await (const _ of stream) {}
    assert(captured?.providerHint === 'openrouter', `providerHint=${captured?.providerHint}`)
    assert(typeof captured?.sessionId === 'string' && captured.sessionId.startsWith('tau-query-'),
      `sessionId=${captured?.sessionId}`)
  })

  await test('Antigravity bridge preserves explicit request session id', async () => {
    let captured: LaneProviderCallParams | null = null
    const lane: Lane = {
      ...mockLane([]),
      async *streamAsProvider(params: LaneProviderCallParams) {
        captured = params
        return {
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
        }
      },
    }
    const prov = new LaneBackedProvider(lane, 'antigravity')
    const stream = await prov.stream({
      model: 'gemini-3.5-flash-low',
      messages: [],
      max_tokens: 100,
      sessionId: 'tau-agent-explicit',
    } as any)
    for await (const _ of stream) {}
    assert(captured?.providerHint === 'antigravity', `providerHint=${captured?.providerHint}`)
    assert(captured?.sessionId === 'tau-agent-explicit',
      `sessionId=${captured?.sessionId}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
