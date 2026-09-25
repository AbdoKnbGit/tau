#!/usr/bin/env node
// Explicit live integration audit of the installed Tau bundle. Synthetic inputs only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import Ajv from 'ajv'
import { loadMcpRuntime, fixtureTool, executeBlock } from '../test/helpers/mcp-built-runtime.mjs'

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, model: { type: 'string', multiple: true },
  size: { type: 'string', multiple: true },
  output: { type: 'string', default: 'docs/openrouter-free-model-results.jsonl' },
} })
const apiKey = process.env.OPENROUTER_API_KEY
const sizes = values.size ?? ['short', 'long']
assert.ok(sizes.every(size => ['short', 'long'].includes(size)))
const realFetch = globalThis.fetch
const catalog = await (await realFetch('https://openrouter.ai/api/v1/models', {
  signal: AbortSignal.timeout(20_000),
})).json()
const models = catalog.data.filter(model =>
  Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0 &&
  model.context_length >= 90_000 && model.supported_parameters?.includes('tools') &&
  (!values.model || values.model.includes(model.id)))
if (!values.live) {
  console.log(JSON.stringify({ dryRun: true, models: models.map(model => model.id),
    cases: sizes, maxOutputTokens: 16384, toolsExecute: 'synthetic in-memory record only' }))
  process.exit(0)
}
if (!apiKey) throw new Error('Live testing requires OPENROUTER_API_KEY.')
if (!models.length) throw new Error('No matching free tool-capable models in the live catalog.')
const isolated = mkdtempSync(join(tmpdir(), 'tau-openrouter-live-'))
process.env.CLAUDE_CONFIG_DIR = isolated
process.env.TAU_OPENROUTER_STRICT_TOOLS_STORE = join(isolated, 'strict.json')
process.env.TAU_OPENROUTER_REASONING_CATALOG = '0'
const runtime = await loadMcpRuntime({ paths: ['src/utils/forcedProvider.ts'], exports: ['runWithForcedProvider'] })
const context = new AsyncLocalStorage()
const allowed = new Set(models.map(model => model.id))
const output = resolve(values.output)
const runId = new Date().toISOString()
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const observations = []
const schemaValidator = new Ajv({ strict: false })

globalThis.fetch = async (url, init) => {
  const target = new URL(typeof url === 'string' ? url : url.url ?? String(url))
  assert.equal(target.origin, 'https://openrouter.ai', 'audit cannot send data outside OpenRouter')
  const state = context.getStore()
  if (!init?.body) return realFetch(url, init)
  const body = JSON.parse(init.body)
  assert.equal(target.pathname, '/api/v1/chat/completions')
  assert.ok(allowed.has(body.model), 'only catalog-verified free models are allowed')
  assert.equal(body.tools.length, 1)
  assert.equal(body.tools[0].function.name, 'StoreRecord')
  assert.ok(!init.body.includes('C:\\\\Users\\\\ok') && !init.body.includes('C:/Users/ok'),
    'no local user path may enter the synthetic request')
  const attempt = { stream: body.stream, toolHash: hash(body.tools),
    systemHash: hash(body.messages.filter(message => message.role === 'system')),
    sessionId: body.session_id, cacheKey: body.prompt_cache_key }
  state.attempts.push(attempt)
  const response = await realFetch(url, init)
  attempt.status = response.status
  const observation = response.clone().text().then(raw => {
      const frames = response.headers.get('content-type')?.includes('text/event-stream')
      ? raw.split(/\r?\n\r?\n/).flatMap(frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n')
        return data && data !== '[DONE]' ? [JSON.parse(data)] : []
      }) : [JSON.parse(raw)]
    const wireCalls = new Map()
    for (const frame of frames) {
      attempt.id = frame.id ?? attempt.id
      attempt.provider = frame.provider ?? attempt.provider
      attempt.usage = frame.usage ?? attempt.usage
      attempt.finish = frame.choices?.[0]?.finish_reason ?? attempt.finish
      if (frame.error) attempt.errorCode = frame.error.code
      if (frame.error?.message) attempt.errorMessage = frame.error.message
      if (frame.error?.metadata?.provider_name) attempt.provider = frame.error.metadata.provider_name
      if (frame.error?.metadata?.error_type) attempt.errorType = frame.error.metadata.error_type
      if (frame.error?.metadata?.provider_error_code) attempt.providerErrorCode = frame.error.metadata.provider_error_code
      const delta = frame.choices?.[0]?.delta ?? frame.choices?.[0]?.message ?? {}
      attempt.responseFields = [...new Set([...(attempt.responseFields ?? []), ...Object.keys(delta)])]
      if (typeof delta.content === 'string') {
        attempt.contentChars = (attempt.contentChars ?? 0) + delta.content.length
        attempt.contentPrefix = ((attempt.contentPrefix ?? '') + delta.content).slice(0, 200)
      }
      for (const [index, part] of (frame.choices?.[0]?.delta?.tool_calls ??
        frame.choices?.[0]?.message?.tool_calls ?? []).entries()) {
        const key = part.index ?? index
        const call = wireCalls.get(key) ?? { name: '', arguments: '' }
        call.name = part.function?.name ?? call.name
        call.arguments += part.function?.arguments ?? ''
        wireCalls.set(key, call)
      }
    }
    attempt.wireCalls = [...wireCalls.values()].map(call => {
      let input
      try { input = JSON.parse(call.arguments) } catch {}
      return { name: call.name, argumentChars: call.arguments.length,
        inputHash: input ? hash(input) : undefined, ...argumentSummary(input) }
    })
  }).catch(error => { attempt.observationError = error.name })
  state.observations.push(observation)
  return response
}

