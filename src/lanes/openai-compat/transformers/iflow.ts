/**
 * iFlow transformer.
 *
 * iFlow exposes OpenAI-compatible chat completions at
 * https://apis.iflow.cn/v1. The upstream takes an `apiKey` issued by
 * iFlow's OAuth userinfo endpoint (not the OAuth access_token itself),
 * which the provider layer stores at `meta.apiKey` and surfaces via
 * `getIFlowApiKey()`. Headers below mirror the reference executor at
 * reference/9router-master/open-sse/executors/iflow.js.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const iflowTransformer: Transformer = {
  id: 'iflow',
  displayName: 'iFlow',
  defaultBaseUrl: 'https://apis.iflow.cn/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  buildHeaders(_apiKey: string): Record<string, string> {
    // Bearer is added by the generic header path. Extras identify the
    // session as a Tau IDE request (matches iflow's expected
    // User-Agent shape for chat endpoints).
    return {
      'User-Agent': 'Tau/0.6.0 (+https://github.com/AbdoKnbGit/tau)',
      'X-Source': 'tau',
      'X-Title': 'Tau',
    }
  },

  transformRequest(body: OpenAIChatRequest, _ctx: TransformContext): OpenAIChatRequest {
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'too long']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    // iFlow's Qwen-Coder / Kimi / DeepSeek lines land here — SEARCH/REPLACE
    // works reliably across that set. Frontier Claude/GPT get apply_patch.
    if (m.includes('claude-') || m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3')) {
      return 'apply_patch'
    }
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    const m = model.toLowerCase()
    if (m.includes('claude-')) return 'last-only'
    return 'none'
  },

  // Curated catalog mirrors reference/9router-master/open-sse/config/providerModels.js
  // (the `if` block). iFlow uses bare model ids — no provider namespace prefix.
  staticCatalog() {
    return [
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
      { id: 'qwen3-max', name: 'Qwen3 Max' },
      { id: 'qwen3-vl-plus', name: 'Qwen3 VL Plus' },
      { id: 'qwen3-max-preview', name: 'Qwen3 Max Preview' },
      { id: 'qwen3-235b', name: 'Qwen3 235B A22B' },
      { id: 'qwen3-235b-a22b-instruct', name: 'Qwen3 235B A22B Instruct' },
      { id: 'qwen3-235b-a22b-thinking-2507', name: 'Qwen3 235B A22B Thinking' },
      { id: 'qwen3-32b', name: 'Qwen3 32B' },
      { id: 'kimi-k2', name: 'Kimi K2' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2 Exp' },
      { id: 'deepseek-v3.1', name: 'DeepSeek V3.1 Terminus' },
      { id: 'deepseek-v3', name: 'DeepSeek V3 671B' },
      { id: 'deepseek-r1', name: 'DeepSeek R1' },
      { id: 'glm-4.7', name: 'GLM 4.7' },
      { id: 'iflow-rome-30ba3b', name: 'iFlow ROME' },
    ]
  },
}
