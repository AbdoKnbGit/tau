/** Run: bun run src/utils/model/modelOptions.test.ts */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
// Off the developer's own config, where a saved model would add a row of its own.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tau-model-options-'))
delete process.env.ANTHROPIC_MODEL

const { ANTIGRAVITY_PICKER_MODELS } = await import('../../services/api/providers/gemini_code_assist.js')
const { getModelOptions } = await import('./modelOptions.js')
const { getModelStrings } = await import('./modelStrings.js')
const { setActiveProvider } = await import('./providers.js')

setActiveProvider('antigravity')
const rows = getModelOptions()
assert.equal(rows[0]?.value, null, 'Default stays the first row')
assert.deepEqual(
  rows.slice(1).map(row => row.value),
  ANTIGRAVITY_PICKER_MODELS.map(model => model.id),
  'Antigravity offers its own rows, in catalog order, and nothing else',
)
const opus46 = rows.find(row => row.value === 'claude-opus-4-6-thinking')
assert.equal(opus46?.label, 'Claude Opus 4.6')
assert.equal(opus46?.description, 'claude-opus-4-6-thinking')
assert.ok(rows.some(row => row.value === 'claude-sonnet-4-6'))
assert.match(
  rows.find(row => row.value === 'claude-opus-5-5-high')?.description ?? '',
  /Pro\/Ultra/,
  'a row a free plan cannot run says so, as /models does',
)
assert.ok(
  !rows.some(row => row.value === getModelStrings().opus46),
  'no generic row, whose Anthropic id leaves for the public Gemini API',
)

setActiveProvider('deepseek')
const elsewhere = getModelOptions().map(row => row.value)
assert.ok(elsewhere.includes(getModelStrings().opus46), 'other providers keep the generic rows')
assert.ok(!elsewhere.includes('claude-opus-4-6-thinking'), 'Antigravity rows stay on Antigravity')

console.log('model option checks passed')
