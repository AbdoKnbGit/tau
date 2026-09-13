/**
 * GLM / BigModel transformer.
 *
 * BigModel's `/api/paas/v4` endpoint speaks OpenAI Chat Completions,
 * with GLM thinking controlled by `thinking.type`. The visible model-picker
 * toggle owns that setting for GLM thinking-capable models.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import { directProviderModels, getDirectModelMeta } from '../../../utils/model/directProviderCatalog.js'
import { directThinkingFields } from '../../../utils/model/directProviderThinking.js'

export const glmTransformer: Transformer = {
  id: 'glm',
  displayName: 'GLM',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',

  supportsStrictMode: () => false,

  staticCatalog() {
    return directProviderModels('glm')
  },

  clampMaxTokens(requested: number): number {
    return requested
  },

  transformRequest(body: OpenAIChatRequest, ctx: TransformContext): OpenAIChatRequest {
    body.model = normalizeGlmModelId(body.model)
    delete body.thinking
    delete body.reasoning_effort
    Object.assign(body, directThinkingFields('glm', ctx.model))
    if (body.max_tokens) body.max_tokens = Math.min(body.max_tokens, getDirectModelMeta('glm', ctx.model)?.maxOutputTokens ?? 32_768)
    delete body.stream_options
    return body
  },

  normalizeStreamDelta(): void {
    // BigModel already emits OpenAI-compatible stream deltas.
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'format', 'default'])
  },

  contextExceededMarkers(): string[] {
    return [
      'context length',
      'context_length_exceeded',
      'prompt is too long',
      'token limit',
      'too long',
      'tokens exceed',
      'exceed token',
      '上下文',
      '超过',
    ]
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    return 'glm-5-turbo'
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  // GLM-4.6/4.7 emit syntax-clean tool calls at temperature 1.0;
  // BigModel's docs and opencode's `temperature()` matrix both use
  // 1.0 for those. Lower values made code generation deterministic
  // but tool-call argument quality regressed.
  defaultGenerationParams(model: string) {
    const id = model.toLowerCase()
    if (id.includes('glm-4.6') || id.includes('glm-4.7')) {
      return { temperature: 1.0 }
    }
    return undefined
  },
}

function normalizeGlmModelId(model: string): string {
  const trimmed = model.trim()
  return /^glm-/i.test(trimmed) ? trimmed.toLowerCase() : model
}
