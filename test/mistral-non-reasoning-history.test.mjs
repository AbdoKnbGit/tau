import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { transformSync } from 'esbuild'

// The Mistral request builder, loaded from source. A model the catalog lists as
// non-reasoning (mistral-large-2512, the helper model that runs hook checks)
// refuses thinking input with 400 "Reasoning input is not enabled for this
// model", so the thinking of a conversation held by a reasoning model stays out
// of its requests. Reasoning models and models outside the catalog are sent
// what they were sent before.
const root = dirname(dirname(fileURLToPath(import.meta.url)))

function load(relativePath, dependencies) {
  const code = transformSync(readFileSync(resolve(root, relativePath), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node20',
  }).code
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, require: () => dependencies, structuredClone,
  }, { filename: relativePath })
  return module.exports
}

const deps = { getDirectEffort: () => 'high', MISTRAL_AGENT_MODEL: 'mistral-large-2512' }
Object.assign(deps, load('src/utils/model/mistralCatalog.ts', deps))
const { mistralTransformer } = load('src/lanes/openai-compat/transformers/mistral.ts', deps)

// The shape the history converter hands over: thinking rides on reasoning_content.
const conversation = [
  { role: 'system', content: 'Rules' },
  { role: 'user', content: 'Inspect the source.' },
  { role: 'assistant', content: 'Checking.', reasoning_content: 'Inspect first.',
    tool_calls: [{ id: 'abcdefghi', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] },
  { role: 'tool', tool_call_id: 'abcdefghi', content: 'file contents' },
  { role: 'assistant', content: 'Done.', reasoning_content: 'Done thinking.' },
  { role: 'user', content: 'Is the stop condition met?' },
]
// Compare what goes on the wire: JSON, which also leaves the VM's own realm.
const send = (model, messages) => JSON.parse(JSON.stringify(mistralTransformer.transformRequest(
  { model, messages: structuredClone(messages), max_tokens: 4096, stream: true },
  { model, sessionId: 'root-session', isReasoning: false, reasoningEffort: null })))
const thinkingParts = body => body.messages
  .flatMap(message => Array.isArray(message.content) ? message.content : [])
  .filter(part => part.type === 'thinking')

test('a model the catalog lists as non-reasoning gets the conversation without its thinking', () => {
  for (const model of ['mistral-large-2512', 'mistral-large-latest']) {
    const body = send(model, conversation)
    assert.deepEqual(thinkingParts(body), [], model)
    assert.ok(body.messages.every(message => message.reasoning_content === undefined && message.reasoning === undefined), model)
    const wire = JSON.stringify(body)
    assert.ok(!wire.includes('Inspect first.') && !wire.includes('Done thinking.'), model)
    assert.deepEqual(body.messages.map(message => message.role), conversation.map(message => message.role), 'every turn stays')
    const call = body.messages.find(message => message.tool_calls)
    assert.equal(call.content, 'Checking.')
    assert.equal(call.tool_calls[0].id, 'abcdefghi')
    assert.equal(body.messages[body.messages.indexOf(call) + 1].tool_call_id, 'abcdefghi')
  }
})

test('reasoning models and models outside the catalog keep the thinking as before', () => {
  for (const model of ['mistral-large-4', 'mistral-medium-3-5', 'magistral-medium-latest']) {
    const parts = thinkingParts(send(model, conversation))
    assert.deepEqual(parts.map(part => part.thinking[0].text), ['Inspect first.', 'Done thinking.'], model)
  }
})

test('the rule touches only thinking: without it, both kinds of model get the same messages', () => {
  const plain = conversation.map(({ reasoning_content: _thinking, ...message }) => message)
  assert.deepEqual(send('mistral-large-2512', plain).messages, send('mistral-large-4', plain).messages)
})

test('a turn that held only thinking leaves like a turn that was empty to begin with', () => {
  const around = turn => [{ role: 'user', content: 'Hello.' }, turn, { role: 'user', content: 'Go on.' }]
  const thinkingOnly = send('mistral-large-2512', around({ role: 'assistant', content: null, reasoning_content: 'Only a trace.' }))
  const empty = send('mistral-large-2512', around({ role: 'assistant', content: null }))
  assert.deepEqual(thinkingOnly.messages, empty.messages)
  assert.deepEqual(thinkingOnly.messages.map(message => message.role), ['user', 'user'])
})

test('a growing conversation keeps its request prefix for the cache', () => {
  const first = send('mistral-large-2512', conversation.slice(0, 4))
  const next = send('mistral-large-2512', conversation)
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages)
  assert.equal(next.prompt_cache_key, first.prompt_cache_key)
})
