/**
 * Output-cap truncation regressions.
 *
 * The failure this guards against: a provider stops at the output-token
 * ceiling while the model is mid-tool-call, closes the JSON object for us, and
 * hands back `{"content": "<half a file>"}` with the required `file_path`
 * never written. Forwarded as a normal tool call it either draws a misleading
 * "required parameter is missing" rejection or — when every required field
 * happened to arrive before the cut — silently writes a truncated file.
 *
 * Run:  bun run src/lanes/shared/truncation.test.ts
 */

import assert from 'node:assert/strict'
import type { AnthropicStreamEvent } from '../../services/api/providers/base_provider.js'
import { openAIStreamToAnthropicEvents } from '../../services/api/adapters/openai_to_anthropic.js'
import { codexApi } from '../codex/api.js'
import { CodexLane } from '../codex/loop.js'
import { OpenAICompatLane } from '../openai-compat/loop.js'
import { LaneBackedProvider } from '../provider-bridge.js'
import { qwenApi } from '../qwen/api.js'
import { QwenLane } from '../qwen/loop.js'
import {
  InFlightToolCall,
  isOutputCapTruncation,
  laneStopReason,
} from './truncation.js'

// ─── Helpers ───────────────────────────────────────────────────────

function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** One OpenAI streaming chunk carrying a tool-call argument fragment. */
function argsChunk(index: number, args: string, name?: string): unknown {
  return {
    id: 'chatcmpl-test',
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            name
              ? { index, id: `call_${index}`, function: { name, arguments: args } }
              : { index, function: { arguments: args } },
          ],
        },
        finish_reason: null,
      },
    ],
  }
}

function textChunk(text: string): unknown {
  return {
    id: 'chatcmpl-test',
    model: 'test-model',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
}

function finishChunk(reason: string): unknown {
  return {
    id: 'chatcmpl-test',
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 100, completion_tokens: 8192 },
  }
}

async function runCompatLane(chunks: unknown[]): Promise<AnthropicStreamEvent[]> {
  const lane = new OpenAICompatLane()
  lane.registerProvider('openrouter', 'test-key', 'https://openrouter.example/v1')
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async () => sseResponse(chunks)) as unknown as typeof fetch
  try {
    const events: AnthropicStreamEvent[] = []
    const stream = lane.streamAsProvider({
      model: 'test-model',
      messages: [{ role: 'user', content: 'scaffold the project' }],
      system: 'You are a coding agent.',
      tools: [],
      max_tokens: 8192,
      thinking: { type: 'disabled' },
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: 'openrouter',
    })
    for await (const ev of stream) events.push(ev)
    return events
  } finally {
    globalThis.fetch = oldFetch
    lane.unregisterProvider('openrouter')
  }
}

function toolUseStarts(
  events: AnthropicStreamEvent[],
): Array<{ index: number; name: string }> {
  return events
    .filter(
      e =>
        e.type === 'content_block_start' &&
        (e as any).content_block?.type === 'tool_use',
    )
    .map(e => ({
      index: (e as any).index as number,
      name: (e as any).content_block.name as string,
    }))
}

function stopReasonOf(events: AnthropicStreamEvent[]): string | undefined {
  const delta = events.find(e => e.type === 'message_delta') as any
  return delta?.delta?.stop_reason
}

/** The JSON the tool layer would end up validating, per tool_use block index. */
function toolInputs(events: AnthropicStreamEvent[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const e of events) {
    if (e.type !== 'content_block_delta') continue
    const d = (e as any).delta
    if (d?.type !== 'input_json_delta') continue
    const idx = (e as any).index as number
    out.set(idx, (out.get(idx) ?? '') + d.partial_json)
  }
  return out
}

// ─── Runner ────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const pending: Array<[string, () => void | Promise<void>]> = []

function test(name: string, fn: () => void | Promise<void>): void {
  pending.push([name, fn])
}

// ─── The policy helpers ────────────────────────────────────────────

