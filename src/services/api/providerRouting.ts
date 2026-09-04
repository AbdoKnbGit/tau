import { getForcedProvider } from '../../utils/forcedProvider.js'
import type { APIProvider } from '../../utils/model/providerRegistry.js'
import { ANTIGRAVITY_MODEL_IDS } from './providers/gemini_code_assist.js'

/**
 * Providers whose model selection may still be auto-corrected.
 *
 * Exactly `isThirdPartyProvider()` minus the explicitly-pinned providers the
 * previous `_autoCorrectProvider()` returned early for, so extracting this
 * helper out of client.ts changed no routing decision. `openai` and `gemini`
 * are the legacy single-provider rows where users routinely pick a model from
 * the other domain; the remaining three were simply never added to that
 * pinned list. Narrowing this set is a real behavior change for those users —
 * make it deliberately, not as a side effect of another fix.
 */
const MODEL_ROUTABLE_PROVIDERS = new Set<APIProvider>([
  'openai',
  'gemini',
  'fireworks',
  'cloudflare',
  'clinepass',
])

/**
 * Resolve the provider that will actually execute a model request. Request
 * shaping and client creation must share this decision so auto-routed models
 * receive the correct session affinity, cache policy, and transport behavior.
 */
export function resolveEffectiveAPIProvider(
  current: APIProvider,
  model?: string,
): APIProvider {
  if (!model) return current

  // A forced provider is an explicit per-call choice (team roles and agent
  // overrides), so model-name heuristics must never replace it.
  if (getForcedProvider() !== undefined) return current

  // Only unpinned providers participate in correction. An explicitly-selected
  // provider is authoritative: overlapping model ids must not move
  // credentials, quota pools, or caches to a sibling provider.
  if (!MODEL_ROUTABLE_PROVIDERS.has(current)) return current

  const normalizedModel = model.toLowerCase()

  // Antigravity hosts a small fixed set of Gemini 3.x + Claude ids on
  // cloudcode-pa. Reachable from any unpinned provider, matching the routing
  // this function replaced.
  if (ANTIGRAVITY_MODEL_IDS.has(normalizedModel)) return 'antigravity'
  if (
    current === 'openai'
    && (normalizedModel.startsWith('gemini-') || normalizedModel.startsWith('gemma-'))
  ) {
    return 'gemini'
  }
  if (
    current === 'gemini'
    && (
      normalizedModel.startsWith('gpt-')
      || normalizedModel.startsWith('o1')
      || normalizedModel.startsWith('o3')
      || normalizedModel.startsWith('o4')
      || normalizedModel.startsWith('codex-')
    )
  ) {
    return 'openai'
  }

  return current
}