async function audit(model, size) {
  const state = { attempts: [], observations: [] }
  return context.run(state, async () => {
    const started = Date.now()
    const location = 'C:\\Temp\\synthetic-only.txt'
    const value = size === 'short' ? 'Synthetic record.' : Array.from({ length: 280 }, (_, i) =>
      `row ${i}: "quoted" \\path\\part; synthetic data`).join('\n')
    const schema = { type: 'object', properties: {
      location: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
    }, required: ['location', 'value'], additionalProperties: false }
    const validate = schemaValidator.compile(schema)
    const tool = fixtureTool({ name: 'StoreRecord', inputJSONSchema: schema,
      inputSchema: { safeParse: input => validate(input)
        ? { success: true, data: input }
        : { success: false, error: { issues: validate.errors } } },
    })
    const lane = new runtime.OpenAICompatLane()
    lane.registerProvider('openrouter', apiKey, 'https://openrouter.ai/api/v1')
    const result = { runId, model: model.id, size, expectedValueChars: value.length, attempts: state.attempts }
    try {
      await runtime.runWithForcedProvider({ provider: 'openrouter' }, async () => {
        const reply = await runtime.assembleFinalMessage(lane.streamAsProvider({
          providerHint: 'openrouter', model: model.id,
          messages: [{ role: 'user', content: JSON.stringify({ location, value }) }],
          system: 'Use the supplied tool to record exactly the user-provided data. Call it once. Do not summarize or abbreviate the value.',
          tools: [{ name: tool.name, description: 'Record the supplied location and value exactly.', input_schema: schema }],
          max_tokens: 16384, temperature: 0,
          sessionId: `free-audit-${hash(model.id).slice(0, 12)}`,
          signal: AbortSignal.timeout(150_000),
        }), model.id)
        const calls = reply.content.filter(block => block.type === 'tool_use')
        result.toolCalls = calls.length
        result.calls = calls.map(call => ({ name: call.name, inputHash: hash(call.input),
          ...argumentSummary(call.input) }))
        result.stop = reply.stop_reason
        if (!calls.length) {
          result.outcome = state.attempts.some(attempt => attempt.status >= 400) ? 'http_error' : 'no_tool_call'
          return
        }
        result.exact = calls.length === 1 && calls[0].name === 'StoreRecord' &&
          calls[0].input?.location === location && calls[0].input?.value === value
        result.valueChars = calls[0].input?.value?.length
        result.decodeError = runtime.decodeStatusOf(calls[0])
        result.schemaValid = validate(calls[0].input)
        if (!result.exact || result.decodeError || !result.schemaValid) {
          result.outcome = 'invalid_or_inexact_arguments'
          return
        }
        const execution = await executeBlock(runtime, calls[0], tool)
        result.executions = tool.calls.length
        result.outcome = tool.calls.length === 1 && execution.results.length === 1 &&
          !execution.results[0].is_error ? 'pass' : 'execution_error'
      })
    } catch (error) {
      result.outcome = 'error'
      result.error = String(error.message).replaceAll(apiKey, '[redacted]').slice(0, 1000)
    }
    await Promise.all(state.observations)
    result.wireArgumentsMatch = result.calls?.every((call, index) =>
      call.inputHash === state.attempts.at(-1)?.wireCalls?.[index]?.inputHash)
    result.elapsedMs = Date.now() - started
    appendFileSync(output, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ model: model.id, size, outcome: result.outcome,
      provider: state.attempts.at(-1)?.provider, attempts: state.attempts.length,
      elapsedMs: result.elapsedMs, error: result.error }))
    return result
  })
}

try {
  // Three independent model requests at a time. Cases for a model stay sequential.
  let cursor = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < models.length) {
      const model = models[cursor++]
      for (const size of sizes) {
        const result = await audit(model, size)
        observations.push(result)
        if (result.attempts.some(attempt => [401, 402, 403, 404, 429].includes(attempt.status))) break
        await setTimeout(3000)
      }
    }
  }))
} finally {
  globalThis.fetch = realFetch
  const base = resolve(tmpdir())
  const target = resolve(isolated)
  assert.ok(target.startsWith(base + '\\') || target.startsWith(base + '/'))
  rmSync(target, { recursive: true, force: true })
}
console.log(JSON.stringify({ output, cases: observations.length,
  passed: observations.filter(row => row.outcome === 'pass').length }))

function argumentSummary(input) {
  return { keys: input && typeof input === 'object' ? Object.keys(input) : [],
    location: input?.location, valueChars: input?.value?.length,
    valueSample: typeof input?.value === 'string' ? input.value.slice(0, 90) : undefined }
}
