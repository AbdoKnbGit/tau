import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod/v4'
import {
  executeBlock, fixtureContext, fixtureTool, loadMcpRuntime,
} from './helpers/mcp-built-runtime.mjs'

const directory = mkdtempSync(join(tmpdir(), 'tau-tool-hook-compat-'))
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: directory,
  CLAUDE_CODE_SIMPLE: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
})
after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10 }))

const r = await loadMcpRuntime({
  paths: [
    'src/services/tools/toolHooks.ts', 'src/services/tools/postToolBatch.ts',
    'src/services/api/adapters/anthropic_to_openai.ts',
  ],
  exports: [
    'runPostToolUseHooks', 'runPostToolBatchHooks', 'collectPostToolBatchCalls',
    'normalizeMessagesForAPI', 'createUserMessage',
    'anthropicMessagesToOpenAI', 'anthropicToResponsesInput',
    'convertHistoryToCodex', '_convertHistoryToGeminiForTest',
    'convertHistoryToOpenAI',
    'getPostToolHookRunner: () => executePostToolHooks',
    'setPostToolHookRunner: fn => { executePostToolHooks = fn }',
    'getBatchHookRunner: () => executePostToolBatchHooks',
    'setBatchHookRunner: fn => { executePostToolBatchHooks = fn }',
  ],
})

let nextCall = 0
const block = (id = `fixture-call-${nextCall++}`, name = 'FixtureTool') => ({
  type: 'tool_use', id, name, input: { path: id },
})
const iterable = values => (async function* () { yield* values })()
async function withPostResults(results, run) {
  const original = r.getPostToolHookRunner()
  r.setPostToolHookRunner(() => iterable(results))
  try { return await run() } finally { r.setPostToolHookRunner(original) }
}
async function withBatchRunner(runner, run) {
  const original = r.getBatchHookRunner()
  r.setBatchHookRunner(runner)
  try { return await run() } finally { r.setBatchHookRunner(original) }
}
async function collect(generator) {
  const results = []
  for await (const result of generator) results.push(result)
  return results
}
const mapped = (data, id) => ({
  type: 'tool_result', tool_use_id: id,
  content: typeof data === 'string' ? data : JSON.stringify(data),
})

test('PostToolUse rewrites built-in results before serialization and keeps context', async () => {
  const original = { stdout: 'secret', stderr: '', interrupted: false }
  const replacement = { ...original, stdout: '[redacted]' }
  const tool = fixtureTool({
    outputSchema: z.object({ stdout: z.string(), stderr: z.string(), interrupted: z.boolean() }),
    call: async () => ({ data: original }),
    mapToolResultToToolResultBlockParam: mapped,
  })
  await withPostResults([
    { updatedToolOutput: replacement }, { additionalContexts: ['result was redacted'] },
  ], async () => {
    const result = await executeBlock(r, block(), tool)
    assert.equal(result.results.length, 1)
    assert.deepEqual(JSON.parse(result.results[0].content), replacement)
    assert.deepEqual(result.messages[0].toolUseResult, replacement)
    assert.deepEqual(original, { stdout: 'secret', stderr: '', interrupted: false })
  })
})

test('invalid built-in replacements and legacy MCP-only replacements retain the real result', async () => {
  const original = { stdout: 'successful output' }
  const tool = fixtureTool({
    outputSchema: z.object({ stdout: z.string() }),
    call: async () => ({ data: original }), mapToolResultToToolResultBlockParam: mapped,
  })
  for (const hooks of [
    [{ updatedToolOutput: 'wrong shape' }],
    [{ updatedToolOutput: { stdout: false } }],
    [{ updatedMCPToolOutput: { stdout: 'legacy field must not affect built-ins' } }],
  ]) {
    await withPostResults(hooks, async () => {
      const result = await executeBlock(r, block(), tool)
      assert.equal(result.results[0].is_error, undefined)
      assert.deepEqual(JSON.parse(result.results[0].content), original)
    })
  }
})

test('MCP rewrites preserve falsy values for both output fields without schema validation', async () => {
  for (const field of ['updatedToolOutput', 'updatedMCPToolOutput']) {
    for (const value of ['', 0, false, null]) {
      const tool = fixtureTool({
        isMcp: true, outputSchema: z.never(),
        mapToolResultToToolResultBlockParam: (data, id) => mapped(JSON.stringify(data), id),
      })
      await withPostResults([{ [field]: value }], async () => {
        const result = await executeBlock(r, block(), tool)
        assert.equal(result.results[0].content, JSON.stringify(value), `${field}: ${value}`)
        assert.equal(result.messages[0].toolUseResult, value)
      })
    }
  }
})

test('later valid hook replacements win and malformed replacements do not erase them', async () => {
  const tool = fixtureTool({
    outputSchema: z.object({ stdout: z.string() }),
    call: async () => ({ data: { stdout: 'original' } }),
    mapToolResultToToolResultBlockParam: mapped,
  })
  await withPostResults([
    { updatedToolOutput: { stdout: 'first' } },
    { updatedToolOutput: { stdout: 'last valid' } },
    { updatedToolOutput: false },
  ], async () => {
    const result = await executeBlock(r, block(), tool)
    assert.equal(JSON.parse(result.results[0].content).stdout, 'last valid')
  })
})

