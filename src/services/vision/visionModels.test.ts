/**
 * Run: bun run src/services/vision/visionModels.test.ts
 */

import {
  describerCapableProviders,
  pickVisionModel,
  visionFamilyFor,
  visionVariantKey,
} from './visionModels.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
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

console.log('vision model selection:')

await test('maps the three request shapes', () => {
  assert(visionFamilyFor('firstParty') === 'anthropic', 'firstParty is anthropic-shaped')
  assert(visionFamilyFor('openai') === 'openai', 'openai is openai-shaped')
  assert(visionFamilyFor('antigravity') === 'gemini', 'antigravity is gemini-shaped')
  assert(visionFamilyFor('gemini') === 'gemini', 'gemini is gemini-shaped')
})

await test('refuses providers it cannot format a request for', () => {
  assert(visionFamilyFor('deepseek') === null, 'deepseek is not a describer')
  assert(visionFamilyFor(undefined) === null, 'undefined is not a describer')
})

await test('nothing is chosen until the user chooses', () => {
  // No hardcoded default model: a built-in list goes stale the moment a
  // provider ships a new generation, so the model has to come from the live
  // catalog via /vision-model.
  assert(pickVisionModel(['firstParty', 'openai']) === null, 'no implicit default')
  assert(pickVisionModel(['firstParty'], null) === null, 'null preference stays null')
})

await test('an explicit choice is honoured verbatim', () => {
  const picked = pickVisionModel(['openai'], { provider: 'openai', model: 'gpt-5.4' })
  assert(picked?.provider === 'openai', `got ${picked?.provider}`)
  assert(picked?.model === 'gpt-5.4', 'model must survive exactly as chosen')
})

await test('any model id the catalog offers is accepted', () => {
  // Nothing here may second-guess the catalog: whatever /vision-model listed is
  // what the provider actually serves today.
  for (const model of ['gemini-3.6-pro', 'claude-sonnet-5', 'gpt-5.4', 'o4-mini']) {
    const picked = pickVisionModel(['openai'], { provider: 'openai', model })
    assert(picked?.model === model, `${model} should pass through unchanged`)
  }
})

await test('a stale choice is dropped rather than honoured', () => {
  // Logged out of openai since choosing it. Honouring it would fail on every
  // attachment forever with nothing to explain why.
  const picked = pickVisionModel(['firstParty'], { provider: 'openai', model: 'gpt-5.4' })
  assert(picked === null, `expected null, got ${JSON.stringify(picked)}`)
})

await test('a choice naming an unformattable provider is dropped', () => {
  const picked = pickVisionModel(
    ['deepseek'],
    { provider: 'deepseek', model: 'deepseek-vl' },
  )
  assert(picked === null, 'unformattable choice must not be used')
})

await test('an incomplete choice is dropped', () => {
  assert(pickVisionModel(['openai'], { provider: 'openai', model: '' }) === null, 'empty model')
  assert(pickVisionModel(['openai'], { provider: '', model: 'gpt-5.4' }) === null, 'empty provider')
})

await test('describerCapableProviders filters and orders', () => {
  const capable = describerCapableProviders(['ollama', 'antigravity', 'firstParty'])
  assert(capable.length === 2, `expected 2 capable, got ${capable.length}`)
  assert(capable[0] === 'firstParty', 'display order should be preserved')
  assert(!capable.includes('ollama'), 'ollama cannot describe')
})

await test('variant key is filename-safe and model-specific', () => {
  const a = visionVariantKey({ provider: 'firstParty', model: 'claude-sonnet-5' })
  const b = visionVariantKey({ provider: 'firstParty', model: 'claude-opus-5' })

  assert(a !== b, 'different models must not share a cache entry')
  assert(/^vision-[a-z0-9_-]+$/.test(a), `expected a safe filename fragment, got ${a}`)
})

await test('variant key sanitises path separators out of a model id', () => {
  const key = visionVariantKey({ provider: 'openai', model: '../../etc/passwd' })
  assert(!key.includes('/'), 'slashes must not survive into a filename')
  assert(!key.includes('..'), 'traversal must not survive into a filename')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