test('isOutputCapTruncation accepts every wire spelling of the output cap', () => {
  assert.equal(isOutputCapTruncation('length'), true, 'OpenAI Chat Completions')
  assert.equal(isOutputCapTruncation('MAX_TOKENS'), true, 'Gemini')
  assert.equal(isOutputCapTruncation('max_output_tokens'), true, 'OpenAI Responses')
  assert.equal(isOutputCapTruncation('max_tokens'), true, 'Anthropic passthrough')
  assert.equal(isOutputCapTruncation(' Length '), true, 'padded / mixed case')
})

test('isOutputCapTruncation rejects ordinary finishes', () => {
  for (const reason of ['stop', 'tool_calls', 'content_filter', '', null, undefined, 42, {}]) {
    assert.equal(
      isOutputCapTruncation(reason),
      false,
      `treated ${JSON.stringify(reason)} as truncation`,
    )
  }
})

test('laneStopReason: truncation outranks tool_use', () => {
  assert.equal(laneStopReason({ truncated: true, hadToolUse: true }), 'max_tokens')
  assert.equal(laneStopReason({ truncated: true, hadToolUse: false }), 'max_tokens')
  assert.equal(laneStopReason({ truncated: false, hadToolUse: true }), 'tool_use')
  assert.equal(laneStopReason({ truncated: false, hadToolUse: false }), 'end_turn')
})

test('InFlightToolCall forgets a call once other output follows it', () => {
  const f = new InFlightToolCall<number>()
  f.noteArgs(3)
  assert.equal(f.toDrop(true), 3, 'the call taking fragments is the one at risk')
  f.noteOtherOutput()
  assert.equal(f.toDrop(true), null, 'text after the call proves it was finished')
})

test('InFlightToolCall never drops anything on a clean finish', () => {
  const f = new InFlightToolCall<number>()
  f.noteArgs(0)
  assert.equal(f.toDrop(false), null)
})

test('InFlightToolCall.noteSettled only clears the call it names', () => {
  const f = new InFlightToolCall<number>()
  f.noteArgs(2)
  f.noteSettled(1)
  assert.equal(f.toDrop(true), 2, 'a different call settling must not clear this one')
  f.noteSettled(2)
  assert.equal(f.toDrop(true), null)
})

// ─── openai-compat lane, end to end over a mocked SSE stream ───────

test('compat lane drops the tool call that was still being written at the cap', async () => {
  const events = await runCompatLane([
    argsChunk(0, '{"file_path":"a.py",', 'Write'),
    argsChunk(0, '"content":"done"}'),
    argsChunk(1, '{"content":"half a file', 'Write'),
    finishChunk('length'),
  ])

  const starts = toolUseStarts(events)
  assert.equal(starts.length, 1, 'the half-written call was emitted anyway')
  assert.equal(starts[0]!.name, 'Write')
  assert.equal(
    toolInputs(events).get(starts[0]!.index),
    '{"file_path":"a.py","content":"done"}',
    'the completed call must survive untouched',
  )
  assert.equal(
    stopReasonOf(events),
    'max_tokens',
    'truncation was reported as a clean finish',
  )
})

test('compat lane leaves a clean tool_calls turn exactly as it was', async () => {
  const events = await runCompatLane([
    argsChunk(0, '{"file_path":"a.py","content":"done"}', 'Write'),
    argsChunk(1, '{"file_path":"b.py","content":"also done"}', 'Write'),
    finishChunk('tool_calls'),
  ])

  assert.equal(toolUseStarts(events).length, 2, 'a complete turn lost a tool call')
  assert.equal(stopReasonOf(events), 'tool_use')
})

test('compat lane keeps a tool call the model finished before the cut', async () => {
  const events = await runCompatLane([
    argsChunk(0, '{"file_path":"a.py","content":"done"}', 'Write'),
    textChunk('now let me explain what I did at some length'),
    finishChunk('length'),
  ])

  assert.equal(
    toolUseStarts(events).length,
    1,
    'text after the call proves it was complete',
  )
  assert.equal(stopReasonOf(events), 'max_tokens')
})

test('compat lane emits no tool call at all when the only one was truncated', async () => {
  const events = await runCompatLane([
    argsChunk(0, '{"content":"half a file', 'Write'),
    finishChunk('length'),
  ])

  assert.equal(toolUseStarts(events).length, 0)
  assert.equal(
    stopReasonOf(events),
    'max_tokens',
    'without this the turn looks like a finished end_turn',
  )
})

