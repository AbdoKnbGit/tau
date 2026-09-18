/**
 * A prompt suggestion forks the parent's full conversation for a few-word
 * answer. That is cheap only when the fork reads the prefix cache its parent
 * just used, which is what the parent-cache check in promptSuggestion.ts
 * assumes.
 *
 * Antigravity Gemini breaks that assumption: its implicit cache is served per
 * backend pool, not per conversation. Measured 2026-09-18, suggestion forks
 * sent right after a warm parent read 0 of ~46k prompt tokens, so each one
 * re-billed the whole conversation. TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS=1 opts
 * back in.
 */
import { isAntigravityGeminiModel } from '../api/providers/gemini_code_assist.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export function getForkCacheSuppressReason(
  provider: string,
  model: string | undefined,
): string | null {
  if (provider !== 'antigravity' || !model || !isAntigravityGeminiModel(model)) {
    return null
  }
  if (isEnvTruthy(process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS)) return null
  return 'provider_cache_not_shared'
}
