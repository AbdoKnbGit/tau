/**
 * Antigravity's per-level Claude 5.5 ids: parsing, registry routing and the
 * thinking config the lane sends for them.
 *
 * Run: bun run src/utils/model/antigravityClaudeTiers.test.ts
 */

import {
  ANTIGRAVITY_CLAUDE_EFFORTS,
  ANTIGRAVITY_CLAUDE_TIER_MODELS,
  antigravityClaudeTierModelId,
  antigravityEffortCommand,
  parseAntigravityClaudeTier,
} from './antigravityClaudeTiers.js'
import {
  ANTIGRAVITY_MODEL_IDS,
  ANTIGRAVITY_PICKER_MODELS,
  antigravityPickerModelsForPlan,
  executorForModel,
  getAntigravityModelDisplayName,
  isAntigravityGeminiModel,
  resolveAntigravityWireModel,
  wrapForCodeAssist,
} from '../../services/api/providers/gemini_code_assist.js'
import { resolveThinkingConfig } from '../../lanes/gemini/thinking.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const LEVEL_IDS = ANTIGRAVITY_CLAUDE_TIER_MODELS.flatMap(model =>
  ANTIGRAVITY_CLAUDE_EFFORTS.map(effort => antigravityClaudeTierModelId(model, effort)),
)

console.log('antigravity claude tiers:')

test('the six level ids are the ones the Antigravity catalog lists', () => {
  assert(
    JSON.stringify([...LEVEL_IDS].sort()) === JSON.stringify([
      'claude-opus-5-5-high', 'claude-opus-5-5-low', 'claude-opus-5-5-medium',
      'claude-sonnet-5-5-high', 'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium',
    ]),
    `level ids: ${JSON.stringify(LEVEL_IDS)}`,
  )
})

test('parses level ids and nothing else', () => {
  const opus = parseAntigravityClaudeTier('Models/CLAUDE-OPUS-5-5-Medium')
  assert(opus?.model.id === 'claude-opus-5-5' && opus.effort === 'medium', JSON.stringify(opus))
  for (const other of [
    'claude-opus-5-5', 'claude-opus-5-5-xhigh', 'claude-opus-5-5-max', 'claude-sonnet-5-5',
    'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3.8-flash-high',
    'anthropic/claude-opus-5-5', 'claude-opus-5-5-high-extra',
  ]) {
    assert(parseAntigravityClaudeTier(other) === null, `${other} must not parse as a level id`)
  }
})

test('every level id routes through Antigravity as a Claude model', () => {
  for (const id of LEVEL_IDS) {
    assert(ANTIGRAVITY_MODEL_IDS.has(id), `${id} missing from the registry`)
    assert(executorForModel(id) === 'antigravity', `${id} executor`)
    assert(!isAntigravityGeminiModel(id), `${id} must skip the Gemini cache discipline`)
    assert(resolveAntigravityWireModel(id) === id, `${id} wire id`)
    const picker = ANTIGRAVITY_PICKER_MODELS.find(model => model.id === id)
    assert(picker?.tags?.includes('pro-ultra'), `${id} must carry the paid-plan tag`)
  }
  assert(
    getAntigravityModelDisplayName('claude-sonnet-5-5-low') === 'Claude Sonnet 5.5 (Low)',
    'display name',
  )
})

test('the Code Assist envelope keeps the output cap and Claude content fixes', () => {
  const wrapped = wrapForCodeAssist('claude-opus-5-5-high', 'project-id', {
    contents: [
      { role: 'model', parts: [{ thought: true, text: '' }, { text: 'ok' }] },
      { role: 'model', parts: [{ functionResponse: { name: 'read', response: {} } }] },
    ],
    generationConfig: { maxOutputTokens: 64000 },
    safetySettings: [],
  })
  const request = wrapped.request as any
  assert(wrapped.model === 'claude-opus-5-5-high', `wire model ${wrapped.model}`)
  assert(request.generationConfig.maxOutputTokens === 64000, 'maxOutputTokens must reach Claude')
  assert(request.safetySettings === undefined, 'safetySettings must be stripped')
  assert(request.contents[0].parts.length === 1, 'empty thought parts must be dropped')
  assert(request.contents[1].role === 'user', 'functionResponse turns are user turns')
})

test('the lane sends one thinking shape for the level ids, whatever /thinking says', () => {
  const expected = JSON.stringify({ thinkingBudget: -1, includeThoughts: true })
  for (const id of LEVEL_IDS) {
    for (const [budget, thinking] of [
      [-1, undefined],
      [8192, { type: 'enabled', budget_tokens: 8192 }],
      [0, { type: 'disabled' }],
      [-1, { type: 'adaptive' }],
    ] as const) {
      const config = resolveThinkingConfig(id, budget, thinking as any)
      assert(JSON.stringify(config) === expected, `${id} budget=${budget}: ${JSON.stringify(config)}`)
    }
  }
})

test('/effort switches the level of a Claude 5.5 id and nothing else', () => {
  const low = antigravityEffortCommand('claude-sonnet-5-5-high', 'low')
  assert(low.model === 'claude-sonnet-5-5-low', `low: ${JSON.stringify(low)}`)
  const max = antigravityEffortCommand('claude-opus-5-5-low', 'max')
  assert(max.model === 'claude-opus-5-5-high', `max maps to high: ${JSON.stringify(max)}`)
  for (const args of ['', 'status', 'auto', 'medium']) {
    const result = antigravityEffortCommand('claude-sonnet-5-5-medium', args)
    assert(result.model === undefined, `${args || '(none)'} must not switch: ${JSON.stringify(result)}`)
    assert(result.message.includes('Claude Sonnet 5.5 is on Medium effort'), result.message)
  }
  for (const model of ['gemini-3.8-flash-low', 'claude-opus-4-6-thinking']) {
    const result = antigravityEffortCommand(model, 'high')
    assert(result.model === undefined && /no effort setting/.test(result.message), `${model}: ${result.message}`)
  }
})

test('the picker offers each plan only the Claude models it can run', () => {
  const ids = (tier: string | null) => antigravityPickerModelsForPlan(tier).map(m => m.id)
  for (const tier of ['g1-pro-tier', 'g1-ultra-tier']) {
    const paid = ids(tier)
    assert(LEVEL_IDS.every(id => paid.includes(id)), `${tier}: 5.5 rows missing`)
    assert(!paid.includes('claude-sonnet-4-6') && !paid.includes('claude-opus-4-6-thinking'), `${tier}: 4.6 listed`)
    assert(paid.includes('gemini-3.8-flash-high'), `${tier}: Gemini rows kept`)
  }
  const free = ids('free-tier')
  assert(!LEVEL_IDS.some(id => free.includes(id)), 'free: 5.5 listed')
  assert(free.includes('claude-sonnet-4-6') && free.includes('claude-opus-4-6-thinking'), 'free: 4.6 missing')
  assert(ids(null).length === ANTIGRAVITY_PICKER_MODELS.length, 'unknown plan lists everything')
})

test('other Antigravity models keep their thinking config', () => {
  const claude46 = resolveThinkingConfig('claude-opus-4-6-thinking', 8192, { type: 'enabled', budget_tokens: 8192 } as any)
  assert(
    JSON.stringify(claude46) === JSON.stringify({ thinkingBudget: 8192, includeThoughts: true }),
    `claude 4.6: ${JSON.stringify(claude46)}`,
  )
  const gemini = resolveThinkingConfig('gemini-3.8-flash-medium', -1, undefined)
  assert((gemini as any).thinkingLevel === 'medium', `gemini: ${JSON.stringify(gemini)}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