test('compat lane keeps emitted block indices contiguous after a drop', async () => {
  const events = await runCompatLane([
    textChunk('scaffolding now'),
    argsChunk(0, '{"file_path":"a.py","content":"done"}', 'Write'),
    argsChunk(1, '{"content":"half', 'Write'),
    finishChunk('length'),
  ])

  const indices = events
    .filter(e => e.type === 'content_block_start')
    .map(e => (e as any).index as number)
  assert.deepEqual(
    indices,
    [0, 1],
    `block indices left a gap: ${JSON.stringify(indices)}`,
  )
})

// ─── shared OpenAI→Anthropic converter (cline / kilo / nim / ollama) ──

async function runConverter(chunks: unknown[]): Promise<AnthropicStreamEvent[]> {
  async function* src() {
    for (const c of chunks) yield c as any
  }
  const out: AnthropicStreamEvent[] = []
  for await (const ev of openAIStreamToAnthropicEvents(src())) out.push(ev)
  return out
}

test('shared converter never closes the block that was cut off', async () => {
  const events = await runConverter([
    argsChunk(0, '{"file_path":"a.py","content":"done"}', 'Write'),
    argsChunk(1, '{"content":"half a file', 'Write'),
    finishChunk('length'),
  ])

  const closed = new Set(
    events
      .filter(e => e.type === 'content_block_stop')
      .map(e => (e as any).index as number),
  )
  const started = toolUseStarts(events)
  assert.equal(started.length, 2, 'both blocks start while streaming — that is unavoidable')
  assert.equal(closed.has(started[0]!.index), true, 'the finished call must still be closed')
  assert.equal(
    closed.has(started[1]!.index),
    false,
    'closing the truncated block is what turns it into an executable tool call',
  )
  assert.equal(stopReasonOf(events), 'max_tokens')
})

test('shared converter closes every block on a clean finish', async () => {
  const events = await runConverter([
    argsChunk(0, '{"file_path":"a.py","content":"done"}', 'Write'),
    argsChunk(1, '{"file_path":"b.py","content":"also"}', 'Write'),
    finishChunk('tool_calls'),
  ])

  const closed = new Set(
    events
      .filter(e => e.type === 'content_block_stop')
      .map(e => (e as any).index as number),
  )
  for (const s of toolUseStarts(events)) {
    assert.equal(closed.has(s.index), true, `block ${s.index} was left open on a clean finish`)
  }
  assert.equal(stopReasonOf(events), 'tool_use')
})

// The gemini lane's equivalent lives in ../gemini/truncation.test.ts: its
// import chain reaches entrypoints/agentSdkTypes, which does not resolve
// standalone today, and dragging that in here would take the whole suite
// down with it.

// ─── qwen lane ─────────────────────────────────────────────────────

async function runQwenLane(chunks: unknown[]): Promise<AnthropicStreamEvent[]> {
  const original = qwenApi.streamChat
  qwenApi.streamChat = (async function* () {
    for (const c of chunks) yield c as any
  }) as typeof qwenApi.streamChat
  try {
    const events: AnthropicStreamEvent[] = []
    const stream = new QwenLane().streamAsProvider({
      model: 'qwen3-coder-plus',
      messages: [{ role: 'user', content: 'scaffold the project' }],
      system: 'You are a coding agent.',
      tools: [],
      max_tokens: 8192,
      thinking: { type: 'disabled' },
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: 'qwen',
    })
    for await (const ev of stream) events.push(ev)
    return events
  } finally {
    qwenApi.streamChat = original
  }
}

test('qwen lane drops the tool call that was still being written at the cap', async () => {
  const events = await runQwenLane([
    argsChunk(0, '{"file_path":"a.py","content":"done"}', 'Write'),
    argsChunk(1, '{"content":"half a file', 'Write'),
    finishChunk('length'),
  ])

  assert.equal(toolUseStarts(events).length, 1, 'the half-written call was emitted anyway')
  assert.equal(stopReasonOf(events), 'max_tokens')
})

