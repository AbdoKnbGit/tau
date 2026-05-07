/**
 * Per-model capability resolver for the OpenAI-compat lane.
 *
 * Drives three decisions the lane must make for every call:
 *
 *   1. Which edit primitive to expose (apply_patch / edit_block /
 *      str_replace). Models trained against different formats emit
 *      drastically better or worse patches depending on what they
 *      were shown during instruction-tuning.
 *   2. Whether the model supports reasoning / extended thinking
 *      natively (maps to reasoning_effort / thinking toggles).
 *   3. Whether the model handles function-calling reliably at all
 *      (a handful of older / tiny local models don't).
 *
 * The Transformer for the provider gets the final say via
 * `preferredEditFormat(model)`; this module is a lookup helper that
 * provides additional per-model overrides where the provider default
 * is wrong.
 */

import type { ProviderId } from './transformers/base.js'

export interface ModelCapabilities {
  /** Does this model support function / tool calling reliably? */
  supportsTools: boolean
  /** Does it support native reasoning / thinking output? */
  supportsReasoning: boolean
  /** How many tokens its context window holds (best-effort, for logging). */
  contextWindow?: number
  /** Preferred edit primitive (overrides provider default when set). */
  editFormat?: 'apply_patch' | 'edit_block' | 'str_replace'
}

const EDIT_FORMAT_OVERRIDES: Array<{ pattern: RegExp; format: ModelCapabilities['editFormat'] }> = [
  // DeepSeek coder-series — SEARCH/REPLACE is their post-training edit format.
  { pattern: /deepseek.*coder/i, format: 'edit_block' },
  // Moonshot Kimi K2 / Kimi-Dev handle edit_block cleanly.
  { pattern: /kimi(-k2|-dev)?/i, format: 'edit_block' },
  // Codestral / Mistral's coder family.
  { pattern: /^(codestral|magistral|mistral-coder)/i, format: 'edit_block' },
  // Qwen3-coder (if routed through compat rather than the Qwen lane).
  { pattern: /qwen.*coder/i, format: 'edit_block' },
  // Llama-3.3 70B and up handle edit_block; older / smaller Llama → str_replace.
  { pattern: /llama-?3\.[3-9]/i, format: 'edit_block' },
  { pattern: /llama-?[45]/i, format: 'edit_block' },
  // xAI grok-code-fast — edit_block per benchmarks.
  { pattern: /grok.*code/i, format: 'edit_block' },
  // Tiny / older models → str_replace is most reliable.
  { pattern: /llama-?3\.?[0-2]/i, format: 'str_replace' },
  { pattern: /gemma/i, format: 'str_replace' },
  { pattern: /phi-[23]/i, format: 'str_replace' },
]

const REASONING_CAPABLE_MODELS: RegExp[] = [
  /deepseek.*reason/i,
  /deepseek-r1/i,
  /qwq/i,
  /^o[1-5]/i,
  /reasoning/i,
  /thinking/i,
  /magistral/i,
  /gpt-5/i,
  /claude-.*-4\.?[5-9]/i,
  /claude-opus/i,
  /gemini-[23]/i,
  /gpt-oss/i,
  /^glm-(?:4\.7|5)/i,
]

const NO_TOOL_SUPPORT: RegExp[] = [
  // Tiny models / base completions with no function-calling post-training.
  /^gemma-[12]/i,
  /tinyllama/i,
]

export function resolveCapabilities(
  provider: ProviderId,
  model: string,
): ModelCapabilities {
  const m = model.toLowerCase()
  const supportsTools = !NO_TOOL_SUPPORT.some(re => re.test(m))
  const supportsReasoning = REASONING_CAPABLE_MODELS.some(re => re.test(m))

  let editFormat: ModelCapabilities['editFormat']
  for (const { pattern, format } of EDIT_FORMAT_OVERRIDES) {
    if (pattern.test(m)) {
      editFormat = format
      break
    }
  }

  return { supportsTools, supportsReasoning, editFormat }
}

/**
 * Final answer for "which edit primitive does this model get?" —
 * combines per-model override + per-provider default.
 */
export function resolveEditFormat(
  provider: ProviderId,
  model: string,
  providerDefault: 'apply_patch' | 'edit_block' | 'str_replace',
): 'apply_patch' | 'edit_block' | 'str_replace' {
  const caps = resolveCapabilities(provider, model)
  return caps.editFormat ?? providerDefault
}
