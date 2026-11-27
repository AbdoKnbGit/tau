/**
 * LLMTR transformer — prepaid OpenAI-compatible gateway at https://llmtr.com/v1.
 *
 * Model ids use the vendor/model form. Live GET /v1/models is preferred;
 * the static list is only a fallback when that catalog is unavailable.
 */

import type { ModelInfo } from '../../../services/api/providers/base_provider.js'
import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'

const FALLBACK_MODELS: readonly ModelInfo[] = [
  { id: 'qwen/qwen3.8-27b-free', name: 'Qwen3.8 27B Free', supportsToolCalling: true },
  { id: 'lgai/k-exaone-2.5', name: 'K-EXAONE 2.5', supportsToolCalling: true },
  { id: 'nvidia/nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', supportsToolCalling: true },
]

export const llmtrTransformer: Transformer = {
  id: 'llmtr',
  displayName: 'LLMTR',
  defaultBaseUrl: 'https://llmtr.com/v1',

  supportsStrictMode: () => false,

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, _ctx: TransformContext): OpenAIChatRequest {
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'pattern', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'context_length_exceeded', 'prompt is too long', 'maximum context', 'token limit']
  },

  preferredEditFormat(model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    const m = model.toLowerCase()
    if (m.includes('anthropic/') || m.includes('claude-')) return 'apply_patch'
    if (m.includes('openai/gpt-5') || m.includes('openai/o1') || m.includes('openai/o3')) return 'apply_patch'
    if (m.includes('google/gemini-3') || m.includes('google/gemini-2.5')) return 'apply_patch'
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'qwen/qwen3.8-27b-free'
  },

  cacheControlMode(_model: string): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  preferLiveModelCatalog(): boolean {
    return true
  },

  staticCatalog(): ModelInfo[] {
    return FALLBACK_MODELS.map(model => ({ ...model }))
  },
}