test('qwen lane leaves a clean tool_calls turn exactly as it was', async () => {
  const events = await runQwenLane([
    argsChunk(0, '{"file_path":"a.py","content":"done"}', 'Write'),
    argsChunk(1, '{"file_path":"b.py","content":"also"}', 'Write'),
    finishChunk('tool_calls'),
  ])

  assert.equal(toolUseStarts(events).length, 2, 'a complete turn lost a tool call')
  assert.equal(stopReasonOf(events), 'tool_use')
})

// ─── codex lane (OpenAI Responses) ─────────────────────────────────

async function runCodexLane(wire: unknown[]): Promise<AnthropicStreamEvent[]> {
  const original = codexApi.streamResponses
  codexApi.streamResponses = (async function* () {
    for (const e of wire) yield e as any
  }) as typeof codexApi.streamResponses
  try {
    const events: AnthropicStreamEvent[] = []
    const stream = new CodexLane().streamAsProvider({
      model: 'gpt-5.4-codex',
      messages: [{ role: 'user', content: 'scaffold the project' }],
      system: 'You are a coding agent.',
      tools: [],
      max_tokens: 8192,
      thinking: { type: 'disabled' },
      signal: new AbortController().signal,
      sessionId: 'session-fixed',
      providerHint: 'codex',
    })
    for await (const ev of stream) events.push(ev)
    return events
  } finally {
    codexApi.streamResponses = original
  }
}

test('codex lane reports response.incomplete as max_tokens', async () => {
  const events = await runCodexLane([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'c0', name: 'Write' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"content":"half a file',
    },
    {
      type: 'response.incomplete',
      response: {
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 100, output_tokens: 8192 },
      },
    },
  ])

  assert.equal(
    toolUseStarts(events).length,
    0,
    'a call with no output_item.done must never reach the tool layer',
  )
  assert.equal(
    stopReasonOf(events),
    'max_tokens',
    'without this a capped Responses turn looks like a clean tool_use turn',
  )
})

test('codex lane still reports a completed tool call as tool_use', async () => {
  const events = await runCodexLane([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'c0', name: 'Write' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"file_path":"a.py","content":"done"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call' },
    },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 100, output_tokens: 40 } },
    },
  ])

  assert.equal(toolUseStarts(events).length, 1)
  assert.equal(stopReasonOf(events), 'tool_use')
})

// ─── non-streaming create() assembler ──────────────────────────────

/**
 * `LaneBackedProvider.create()` rebuilds a whole message from the same event
 * stream. It has to honour a dropped block for the same reason claude.ts does,
 * or the one-shot path would resurrect the call the lane discarded.
 */
test('create() drops a tool_use block that never got its content_block_stop', async () => {
  const lane = {
    name: 'gemini', // in LANES_WITH_NATIVE_MEDIA: skips attachment prefetch
    resolveModel: (m: string) => m,
    listModels: async () => [],
    async *streamAsProvider() {
      yield { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1 } } }
      // A finished call.
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't0', name: 'Write', input: {} },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.py","content":"done"}' },
      }
      yield { type: 'content_block_stop', index: 0 }
      // One cut off mid-arguments: started, never stopped.
      yield {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} },
      }
      yield {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"content":"half a file' },
      }
      yield { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8192 } }
      yield { type: 'message_stop' }
      return { input_tokens: 1, output_tokens: 8192, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0 }
    },
  }

  const msg = await new LaneBackedProvider(lane as any).create({
    model: 'gemini-3-pro-preview',
    messages: [{ role: 'user', content: 'scaffold the project' }],
    system: '',
    tools: [],
    max_tokens: 8192,
  } as any)

  const toolBlocks = msg.content.filter(b => b.type === 'tool_use')
  assert.equal(toolBlocks.length, 1, 'the unfinalized block was assembled anyway')
  assert.deepEqual((toolBlocks[0] as any).input, {
    file_path: 'a.py',
    content: 'done',
  })
  assert.equal(
    '_finalized' in (toolBlocks[0] as any),
    false,
    'the internal marker leaked into the assembled message',
  )
  assert.equal(msg.stop_reason, 'max_tokens')
})

// ─── Go ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('output-cap truncation:')
  for (const [name, fn] of pending) {
    try {
      await fn()
      passed++
      console.log(`  ok  ${name}`)
    } catch (e: any) {
      failed++
      console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
