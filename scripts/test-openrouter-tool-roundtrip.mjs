#!/usr/bin/env node
// Opt-in live test of tool results through the shipped bundle. Synthetic data only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadMcpRuntime } from '../test/helpers/mcp-built-runtime.mjs'

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, model: { type: 'string', multiple: true },
  output: { type: 'string', default: 'docs/openrouter-tool-roundtrip-results.jsonl' },
} })
const models = [...new Set(values.model ?? [])]
assert.ok(models.length, 'Specify at least one --model from the free catalog.')
if (!values.live) {
  console.log(JSON.stringify({ dryRun: true, models, cases: ['generate-four', 'ordered', 'completion-order', 'saved-native'],
    toolsExecute: 'none; synthetic results are supplied in memory' }))
  process.exit(0)
}
const apiKey = process.env.OPENROUTER_API_KEY
assert.ok(apiKey, 'Live testing requires OPENROUTER_API_KEY.')
const realFetch = globalThis.fetch
const catalog = await (await realFetch('https://openrouter.ai/api/v1/models', {
  signal: AbortSignal.timeout(20_000),
})).json()
for (const id of models) {
  const model = catalog.data.find(model => model.id === id)
  assert.ok(model && Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0 &&
    model.supported_parameters?.includes('tools'), `${id} is not a catalog-verified free tool model`)
}
const isolated = mkdtempSync(join(tmpdir(), 'tau-openrouter-roundtrip-'))
process.env.CLAUDE_CONFIG_DIR = isolated
process.env.TAU_OPENROUTER_STRICT_TOOLS_STORE = join(isolated, 'strict.json')
process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'
const runtime = await loadMcpRuntime({ paths: ['src/utils/forcedProvider.ts'],
  exports: ['runWithForcedProvider', 'normalizeMessagesForAPI'] })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const output = resolve(values.output)
