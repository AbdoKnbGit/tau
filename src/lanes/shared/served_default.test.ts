/** Run: bun run src/lanes/shared/served_default.test.ts */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProviderModelSet } from '../../utils/model/configs.js'
import { LaneBackedProvider } from '../provider-bridge.js'
import type { Lane } from '../types.js'
import { _resetServedDefaultsForTest, servedDefaultModel } from './served_default.js'

// Its own settings: a model saved in the real ones would count as chosen.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tau-served-default-'))
process.env.NODE_ENV = 'test'
delete process.env.ANTHROPIC_MODEL

const provider = 'cline'
const builtIn = getProviderModelSet(provider).sonnet

function laneListing(rows: () => Promise<{ id: string; tags?: string[] }[]>): Lane & { lists: number } {
  const lane = {
    lists: 0,
    listModels: () => {
      lane.lists++
      return rows()
    },
  }
  return lane as unknown as Lane & { lists: number }
}
const listing = (...rows: { id: string; tags?: string[] }[]) => laneListing(async () => rows)

async function check(name: string, run: () => Promise<void>): Promise<void> {
  _resetServedDefaultsForTest()
  await run()
  console.log(`  ok  ${name}`)
}

await check('a default the provider still serves stays', async () => {
  const lane = listing({ id: 'other', tags: ['free'] }, { id: builtIn })
  assert.equal(await servedDefaultModel(lane, provider, builtIn), builtIn)
})

await check('a default it no longer serves gives way to a free row first', async () => {
  const lane = listing({ id: 'paid/first' }, { id: 'paid/second' }, { id: 'free/row', tags: ['free'] })
  assert.equal(await servedDefaultModel(lane, provider, builtIn), 'free/row')
})

await check('with no free row, the first one the provider lists', async () => {
  const lane = listing({ id: 'paid/first' }, { id: 'paid/second' })
  assert.equal(await servedDefaultModel(lane, provider, builtIn), 'paid/first')
})

await check('an empty list or a failed one changes nothing', async () => {
  assert.equal(await servedDefaultModel(listing(), provider, builtIn), builtIn)
  _resetServedDefaultsForTest()
  const failing = laneListing(async () => { throw new Error('offline') })
  assert.equal(await servedDefaultModel(failing, provider, builtIn), builtIn)
})

await check('the answer is settled once, so the model cannot change mid-session', async () => {
  let rows = [{ id: 'first/answer' }]
  const lane = laneListing(async () => rows)
  assert.equal(await servedDefaultModel(lane, provider, builtIn), 'first/answer')
  rows = [{ id: 'later/answer' }]
  assert.equal(await servedDefaultModel(lane, provider, builtIn), 'first/answer')
  assert.equal(lane.lists, 1)
})

await check('any other model, or a provider with its own table, is never looked up', async () => {
  const lane = listing({ id: 'free/row', tags: ['free'] })
  assert.equal(servedDefaultModel(lane, provider, 'some/model'), 'some/model')
  assert.equal(servedDefaultModel(lane, 'openai', getProviderModelSet('openai').sonnet), getProviderModelSet('openai').sonnet)
  assert.equal(servedDefaultModel(lane, undefined, builtIn), builtIn)
  assert.equal(lane.lists, 0)
})

await check('a model someone chose stays theirs, even when it is the same id', async () => {
  process.env.ANTHROPIC_MODEL = builtIn
  try {
    const lane = listing({ id: 'free/row', tags: ['free'] })
    assert.equal(servedDefaultModel(lane, provider, builtIn), builtIn)
    assert.equal(lane.lists, 0)
  } finally {
    delete process.env.ANTHROPIC_MODEL
  }
})

await check('the bridge sends the model it settled on, and the finished message names it', async () => {
  const sent: string[] = []
  const lane = {
    name: provider,
    displayName: 'Fixture',
    resolveModel: (model: string) => model,
    listModels: async () => [{ id: 'free/row', tags: ['free'] }],
    async *streamAsProvider(params: { model: string }) {
      sent.push(params.model)
      yield { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', content: [], model: params.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }
      yield { type: 'message_stop' }
      return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0 }
    },
  } as unknown as Lane
  const bridge = new LaneBackedProvider(lane, provider)
  const params = { model: builtIn, messages: [], system: '', max_tokens: 10 } as never
  assert.equal((await bridge.create(params)).model, 'free/row')
  assert.equal((await bridge.create(params)).model, 'free/row')
  assert.deepEqual(sent, ['free/row', 'free/row'])
})

console.log('served default checks passed')
