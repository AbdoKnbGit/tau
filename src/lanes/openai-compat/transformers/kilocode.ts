/**
 * KiloCode transformer.
 *
 * KiloCode exposes an OpenAI-compatible chat completions endpoint at
 * https://kilocode.ai/api/openrouter/v1 (KiloCode routes through an
 * internal OpenRouter-style aggregator, so many of the same model IDs
 * are available). Auth is the OAuth bearer token; extra headers carry
 * the organization id and usage attribution — see the reference executor
 * at reference/9router-master/open-sse/executors/kiloCode.js.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import { getKiloCodeOrgId } from '../../../services/api/auth/oauth_services.js'

export const kilocodeTransformer: Transformer = {
  id: 'kilocode',
  displayName: 'KiloCode',
  defaultBaseUrl: 'https://kilocode.ai/api/openrouter/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested > 8192 ? 8192 : requested
  },

  buildHeaders(_apiKey: string): Record<string, string> {
    const orgId = getKiloCodeOrgId()
    const headers: Record<string, string> = {
      'HTTP-Referer': 'https://github.com/AbdoKnbGit/tau',
      'X-Title': 'Tau',
      'X-Kilocode-Version': '0.4.0',
    }
    if (orgId) headers['X-Kilocode-OrganizationID'] = orgId
    return headers
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
    // KiloCode aggregates a broad catalog — frontier models keep apply_patch,
    // everything else uses SEARCH/REPLACE for safety.
    if (m.includes('claude-') || m.includes('anthropic/')) return 'apply_patch'
    if (m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3')) return 'apply_patch'
    if (m.includes('gemini-3') || m.includes('gemini-2.5')) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(model: string): string | null {
    const m = model.toLowerCase()
    if (m.startsWith('anthropic/')) return 'anthropic/claude-haiku-4-5'
    if (m.startsWith('openai/')) return 'openai/gpt-4o-mini'
    if (m.startsWith('google/')) return 'google/gemini-2.5-flash-lite'
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    const m = model.toLowerCase()
    if (m.includes('claude-') || m.includes('anthropic/')) return 'last-only'
    if (m.includes('google/gemini')) return 'last-only'
    return 'none'
  },

  // Curated catalog mirrors reference/9router-master/open-sse/config/providerModels.js
  // (the `kc` block). KiloCode uses OpenRouter-style namespaced ids since
  // the gateway routes through an OpenRouter-style aggregator.
  staticCatalog() {
    return [
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus 4' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
      { id: 'openai/o3', name: 'o3' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek/deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ]
  },
}