const runId = new Date().toISOString()
let state
globalThis.fetch = async (url, init) => {
  const target = new URL(typeof url === 'string' ? url : url.url ?? String(url))
  assert.equal(target.origin, 'https://openrouter.ai')
  if (!init?.body) return realFetch(url, init)
  assert.equal(target.pathname, '/api/v1/chat/completions')
  const body = JSON.parse(init.body)
  assert.ok(models.includes(body.model))
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['FetchRecord'])
  assert.ok(!init.body.includes('C:\\\\Users\\\\ok') && !init.body.includes('C:/Users/ok'))
  const assistantIds = body.messages.flatMap(message => message.tool_calls ?? []).map(call => call.id)
  const resultIds = body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)
  assert.deepEqual(assistantIds, state.expectedIds)
  assert.deepEqual(resultIds, state.expectedResultIds)
  const attempt = { stream: body.stream, assistantIds, resultIds,
    toolHash: hash(body.tools), systemHash: hash(body.messages.filter(message => message.role === 'system')),
    sessionId: body.session_id, cacheKey: body.prompt_cache_key }
  state.attempts.push(attempt)
  const response = await realFetch(url, init)
  attempt.status = response.status
  state.observations.push(response.clone().text().then(raw => {
    const frames = response.headers.get('content-type')?.includes('text/event-stream')
      ? raw.split(/\r?\n\r?\n/).flatMap(frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n')
        return data && data !== '[DONE]' ? [JSON.parse(data)] : []
      }) : [JSON.parse(raw)]
    for (const frame of frames) {
      attempt.id = frame.id ?? attempt.id
      attempt.provider = frame.provider ?? frame.error?.metadata?.provider_name ?? attempt.provider
      attempt.finish = frame.choices?.[0]?.finish_reason ?? attempt.finish
      attempt.usage = frame.usage ?? attempt.usage
      if (frame.error) attempt.error = frame.error
    }
  }).catch(error => { attempt.observationError = error.name }))
  return response
}
let failed = false
try {
  for (const model of models) {
    const lane = new runtime.OpenAICompatLane()
    lane.registerProvider('openrouter', apiKey, 'https://openrouter.ai/api/v1')
    const initial = [{ role: 'user', content: 'Retrieve the four records, then summarize their values.' }]
    const params = { providerHint: 'openrouter', model, max_tokens: 16384, temperature: 0,
      sessionId: `roundtrip-${hash(model).slice(0, 12)}`,
      system: 'Retrieve records A, B, C and D using four FetchRecord calls in one parallel batch. After the tool results, answer with the four keys and their returned values. Do not call tools again after all four results are available.',
      tools: [{ name: 'FetchRecord', description: 'Read one synthetic record by key.',
        input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }],
    }
    let prefix
    async function run(label, messages, expectedIds = [], expectedResultIds = []) {
      state = { attempts: [], observations: [], expectedIds, expectedResultIds }
      const result = { runId, model, label, attempts: state.attempts }
      let reply
      try {
        reply = await runtime.runWithForcedProvider({ provider: 'openrouter' }, () =>
          runtime.assembleFinalMessage(lane.streamAsProvider({ ...params, messages,
            signal: AbortSignal.timeout(90_000) }), model))
        if (label === 'generate-four') {
          const calls = reply.content.filter(block => block.type === 'tool_use')
          assert.equal(calls.length, 4)
          assert.deepEqual(calls.map(call => call.input.key).sort(), ['A', 'B', 'C', 'D'])
          assert.ok(calls.every(call => call.name === 'FetchRecord' && call._openrouter_tool_call_id))
        } else {
          assert.equal(reply.content.filter(block => block.type === 'tool_use').length, 0)
          const text = reply.content.filter(block => block.type === 'text').map(block => block.text).join('')
          for (const key of ['A', 'B', 'C', 'D']) assert.ok(text.includes(`synthetic-${key}`))
        }
        for (const attempt of state.attempts) {
          const current = [attempt.toolHash, attempt.systemHash, attempt.sessionId, attempt.cacheKey]
          prefix ??= current
          assert.deepEqual(current, prefix, 'initial prompt, tools and cache identity must stay stable')
        }
        result.outcome = 'pass'
      } catch (error) {
        failed = true
        result.outcome = 'error'
        result.error = String(error.message).replaceAll(apiKey, '[redacted]').slice(0, 1500)
      }
      await Promise.all(state.observations)
      appendFileSync(output, JSON.stringify(result) + '\n')
      console.log(JSON.stringify({ model, label, outcome: result.outcome,
        ids: state.attempts.map(attempt => attempt.id), error: result.error }))
      return result.outcome === 'pass' ? reply : undefined
    }
    const reply = await run('generate-four', initial)
    if (!reply) continue
    const calls = reply.content.filter(block => block.type === 'tool_use')
    const originalIds = calls.map(call => call._openrouter_tool_call_id)
    for (const [label, order] of [['ordered', [0, 1, 2, 3]], ['completion-order', [3, 1, 2, 0]], ['saved-native', [3, 1, 2, 0]]]) {
      const messages = [...initial, { role: 'assistant', content: reply.content }, { role: 'user', content: order.map(index => ({
        type: 'tool_result', tool_use_id: calls[index].id,
        content: JSON.stringify({ key: calls[index].input.key, value: `synthetic-${calls[index].input.key}` }),
      })) }]
      let history = JSON.parse(JSON.stringify(messages))
      if (label === 'saved-native') {
        // Emulate a pre-fix native transcript, where only the UI IDs were persisted.
        const records = history.flatMap((message, index) => message.role === 'assistant'
          ? message.content.map((block, blockIndex) => {
            delete block._openrouter_tool_call_id
            return { type: 'assistant', uuid: `assistant-${blockIndex}`,
              message: { id: 'compat-1234', model, role: 'assistant', content: [block] } }
          }) : [{ type: 'user', uuid: `user-${index}`, message }])
        const saved = JSON.stringify(records)
        history = runtime.runWithForcedProvider({ provider: 'openrouter' }, () =>
          runtime.normalizeMessagesForAPI(records, []).map(record => record.message))
        assert.equal(JSON.stringify(records), saved, 'resume must not rewrite stored history')
      }
      await run(label, history, originalIds, order.map(index => originalIds[index]))
    }
  }
} finally {
  globalThis.fetch = realFetch
  const child = relative(resolve(tmpdir()), resolve(isolated))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(isolated, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