test('batch collection includes failures and model-visible content in original call order', () => {
  const first = block('first')
  const second = block('second')
  const image = [{ type: 'text', text: 'failure details' }]
  const messages = [
    r.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'second', content: image, is_error: true }] }),
    r.createUserMessage({ content: 'unrelated reminder' }),
    r.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'first', content: '' }], toolUseResult: { raw: 'must not leak' } }),
  ]
  assert.deepEqual(r.collectPostToolBatchCalls([first, second], messages), [
    { tool_name: first.name, tool_input: first.input, tool_use_id: 'first', tool_response: '' },
    { tool_name: second.name, tool_input: second.input, tool_use_id: 'second', tool_response: image },
  ])
})

test('PostToolBatch runs once on complete batches and skips empty, incomplete and aborted batches', async () => {
  const calls = [block('first'), block('second')]
  const results = calls.map(call => r.createUserMessage({ content: [mapped(`output-${call.id}`, call.id)] }))
  let invocations = 0
  await withBatchRunner(async function* (payload, context) {
    invocations++
    assert.deepEqual(payload.map(call => call.tool_use_id), ['first', 'second'])
    assert.deepEqual(context.messages, results)
    yield { additionalContexts: ['one summary for the batch'] }
  }, async () => {
    const context = fixtureContext([], { messages: results })
    const output = await collect(r.runPostToolBatchHooks(calls, results, context))
    assert.equal(output.length, 1)
    assert.equal(output[0].attachment.hookEvent, 'PostToolBatch')
    assert.deepEqual(output[0].attachment.content, ['one summary for the batch'])
    assert.deepEqual(await collect(r.runPostToolBatchHooks([], [], context)), [])
    assert.deepEqual(await collect(r.runPostToolBatchHooks(calls, results.slice(1), context)), [])
    context.abortController.abort()
    assert.deepEqual(await collect(r.runPostToolBatchHooks(calls, results, context)), [])
    assert.equal(invocations, 1)
  })
})

test('PostToolBatch context reaches Anthropic, OpenAI, Codex and Gemini message formats once', async () => {
  const tool = fixtureTool()
  const call = block()
  const assistant = {
    type: 'assistant', uuid: 'assistant', timestamp: new Date().toISOString(),
    message: { id: 'assistant', role: 'assistant', model: 'fixture', content: [call] },
  }
  const result = r.createUserMessage({ content: [mapped('result marker', call.id)] })
  await withBatchRunner(() => iterable([{ additionalContexts: ['batch-context-marker'] }]), async () => {
    const context = fixtureContext([tool])
    const output = await collect(r.runPostToolBatchHooks([call], [result], context))
    const normalized = r.normalizeMessagesForAPI([assistant, result, ...output], [tool])
    const messages = normalized.map(message => message.message)
    const variants = {
      anthropic: messages,
      'openai adapter': r.anthropicMessagesToOpenAI(messages),
      responses: r.anthropicToResponsesInput(messages),
      codex: r.convertHistoryToCodex(messages, new Map()),
      gemini: r._convertHistoryToGeminiForTest(messages),
      'openai lane': r.convertHistoryToOpenAI(messages, '', 'openrouter', 'fixture'),
    }
    for (const [provider, payload] of Object.entries(variants)) {
      const serialized = JSON.stringify(payload)
      assert.equal(serialized.split('batch-context-marker').length - 1, 1, provider)
      assert.ok(serialized.indexOf('result marker') < serialized.indexOf('batch-context-marker'), provider)
    }
  })
})

test('a PostToolBatch block stops the loop after every hook delivers its context', async () => {
  const call = block()
  const result = r.createUserMessage({ content: [mapped('tool already ran', call.id)] })
  const blockingError = { blockingError: 'Review the combined tool results', command: 'batch-policy' }
  await withBatchRunner(() => iterable([
    { blockingError },
    { message: { type: 'attachment', attachment: { type: 'hook_blocking_error', blockingError, hookName: 'PostToolBatch', hookEvent: 'PostToolBatch', toolUseID: call.id } } },
    { additionalContexts: ['context from a hook that finished later'] },
    { preventContinuation: true, stopReason: 'a later stop reason' },
  ]), async () => {
    const output = await collect(r.runPostToolBatchHooks([call], [result], fixtureContext([])))
    // query.ts ends the turn on hook_stopped_continuation, before the next model call.
    assert.deepEqual(output.map(message => message.attachment.type), ['hook_additional_context', 'hook_stopped_continuation'])
    assert.equal(output[1].attachment.message, blockingError.blockingError, 'the first reason is shown')
    const normalized = JSON.stringify(r.normalizeMessagesForAPI(output))
    assert.equal(normalized.split(blockingError.blockingError).length - 1, 1)
    assert.equal(normalized.split('a later stop reason').length - 1, 0)
  })
})

test('PostToolBatch continue:false alone stops with its own reason', async () => {
  const call = block()
  const result = r.createUserMessage({ content: [mapped('tool already ran', call.id)] })
  await withBatchRunner(() => iterable([{ preventContinuation: true }]), async () => {
    const output = await collect(r.runPostToolBatchHooks([call], [result], fixtureContext([])))
    assert.deepEqual(output.map(message => message.attachment.type), ['hook_stopped_continuation'])
    assert.equal(output[0].attachment.message, 'Execution stopped by PostToolBatch hook')
  })
})
