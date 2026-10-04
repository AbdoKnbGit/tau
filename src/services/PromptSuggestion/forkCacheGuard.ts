/**
 * A prompt suggestion forks the parent's full conversation for a few-word
 * answer. That is cheap only when the fork reads the prefix cache its parent
 * just used, which is what the parent-cache check in promptSuggestion.ts
 * assumes.
 *
 * Antigravity Gemini breaks that assumption: its implicit cache is served per
 * backend pool, not per conversation. Measured 2026-09-18, suggestion forks
 * sent right after a warm parent read 0 of ~46k prompt tokens, so each one
 * re-billed the whole conversation.
 *
 * Claude on Antigravity does read the parent's cache, but Antigravity consumes
 * quota "proportionally to the cost of the tokens", cache reads included. A
 * fork re-reads the whole conversation, so it costs about as much as the turn
 * it follows: live 2026-10-04, a Sonnet 5.5 chat sent one ~48k-token fork per
 * turn and spent its quota about twice as fast as the turns alone.
 *
 * TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS=1 opts back in for both.
 */
import {
  isAntigravityGeminiModel,
  isAntigravityModelId,
} from '../api/providers/gemini_code_assist.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export function getForkCacheSuppressReason(
  provider: string,
  model: string | undefined,
): string | null {
  if (provider !== 'antigravity' || !model || !isAntigravityModelId(model)) {
    return null
  }
  if (isEnvTruthy(process.env.TAU_ANTIGRAVITY_PROMPT_SUGGESTIONS)) return null
  return isAntigravityGeminiModel(model)
    ? 'provider_cache_not_shared'
    : 'provider_quota_per_token'
}
