/**
 * Cline and Cline Pass model descriptions from models.dev: the thinking
 * ladder each model publishes, the stop that goes on the wire, and the
 * window and output cap it states.
 *
 * Run: bun run src/utils/model/clineModelsDevCatalog.test.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetClineModelsDevForTests,
  deriveClineModelsDevCache,
  ensureClineModelsDevFresh,
  getClineModelMeta,
  hasClineModelsDev,
} from './clineModelsDevCatalog.js'
import {
  _resetClineThinkingForTests,
  applyClineReasoningFields,
  cycleClineEffort,
  getClineEffort,
  getClineEffortLabel,
  getClineThinkingLadder,
  resolveClineReasoningFields,
  setClineEffort,
  supportsClineThinkingSelection,
} from './clineThinking.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e: any) {
    failed++
    console.log(`  FAIL ${name}: ${e?.message ?? String(e)}`)
  }
}

function assert(cond: unknown, hint: string): void {
  if (!cond) throw new Error(hint)
}

// Rows as models.dev publishes them (https://models.dev/api.json, fetched
// 2026-09-13), trimmed to the fields this code reads.
const MODELS_DEV = {
  'cline-pass': {
    models: {
      'cline-pass/glm-5.3': {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        limit: { context: 1_000_000, output: 131_072 },
      },
      'cline-pass/deepseek-v4-pro': {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
        limit: { context: 1_000_000, output: 384_000 },
      },
      'cline-pass/qwen3.8-max': {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
        limit: { context: 1_000_000, output: 131_072 },
      },
      'cline-pass/qwen3.7-plus': {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
        limit: { context: 1_000_000, output: 64_000 },
      },
    },
  },
  openrouter: {
    models: {
      'moonshotai/kimi-k2.6': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }],
        limit: { context: 262_144, output: 235_929 },
      },
      'anthropic/claude-opus-5': {
        reasoning: true,
        reasoning_options: [
          { type: 'toggle' },
          { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
        ],
        limit: { context: 1_000_000, output: 128_000 },
      },
      'openai/gpt-6-astra': {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
      'deepseek/deepseek-v4.1-flash': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
        limit: { context: 1_048_576, output: 384_000 },
      },
      'minimax/minimax-m2.7': {
        reasoning: true,
        reasoning_options: [],
        limit: { context: 204_800, output: 131_072 },
      },
      'qwen/qwen3-coder': {
        reasoning: false,
        limit: { context: 262_144, output: 65_536 },
      },
    },
  },
  // Blocks other than those two are never read.
  anthropic: {
    models: {
      'claude-opus-5': { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
    },
  },
}

const dir = mkdtempSync(join(tmpdir(), 'tau-cline-models-dev-'))
process.env.TAU_CLINE_THINKING_STORE = join(dir, 'cline-thinking.json')
process.env.TAU_CLINE_MODELS_DEV_CACHE = join(dir, 'cline-models-dev.json')
delete process.env.CLAUDEX_DISABLE_MODEL_PRICING

function freshTable(): void {
  _resetClineModelsDevForTests(deriveClineModelsDevCache(MODELS_DEV, Date.now()))
  _resetClineThinkingForTests()
}

function ladderOf(model: string): string {
  const ladder = getClineThinkingLadder(model)
  if (!ladder) return 'nothing to pick'
  return `${ladder.levels.join('/')}${ladder.offSupported ? '' : ' (no off)'}`
}

function main(): void {
  console.log('cline models.dev catalog:')
  freshTable()

  test('only the cline-pass and openrouter blocks are read', () => {
    const cache = deriveClineModelsDevCache(MODELS_DEV, 1)
    const sources = Object.keys(cache.providers).sort().join(',')
    assert(sources === 'cline-pass,openrouter', `sources=${sources}`)
  })

  test('windows are the Cline Pass ones, and input ceilings where stated', () => {
    assert(getClineModelMeta('cline-pass/glm-5.3')?.contextWindow === 1_000_000, 'glm-5.3 window')
    assert(getClineModelMeta('cline-pass/qwen3.7-plus')?.maxOutputTokens === 64_000, 'qwen3.7-plus output cap')
    assert(getClineModelMeta('openai/gpt-6-astra')?.contextWindow === 922_000,
      `gpt-6-astra prompt ceiling=${getClineModelMeta('openai/gpt-6-astra')?.contextWindow}`)
    assert(getClineModelMeta('moonshotai/kimi-k2.6')?.contextWindow === 262_144, 'kimi-k2.6 window')
  })

  test('the block follows the id, and route variants share the model', () => {
    assert(getClineModelMeta('CLINE-PASS/GLM-5.3')?.reasoning === true, 'case-insensitive pass lookup')
    assert(getClineModelMeta('anthropic/claude-opus-5:batch')?.toggle === true, ':batch shares the model')
    assert(getClineModelMeta('cline-pass/glm-5.3::cline-effort=max')?.contextWindow === 1_000_000,
      'an effort variant id describes the same model')
    assert(getClineModelMeta('claude-opus-5') === undefined, 'the anthropic block must not be read')
    assert(getClineModelMeta('cline-pass/not-described') === undefined, 'undescribed ids stay undescribed')
  })

  test("ladders are each model's own stops", () => {
    const expected: Record<string, string> = {
      'cline-pass/glm-5.3': 'none/low/high/max (no off)',
      'cline-pass/deepseek-v4-pro': 'none/low/medium/high/xhigh',
      'cline-pass/qwen3.8-max': 'none/minimal/low/medium/high/xhigh (no off)',
      'moonshotai/kimi-k2.6': 'none/on',
      'anthropic/claude-opus-5': 'none/low/medium/high/xhigh/max',
      'openai/gpt-6-astra': 'none/low/medium/high/xhigh/max (no off)',
      'deepseek/deepseek-v4.1-flash': 'none/low/high/max',
      'minimax/minimax-m2.7': 'nothing to pick',
      'qwen/qwen3-coder': 'nothing to pick',
    }
    for (const [model, ladder] of Object.entries(expected)) {
      assert(ladderOf(model) === ladder, `${model}: ${ladderOf(model)}`)
    }
    assert(!supportsClineThinkingSelection('minimax/minimax-m2.7'), 'no chip when there is nothing to pick')
    assert(!supportsClineThinkingSelection('qwen/qwen3-coder'), 'no chip on a model that does not reason')
    assert(supportsClineThinkingSelection('moonshotai/kimi-k2.6'), 'a bare switch still gets a chip')
  })

  test('models models.dev does not describe keep the five old stops', () => {
    assert(ladderOf('deepseek/deepseek-v4-flash-free') === 'none/low/medium/high/xhigh',
      `legacy thinking model: ${ladderOf('deepseek/deepseek-v4-flash-free')}`)
    assert(ladderOf('someone/plain-chat-model') === 'nothing to pick', 'legacy non-thinking model')
  })

  test('labels say what none does on each model', () => {
    assert(getClineEffortLabel('none', 'cline-pass/glm-5.3') === 'Default', 'no off: Default')
    assert(getClineEffortLabel('none', 'cline-pass/deepseek-v4-pro') === 'Off', 'off exists: Off')
    assert(getClineEffortLabel('none') === 'Off', 'without a model: Off')
    assert(
      getClineEffortLabel('on') === 'On'
      && getClineEffortLabel('max') === 'Max'
      && getClineEffortLabel('minimal') === 'Minimal'
      && getClineEffortLabel('xhigh') === 'Extra High',
      'stop names',
    )
  })

  test('an unconfigured model is sent Off only where Off exists', () => {
    freshTable()
    const wire = (model: string) => JSON.stringify(resolveClineReasoningFields(model))
    assert(wire('cline-pass/deepseek-v4-pro') === '{"reasoning":{"enabled":false}}', wire('cline-pass/deepseek-v4-pro'))
    assert(resolveClineReasoningFields('cline-pass/glm-5.3') === null, 'glm-5.3 cannot stop thinking: send nothing')
    assert(resolveClineReasoningFields('cline-pass/qwen3.8-max') === null, 'qwen3.8-max cannot stop thinking')
    assert(resolveClineReasoningFields('openai/gpt-6-astra') === null, 'gpt-6-astra cannot stop thinking')
    assert(wire('moonshotai/kimi-k2.6') === '{"reasoning":{"enabled":false}}', wire('moonshotai/kimi-k2.6'))
    assert(resolveClineReasoningFields('minimax/minimax-m2.7') === null, 'nothing to set')
    assert(resolveClineReasoningFields('qwen/qwen3-coder') === null, 'does not reason')
  })

  test('a pick goes on the wire as the value the model published', () => {
    freshTable()
    setClineEffort('cline-pass/glm-5.3', 'max')
    assert(
      JSON.stringify(resolveClineReasoningFields('cline-pass/glm-5.3'))
        === '{"reasoning":{"enabled":true,"effort":"max"},"reasoning_effort":"max"}',
      JSON.stringify(resolveClineReasoningFields('cline-pass/glm-5.3')),
    )
    setClineEffort('cline-pass/qwen3.8-max', 'minimal')
    assert(resolveClineReasoningFields('cline-pass/qwen3.8-max')?.reasoning_effort === 'minimal', 'minimal')
    setClineEffort('moonshotai/kimi-k2.6', 'on')
    assert(JSON.stringify(resolveClineReasoningFields('moonshotai/kimi-k2.6')) === '{"reasoning":{"enabled":true}}',
      'a bare switch names no effort')
    assert(resolveClineReasoningFields('cline-pass/glm-5.3::cline-effort=low')?.reasoning_effort === 'low',
      'an effort variant id wins over the stored pick')
  })

  test('a stale pick lands on the nearest published stop', () => {
    freshTable()
    setClineEffort('cline-pass/glm-5.3', 'medium')
    assert(getClineEffort('cline-pass/glm-5.3') === 'high', `medium on low/high/max -> ${getClineEffort('cline-pass/glm-5.3')}`)
    setClineEffort('deepseek/deepseek-v4.1-flash', 'xhigh')
    assert(getClineEffort('deepseek/deepseek-v4.1-flash') === 'max',
      `xhigh on low/high/max -> ${getClineEffort('deepseek/deepseek-v4.1-flash')}`)
    setClineEffort('moonshotai/kimi-k2.6', 'high')
    const fields = resolveClineReasoningFields('moonshotai/kimi-k2.6')
    assert(fields?.reasoning.enabled === true && fields.reasoning_effort === undefined,
      `an effort on a bare switch -> ${JSON.stringify(fields)}`)
  })

  test("the picker cycles each model's own ladder", () => {
    freshTable()
    const seen = [getClineEffort('cline-pass/glm-5.3')]
    for (let step = 0; step < 4; step++) seen.push(cycleClineEffort('cline-pass/glm-5.3', 'right'))
    assert(seen.join('/') === 'none/low/high/max/none', seen.join('/'))
    assert(cycleClineEffort('moonshotai/kimi-k2.6', 'left') === 'on', 'left wraps to the last stop')
  })

  test('a model models.dev does not describe keeps its old wire shape', () => {
    freshTable()
    const model = 'deepseek/deepseek-v4-flash-free'
    assert(JSON.stringify(resolveClineReasoningFields(model)) === '{"reasoning":{"enabled":false}}',
      JSON.stringify(resolveClineReasoningFields(model)))
    setClineEffort(model, 'high')
    assert(
      JSON.stringify(resolveClineReasoningFields(model))
        === '{"reasoning":{"enabled":true,"effort":"high"},"reasoning_effort":"high"}',
      JSON.stringify(resolveClineReasoningFields(model)),
    )
  })

  test('applying no fields clears stale ones', () => {
    const body: Record<string, unknown> = { reasoning: { enabled: true }, reasoning_effort: 'high' }
    applyClineReasoningFields(body, null)
    assert(!('reasoning' in body) && !('reasoning_effort' in body), JSON.stringify(body))
  })

  test('a fresh table fetches nothing, and the opt-out hides it', () => {
    freshTable()
    assert(ensureClineModelsDevFresh() === null, 'a fresh table must not be fetched again')
    assert(hasClineModelsDev(), 'table present')
    process.env.CLAUDEX_DISABLE_MODEL_PRICING = '1'
    try {
      assert(getClineModelMeta('cline-pass/glm-5.3') === undefined, 'opt-out ignored')
      assert(ensureClineModelsDevFresh() === null, 'opt-out must not fetch')
      assert(ladderOf('cline-pass/glm-5.3') === 'none/low/medium/high/xhigh',
        `with models.dev off, the old ladder: ${ladderOf('cline-pass/glm-5.3')}`)
    } finally {
      delete process.env.CLAUDEX_DISABLE_MODEL_PRICING
    }
  })

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
