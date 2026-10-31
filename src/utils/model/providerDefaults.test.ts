/** Run: bun run src/utils/model/providerDefaults.test.ts */
import assert from 'node:assert/strict'
import { CLINE_FALLBACK_MODELS } from '../../lanes/cline/catalog.js'
import { CURSOR_MODELS } from '../../lanes/cursor/catalog.js'
import { KILO_FALLBACK_MODELS } from '../../lanes/kilo/catalog.js'
import { KIRO_MODELS } from '../../lanes/kiro/catalog.js'
import { getTransformer } from '../../lanes/openai-compat/transformers/index.js'
import { ANTIGRAVITY_PICKER_MODELS } from '../../services/api/providers/gemini_code_assist.js'
import { getProviderModelSet } from './configs.js'
import { API_PROVIDERS } from './providerRegistry.js'

// A provider left off every table falls to this, an OpenAI id most of them
// would refuse. So no provider in the registry may end up here.
const unknownProviderSet = getProviderModelSet('no-such-provider')

const ANTHROPIC_ROUTES = ['firstParty', 'bedrock', 'vertex', 'foundry']

for (const provider of API_PROVIDERS) {
  if (ANTHROPIC_ROUTES.includes(provider)) continue
  assert.notDeepEqual(getProviderModelSet(provider), unknownProviderSet, `${provider} has no default models of its own`)
}

const catalogs: Record<string, readonly { id: string }[]> = {
  antigravity: ANTIGRAVITY_PICKER_MODELS,
  cline: CLINE_FALLBACK_MODELS,
  cloudflare: getTransformer('cloudflare').staticCatalog?.() ?? [],
  cursor: CURSOR_MODELS,
  iflow: getTransformer('iflow').staticCatalog?.() ?? [],
  kilocode: KILO_FALLBACK_MODELS,
  kiro: KIRO_MODELS,
}

for (const [provider, catalog] of Object.entries(catalogs)) {
  const served = new Set(catalog.map(model => model.id))
  assert(served.size > 0, `${provider} has an empty catalog here`)
  const set = getProviderModelSet(provider)
  for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
    assert(served.has(set[tier]), `${provider} ${tier} default ${set[tier]} is not in its catalog`)
  }
}

console.log('provider default model checks passed')
