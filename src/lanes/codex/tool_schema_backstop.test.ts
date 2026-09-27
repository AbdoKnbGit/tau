/**
 * Codex lane: the rejected-tool-schema backstop.
 *
 *   - an MCP/custom tool the backend refuses is left out and the turn retried;
 *   - the rejection is recognised as an HTTP 400 or as an error event inside
 *     the stream (both measured on the live backend), by tool name or by the
 *     `tools[N]` index alone;
 *   - native registry tools are never left out: their rejection surfaces;
 *   - a tool whose schema changes is offered again;
 *   - once output has started nothing is retried, but the next request is fixed.
 *
 * Run: bun run src/lanes/codex/tool_schema_backstop.test.ts
 */
import assert from 'node:assert/strict'
import { APIConnectionError } from '@anthropic-ai/sdk'
import { codexApi, CodexApiError } from './api.js'
import { _resetCodexToolRejectionsForTest, codexLane, parseCodexToolSchemaRejection } from './loop.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  _resetCodexToolRejectionsForTest()
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

type Step = (request: any) => AsyncGenerator<any>
const requests: any[] = []
let script: Step[] = []

const okStream: Step = async function* () {
  yield { type: 'response.created', response: { id: 'r' } }
  yield { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [] } }
  yield { type: 'response.output_text.delta', output_index: 0, delta: 'OK' }
  yield { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm' } }
  yield { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 10, output_tokens: 1 } } }
}

function rejectBody(name: string | null, index: number): string {
  return JSON.stringify({
    error: {
      message: name
        ? `Invalid schema for function '${name}': In context=('properties', 'batch'), 'text' is not valid under any of the given schemas.`
        : 'Invalid schema: not valid under any of the given schemas.',
      type: 'invalid_request_error',
      param: `tools[${index}].parameters`,
      code: 'invalid_function_parameters',
    },
  })
}

function httpReject(name: string | null, index = 0): Step {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw new CodexApiError(400, rejectBody(name, index))
  }
}

function streamReject(name: string, afterCreated = false): Step {
  return async function* () {
    if (afterCreated) yield { type: 'response.created', response: { id: 'r' } }
    yield { type: 'error', error: JSON.parse(rejectBody(name, 0)).error }
  }
}

;(codexApi as any).streamResponses = async function* (request: any) {
  requests.push(structuredClone(request))
  const step = script.shift() ?? okStream
  yield* step(request)
}

const SHELL = { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
const DOCS = { name: 'mcp__docs__update', description: 'update', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }
const BATCH = { name: 'mcp__docs__batch', description: 'batch', input_schema: { type: 'object', properties: { batch: { type: 'array' } } } }

async function run(tools: any[]): Promise<{ events: any[]; error?: unknown }> {
  const events: any[] = []
  try {
    for await (const event of codexLane.streamAsProvider({
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', content: 'Go.' }],
      system: 'Use the tools.',
      tools,
      max_tokens: 1000,
      signal: new AbortController().signal,
      sessionId: 'backstop-session',
    } as any)) {
      events.push(event)
    }
    return { events }
  } catch (error) {
    return { events, error }
  }
}

function tool(request: any, name: string): any {
  return (request.tools ?? []).find((t: any) => t.name === name)
}

function text(events: any[]): string {
  return events.filter(e => e.type === 'content_block_delta' && e.delta?.type === 'text_delta').map(e => e.delta.text).join('')
}

async function main(): Promise<void> {
  console.log('codex tool schema backstop:')

  await test('parses the tool from a rejection by name or by index', () => {
    const byName = parseCodexToolSchemaRejection(new CodexApiError(400, rejectBody('mcp__x__y', 4)))
    assert.equal(byName?.toolName, 'mcp__x__y')
    assert.equal(byName?.toolIndex, 4)
    const byIndex = parseCodexToolSchemaRejection(new CodexApiError(400, rejectBody(null, 2)))
    assert.equal(byIndex?.toolName, undefined)
    assert.equal(byIndex?.toolIndex, 2)
    assert.equal(parseCodexToolSchemaRejection(new CodexApiError(400, '{"error":{"message":"Unsupported parameter: store"}}')), null)
    assert.equal(parseCodexToolSchemaRejection(new CodexApiError(429, rejectBody('mcp__x__y', 0))), null)
  })

  await test('a refused tool is left out and the turn retried', async () => {
    requests.length = 0
    script = [httpReject(DOCS.name, 1)]
    const first = await run([SHELL, DOCS, BATCH])
    assert.ok(first.error instanceof APIConnectionError, `expected a retryable error, got ${String(first.error)}`)
    assert.match(String((first.error as Error).message), /mcp__docs__update; retrying without that tool/)
    assert.equal(tool(requests[0], DOCS.name).strict, false, 'every tool is sent non-strict')

    const second = await run([SHELL, DOCS, BATCH])
    assert.equal(second.error, undefined)
    assert.equal(tool(requests[1], DOCS.name), undefined, 'left out after the rejection')
    assert.ok(tool(requests[1], BATCH.name), 'the other MCP tool stays')
    assert.ok(tool(requests[1], 'shell'), 'native tools stay')

    // The same bytes keep the same decision: the tool block is stable.
    await run([SHELL, DOCS, BATCH])
    assert.equal(JSON.stringify(requests[2].tools), JSON.stringify(requests[1].tools))
  })

  await test('a stream error event is handled like the HTTP 400', async () => {
    requests.length = 0
    script = [streamReject(BATCH.name)]
    const first = await run([SHELL, BATCH])
    assert.ok(first.error instanceof APIConnectionError, `expected a retryable error, got ${String(first.error)}`)
    await run([SHELL, BATCH])
    assert.equal(tool(requests[1], BATCH.name), undefined, 'a tool refused in-stream is left out')
  })

  await test('a rejection that only names tools[N] finds the tool by index', async () => {
    requests.length = 0
    script = [httpReject(null, 1)]
    const first = await run([SHELL, DOCS])
    assert.ok(first.error instanceof APIConnectionError)
    await run([SHELL, DOCS])
    assert.equal(tool(requests[1], DOCS.name), undefined)
  })

  await test('a native registry tool is never left out', async () => {
    requests.length = 0
    script = [httpReject('shell', 0)]
    const result = await run([SHELL, DOCS])
    assert.equal(result.error, undefined, 'the rejection surfaces as text instead of a retry')
    assert.match(text(result.events), /Codex API error/)
    await run([SHELL, DOCS])
    assert.ok(tool(requests[1], 'shell'), 'shell is still offered')
  })

  await test('a tool whose schema changed is offered again', async () => {
    requests.length = 0
    script = [httpReject(DOCS.name, 0)]
    await run([DOCS])
    await run([DOCS])
    assert.equal(tool(requests[1], DOCS.name), undefined)
    const changed = { ...DOCS, input_schema: { type: 'object', properties: { id: { type: 'string' }, rev: { type: 'integer' } }, required: ['id'] } }
    await run([changed])
    assert.ok(tool(requests[2], DOCS.name), 'the changed schema is tried again')
  })

  await test('after output started nothing is retried, but the next request is fixed', async () => {
    requests.length = 0
    script = [streamReject(DOCS.name, true)]
    const first = await run([SHELL, DOCS])
    assert.equal(first.error, undefined, 'no retry once message_start was emitted')
    assert.match(text(first.events), /Codex API error/)
    await run([SHELL, DOCS])
    assert.equal(tool(requests[1], DOCS.name), undefined)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
