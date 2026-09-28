/**
 * What models.dev says about OpenCode Zen / Go rows.
 *
 * Run: bun run src/utils/model/opencodeModelsDevCatalog.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Never read or write a developer's real copy.
process.env.TAU_OPENCODE_MODELS_DEV_CACHE = join(
  mkdtempSync(join(tmpdir(), 'tau-opencode-models-dev-')),
  'catalog.json',
)

const {
  _resetOpencodeModelsDevForTests,
  deriveOpencodeModelsDevCache,
  deriveOpencodeModelsDevRows,
  getOpencodeModelMeta,
} = await import('./opencodeModelsDevCatalog.js')

let passed = 0

function test(name: string, fn: () => void): void {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

test('keeps published efforts in ascending order, known values only', () => {
  const rows = deriveOpencodeModelsDevRows({
    models: {
      'GPT-6-Luna': {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['max', 'none', 'low', 'turbo', 'low'] }],
      },
    },
  })
  assert.deepEqual(rows['gpt-6-luna'], { r: true, e: ['none', 'low', 'max'] })
})

test('records the reasoning_content replay contract, and only that field', () => {
  const rows = deriveOpencodeModelsDevRows({
    models: {
      'kimi-k2.6': { reasoning: true, reasoning_options: [{ type: 'toggle' }], interleaved: { field: 'reasoning_content' } },
      // `interleaved: true` names no replay field.
      'claude-sonnet-4-6': { reasoning: true, interleaved: true, reasoning_options: [{ type: 'budget_tokens', min: 1024 }] },
    },
  })
  assert.deepEqual(rows['kimi-k2.6'], { r: true, i: true })
  assert.deepEqual(rows['claude-sonnet-4-6'], { r: true })
})

test('records the SDK override and image input that pick the gateway route', () => {
  const rows = deriveOpencodeModelsDevRows({
    models: {
      'claude-opus-5-5': { reasoning: false, provider: { npm: '@ai-sdk/anthropic' }, modalities: { input: ['text', 'image', 'pdf'] } },
      'gpt-5.5': { reasoning: false, provider: { npm: '@ai-sdk/openai' } },
      'gemini-3.7-flash': { reasoning: false, provider: { npm: '@ai-sdk/google' }, modalities: { input: ['text'] } },
      // An SDK Tau has no route for is left to /chat/completions.
      'jev-1.13': { reasoning: false, provider: { npm: '@ai-sdk/unknown' } },
    },
  })
  assert.deepEqual(rows['claude-opus-5-5'], { r: false, s: 'anthropic', v: true })
  assert.deepEqual(rows['gpt-5.5'], { r: false, s: 'openai' })
  assert.deepEqual(rows['gemini-3.7-flash'], { r: false, s: 'google' })
  assert.deepEqual(rows['jev-1.13'], { r: false })
})

test('a row that does not reason carries no ladder', () => {
  const rows = deriveOpencodeModelsDevRows({
    models: { plain: { reasoning: false, reasoning_options: [{ type: 'effort', values: ['low'] }] } },
  })
  assert.deepEqual(rows.plain, { r: false })
})

test('each host reads its own block, and no other', () => {
  _resetOpencodeModelsDevForTests(deriveOpencodeModelsDevCache({
    opencode: { models: { 'qwen3.8-max': { reasoning: true, reasoning_options: [{ type: 'toggle' }] } } },
    'opencode-go': {
      models: { 'qwen3.8-max': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'xhigh'] }] } },
    },
    openrouter: {
      models: { 'qwen3.8-max': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['high'] }] } },
    },
  }, Date.now()))
  assert.deepEqual(getOpencodeModelMeta('opencode', 'qwen3.8-max')?.efforts, [])
  assert.deepEqual(getOpencodeModelMeta('opencodego', 'Qwen3.8-Max')?.efforts, ['low', 'medium', 'xhigh'])
  assert.equal(getOpencodeModelMeta('openrouter', 'qwen3.8-max'), undefined)
  assert.equal(getOpencodeModelMeta('opencode', 'not-listed'), undefined)
})

test('CLAUDEX_DISABLE_MODEL_PRICING switches the catalogue off', () => {
  process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
  try {
    assert.equal(getOpencodeModelMeta('opencodego', 'qwen3.8-max'), undefined)
  } finally {
    delete process.env.CLAUDEX_DISABLE_MODEL_PRICING
  }
  assert.ok(getOpencodeModelMeta('opencodego', 'qwen3.8-max'))
})

console.log(`\nOpenCode models.dev catalogue: ${passed} passed`)
