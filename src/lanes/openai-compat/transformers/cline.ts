/**
 * Cline transformer.
 *
 * Cline exposes an OpenAI-compatible chat completions endpoint at
 * api.cline.bot. Authentication is via the OAuth access token as a
 * standard Bearer header (the lane writes that; we don't override here).
 *
 * Extra request headers: `workos:<token>` identifies the OAuth session,
 * `X-Title` / `HTTP-Referer` show up in Cline's analytics so free-tier
 * usage attributes back to Tau (matching the reference executor at
 * reference/9router-master/open-sse/executors/cline.js).
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

export const clineTransformer: Transformer = {
  id: 'cline',
  displayName: 'Cline',
  defaultBaseUrl: 'https://api.cline.bot/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  buildHeaders(apiKey: string): Record<string, string> {
    return {
      // Cline sends the OAuth token both as Bearer AND as a `workos:` prefix
      // header. The Bearer comes from the lane's default path; we add
      // workos here so the backend links the request to the OAuth session.
      workos: apiKey ? `workos:${apiKey}` : '',
      'HTTP-Referer': 'https://github.com/AbdoKnbGit/tau',
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
    // Cline serves frontier Claude/GPT models; keep apply_patch for those.
    if (m.includes('claude-') || m.includes('anthropic/')) return 'apply_patch'
    if (m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3')) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return null
  },

  cacheControlMode(model: string): 'none' | 'passthrough' | 'last-only' {
    const m = model.toLowerCase()
    if (m.includes('claude-') || m.includes('anthropic/')) return 'last-only'
    return 'none'
  },

  // Curated catalog mirrors reference/9router-master/open-sse/config/providerModels.js
  // (the `cl` block). Cline's gateway uses OpenRouter-style namespaced ids.
  staticCatalog() {
    return [
      { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' },
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
      { id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
      { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
      { id: 'google/gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite Preview' },
      { id: 'kwaipilot/kat-coder-pro', name: 'KAT Coder Pro' },
    ]
  },
}
